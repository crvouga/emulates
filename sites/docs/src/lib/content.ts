/**
 * The copy the repo README and the docs site both show. `scripts/readme.ts` renders it into
 * README.md (CI fails when README.md is stale); the site renders it on the landing page. Inline
 * markdown only: backticks, **bold** and [links](url).
 */

/** Identity art lives in the repo, under the docs site's public directory. */
const DOCS_PUBLIC = "sites/docs/public/"
const HOME = "https://github.com/crvouga/mockingbird"

export const MARK_REPO_PATH = `${DOCS_PUBLIC}identity/mockingbird.png`
export const PLATE_REPO_PATH = `${DOCS_PUBLIC}identity/mockingbird-field.webp`

function docsPublicHref(repoFile: string): string {
  if (!repoFile.startsWith(DOCS_PUBLIC)) {
    throw new Error(`identity art must live under ${DOCS_PUBLIC}`)
  }
  return `/${repoFile.slice(DOCS_PUBLIC.length)}`
}

/** Path the docs site serves for `MARK_REPO_PATH`. */
export const MARK_HREF = docsPublicHref(MARK_REPO_PATH)
/** Path the docs site serves for `PLATE_REPO_PATH`. */
export const PLATE_HREF = docsPublicHref(PLATE_REPO_PATH)

/** Shared identity for the site, GitHub and the READMEs published to npm. */
export const IDENTITY = {
  name: "Mockingbird",
  tagline: "Familiar calls. Faithful echoes.",
  note: "Like its namesake, Mockingbird learns a familiar call and answers in kind. Real API shapes, stateful behavior, right inside your tests.",
  /** The mark on `main`. The README image uses this address; `check:readme` requires the file in this repo. */
  mark: `${HOME.replace("https://github.com/", "https://raw.githubusercontent.com/")}/main/${MARK_REPO_PATH}`,
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
  lead: "Familiar calls.",
  accent: "Faithful echoes.",
}

export const PITCH =
  "Mockingbird is a catalog of stateful test doubles for third-party HTTP APIs and SQL databases. Each one speaks the vendor's real surface, keeps state, and runs in-process."

export const FEATURES = [
  {
    icon: "plug",
    title: "The vendor's real surface",
    body: "Each mock answers the provider's own paths, headers, status codes and error envelopes through `fetch(Request) → Response`. Point the official SDK at it.",
  },
  {
    icon: "layers",
    title: "State that behaves",
    body: "Records persist in an in-memory SQL engine. Created customers can be listed, orders move through their lifecycle, webhooks fire, and reset or snapshot takes one call.",
  },
  {
    icon: "shield",
    title: "Checked against the real thing",
    body: "Random walks generated from each vendored OpenAPI contract run against two mock instances in CI, and against the live sandbox when credentials exist.",
  },
  {
    icon: "zap",
    title: "No network, no waiting",
    body: "Everything runs in your test process. No sandbox keys, rate limits, shared test accounts or flaky round trips.",
  },
  {
    icon: "globe",
    title: "Runs anywhere JavaScript runs",
    body: "Every mock is isomorphic: the same package runs in Node, Bun, browsers, and Workers. The playgrounds on this site run that package in your browser tab.",
  },
  {
    icon: "terminal",
    title: "One contract for every service",
    body: "Every HTTP mock shares `/health`, `/__admin` reset, snapshots, clock control, fault injection, request journals, collection introspection, an admin UI, and per-namespace isolation.",
  },
] as const

/** Executed against the real package during the docs build: it must log a 2xx status first. */
export const QUICK_START = {
  package: "@crvouga/mockingbird-service-stripe",
  file: "stripe.test.ts",
  code: `import { createRuntime } from "@crvouga/mockingbird-service-stripe"

const stripe = createRuntime()

const res = await stripe.fetch(
  new Request("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test_mockingbird",
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
    headers: { authorization: "Bearer sk_test_mockingbird" },
  }),
)
console.log((await list.json()).data[0].id === customer.id) // true`,
}

export const CONTRACT = {
  intro:
    "Every HTTP service ships an in-process `fetch`, a Node server and a CLI, and all answer the same control surface, so a stack learns it once.",
  serve: `npx mockingbird-junction serve --port 8787                # one service
npx mockingbird-junction serve --config mockingbird.json  # every service in the config`,
  rows: [
    [
      "`createRuntime()` · `createServer()` (`./server`) · `mockingbird-<service> serve`",
      "The mock as one runtime-neutral `fetch`, or a listening server from Node or the CLI",
    ],
    ["`GET /health`", "Unauthenticated readiness probe, outside the vendor's auth gate"],
    [
      "`/__admin/*` (`x-mockingbird-admin-key` optional)",
      "Reset, snapshot and restore, clock control, fault injection, a request journal, metrics with unmatched-route counts, plus service-specific routes",
    ],
    [
      "`GET /__admin/state`",
      "The collections in the selected namespace: declared shape, live `Collection` fields, and stored rows. Create, replace, merge, and delete records through the same paths on every mock",
    ],
    [
      "`GET /__admin/ui`",
      "The shared admin UI. A mock can add panels or replace the document; the shell still reads the same state API. Its header fetches that service's logo, website, and docs from the docs site when the page opens",
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
    "stripe": { "port": 12111 }
  }
}`,
  configNote:
    "`mockingbird.json` names services by their package suffix and takes each one's `serve` flags; any installed service's CLI can serve all of them. The database engines are not HTTP APIs, so they are outside this contract.",
}

export const AGENTS =
  "Every service README doubles as its integration guide and ships inside the npm tarball (`node_modules/<package>/README.md`). [`llms.txt`](llms.txt) indexes them with the parity each service declares, and the docs site publishes the same content as markdown and JSON, rebuilt from the packages on every build. When a mock diverges from the real API, lacks a feature you call, or the vendor you need is not in the catalog, file an issue: [the filing guide](https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md) gives the title format, templates and the behavior spec for feature and service requests."

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
