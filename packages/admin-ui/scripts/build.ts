import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"

const result = await build({
  entryPoints: ["src/browser.tsx"],
  bundle: true,
  format: "iife",
  globalName: "EmulatesAdmin",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  legalComments: "inline",
  // This bundle only executes in browsers, including embedded service documents.
  // Remove library fallbacks for Node's process instead of shipping runtime shims.
  define: { "process.env.NODE_ENV": '"production"', process: "undefined" },
  write: false,
  metafile: true,
})
const output = result.outputFiles?.[0]
if (!output) throw new Error("Admin UI build produced no bundle")
// Published services inline this bundle, so carry the bundled packages' licenses
// inside it rather than depending on node_modules or a separate hosted asset.
const notices = new Map<string, string>()
for (const input of Object.keys(result.metafile.inputs).sort()) {
  if (!input.includes("node_modules/")) continue
  let directory = dirname(resolve(input))
  while (directory !== dirname(directory)) {
    const manifest = resolve(directory, "package.json")
    if (existsSync(manifest)) {
      const pkg = JSON.parse(await readFile(manifest, "utf8")) as {
        name?: string
        version?: string
      }
      if (!pkg.name) {
        directory = dirname(directory)
        continue
      }
      const key = `${pkg.name}@${pkg.version}`
      if (!notices.has(key)) {
        const licenses = (await readdir(directory))
          .filter((file) => /^licen[sc]e(?:$|[.-])/i.test(file))
          .sort()
        const content = await Promise.all(
          licenses.map((file) => readFile(resolve(directory, file), "utf8")),
        )
        if (content.length) notices.set(key, content.join("\n\n"))
      }
      break
    }
    directory = dirname(directory)
  }
}
const attribution = [...notices].map(([name, license]) => `${name}\n${license}`).join("\n\n")
// HTML parsers recognize closing script tags even inside a JavaScript string.
const source =
  `/*! Bundled third-party notices\n${attribution.replace(/\*\//g, "* /")}\n*/\n${output.text}`.replace(
    /<\/script/gi,
    "<\\/script",
  )
await mkdir("dist", { recursive: true })
await writeFile("dist/bundle.js", `export const ADMIN_BROWSER_BUNDLE = ${JSON.stringify(source)}\n`)
await writeFile("dist/bundle.d.ts", "export declare const ADMIN_BROWSER_BUNDLE: string\n")
console.log(`admin-ui: bundled React + Ant Design (${Math.round(source.length / 1024)} KiB)`)
