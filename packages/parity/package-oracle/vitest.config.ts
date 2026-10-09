import { defineConfig } from "vitest/config"
export default defineConfig({
  test: {
    include: ["upstream/**/*.test.upstream.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 2,
  },
})
