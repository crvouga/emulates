#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@emulators/adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "emulators-google-calendar",
    description: "Google Calendar v3 + OAuth emulator",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
