import type { FetchAPI } from "@emulates/core"
import {
  type APIOptions,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  jsonRes,
  type Service,
} from "@emulates/service"
import type { SqliteClient } from "@emulates/sqlite-client"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { RecaptchaState, type Settings } from "./state.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { createRuntime, RECAPTCHA_PRESETS } from "./runtime.js"
export type { Attempt, Settings, Site, Token } from "./state.js"
export { DEFAULT_SETTINGS, RecaptchaState } from "./state.js"
export type RecaptchaAPIOptions = APIOptions & {
  settings?: Partial<Settings>
  issuePath?: string
  publicNamespace?: string
}
export const RECAPTCHA_NAMESPACE = "recaptcha"

export class RecaptchaAPI implements FetchAPI {
  readonly sqlite: SqliteClient
  readonly app: Hono
  readonly state: RecaptchaState
  private readonly service: Service
  private readonly now: () => number
  constructor(options: RecaptchaAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? RECAPTCHA_NAMESPACE
    this.now = options.now ?? Date.now
    this.state = new RecaptchaState(sqlite, namespace, options.settings ?? {})
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, { error: "Not found" }),
      onError: (error) => {
        throw error
      },
      handlers: defineOperations<SupportedOperationId>({
        BrowserScript: (context) => {
          const issueUrl = new URL(options.issuePath ?? "/__admin/issue", context.url)
          issueUrl.searchParams.set("namespace", options.publicNamespace ?? "default")
          return new Response(
            `(function(){
            const endpoint = ${JSON.stringify(issueUrl.toString())};
            window.grecaptcha = {
              ready: function(callback){ Promise.resolve().then(callback); },
              execute: async function(siteKey, options){
                const response = await fetch(endpoint, {
                  method: "POST", headers: {"content-type":"application/json"},
                  body: JSON.stringify({siteKey:siteKey,action:options && options.action,hostname:location.hostname})
                });
                const body = await response.json();
                if (!response.ok) throw new Error(body.error || "reCAPTCHA execution failed");
                return body.token;
              }
            };
          })();`,
            { headers: { "content-type": "application/javascript" } },
          )
        },
        Siteverify: (context) =>
          this.verify(context.body.kind === "form" ? context.body.value : {}, context.request),
      }),
    })
    this.sqlite = sqlite
    this.app = this.service.app
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  issue(input: unknown): Response {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return jsonRes(400, { error: "Expected siteKey, action and hostname" })
    const { siteKey, action, hostname } = input as Record<string, unknown>
    const settings = this.state.current()
    if (!settings.sites.some((site) => site.siteKey === siteKey))
      return jsonRes(400, { error: "Invalid site key" })
    if (
      typeof action !== "string" ||
      !/^[A-Za-z0-9_/]+$/.test(action) ||
      typeof hostname !== "string" ||
      !hostname
    )
      return jsonRes(400, { error: "Invalid action or hostname" })
    if (settings.executeError) return jsonRes(503, { error: "Scripted execute failure" })
    const token = this.state.ids.next("mock_recaptcha_", 24)
    this.state.tokens.insert(token, {
      token,
      siteKey: String(siteKey),
      action: settings.action ?? action,
      hostname: settings.hostname ?? hostname,
      score: settings.scores[action] ?? settings.score,
      issuedAt: this.now() - (settings.expired ? 120_001 : 0),
      used: settings.replayed,
      errorCodes: settings.errorCodes,
    })
    return jsonRes(200, { token })
  }

  private verify(body: Record<string, unknown>, request: Request): Response {
    const contentType = request.headers.get("content-type")
    const errors: string[] = []
    if (!contentType?.startsWith("application/x-www-form-urlencoded")) errors.push("bad-request")
    const secret = typeof body.secret === "string" ? body.secret : undefined
    const response = typeof body.response === "string" ? body.response : undefined
    const site = this.state.current().sites.find((entry) => entry.secret === secret)
    if (!secret) errors.push("missing-input-secret")
    else if (!site) errors.push("invalid-input-secret")
    if (!response) errors.push("missing-input-response")
    const token = response ? this.state.tokens.get(response) : undefined
    if (response && !token) errors.push("invalid-input-response")
    if (token && site && token.siteKey !== site.siteKey) errors.push("invalid-input-response")
    if (token && (token.used || this.now() - token.issuedAt >= 120_000))
      errors.push("timeout-or-duplicate")
    if (token) errors.push(...token.errorCodes)
    if (faultEffect(request, "expired") || faultEffect(request, "replayed"))
      errors.push("timeout-or-duplicate")
    const success = errors.length === 0 && token !== undefined
    this.state.attempts.insert(this.state.ids.next("attempt_", 20), {
      at: this.now(),
      success,
      errors,
    })
    if (!success || !token)
      return jsonRes(200, { success: false, "error-codes": [...new Set(errors)] })
    this.state.tokens.insert(token.token, { ...token, used: true })
    return jsonRes(200, {
      success: true,
      score: faultEffect(request, "human")
        ? 0.9
        : faultEffect(request, "bot")
          ? 0.1
          : faultEffect(request, "threshold_boundary")
            ? 0.5
            : token.score,
      action: token.action,
      hostname: token.hostname,
      challenge_ts: new Date(token.issuedAt).toISOString(),
    })
  }
}
