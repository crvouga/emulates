import { createServer } from "../src/server.js"

const server = await createServer()
try {
  const child = Bun.spawn(
    ["uv", "run", "--script", `${import.meta.dir}/python-smoke.py`, server.url],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  if ((await child.exited) !== 0) throw new Error("Python client wire smoke failed")
} finally {
  await server.close()
}
