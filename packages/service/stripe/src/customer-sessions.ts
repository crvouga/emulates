import { jsonResponse, type OperationHandler } from "@crvouga/mockingbird-service"
import { parameterMissing, resourceMissing } from "./errors.js"
import { findCustomer, requestScope, type Services } from "./internal.js"
import { bodyParams } from "./params.js"
import { seconds } from "./state.js"

/** Embedded components authenticate a customer through a short-lived client secret. */
export const customerSessionHandlers = (services: Services): Record<string, OperationHandler> => ({
  PostCustomerSessions: (context) => {
    const scope = requestScope(services, context)
    const body = bodyParams(context)
    if (typeof body.customer !== "string" || !body.customer) throw parameterMissing("customer")
    const customer = findCustomer(scope, body.customer)
    if (!customer) throw resourceMissing("customer", body.customer, "customer", 400)
    const created = seconds(scope.now)
    return jsonResponse(200, {
      object: "customer_session",
      client_secret: scope.ids.next("cuss_secret_"),
      components: body.components ?? {},
      created,
      customer: customer.id,
      expires_at: created + 1800,
      livemode: false,
    })
  },
})
