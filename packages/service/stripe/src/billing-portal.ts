import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { cancelSubscription, markInvoicePaid, payInvoice, subscriptionItems } from "./billing.js"
import { invalidRequest, parameterMissing, resourceMissing, StripeError } from "./errors.js"
import {
  booleanOf,
  changedFields,
  clientSecretFor,
  customerNow,
  findCustomer,
  intOf,
  mergeRecordMetadata,
  type RequestScope,
  recordOf,
  requestScope,
  type Services,
  stringOf,
} from "./internal.js"
import { paginate } from "./list.js"
import { bodyParams, queryParams } from "./params.js"
import { attachPaymentMethod, paymentMethodFromCard } from "./payments.js"
import {
  renderCustomer,
  renderPaymentMethod,
  renderPortalConfiguration,
  renderPortalSession,
  renderSetupIntent,
} from "./render.js"
import {
  type BillingPortalConfigurationRecord,
  type BillingPortalSessionRecord,
  type CustomerRecord,
  type PaymentMethodRecord,
  type PortalFeatures,
  type PortalFlow,
  type SetupIntentRecord,
  type SubscriptionRecord,
  seconds,
} from "./state.js"
import { updateSubscription } from "./subscriptions.js"
import { chargeOutcomeFor } from "./test-tokens.js"

type RecordValue = Record<string, unknown>

export const CANCELLATION_REASONS = [
  "too_expensive",
  "missing_features",
  "switched_service",
  "unused",
  "customer_service",
  "too_complex",
  "low_quality",
  "other",
] as const

/** Every feature off, the base an API-created configuration's `features` are merged onto. */
const disabledFeatures = (): PortalFeatures => ({
  customer_update: { allowed_updates: [], enabled: false },
  invoice_history: { enabled: false },
  payment_method_update: { enabled: false, payment_method_configuration: null },
  subscription_cancel: {
    cancellation_reason: { enabled: false, options: [] },
    enabled: false,
    mode: "at_period_end",
    proration_behavior: "none",
  },
  subscription_update: {
    billing_cycle_anchor: null,
    default_allowed_updates: [],
    enabled: false,
    products: [],
    proration_behavior: "none",
    schedule_at_period_end: { conditions: [] },
    trial_update_behavior: "end_trial",
  },
})

/**
 * The configuration a test account's dashboard would have saved: every feature on, cancellation
 * at period end with a reason, plan and quantity changes with prorations. `products: null` means
 * "every active product with an active recurring price", resolved whenever it is read.
 */
const dashboardFeatures = (): PortalFeatures => ({
  customer_update: { allowed_updates: ["email", "address", "phone", "name"], enabled: true },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true, payment_method_configuration: null },
  subscription_cancel: {
    cancellation_reason: { enabled: true, options: [...CANCELLATION_REASONS] },
    enabled: true,
    mode: "at_period_end",
    proration_behavior: "none",
  },
  subscription_update: {
    billing_cycle_anchor: null,
    default_allowed_updates: ["price", "quantity", "promotion_code"],
    enabled: true,
    products: null,
    proration_behavior: "create_prorations",
    schedule_at_period_end: { conditions: [] },
    trial_update_behavior: "end_trial",
  },
})

/** The account's default configuration, created on first use as the dashboard would have. */
export const ensureDefaultConfiguration = (scope: RequestScope): BillingPortalConfigurationRecord => {
  const existing = scope.account.portalConfigurations
    .list({ order: "oldest", where: (config) => config.is_default })
    .at(0)?.value
  if (existing) return existing
  const now = seconds(scope.now)
  const id = scope.ids.next("bpc_", 24)
  const record: BillingPortalConfigurationRecord = {
    id,
    active: true,
    business_profile: { headline: null, privacy_policy_url: null, terms_of_service_url: null },
    created: now,
    default_return_url: null,
    features: dashboardFeatures(),
    is_default: true,
    login_page: { enabled: false, url: null },
    metadata: {},
    name: null,
    updated: now,
  }
  scope.account.portalConfigurations.insert(id, record)
  return record
}

export type PortalProduct = {
  product: string
  prices: string[]
  adjustable_quantity: { enabled: boolean; maximum: number | null; minimum: number }
}

/** The products (and prices) a configuration lets customers switch between. */
export const portalProducts = (
  scope: RequestScope,
  config: BillingPortalConfigurationRecord,
): PortalProduct[] => {
  const configured = config.features.subscription_update.products
  if (configured !== null) return configured
  const byProduct = new Map<string, string[]>()
  for (const { value: price } of scope.account.prices.list({ order: "oldest" })) {
    if (!price.active || price.recurring === null || price.recurring.usage_type !== "licensed")
      continue
    if (scope.account.products.get(price.product)?.active !== true) continue
    byProduct.set(price.product, [...(byProduct.get(price.product) ?? []), price.id])
  }
  return [...byProduct.entries()].slice(0, 10).map(([product, prices]) => ({
    product,
    prices,
    adjustable_quantity: { enabled: true, maximum: 99, minimum: 1 },
  }))
}

