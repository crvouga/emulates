#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@emulators/adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "emulators-google-maps",
    description:
      "Google Places / Geocoding / Maps JavaScript API emulator over a QA address corpus",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
