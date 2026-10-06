#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@emulates/adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "emulates-intercom",
    description: "Intercom (contacts, conversations, webhooks) emulator",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
