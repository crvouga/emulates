/// <reference types="node" />
import type { Listening, ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type DockerRuntime, type DockerRuntimeOptions } from "./runtime.js"

import { listenDocker, type TransportOptions } from "./transport.js"

export const DEFAULT_PORT = 8826
export type DockerServerOptions = DockerRuntimeOptions & TransportOptions
export type DockerServer = Listening & { runtime: DockerRuntime; socketPath?: string }

/** Node-only bounded HTTP transport over TCP or a test-owned Unix socket. */
export const createServer = async (options: DockerServerOptions = {}): Promise<DockerServer> => {
  const { port, host, socketPath, maxBodyBytes, bodyTimeoutMs, maxConnections, ...rest } = options
  const runtime = createRuntime(rest)
  try {
    const listening = await listenDocker(runtime, {
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(socketPath !== undefined ? { socketPath } : {}),
      ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
      ...(bodyTimeoutMs !== undefined ? { bodyTimeoutMs } : {}),
      ...(maxConnections !== undefined ? { maxConnections } : {}),
    })
    return { ...listening, runtime }
  } catch (error) {
    runtime.close()
    throw error
  }
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
  banner: () => ["Docker lifecycle: explicit simulated completion; no image execution or attach"],
}