const renderConfiguration = (scope: RequestScope, config: BillingPortalConfigurationRecord) =>
  renderPortalConfiguration({
    ...config,
    features: {
      ...config.features,
      subscription_update: {
        ...config.features.subscription_update,
        products: portalProducts(scope, config),
      },
    },
  })

// --- configuration parameters -------------------------------------------------------------------

const stringList = (value: unknown): string[] | undefined =>
  value === "" ? [] : Array.isArray(value) ? value.map(String) : undefined

const enabledOf = (raw: RecordValue | undefined, current: boolean) =>
  booleanOf(raw?.enabled) ?? current

/** Merge `features[…]` parameters onto a configuration's features, validating references. */
const mergeFeatures = (
  scope: RequestScope,
  base: PortalFeatures,
  raw: unknown,
): PortalFeatures => {
  const features = recordOf(raw)
  if (features === undefined) return base
  const customerUpdate = recordOf(features.customer_update)
  const invoiceHistory = recordOf(features.invoice_history)
  const paymentMethodUpdate = recordOf(features.payment_method_update)
  const cancel = recordOf(features.subscription_cancel)
  const reason = recordOf(cancel?.cancellation_reason)
  const update = recordOf(features.subscription_update)
  const products = update?.products
  const next: PortalFeatures = {
    customer_update: {
      allowed_updates:
        stringList(customerUpdate?.allowed_updates) ?? base.customer_update.allowed_updates,
      enabled: enabledOf(customerUpdate, base.customer_update.enabled),
    },
    invoice_history: { enabled: enabledOf(invoiceHistory, base.invoice_history.enabled) },
    payment_method_update: {
      enabled: enabledOf(paymentMethodUpdate, base.payment_method_update.enabled),
      payment_method_configuration: base.payment_method_update.payment_method_configuration,
    },
    subscription_cancel: {
      cancellation_reason: {
        enabled: enabledOf(reason, base.subscription_cancel.cancellation_reason.enabled),
        options:
          stringList(reason?.options) ?? base.subscription_cancel.cancellation_reason.options,
      },
      enabled: enabledOf(cancel, base.subscription_cancel.enabled),
      mode:
        cancel?.mode === "immediately" || cancel?.mode === "at_period_end"
          ? cancel.mode
          : base.subscription_cancel.mode,
      proration_behavior:
        cancel?.proration_behavior === "always_invoice" ||
        cancel?.proration_behavior === "create_prorations" ||
        cancel?.proration_behavior === "none"
          ? cancel.proration_behavior
          : base.subscription_cancel.proration_behavior,
    },
    subscription_update: {
      billing_cycle_anchor:
        update?.billing_cycle_anchor === "now" || update?.billing_cycle_anchor === "unchanged"
          ? update.billing_cycle_anchor
          : base.subscription_update.billing_cycle_anchor,
      default_allowed_updates:
        stringList(update?.default_allowed_updates) ??
        base.subscription_update.default_allowed_updates,
      enabled: enabledOf(update, base.subscription_update.enabled),
      products:
        products === undefined
          ? base.subscription_update.products
          : products === ""
            ? []
            : parseProducts(scope, products),
      proration_behavior:
        update?.proration_behavior === "always_invoice" ||
        update?.proration_behavior === "create_prorations" ||
        update?.proration_behavior === "none"
          ? update.proration_behavior
          : base.subscription_update.proration_behavior,
      schedule_at_period_end: base.subscription_update.schedule_at_period_end,
      trial_update_behavior:
        update?.trial_update_behavior === "continue_trial" ||
        update?.trial_update_behavior === "end_trial"
          ? update.trial_update_behavior
          : base.subscription_update.trial_update_behavior,
    },
  }
  if (next.subscription_cancel.cancellation_reason.enabled)
    next.subscription_cancel.cancellation_reason.options.forEach((option, index) => {
      if (!(CANCELLATION_REASONS as readonly string[]).includes(option))
        throw invalidRequest(
          `Invalid features[subscription_cancel][cancellation_reason][options][${index}]: must be one of ${CANCELLATION_REASONS.join(", ")}`,
          `features[subscription_cancel][cancellation_reason][options][${index}]`,
        )
    })
  return next
}

