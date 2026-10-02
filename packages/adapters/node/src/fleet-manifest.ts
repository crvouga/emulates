/** Public readiness contract, usable before workspace packages have been built. */
export type EndpointManifest = {
  version: 1
  state: "ready"
  pid: number
  id: string
  startedAt: string
  adminBase: string
  healthUrl: string
  services: Record<
    string,
    {
      protocol: "http" | "postgres" | "redis"
      url: string
      healthUrl: string
      adminUrl: string
      namespaces: Record<string, unknown>
      processReady: boolean
      protocolReady: boolean
    }
  >
}
