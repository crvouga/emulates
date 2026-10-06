/**
 * The copy the repo README and the docs site both show. `scripts/readme.ts` renders it into
 * README.md (CI fails when README.md is stale); the site renders it on the landing page. Inline
 * markdown only: backticks, **bold** and [links](url).
 */

import { project, repositoryUrl } from "../../../../project.ts"

/** Identity art lives in the repo, under the docs site's public directory. */
const DOCS_PUBLIC = "sites/docs/public/"

export const MARK_REPO_PATH = `${DOCS_PUBLIC}identity/${project.slug}.svg`

function docsPublicHref(repoFile: string): string {
  if (!repoFile.startsWith(DOCS_PUBLIC)) {
    throw new Error(`identity art must live under ${DOCS_PUBLIC}`)
  }
  return `/${repoFile.slice(DOCS_PUBLIC.length)}`
}

/** Path the docs site serves for `MARK_REPO_PATH`. */
export const MARK_HREF = docsPublicHref(MARK_REPO_PATH)

/** Shared identity for the site, GitHub and the READMEs published to npm. Edit project.ts, not this. */
export const IDENTITY = {
  name: project.name,
  tagline: project.description,
  /** The mark on `main`. The README image uses this address; `check:readme` requires the file in this repo. */
  mark: `${repositoryUrl.replace("https://github.com/", "https://raw.githubusercontent.com/")}/main/${MARK_REPO_PATH}`,
  guide: `${repositoryUrl}/blob/main/docs/DESIGN.md`,
  home: repositoryUrl,
  /** Public docs site, including the service catalog at `/services`. */
  docs: project.site,
}

/** Opening line of every published package README. `pack:check` requires it verbatim. */
export const EPIGRAPH = `> Part of [${IDENTITY.name}](${IDENTITY.home}): ${IDENTITY.tagline.charAt(0).toLowerCase()}${IDENTITY.tagline.slice(1)}`

/**
 * Single toggle for the "use at your own risk" banner shown at the top of the README and every
 * docs site page. Flip `enabled` to `false` once the project is stable enough to drop it.
 */
export const RISK_DISCLAIMER = {
  enabled: false,
  text: "**Use at your own risk.** Emulates is under active development — APIs, behavior and package names may change without notice.",
}

export const PITCH =
  "Each emulator speaks a vendor's real API or a database's real wire protocol, keeps state like the real thing, and runs in your process. Point the official SDK or driver at it and most tests run fast, offline and deterministically, without a live vendor sandbox. Differential tests check every emulator against the real implementation."

export const FEATURES = [
  {
    icon: "plug",
    title: "Real SDK and API compatibility",
    body: "Each emulator answers the provider's own paths, headers, status codes and error envelopes through `fetch(Request) → Response`, and the database emulators speak the real wire protocol. Point the official SDK or driver at it unchanged.",
  },
  {
    icon: "layers",
    title: "Stateful behavior",
    body: "Records persist in an in-memory SQL engine. Created customers can be listed, orders move through their lifecycle, webhooks fire, and reset or snapshot takes one call.",
  },
  {
    icon: "globe",
    title: "Runs locally, in-process",
    body: "No container or server to start: the emulator runs inside your test process. The same isomorphic package runs in Node, Bun, browsers and Workers; the playgrounds on this site run it in your browser tab.",
  },
  {
    icon: "zap",
    title: "Fast, deterministic tests",
    body: "No network round trips, rate limits or shared test accounts, and no live vendor sandbox for most tests. Seeded randomness, an injectable clock and per-namespace isolation make every run replay exactly.",
  },
  {
    icon: "shield",
    title: "Parity checked against the real thing",
    body: "Differential tests send the same requests to the emulator and to the real implementation (the vendor's sandbox or the real database engine) and compare the answers. Random walks generated from each vendored OpenAPI contract run in CI.",
  },
  {
    icon: "terminal",
    title: "One contract for every service",
    body: "Every HTTP emulator shares `/__admin/health`, `/__admin` reset, snapshots, clock control, fault injection, request journals, collection introspection, an admin UI, and per-namespace isolation.",
  },
] as const

