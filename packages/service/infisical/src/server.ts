/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@emulators/adapter-node"
import { createRuntime, type InfisicalRuntime, type InfisicalRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8811
export type InfisicalServerOptions = InfisicalRuntimeOptions & { port?: number; host?: string }
export type InfisicalServer = Listening & { runtime: InfisicalRuntime }
export const createServer = async (
  options: InfisicalServerOptions = {},
): Promise<InfisicalServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "infisical",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminPrefix !== undefined ? { adminPrefix: common.adminPrefix } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => ["Universal Auth: fixture-machine / fixture-client-secret; admin key required"],
}
