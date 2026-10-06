/**
 * Full-stack demo apps built entirely on Emulates, one process,
 * no real network. Hand-authored (unlike the per-service `emulates.examples`
 * snippets, which the catalog integration derives from each service's own
 * package.json at build time) because there is one of these per app, not
 * per service.
 */
export type AppExample = {
  slug: string
  title: string
  description: string
  /** Service catalog `name`s this app composes, linked to `/services/<name>`. */
  servicesUsed: string[]
  /** Repo-relative path to the app's package, for the "source" link. */
  packagePath: string
  runCommand: string
}

export const APP_EXAMPLES: readonly AppExample[] = [
  {
    slug: "medical-testing",
    title: "Lab ordering workspace",
    description:
      "A complete lab ordering app with patient, clinician, and administrator roles. Order tests, track fulfillment, explore biomarker reports, review results, download records, and manage access. The same full stack runs in your browser or on Bun.",
    servicesUsed: ["oauth", "junction", "stripe", "postgres"],
    packagePath: "packages/examples/medical-testing",
    runCommand: "bunx turbo run dev --filter=@emulates/example-medical-testing",
  },
]
