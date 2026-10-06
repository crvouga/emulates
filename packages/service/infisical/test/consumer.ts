import { DEFAULT_ADMIN_KEY } from "../src/index.js"
/** HTTP calls made by the reported secrets store; SDK mapping is verified separately. */
export class InfisicalStore {
  constructor(
    readonly fetch: (request: Request) => Promise<Response>,
    readonly base = "http://infisical.fixture",
    readonly namespace?: string,
    readonly token = "fixture-service-token",
    readonly adminPrefix = "/__admin",
    readonly adminKey = DEFAULT_ADMIN_KEY,
  ) {}
  request(
    method: string,
    path: string,
    body?: unknown,
    headers: HeadersInit = {},
  ): Promise<Response> {
    const h = new Headers({
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      "x-emulates-admin-key": this.adminKey,
      ...Object.fromEntries(new Headers(headers)),
    })
    if (this.namespace) h.set("x-emulates-namespace", this.namespace)
    return this.fetch(
      new Request(`${this.base}${path}`, {
        method,
        headers: h,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  admin(method: string, path: string, body?: unknown): Promise<Response> {
    return this.request(method, `${this.adminPrefix}${path}`, body)
  }
  list(path = "/", query = ""): Promise<Response> {
    return this.request(
      "GET",
      `/api/v3/secrets/raw?workspaceId=fixture-project&environment=dev&secretPath=${encodeURIComponent(path)}${query}`,
    )
  }
  get(name: string, path = "/", version?: number): Promise<Response> {
    return this.request(
      "GET",
      `/api/v3/secrets/raw/${encodeURIComponent(name)}?workspaceId=fixture-project&environment=dev&secretPath=${encodeURIComponent(path)}${version === undefined ? "" : `&version=${version}`}`,
    )
  }
  write(method: "POST" | "PATCH", name: string, body: Record<string, unknown>): Promise<Response> {
    return this.request(method, `/api/v3/secrets/raw/${encodeURIComponent(name)}`, {
      workspaceId: "fixture-project",
      environment: "dev",
      secretPath: "/",
      ...body,
    })
  }
  login(): Promise<Response> {
    return this.request("POST", "/api/v1/auth/universal-auth/login", {
      clientId: "fixture-machine",
      clientSecret: "fixture-client-secret",
    })
  }
}
