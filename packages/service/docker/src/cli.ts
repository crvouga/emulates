#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@emulators/adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "emulators-docker",
    description: "Docker Engine API emulator (WIP: synthetic observations and shared controls)",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
