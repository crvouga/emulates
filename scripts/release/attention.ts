/**
 * Get the maintainer's attention while a local seed waits on them.
 *
 * npm only prompts (login, 2FA approval for publish and trust changes) when it owns the
 * terminal, so its output cannot be read to spot a prompt. A step that outlives a normal
 * registry round trip is treated as waiting instead: ring the bell, post a desktop
 * notification, and repeat until the step finishes.
 */

/** Longer than a publish or trust change takes when nothing is asked of the maintainer. */
const WAIT_MS = 20_000
const REPEAT_MS = 60_000

function spawnQuiet(cmd: string[]): void {
  try {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref()
  } catch {
    // Not installed. The bell and the printed line still stand.
  }
}

/** Terminal bell, a printed line, and a desktop notification (with a sound on macOS). */
export function alertMaintainer(message: string): void {
  process.stderr.write(`\x07\nrelease:seed: ${message}\n`)
  if (process.platform === "darwin") {
    // The message is an argument, never part of the script.
    spawnQuiet([
      "osascript",
      "-e",
      "on run argv",
      "-e",
      'display notification (item 1 of argv) with title "release:seed"',
      "-e",
      "end run",
      message,
    ])
    spawnQuiet(["afplay", "/System/Library/Sounds/Glass.aiff"])
  } else if (process.platform === "linux") {
    spawnQuiet(["notify-send", "--urgency=critical", "release:seed", message])
  }
}

/** Run `work`; alert once it has run for `afterMs`, then every `everyMs` until it settles. */
export async function alertIfWaiting<T>(
  message: string,
  work: () => Promise<T>,
  options: { afterMs?: number; everyMs?: number; alert?: (message: string) => void } = {},
): Promise<T> {
  const { afterMs = WAIT_MS, everyMs = REPEAT_MS, alert = alertMaintainer } = options
  let timer: ReturnType<typeof setTimeout>
  const ring = () => {
    alert(message)
    timer = setTimeout(ring, everyMs)
  }
  timer = setTimeout(ring, afterMs)
  try {
    return await work()
  } finally {
    clearTimeout(timer)
  }
}
