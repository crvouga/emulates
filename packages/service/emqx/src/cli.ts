#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@crvouga/mockingbird-adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "mockingbird-emqx",
    description: "stateful EMQX 5 broker emulator: MQTT 5 over TCP and WebSocket, REST v5",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
