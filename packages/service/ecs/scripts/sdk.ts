import { createServer } from "../src/server.js"

const server = await createServer()
try {
  const child = Bun.spawn(
    [
      "uv",
      "run",
      "--with",
      "boto3==1.43.56",
      new URL("./sdk.py", import.meta.url).pathname,
      server.url,
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  if ((await child.exited) !== 0) throw new Error("Pinned boto3 drop-in failed")
} finally {
  await server.close()
}
