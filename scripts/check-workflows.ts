/**
 * Lint every GitHub Actions workflow with actionlint: expression and context errors, bad `needs`,
 * input types, and (when shellcheck is on PATH, as on GitHub's runners) the `run:` scripts. A
 * broken workflow otherwise surfaces only when it runs, which for a dispatch-only workflow such as
 * resolve-issues.yml may be long after it merged.
 *
 *   bun run check:workflows
 *
 * Uses a pinned actionlint release, downloaded once into node_modules/.cache and verified against
 * its published SHA-256, so every machine and CI run lints with the same version.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const VERSION = "1.7.12"
/** From the release's actionlint_<version>_checksums.txt. */
const SHA256: Record<string, string> = {
  darwin_amd64: "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
  darwin_arm64: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
  linux_amd64: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  linux_arm64: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
}

const root = join(import.meta.dir, "..")

async function actionlint(): Promise<string> {
  const dir = join(root, "node_modules/.cache/actionlint", VERSION)
  const binary = join(dir, "actionlint")
  if (existsSync(binary)) return binary

  const platform = `${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`
  const expected = SHA256[platform]
  if (!expected) throw new Error(`no pinned actionlint build for ${platform}`)
  const asset = `actionlint_${VERSION}_${platform}.tar.gz`
  const url = `https://github.com/rhysd/actionlint/releases/download/v${VERSION}/${asset}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`downloading ${url}: HTTP ${response.status}`)
  const archive = new Uint8Array(await response.arrayBuffer())
  const actual = new Bun.CryptoHasher("sha256").update(archive).digest("hex")
  if (actual !== expected) throw new Error(`${asset}: SHA-256 ${actual}, expected ${expected}`)

  const tarball = join(tmpdir(), `${asset}.${process.pid}`)
  writeFileSync(tarball, archive)
  mkdirSync(dir, { recursive: true })
  const untar = Bun.spawnSync(["tar", "-xzf", tarball, "-C", dir, "actionlint"])
  rmSync(tarball, { force: true })
  if (untar.exitCode !== 0) throw new Error(`extracting ${asset}: ${untar.stderr.toString()}`)
  chmodSync(binary, 0o755)
  return binary
}

try {
  const lint = Bun.spawnSync([await actionlint()], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (lint.exitCode !== 0) {
    console.error("check:workflows FAILED — fix the workflow errors above.")
    process.exit(1)
  }
  console.log(`check:workflows: every workflow passes actionlint ${VERSION}.`)
} catch (error) {
  console.error(`check:workflows: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
