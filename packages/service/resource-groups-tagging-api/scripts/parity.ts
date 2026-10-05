import { serviceParity } from "../../../../scripts/aws/service-parity.js"
import { createServer } from "../src/server.js"

const server = await createServer()
try {
  await serviceParity("resource-groups-tagging-api", server.url)
} finally {
  await server.close()
}