/** `features[subscription_update][products][i][product|prices|adjustable_quantity]`. */
const parseProducts = (scope: RequestScope, raw: unknown): PortalProduct[] => {
  if (!Array.isArray(raw)) return []
  return raw.map((entry, index) => {
    const param = `features[subscription_update][products][${index}]`
    const record = recordOf(entry) ?? {}
    const product = typeof record.product === "string" ? record.product : ""
    if (product === "") throw parameterMissing(`${param}[product]`)
    if (!scope.account.products.get(product))
      throw resourceMissing("product", product, `${param}[product]`)
    const prices = stringList(record.prices) ?? []
    if (prices.length === 0) throw parameterMissing(`${param}[prices]`)
    prices.forEach((id, position) => {
      const price = scope.account.prices.get(id)
      if (!price) throw resourceMissing("price", id, `${param}[prices][${position}]`)
      if (price.product !== product)
        throw invalidRequest(
          `The price ${id} does not belong to the product ${product}.`,
          `${param}[prices][${position}]`,
        )
      if (price.recurring === null)
        throw invalidRequest(
          `The price ${id} is not a recurring price. Only recurring prices can be used for subscription updates.`,
          `${param}[prices][${position}]`,
        )
    })
    const quantity = recordOf(record.adjustable_quantity)
    return {
      product,
      prices,
      adjustable_quantity: {
        enabled: booleanOf(quantity?.enabled) ?? false,
        maximum: intOf(quantity?.maximum) ?? null,
        minimum: intOf(quantity?.minimum) ?? 1,
      },
    }
  })
}

const businessProfileOf = (
  raw: unknown,
  base: BillingPortalConfigurationRecord["business_profile"],
): BillingPortalConfigurationRecord["business_profile"] => {
  const profile = recordOf(raw)
  if (profile === undefined) return base
  const text = (key: string, current: string | null) =>
    profile[key] === undefined ? current : stringOf(profile, key)
  return {
    headline: text("headline", base.headline),
    privacy_policy_url: text("privacy_policy_url", base.privacy_policy_url),
    terms_of_service_url: text("terms_of_service_url", base.terms_of_service_url),
  }
}

const loginPageOf = (
  scope: RequestScope,
  raw: unknown,
  base: BillingPortalConfigurationRecord["login_page"],
  id: string,
): BillingPortalConfigurationRecord["login_page"] => {
  const enabled = booleanOf(recordOf(raw)?.enabled)
  if (enabled === undefined) return base
  return {
    enabled,
    url: enabled ? (base.url ?? `${scope.base}/p/login/test_${id.slice(4)}`) : null,
  }
}

const requireConfiguration = (scope: RequestScope, id: string, param = "configuration") => {
  if (!scope.account.portalConfigurations.get(id)) ensureDefaultConfiguration(scope)
  const config = scope.account.portalConfigurations.get(id)
  if (!config) throw resourceMissing("billing portal configuration", id, param)
  return config
}

// --- flows --------------------------------------------------------------------------------------

/** The live (portal-manageable) subscription a flow names, owned by the session's customer. */
const flowSubscription = (
  scope: RequestScope,
  customer: string,
  id: unknown,
  param: string,
): SubscriptionRecord => {
  if (typeof id !== "string" || id === "") throw parameterMissing(param)
  const subscription = scope.account.subscriptions.get(id)
  if (!subscription || subscription.customer !== customer)
    throw resourceMissing("subscription", id, param)
  if (!["active", "trialing", "past_due"].includes(subscription.status))
    throw invalidRequest(
      `The subscription ${id} cannot be managed in the portal because its status is ${subscription.status}.`,
      param,
    )
  return subscription
}

const featureDisabled = (feature: string) =>
  invalidRequest(
    `The ${feature} feature is disabled in this portal configuration. Enable it to use this flow.`,
    "flow_data[type]",
  )

