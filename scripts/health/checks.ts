/**
 * Health checks a maintainer runs by hand. Each one prints only the pages still
 * left to fix. Append a check here to extend `bun run health`.
 */
import type { HealthCheck } from "./report.ts"
import { runTrustedPublisher } from "./trusted-publisher.ts"

export const checks: HealthCheck[] = [
  {
    id: "trusted-publisher",
    summary:
      "npm packages from this repo whose GitHub Actions publisher is missing or cannot npm publish, each with its access page",
    run: () => runTrustedPublisher(),
  },
]
