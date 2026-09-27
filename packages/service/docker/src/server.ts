/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type DockerRuntime, type DockerRuntimeOptions } from "./runtime.js"

export const DEFAULT_PORT = 8826
export type DockerServerOptions = DockerRuntimeOptions & { port?: number; host?: string }
export type DockerServer = Listening & { runtime: DockerRuntime }

/** Ordinary HTTP transport. Duplex attach and UNIX sockets are not implemented yet. */
export const createServer = async (options: DockerServerOptions = {}): Promise<DockerServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

export const serveTarget: ServeTarget = {
  name: "docker",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => [
    "Docker observations: simulated metadata; container lifecycle and attach are unavailable",
  ],
}
