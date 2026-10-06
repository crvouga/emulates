#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@emulators/adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "emulators-aha",
    description: "AHA at-home phlebotomy partner API emulator",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
