#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@emulates/adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "emulates-ec2",
    description: "Amazon Elastic Compute Cloud emulator",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