/** Validate `flow_data` against the customer and configuration, as Stripe does at creation. */
const parseFlow = (
  scope: RequestScope,
  raw: unknown,
  customer: string,
  config: BillingPortalConfigurationRecord,
): PortalFlow | null => {
  const data = recordOf(raw)
  if (data === undefined) return null
  const type = data.type
  if (typeof type !== "string" || type === "") throw parameterMissing("flow_data[type]")
  const after = recordOf(data.after_completion)
  const afterType =
    after?.type === "redirect" || after?.type === "hosted_confirmation"
      ? after.type
      : "portal_homepage"
  const redirect = recordOf(after?.redirect)
  if (afterType === "redirect" && typeof redirect?.return_url !== "string")
    throw parameterMissing("flow_data[after_completion][redirect][return_url]")
  const confirmation = recordOf(after?.hosted_confirmation)
  const flow: PortalFlow = {
    type: type as PortalFlow["type"],
    after_completion: {
      type: afterType,
      hosted_confirmation:
        afterType === "hosted_confirmation"
          ? {
              custom_message:
                typeof confirmation?.custom_message === "string"
                  ? confirmation.custom_message
                  : null,
            }
          : null,
      redirect: afterType === "redirect" ? { return_url: String(redirect?.return_url) } : null,
    },
    subscription_cancel: null,
    subscription_update: null,
    subscription_update_confirm: null,
  }
  const features = config.features
  if (type === "payment_method_update") {
    if (!features.payment_method_update.enabled) throw featureDisabled("payment_method_update")
    return flow
  }
  if (type === "customer_update") {
    if (!features.customer_update.enabled) throw featureDisabled("customer_update")
    return flow
  }
  if (type === "subscription_cancel") {
    if (!features.subscription_cancel.enabled) throw featureDisabled("subscription_cancel")
    const cancel = recordOf(data.subscription_cancel)
    const param = "flow_data[subscription_cancel][subscription]"
    const subscription = flowSubscription(scope, customer, cancel?.subscription, param)
    if (subscription.cancel_at_period_end)
      throw invalidRequest(
        `The subscription ${subscription.id} is already set to cancel at the end of the period.`,
        param,
      )
    const retention = recordOf(cancel?.retention)
    let coupon: string | null = null
    if (retention !== undefined) {
      coupon = stringOf(recordOf(retention.coupon_offer) ?? {}, "coupon")
      if (coupon === null)
        throw parameterMissing("flow_data[subscription_cancel][retention][coupon_offer][coupon]")
      if (!scope.account.coupons.get(coupon))
        throw resourceMissing(
          "coupon",
          coupon,
          "flow_data[subscription_cancel][retention][coupon_offer][coupon]",
        )
    }
    return {
      ...flow,
      subscription_cancel: {
        subscription: subscription.id,
        retention: coupon === null ? null : { type: "coupon_offer", coupon_offer: { coupon } },
      },
    }
  }
  if (type === "subscription_update" || type === "subscription_update_confirm") {
    if (!features.subscription_update.enabled) throw featureDisabled("subscription_update")
    const body = recordOf(data[type])
    const param = `flow_data[${type}][subscription]`
    const subscription = flowSubscription(scope, customer, body?.subscription, param)
    if (type === "subscription_update")
      return { ...flow, subscription_update: { subscription: subscription.id } }
    const items = Array.isArray(body?.items) ? body.items : []
    if (items.length === 0) throw parameterMissing("flow_data[subscription_update_confirm][items]")
    const offered = portalProducts(scope, config).flatMap((product) => product.prices)
    const current = subscriptionItems(scope, subscription)
    const parsed = items.map((entry, index) => {
      const item = recordOf(entry) ?? {}
      const itemParam = `flow_data[subscription_update_confirm][items][${index}]`
      const id = stringOf(item, "id")
      if (id === null) throw parameterMissing(`${itemParam}[id]`)
      if (!current.some((existing) => existing.id === id))
        throw resourceMissing("subscription_item", id, `${itemParam}[id]`)
      const price = stringOf(item, "price")
      if (price !== null && !offered.includes(price))
        throw invalidRequest(
          `The price ${price} is not one of the prices this portal configuration offers.`,
          `${itemParam}[price]`,
        )
      return { id, price, quantity: intOf(item.quantity) ?? 1 }
    })
    const discounts = Array.isArray(body?.discounts)
      ? body.discounts.map((entry) => {
          const discount = recordOf(entry) ?? {}
          return {
            coupon: stringOf(discount, "coupon"),
            promotion_code: stringOf(discount, "promotion_code"),
          }
        })
      : null
    return {
      ...flow,
      subscription_update_confirm: { subscription: subscription.id, items: parsed, discounts },
    }
  }
  throw invalidRequest(
    `Invalid flow_data[type]: must be one of customer_update, payment_method_update, subscription_cancel, subscription_update, or subscription_update_confirm`,
    "flow_data[type]",
  )
}

// --- API ----------------------------------------------------------------------------------------