/** Executed against the real package during the docs build: it must log a 2xx status first. */
export const QUICK_START = {
  package: "@emulates/stripe",
  file: "stripe.test.ts",
  code: `import { createRuntime } from "@emulates/stripe"

const stripe = createRuntime()

const res = await stripe.fetch(
  new Request("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test_emulates",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "email=ada@example.com",
  }),
)

console.log(res.status) // 200
const customer = await res.json() // { id: "cus_…", object: "customer", email: "ada@example.com", … }

// State persists: the customer is there when you list customers.
const list = await stripe.fetch(
  new Request("https://api.stripe.com/v1/customers", {
    headers: { authorization: "Bearer sk_test_emulates" },
  }),
)
console.log((await list.json()).data[0].id === customer.id) // true`,
}

export const CONTRACT = {
  intro:
    "Every HTTP service ships an in-process `fetch`, a Node server and a CLI, and all answer the same control surface, so a stack learns it once. Every internal path is under `/__admin` by default. Set `adminPrefix` or `serve --admin-prefix` (`EMULATES_ADMIN_PREFIX`) to relocate the entire tree; `/health` and `/ns` aliases are removed.",
  serve: `npx emulates-junction serve --port 8787                # one service
npx emulates-junction serve --config emulates.json  # every service in the config`,
  rows: [
    [
      "`createRuntime()` · `createServer()` (`./server`) · `emulates-<service> serve`",
      "The emulator as one runtime-neutral `fetch`, or a listening server from Node or the CLI",
    ],
    ["`GET /__admin/health`", "Unauthenticated readiness probe, outside the vendor's auth gate"],
    [
      "`/__admin/*` (`x-emulates-admin-key` optional)",
      "Reset, snapshot and restore, clock control, fault injection, a request journal, metrics with unmatched-route counts, plus service-specific routes",
    ],
    [
      "`GET /__admin/state`",
      "The collections in the selected namespace: declared shape, live `Collection` fields, and stored rows. Create, replace, merge, and delete records through the same paths on every emulator",
    ],
    [
      "`GET /__admin/ui`",
      "The shared admin UI. An emulator can add panels or replace the document; the shell still reads the same state API. Its header fetches that service's logo, website, and docs from the docs site when the page opens",
    ],
    [
      "`x-emulates-namespace`",
      "Per-request isolation: parallel workers share one process without sharing data",
    ],
    [
      "`--seed`, clock control",
      "Seeded randomness and an injectable clock, so a run replays exactly",
    ],
    [
      "`--log json`",
      "One structured line per request: operation id, status, duration, namespace, fault",
    ],
  ] as [string, string][],
  config: `{
  "services": {
    "junction": { "port": 8787, "options": { "corpus": "./test/junction-corpus.json" } },
    "stripe": { "port": 0 },
    "postgres": { "protocol": "postgres", "port": 0 },
    "redis": { "protocol": "redis", "port": 0 }
  }
}`,
  configNote:
    "`emulates.json` names services by their package suffix. HTTP services, PostgreSQL and Redis share a supervisor with ephemeral ports, readiness discovery and namespace controls. Use `--ready-file` or `--ready-json` to discover endpoints; see [Fleets](docs/FLEETS.md). SQLite remains an in-process engine.",
}

export const AGENTS =
  "Every npm package ships an agent index at `node_modules/<package>/DISCOVERY.md`. It points to the local behavior guide, exact capability matrix, machine-readable contract or compatibility evidence, public types, parity oracle, runtime introspection, and issue-reporting contract. [`llms.txt`](llms.txt) indexes those files with the parity each service declares, and the docs site publishes the same source material as markdown and JSON. When an emulator diverges from the real API, lacks a feature you call, or the vendor you need is not in the catalog, file an issue: [the filing guide](https://github.com/crvouga/emulates/blob/main/docs/REPORTING_ISSUES.md) gives the title format, templates and the behavior spec for feature and service requests."

/** Guides in `docs/`, in the order the README and the site list them. Others follow by name. */
export const GUIDE_ORDER = [
  "WHY",
  "TESTING",
  "AUTHORING_A_SERVICE",
  "DEVELOPMENT",
  "DESIGN",
  "REPORTING_ISSUES",
  "RELEASING",
  "SECRETS",
]
