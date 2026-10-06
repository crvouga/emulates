import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EndpointManifest } from "./src/fleet.js"

for (const entry of ["stripe/src/cli.ts", "redis/src/cli.ts", "postgres/src/wire/cli.ts"]) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${entry} serve --config publishes one ready record and shuts down on ${signal}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "emulators-cli-"))
      const readyFile = join(dir, "ready.json")
      const configFile = join(dir, "config.json")
      await writeFile(
        configFile,
        JSON.stringify({
          log: "off",
          services: {
            stripe: { port: 0 },
            postgres: { protocol: "postgres", port: 0 },
            redis: { protocol: "redis", port: 0 },
          },
        }),
      )
      // Source-backed installed packages keep this acceptance test independent of another
      // CI shard's dist output while exercising consumer-project module discovery.
      for (const name of ["stripe", "postgres", "redis"]) {
        const packageDir = join(dir, "node_modules", "@emulators", name)
        await mkdir(packageDir, { recursive: true })
        await writeFile(
          join(packageDir, "package.json"),
          JSON.stringify({ type: "module", exports: { "./server": "./server.ts" } }),
        )
        await writeFile(
          join(packageDir, "server.ts"),
          `export { serveTarget } from ${JSON.stringify(join(import.meta.dir, `../../service/${name}/src/server.ts`))}\n`,
        )
      }
      const process = Bun.spawn(
        [
          "bun",
          join(import.meta.dir, `../../service/${entry}`),
          "serve",
          "--config",
          configFile,
          "--ready-file",
          readyFile,
          "--ready-json",
        ],
        {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      let manifest: EndpointManifest | undefined
      try {
        const deadline = Date.now() + 7000
        while (!manifest && Date.now() < deadline) {
          try {
            manifest = JSON.parse(await readFile(readyFile, "utf8")) as EndpointManifest
          } catch {
            /* not published yet */
          }
          if (process.exitCode !== null)
            throw new Error(
              `CLI exited before readiness: ${await new Response(process.stderr).text()}`,
            )
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        if (!manifest) throw new Error("CLI readiness timed out")
        expect(Object.keys(manifest.services).sort()).toEqual(["postgres", "redis", "stripe"])
        expect((await fetch(manifest.healthUrl)).ok).toBe(true)
        process.kill(signal)
        expect(await process.exited).toBe(0)
        const lines = (await new Response(process.stdout).text()).trim().split("\n")
        expect(lines).toHaveLength(1)
        expect(JSON.parse(lines[0] as string)).toEqual(manifest)
        expect(await Bun.file(readyFile).exists()).toBe(false)
        expect(
          await fetch(manifest.healthUrl).then(
            () => false,
            () => true,
          ),
        ).toBe(true)
      } finally {
        if (process.exitCode === null) process.kill("SIGKILL")
        await process.exited
        await rm(dir, { recursive: true, force: true })
      }
    }, 10000)
  }
}
