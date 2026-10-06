#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@emulates/adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "emulates-medplum",
    description: "Emulator of a self-hosted Medplum server (FHIR R4, OAuth2, admin API)",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
