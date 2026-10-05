import { serviceParity } from "../../../../scripts/aws/service-parity.js"
import { createServer } from "../src/aws-server.js"

const server = await createServer()
try {
  await serviceParity("eventbridge", server.url)
} finally {
  await server.close()
}
