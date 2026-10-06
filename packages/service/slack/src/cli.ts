#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@emulates/adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "emulates-slack",
    description: "Slack incoming-webhook and Web API emulator with an outbox",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
