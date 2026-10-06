# @emulates/docs

The Emulates documentation site: a static [Astro](https://astro.build) build with nothing
hand-maintained. Everything a page shows comes from the service packages at build time.

```bash
bun docs            # build the services (turbo, cached), then start the dev server
bun run docs:build  # static build into sites/docs/dist
bun run docs:preview
```

## Where each thing comes from

| On the site | Source |
| --- | --- |
| Name, category, parity, description, keywords | `packages/service/<name>/package.json` (`emulators.displayName`, `.category`, `.parity`) |
| Service page body | The package `README.md`, rendered with Shiki; its relative links point at GitHub, links between services stay on the site |
| Operations and coverage | The built module's `document`, `operationIds` and `supportedOperationIds` |
| Surfaces | The module's exports (`createRuntime`, `Database`), `exports["./server"]` and `bin` |
| Playground | The published module itself, bundled as a lazy chunk and run in the browser tab |
| Sample requests | Generated from the contract's schemas, then sent to a fresh emulator during the build; operations whose sample succeeds are marked |
| SQL console snippets | `src/lib/sql.ts`, executed against the real engine during the build |
| Brand page | `src/pages/identity.astro` shows the mark and the live tokens. The mark is `public/identity/emulators.svg`, rendered by `src/components/Mark.astro`. The rules are [`docs/DESIGN.md`](../../docs/DESIGN.md); the name and sentence come from `project.ts` through `IDENTITY` in `src/lib/content.ts` |

`integrations/catalog` does the reading (`load.ts`) and exposes it as two virtual modules:
`virtual:emulators/catalog` for pages and `virtual:emulators/runtimes` (one `import()` per
service). The build fails with a list of fixes when a package is missing a
category, a display name or its docs dependency, or when declared playground credentials stop
working. See [Docs in AUTHORING_A_SERVICE.md](../../docs/AUTHORING_A_SERVICE.md#docs).

## For agents

`/llms.txt`, `/llms-full.txt`, `/catalog.json` and `/services/<name>.md` (the raw README) are
generated alongside the pages.

## Client state

Shareable state lives in the URL: `/services?q=&category=&sort=`,
`/services/<name>?op=<operationId>`, `/coverage?sort=&dir=`. Preferences live in
`localStorage`: theme (`mb:theme`), package manager (`mb:pm`), grid or list view
(`mb:services:view`) and recently viewed services (`mb:recent`).
