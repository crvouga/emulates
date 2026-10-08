/**
 * The copy the repo README and the docs site both show. `scripts/readme.ts` renders it into
 * README.md (CI fails when README.md is stale); the site renders it on the landing page. Inline
 * markdown only: backticks, **bold** and [links](url).
 */

import { CHECKOUT } from "./quick-start.ts"

const DOCS_PUBLIC = "sites/docs/public/"
const HOME = "https://github.com/crvouga/mockingbird"

/** Emoji SVG used for the docs favicon. */
export const MARK_REPO_PATH = `${DOCS_PUBLIC}identity/mockingbird.svg`

function docsPublicHref(repoFile: string): string {
  if (!repoFile.startsWith(DOCS_PUBLIC)) {
    throw new Error(`identity art must live under ${DOCS_PUBLIC}`)
  }
  return `/${repoFile.slice(DOCS_PUBLIC.length)}`
}

/** Path the docs site serves for `MARK_REPO_PATH`. */
export const MARK_HREF = docsPublicHref(MARK_REPO_PATH)

/** Shared identity for the site, GitHub and the READMEs published to npm. */
export const IDENTITY = {
  name: "Mockingbird",
  icon: "🐦‍⬛",
  tagline: "Local emulators. Real API contracts.",
  note: "Run the APIs and databases your application depends on, inside your own process. Deterministic state, vendor-compatible requests, and explicit coverage.",
  guide: `${HOME}/blob/main/docs/DESIGN.md`,
  home: HOME,
  /** Public docs site, including the service catalog at `/services`. */
  docs: "https://mockingbird.chrisvouga.dev",
}

/** Opening line of every published package README. `pack:check` requires it verbatim. */
export const EPIGRAPH = `> ${IDENTITY.tagline} Part of [${IDENTITY.name}](${IDENTITY.home}).`

/**
 * Single toggle for the "use at your own risk" banner shown at the top of the README and every
 * docs site page. Flip `enabled` to `false` once the project is stable enough to drop it.
 */
export const RISK_DISCLAIMER = {
  enabled: false,
  text: "**Use at your own risk.** Mockingbird is under active development — APIs, behavior and package names may change without notice.",
}

export const HEADLINE = {
  lead: "Local emulators.",
  accent: "Real API contracts.",
}

export const PITCH =
  "Mockingbird provides stateful emulators for third-party APIs and SQL databases. Use vendor-compatible request and response shapes, persistent in-memory state, and deterministic controls in Node, Bun, browsers, and Workers."

export const FEATURES = [
  {
    icon: "plug",
    title: "The vendor's real surface",
    body: "Each emulator answers the provider's own paths, headers, status codes and error envelopes through `fetch(Request) → Response`. Point the official SDK at it.",
  },
  {
    icon: "layers",
    title: "State that behaves",
    body: "Records persist in an in-memory SQL engine. Created customers can be listed, orders move through their lifecycle, webhooks fire, and reset or snapshot takes one call.",
  },
  {
    icon: "shield",
    title: "Checked against the real thing",
    body: "Random walks generated from each vendored OpenAPI contract run against two emulator instances in CI, and against the live sandbox when credentials exist.",
  },
  {
    icon: "zap",
    title: "No network, no waiting",
    body: "Everything runs in your test process. No sandbox keys, rate limits, shared test accounts or flaky round trips.",
  },
  {
    icon: "globe",
    title: "Runs anywhere JavaScript runs",
    body: "Every emulator is isomorphic: the same package runs in Node, Bun, browsers, and Workers. The playgrounds on this site run that package in your browser tab.",
  },
  {
    icon: "terminal",
    title: "One contract for every service",
    body: "Every HTTP emulator shares `/__admin/health`, `/__admin` reset, snapshots, clock control, fault injection, request journals, collection introspection, an admin UI, and per-namespace isolation.",
  },
] as const

/** The site and generated README share an executable Data → API → Client checkout. */
export const QUICK_START = {
  package: "@crvouga/mockingbird-service-stripe",
  ...CHECKOUT,
}

export const CONTRACT = {
  intro:
    "Every HTTP service ships an in-process `fetch`, a Node server and a CLI, and all answer the same control surface, so a stack learns it once. Every internal path is under `/__admin` by default. Set `adminPrefix` or `serve --admin-prefix` (`MOCKINGBIRD_ADMIN_PREFIX`) to relocate the entire tree; `/health` and `/ns` aliases are removed.",
  serve: `npx mockingbird-junction serve --port 8787                # one service
npx mockingbird-junction serve --config mockingbird.json  # every service in the config`,
  rows: [
    [
      "`createRuntime()` · `createServer()` (`./server`) · `mockingbird-<service> serve`",
      "The emulator as one runtime-neutral `fetch`, or a listening server from Node or the CLI",
    ],
    ["`GET /__admin/health`", "Unauthenticated readiness probe, outside the vendor's auth gate"],
    [
      "`/__admin/*` (`x-mockingbird-admin-key` optional)",
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
      "`x-mockingbird-namespace`",
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
    "`mockingbird.json` names services by their package suffix. HTTP services, PostgreSQL and Redis share a supervisor with ephemeral ports, readiness discovery and namespace controls. Use `--ready-file` or `--ready-json` to discover endpoints; see [Fleets](docs/FLEETS.md). SQLite remains an in-process engine.",
}

export const AGENTS =
  "Every npm package ships an agent index at `node_modules/<package>/DISCOVERY.md`. It points to the local behavior guide, exact capability matrix, machine-readable contract or compatibility evidence, public types, parity oracle, runtime introspection, and issue-reporting contract. [`llms.txt`](llms.txt) indexes those files with the parity each service declares, and the docs site publishes the same source material as markdown and JSON. When an emulator diverges from the real API, lacks a feature you call, or the vendor you need is not in the catalog, file an issue: [the filing guide](https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md) gives the title format, templates and the behavior spec for feature and service requests."

/** Guides in `docs/`, in the order the README and the site list them. Others follow by name. */
export const GUIDE_ORDER = [
  "GETTING_STARTED",
  "WHY",
  "TESTING",
  "AUTHORING_A_SERVICE",
  "DEVELOPMENT",
  "DESIGN",
  "REPORTING_ISSUES",
  "RELEASING",
  "SECRETS",
]