export const billingPortalHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetBillingPortalConfigurations: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    ensureDefaultConfiguration(scope)
    const active = booleanOf(params.active)
    const isDefault = booleanOf(params.is_default)
    return jsonResponse(
      200,
      await paginate<BillingPortalConfigurationRecord>(scope.account.portalConfigurations, params, {
        url: "/v1/billing_portal/configurations",
        kind: "billing portal configuration",
        where: (config) =>
          (active === undefined || config.active === active) &&
          (isDefault === undefined || config.is_default === isDefault),
        render: (config) => renderConfiguration(scope, config),
      }),
    )
  },
  PostBillingPortalConfigurations: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    if (params.features === undefined) throw parameterMissing("features")
    const now = seconds(scope.now)
    const id = scope.ids.next("bpc_", 24)
    const record: BillingPortalConfigurationRecord = {
      id,
      active: true,
      business_profile: businessProfileOf(params.business_profile, {
        headline: null,
        privacy_policy_url: null,
        terms_of_service_url: null,
      }),
      created: now,
      default_return_url: stringOf(params, "default_return_url"),
      features: mergeFeatures(scope, disabledFeatures(), params.features),
      is_default: false,
      login_page: loginPageOf(scope, params.login_page, { enabled: false, url: null }, id),
      metadata: mergeRecordMetadata({}, params.metadata),
      name: stringOf(params, "name"),
      updated: now,
    }
    scope.account.portalConfigurations.insert(id, record)
    const rendered = renderConfiguration(scope, record)
    scope.emit("billing_portal.configuration.created", rendered)
    return jsonResponse(200, rendered)
  },
  GetBillingPortalConfigurationsConfiguration: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    const config = requireConfiguration(scope, context.params.configuration ?? "", "configuration")
    return jsonResponse(200, renderConfiguration(scope, config))
  },
  PostBillingPortalConfigurationsConfiguration: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const current = requireConfiguration(scope, context.params.configuration ?? "", "configuration")
    const active = booleanOf(params.active)
    if (active === false && current.is_default)
      throw invalidRequest("You cannot deactivate your default configuration.", "active")
    const next: BillingPortalConfigurationRecord = {
      ...current,
      active: active ?? current.active,
      business_profile: businessProfileOf(params.business_profile, current.business_profile),
      default_return_url:
        params.default_return_url === undefined
          ? current.default_return_url
          : stringOf(params, "default_return_url"),
      features: mergeFeatures(scope, current.features, params.features),
      login_page: loginPageOf(scope, params.login_page, current.login_page, current.id),
      metadata: mergeRecordMetadata(current.metadata, params.metadata),
      name: params.name === undefined ? current.name : stringOf(params, "name"),
      updated: seconds(scope.now),
    }
    scope.account.portalConfigurations.update(current.id, next)
    const before = renderConfiguration(scope, current)
    const rendered = renderConfiguration(scope, next)
    scope.emit(
      "billing_portal.configuration.updated",
      rendered,
      changedFields(before, rendered),
    )
    return jsonResponse(200, rendered)
  },
  PostBillingPortalSessions: async (context) => {
    const scope = requestScope(services, context)
    const params = bodyParams(context)
    const customer = stringOf(params, "customer")
    if (customer === null) throw parameterMissing("customer")
    const entry = scope.account.customers.get(customer)
    if (!entry || entry.kind === "deleted") throw resourceMissing("customer", customer, "customer")
    const configId = stringOf(params, "configuration")
    const config =
      configId === null
        ? ensureDefaultConfiguration(scope)
        : requireConfiguration(scope, configId, "configuration")
    if (!config.active)
      throw invalidRequest(
        `The configuration ${config.id} is not active. Use an active configuration to create a portal session.`,
        "configuration",
      )
    const flow = parseFlow(scope, params.flow_data, customer, config)
    const id = scope.ids.next("bps_", 24)
    const record: BillingPortalSessionRecord = {
      id,
      configuration: config.id,
      created: seconds(scope.now),
      customer,
      flow,
      locale: stringOf(params, "locale"),
      return_url: stringOf(params, "return_url") ?? config.default_return_url,
      url: `${scope.base}/p/session/${id}`,
    }
    scope.account.portalSessions.insert(id, record)
    const rendered = renderPortalSession(record)
    scope.emit("billing_portal.session.created", rendered)
    return jsonResponse(200, rendered)
  },
})

// --- portal actions (the hosted page) -----------------------------------------------------------

/** What an action did: a message for the page, or where to send the browser. */
export type PortalOutcome = { notice: string } | { redirect: string } | { confirmation: string }

const requireOwnSubscription = (
  scope: RequestScope,
  session: BillingPortalSessionRecord,
  id: string,
): SubscriptionRecord => {
  const subscription = scope.account.subscriptions.get(id)
  if (!subscription || subscription.customer !== session.customer)
    throw invalidRequest("That subscription is not available in this portal session.")
  return subscription
}

const requireOwnPaymentMethod = (
  scope: RequestScope,
  session: BillingPortalSessionRecord,
  id: string,
): PaymentMethodRecord => {
  const method = scope.account.paymentMethods.get(id)
  if (!method || method.customer !== session.customer)
    throw invalidRequest("That payment method is not available in this portal session.")
  return method
}

