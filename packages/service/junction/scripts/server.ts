/**
 * `bun run mock:serve`: the env-configured way to run `emulates-junction serve`.
 *
 *   PORT, HOST                              listen address (default 127.0.0.1:8787)
 *   EMULATES_JUNCTION_CORPUS             corpus file (default: the shipped corpus)
 *   EMULATES_JUNCTION_WEBHOOK_URL        deliver signed webhooks here
 *   EMULATES_JUNCTION_WEBHOOK_SECRET     the receiver's whsec_… secret
 *   EMULATES_JUNCTION_WEBHOOK_SCOPE      sent as x-emulates-scope
 *
 * Extra arguments pass through: `bun run mock:serve -- --geo synthetic --log json`.
 */
const env = process.env
const flags: [string, string | undefined][] = [
  ["--port", env.PORT],
  ["--host", env.HOST],
  ["--corpus", env.EMULATES_JUNCTION_CORPUS],
  ["--webhook-url", env.EMULATES_JUNCTION_WEBHOOK_URL],
  ["--webhook-scope", env.EMULATES_JUNCTION_WEBHOOK_SCOPE],
]
const args = flags.flatMap(([flag, value]) => (value ? [flag, value] : []))
process.argv = [
  process.argv[0] ?? "bun",
  "emulates-junction",
  "serve",
  ...args,
  ...process.argv.slice(2),
]
await import("../src/cli.js")
