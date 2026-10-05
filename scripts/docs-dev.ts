import { join } from "node:path"

const URL_AT_LINE_END = /(https?:\/\/\S+?)(?=\r?$)/gm

/**
 * Keep terminal URL detectors from treating the next rendered line as a continuation of a URL.
 *
 * Astro uses JSON logging when it detects an agent-managed terminal. Its server-ready message
 * ends with the local URL, so renderers that join wrapped rows can accidentally include the next
 * log entry's timestamp in the link. A trailing space is invisible but gives the detector an
 * unambiguous boundary. Plain Astro output gets the same treatment for ordinary terminals.
 */
export function addTerminalUrlBoundary(line: string): string {
  try {
    const event = JSON.parse(line) as unknown
    if (
      typeof event === "object" &&
      event !== null &&
      "message" in event &&
      typeof event.message === "string"
    ) {
      const message = event.message.replace(URL_AT_LINE_END, "$1 ")
      return message === event.message ? line : JSON.stringify({ ...event, message })
    }
  } catch {
    // Non-JSON output is Astro's normal interactive format.
  }

  return line.replace(URL_AT_LINE_END, "$1 ")
}

async function forward(
  stream: ReadableStream<Uint8Array>,
  destination: NodeJS.WriteStream,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""

  while (true) {
    const { done, value } = await reader.read()
    pending += value ? decoder.decode(value, { stream: true }) : decoder.decode()

    let newline = pending.indexOf("\n")
    while (newline !== -1) {
      destination.write(`${addTerminalUrlBoundary(pending.slice(0, newline))}\n`)
      pending = pending.slice(newline + 1)
      newline = pending.indexOf("\n")
    }

    if (done) break
  }

  if (pending) destination.write(addTerminalUrlBoundary(pending))
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..")
  const child = Bun.spawn(
    ["bun", "run", "--cwd", join(root, "sites/docs"), "dev", ...process.argv.slice(2)],
    {
      cwd: root,
      env: process.env,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  const stop = (signal: NodeJS.Signals) => child.kill(signal)
  process.once("SIGINT", () => stop("SIGINT"))
  process.once("SIGTERM", () => stop("SIGTERM"))

  const [code] = await Promise.all([
    child.exited,
    forward(child.stdout, process.stdout),
    forward(child.stderr, process.stderr),
  ])
  process.exitCode = code
}