const saveCustomer = (scope: RequestScope, before: CustomerRecord, after: CustomerRecord) => {
  scope.account.customers.update(after.id, { kind: "live", customer: after })
  const previous = changedFields(renderCustomer(before), renderCustomer(after))
  if (previous !== undefined) scope.emit("customer.updated", renderCustomer(after), previous)
}

/** The flow finished: honour `after_completion`, then fall back to the homepage. */
const completeFlow = (
  scope: RequestScope,
  session: BillingPortalSessionRecord,
  notice: string,
): PortalOutcome => {
  const flow = session.flow
  if (flow === null || session.flow_completed) return { notice }
  scope.account.portalSessions.update(session.id, { ...session, flow_completed: true })
  if (flow.after_completion.type === "redirect" && flow.after_completion.redirect)
    return { redirect: flow.after_completion.redirect.return_url }
  if (flow.after_completion.type === "hosted_confirmation")
    return {
      confirmation: flow.after_completion.hosted_confirmation?.custom_message ?? notice,
    }
  return { notice }
}

export type PortalChange = {
  subscription: SubscriptionRecord
  itemId: string
  price: string
  quantity: number
}

/**
 * Validate a plan/quantity change the way the portal offers it: single-item subscriptions only,
 * to a price the configuration lists, within the product's quantity bounds.
 */
export const portalChange = (
  scope: RequestScope,
  session: BillingPortalSessionRecord,
  config: BillingPortalConfigurationRecord,
  form: Record<string, string>,
): PortalChange => {
  if (!config.features.subscription_update.enabled)
    throw invalidRequest("Plan changes are not enabled for this portal.")
  const subscription = requireOwnSubscription(scope, session, form.subscription ?? "")
  if (!["active", "trialing", "past_due"].includes(subscription.status))
    throw invalidRequest("This subscription can no longer be changed.")
  const items = subscriptionItems(scope, subscription)
  const item = items[0]
  if (items.length !== 1 || item === undefined)
    throw invalidRequest("Subscriptions with more than one product cannot be changed here.")
  const allowed = config.features.subscription_update.default_allowed_updates
  const price = form.price || item.price
  const quantity = form.quantity ? Number(form.quantity) : (item.quantity ?? 1)
  if (price !== item.price && !allowed.includes("price"))
    throw invalidRequest("Changing plans is not enabled for this portal.")
  if (quantity !== (item.quantity ?? 1) && !allowed.includes("quantity"))
    throw invalidRequest("Changing the quantity is not enabled for this portal.")
  const product = portalProducts(scope, config).find((entry) => entry.prices.includes(price))
  if (price !== item.price && product === undefined)
    throw invalidRequest("That plan is not available.")
  if (!Number.isInteger(quantity) || quantity < 1)
    throw invalidRequest("Enter a quantity of at least 1.")
  const bounds = product?.adjustable_quantity
  if (bounds?.enabled && quantity < bounds.minimum)
    throw invalidRequest(`The minimum quantity is ${bounds.minimum}.`)
  if (bounds?.enabled && bounds.maximum !== null && quantity > bounds.maximum)
    throw invalidRequest(`The maximum quantity is ${bounds.maximum}.`)
  if (price === item.price && quantity === (item.quantity ?? 1))
    throw invalidRequest("Choose a different plan or quantity.")
  return { subscription, itemId: item.id, price, quantity }
}

/** The cents a change bills now for the rest of the period (a credit when negative). */
export const previewProration = (
  scope: RequestScope,
  config: BillingPortalConfigurationRecord,
  change: PortalChange,
): number => {
  if (config.features.subscription_update.proration_behavior === "none") return 0
  const { subscription } = change
  if (subscription.status === "trialing") return 0
  const item = scope.account.subscriptionItems.get(change.itemId)
  const amount = (priceId: string, quantity: number) =>
    Math.round(Number(scope.account.prices.get(priceId)?.unit_amount_decimal ?? 0) * quantity)
  const now = customerNow(scope, subscription.customer)
  const span = Math.max(1, subscription.current_period_end - subscription.current_period_start)
  const left = Math.max(0, subscription.current_period_end - now) / span
  return Math.round(
    (amount(change.price, change.quantity) -
      amount(item?.price ?? change.price, item?.quantity ?? 1)) *
      left,
  )
}

/**
 * Run one portal action for the session's customer. Every change goes through the same code the
 * API runs, so the webhooks (`customer.subscription.updated`, `payment_method.attached`, …) are the
 * ones a merchant's own call would produce.
 */
