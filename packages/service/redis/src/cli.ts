#!/usr/bin/env node
import { createRedis } from "./index.ts"
import { serve } from "./server.ts"

const usage = "mockingbird-redis [--port <n>] [--host <h>] [--password <p>]"
const args = process.argv.slice(2)
let port = 6379
let host = "127.0.0.1"
let password: string | undefined

for (let i = 0; i < args.length; i++) {
  const flag = args[i]
  const next = args[i + 1]
  if (flag === "--help" || flag === "-h") {
    console.log(usage)
    process.exit(0)
  }
  if (flag === "--port" || flag === "--host" || flag === "--password") {
    if (next === undefined) {
      console.error(`${flag} requires a value`)
      process.exit(2)
    }
    i++
    if (flag === "--port") port = Number(next)
    else if (flag === "--host") host = next
    else password = next
  } else {
    console.error(usage)
    process.exit(2)
  }
}

const redis = createRedis(password === undefined ? {} : { password })
const listening = await serve(redis, { port, host })
console.log(`redis://${listening.host}:${listening.port}`)
