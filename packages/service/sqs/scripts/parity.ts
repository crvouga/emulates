import { criticalParity } from "../../../../scripts/aws/critical-parity.js"
import { createServer } from "../src/server.js"
const server = await createServer()
try { await criticalParity("sqs", server.url) } finally { await server.close() }