export const runPortalAction = (
  scope: RequestScope,
  session: BillingPortalSessionRecord,
  form: Record<string, string>,
  card: {
    input: {
      expMonth?: number
      expYear?: number
      name?: string | null
      country?: string | null
      postalCode?: string | null
    }
  },
): PortalOutcome => {
  const config = requireConfiguration(scope, session.configuration)
  const features = config.features
  const customer = findCustomer(scope, session.customer)
  if (!customer) throw invalidRequest("This customer no longer exists.")
  switch (form.action) {
    case "cancel": {
      if (!features.subscription_cancel.enabled)
        throw invalidRequest("Canceling is not enabled for this portal.")
      const subscription = requireOwnSubscription(scope, session, form.subscription ?? "")
      if (!["active", "trialing", "past_due"].includes(subscription.status))
        throw invalidRequest("This subscription is already canceled.")
      const reason = form.reason ?? ""
      const feedback =
        features.subscription_cancel.cancellation_reason.enabled && reason !== ""
          ? features.subscription_cancel.cancellation_reason.options.includes(reason)
            ? reason
            : null
          : null
      const comment = form.comment?.trim() ? form.comment.trim() : null
      if (features.subscription_cancel.mode === "immediately") {
        const behavior = features.subscription_cancel.proration_behavior
        cancelSubscription(scope, subscription, "cancellation_requested", undefined, {
          comment,
          feedback,
          prorate: behavior !== "none",
          invoiceNow: behavior === "always_invoice",
        })
        return completeFlow(scope, session, "Your subscription has been canceled.")
      }
      if (subscription.cancel_at_period_end)
        throw invalidRequest("This subscription is already set to cancel.")
      updateSubscription(scope, subscription, {
        cancel_at_period_end: true,
        cancellation_details: {
          ...(comment === null ? {} : { comment }),
          ...(feedback === null ? {} : { feedback }),
        },
      })
      return completeFlow(
        scope,
        session,
        `Your subscription will be canceled on ${formatDate(subscription.current_period_end)}.`,
      )
    }
    case "renew": {
      const subscription = requireOwnSubscription(scope, session, form.subscription ?? "")
      if (!subscription.cancel_at_period_end && subscription.cancel_at === null)
        throw invalidRequest("This subscription is not set to cancel.")
      updateSubscription(scope, subscription, { cancel_at_period_end: false })
      return { notice: "Your subscription has been renewed." }
    }
    case "accept_retention": {
      const retention = session.flow?.subscription_cancel?.retention
      const subscriptionId = session.flow?.subscription_cancel?.subscription
      if (!retention || !subscriptionId) throw invalidRequest("There is no offer to accept.")
      const subscription = requireOwnSubscription(scope, session, subscriptionId)
      updateSubscription(scope, subscription, {
        discounts: [{ coupon: retention.coupon_offer.coupon }],
      })
      return completeFlow(scope, session, "The offer has been applied to your subscription.")
    }
    case "update": {
      const change = portalChange(scope, session, config, form)
      const update = features.subscription_update
      const endTrial =
        change.subscription.status === "trialing" && update.trial_update_behavior === "end_trial"
      updateSubscription(scope, change.subscription, {
        items: [{ id: change.itemId, price: change.price, quantity: change.quantity }],
        proration_behavior: update.proration_behavior,
        ...(endTrial ? { trial_end: "now" } : {}),
      })
      return completeFlow(scope, session, "Your plan has been updated.")
    }
    case "add_payment_method": {
      if (!features.payment_method_update.enabled)
        throw invalidRequest("Updating payment methods is not enabled for this portal.")
      const method = paymentMethodFromCard(scope, form.card ?? "", "card")
      const outcome = chargeOutcomeFor(method.token)
      if (outcome.kind === "card_error") throw invalidRequest(outcome.message)
      const detailed: PaymentMethodRecord = {
        ...method,
        billing_details: {
          ...method.billing_details,
          address: {
            city: null,
            country: card.input.country ?? null,
            line1: null,
            line2: null,
            postal_code: card.input.postalCode ?? null,
            state: null,
          },
          email: customer.email,
          name: card.input.name ?? customer.name,
        },
        card: {
          ...(method.card ?? {}),
          ...(card.input.expMonth === undefined ? {} : { exp_month: card.input.expMonth }),
          ...(card.input.expYear === undefined ? {} : { exp_year: card.input.expYear }),
        },
      }
      scope.account.paymentMethods.update(method.id, detailed)
      // The portal saves a card through a SetupIntent, then makes it the default everywhere.
      const setupId = scope.ids.next("seti_", 24)
      const setup: SetupIntentRecord = {
        id: setupId,
        cancellation_reason: null,
        canceled_at: null,
        client_secret: clientSecretFor(setupId),
        created: seconds(scope.now),
        customer: customer.id,
        description: null,
        last_setup_error: null,
        metadata: {},
        payment_method: method.id,
        payment_method_types: ["card"],
        status: "succeeded",
        usage: "off_session",
      }
      scope.account.setupIntents.insert(setupId, setup)
      scope.emit("setup_intent.created", renderSetupIntent(setup))
      const attached = attachPaymentMethod(scope, detailed, customer.id)
      scope.emit("setup_intent.succeeded", renderSetupIntent(setup))
      makeDefault(scope, customer, attached.id)
      return completeFlow(scope, session, "Your payment method has been added.")
    }
    case "set_default_payment_method": {
      if (!features.payment_method_update.enabled)
        throw invalidRequest("Updating payment methods is not enabled for this portal.")
      const method = requireOwnPaymentMethod(scope, session, form.payment_method ?? "")
      makeDefault(scope, customer, method.id)
      return { notice: "Your default payment method has been updated." }
    }
    case "detach_payment_method": {
      if (!features.payment_method_update.enabled)
        throw invalidRequest("Updating payment methods is not enabled for this portal.")
      const method = requireOwnPaymentMethod(scope, session, form.payment_method ?? "")
      if (customer.invoice_settings.default_payment_method === method.id)
        throw invalidRequest("Your default payment method cannot be removed.")
      const detached: PaymentMethodRecord = { ...method, customer: null, consumed: true }
      scope.account.paymentMethods.update(method.id, detached)
      scope.emit("payment_method.detached", renderPaymentMethod(detached), {
        customer: customer.id,
      })
      return { notice: "The payment method has been removed." }
    }
    case "update_customer": {
      if (!features.customer_update.enabled)
        throw invalidRequest("Updating billing information is not enabled for this portal.")
      const allowed = features.customer_update.allowed_updates
      const value = (key: string) => (form[key]?.trim() ? form[key].trim() : null)
      const email = value("email")
      if (allowed.includes("email") && email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw invalidRequest("Enter a valid email address.")
      const next: CustomerRecord = {
        ...customer,
        ...(allowed.includes("email") && email !== null ? { email } : {}),
        ...(allowed.includes("name") && form.name !== undefined ? { name: value("name") } : {}),
        ...(allowed.includes("phone") && form.phone !== undefined ? { phone: value("phone") } : {}),
        ...(allowed.includes("address") && form.line1 !== undefined
          ? {
              address: {
                city: value("city"),
                country: value("country"),
                line1: value("line1"),
                line2: value("line2"),
                postal_code: value("postal_code"),
                state: value("state"),
              },
            }
          : {}),
      }
      saveCustomer(scope, customer, next)
      return completeFlow(scope, session, "Your billing information has been updated.")
    }
    case "pay_invoice": {
      const invoice = scope.account.invoices.get(form.invoice ?? "")
      if (!invoice || invoice.customer !== customer.id || invoice.status !== "open")
        throw invalidRequest("That invoice cannot be paid here.")
      const paid =
        invoice.amount_remaining === 0
          ? markInvoicePaid(scope, invoice, undefined)
          : payInvoice(scope, invoice, { offSession: false, autoAuthenticate: true })
      if (paid.status !== "paid") throw invalidRequest("The payment could not be completed.")
      return { notice: "Thanks, your invoice has been paid." }
    }
    default:
      throw invalidRequest("Unknown action.")
  }
}

/**
 * Make a payment method the customer's default, and the default of every live subscription that
 * had one of its own, as the portal does when a card is added or chosen.
 */
const makeDefault = (scope: RequestScope, customer: CustomerRecord, methodId: string) => {
  const current = findCustomer(scope, customer.id) ?? customer
  if (current.invoice_settings.default_payment_method !== methodId)
    saveCustomer(scope, current, {
      ...current,
      invoice_settings: { ...current.invoice_settings, default_payment_method: methodId },
    })
  for (const { value: subscription } of scope.account.subscriptions.list({
    where: (record) =>
      record.customer === customer.id &&
      record.default_payment_method !== null &&
      record.default_payment_method !== methodId &&
      ["active", "trialing", "past_due", "unpaid", "paused"].includes(record.status),
  }))
    updateSubscription(scope, subscription, { default_payment_method: methodId })
}

export const formatDate = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })

/** Card errors surface as page messages, like every other portal refusal. */
export const portalErrorMessage = (error: unknown): string | undefined =>
  error instanceof StripeError ? error.init.message : undefined
