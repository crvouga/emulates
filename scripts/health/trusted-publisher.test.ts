import { describe, expect, test } from "bun:test"
import { renderHealth } from "./report.ts"
import {
  accessUrl,
  accountPackageNames,
  collapseTrustAuth,
  collectTrustResponses,
  isProjectPackageName,
  packumentRepository,
  publisherGap,
  readRegistryToken,
  registryPackagePath,
  repositoryMatchesProject,
  selectProjectPackages,
  type TrustConfig,
  trustedPublisherReport,
} from "./trusted-publisher.ts"
import type { WebChallenge } from "./web-auth.ts"

const github = (overrides: TrustConfig = {}): TrustConfig => ({
  type: "github",
  permissions: ["createPackage"],
  claims: { repository: "crvouga/emulators", workflow_ref: { file: "ci.yml" } },
  ...overrides,
})

describe("publisherGap", () => {
  test("a publisher for this repo and workflow that can npm publish is healthy", () => {
    expect(publisherGap(true, [github()])).toBeNull()
  })

  test("a publisher from before explicit permissions still counts as able to publish", () => {
    expect(
      publisherGap(true, [
        {
          type: "github",
          claims: { repository: "crvouga/emulators", workflow_ref: { file: "ci.yml" } },
        },
      ]),
    ).toBeNull()
  })

  test("a workflow_ref string is read the same way as the object form", () => {
    expect(
      publisherGap(true, [
        github({
          claims: {
            repository: "crvouga/emulators",
            workflow_ref: "crvouga/emulators/.github/workflows/ci.yml@refs/heads/main",
          },
        }),
      ]),
    ).toBeNull()
  })

  test("another publisher does not cover a package that lacks this repo's workflow", () => {
    expect(publisherGap(true, [])).toBe("missing")
    expect(
      publisherGap(true, [
        github({ claims: { repository: "other/repo", workflow_ref: { file: "ci.yml" } } }),
      ]),
    ).toBe("missing")
    expect(
      publisherGap(true, [
        github({
          claims: { repository: "crvouga/emulators", workflow_ref: { file: "release.yml" } },
        }),
      ]),
    ).toBe("missing")
  })

  test("stage-only permission still needs npm publish turned on", () => {
    expect(publisherGap(true, [github({ permissions: ["createStagedPackage"] })])).toBe(
      "stage-only",
    )
    expect(publisherGap(true, [github({ permissions: [] })])).toBe("stage-only")
  })

  test("an environment-scoped publisher does not match the Release workflow", () => {
    expect(
      publisherGap(true, [
        github({
          claims: {
            repository: "crvouga/emulators",
            workflow_ref: { file: "ci.yml" },
            environment: "release",
          },
        }),
      ]),
    ).toBe("environment")
    expect(publisherGap(true, [github({ environment: "release" })])).toBe("environment")
  })

  test("one unrestricted publisher is enough when another is limited", () => {
    expect(
      publisherGap(true, [github({ permissions: ["createStagedPackage"] }), github()]),
    ).toBeNull()
  })

  test("a package that is not on npm has no access page yet", () => {
    expect(publisherGap(false, [github()])).toBe("not-published")
  })
})

describe("trustedPublisherReport", () => {
  test("groups the pages that need a click and leaves healthy packages out", () => {
    const report = trustedPublisherReport([
      { name: "@emulators/ok", published: true, configs: [github()] },
      { name: "@emulators/fullscript", published: true, configs: [] },
      {
        name: "@emulators/stripe",
        published: true,
        configs: [github({ permissions: ["createStagedPackage"] })],
      },
      { name: "@emulators/paddle", published: false },
      { name: "@emulators/aha", error: "trust lookup HTTP 500" },
    ])

    expect(renderHealth([report])).toBe(
      [
        "health",
        "",
        "trusted publisher — 4 to fix",
        "",
        "No GitHub Actions publisher for crvouga/emulators ci.yml. On the access page add one and allow npm publish. Organization crvouga, repository emulators, workflow filename ci.yml, environment empty.",
        accessUrl("@emulators/fullscript"),
        "",
        "GitHub Actions publisher does not allow npm publish (stage only). On the access page, allow npm publish.",
        accessUrl("@emulators/stripe"),
        "",
        "Not on npm yet, so there is no access page until the interactive first publish (bun run release:seed).",
        "@emulators/paddle",
        "",
        "npm did not return the trusted publisher for these packages.",
        "@emulators/aha — trust lookup HTTP 500",
        "",
      ].join("\n"),
    )
  })

  test("an empty report says the check is ok", () => {
    const report = trustedPublisherReport([
      { name: "@emulators/ok", published: true, configs: [github()] },
    ])
    expect(renderHealth([report])).toBe("health\n\ntrusted publisher — ok\n")
  })
})

describe("collapseTrustAuth", () => {
  test("a token the trust API refuses is one login error, not a line per package", () => {
    const collapsed = collapseTrustAuth([
      { name: "a", error: "unauthorized" },
      { name: "b", error: "unauthorized" },
    ])
    expect(Array.isArray(collapsed)).toBe(false)
    if (Array.isArray(collapsed)) return
    expect(collapsed.error).toContain("npm login")
  })

  test("a forbidden package stays in the list when another package was readable", () => {
    const results = [
      { name: "a", published: true, configs: [] },
      { name: "b", error: "forbidden" },
    ]
    expect(collapseTrustAuth(results)).toEqual(results)
  })
})

describe("collectTrustResponses", () => {
  const challenge: WebChallenge = {
    authUrl: "https://www.npmjs.com/login/00000000-0000-0000-0000-000000000000",
    doneUrl: "https://registry.npmjs.org/-/v1/done?authId=00000000-0000-0000-0000-000000000000",
  }
  const configs = [{ type: "github" }]

  test("approves the security key once, then reads every package with that session", async () => {
    const approvals: boolean[] = []
    const calls: Array<{ name: string; otp?: string }> = []
    const done = await collectTrustResponses(
      ["a", "b"],
      async (name, otp) => {
        calls.push({ name, ...(otp ? { otp } : {}) })
        if (name === "a" && !otp) return { status: 401, body: challenge }
        return { status: 200, body: configs }
      },
      async (_challenge, again) => {
        approvals.push(again)
        return "otp-code"
      },
    )
    expect(approvals).toEqual([false])
    expect(calls.filter((call) => call.otp)).toEqual([{ name: "a", otp: "otp-code" }])
    expect(done.get("a")?.status).toBe(200)
    expect(done.get("b")?.status).toBe(200)
  })

  test("asks a second time when later packages still need the security key", async () => {
    let approved = 0
    const done = await collectTrustResponses(
      ["a", "b"],
      async (name, otp) => {
        if (name === "a" && !otp) return { status: 401, body: challenge }
        if (name === "b" && approved < 2) return { status: 401, body: challenge }
        return { status: 200, body: configs }
      },
      async () => {
        approved += 1
        return "otp-code"
      },
    )
    expect(approved).toBe(2)
    expect(done.get("b")?.status).toBe(200)
  })
})

describe("readRegistryToken", () => {
  test("reads the registry token and lets a later assignment win", () => {
    expect(
      readRegistryToken(`
        ; comment
        //registry.npmjs.org/:_authToken=first
        # ignored
        //registry.npmjs.org/:_authToken="second"
      `),
    ).toBe("second")
  })

  test("returns nothing when the key is absent", () => {
    expect(readRegistryToken("ignore-scripts=true\n")).toBeUndefined()
  })
})

describe("registryPackagePath", () => {
  test("escapes the scope slash the way npm's trust endpoint expects", () => {
    expect(registryPackagePath("@emulators/stripe")).toBe("@emulators%2fstripe")
  })
})

describe("repositoryMatchesProject", () => {
  test("accepts this repo's git, https, ssh, and github shorthand forms", () => {
    expect(repositoryMatchesProject({ url: "git+https://github.com/crvouga/emulators.git" })).toBe(
      true,
    )
    expect(repositoryMatchesProject("https://github.com/crvouga/emulators")).toBe(true)
    expect(repositoryMatchesProject("git@github.com:crvouga/emulators.git")).toBe(true)
    expect(repositoryMatchesProject("git+ssh://git@github.com/crvouga/emulators.git")).toBe(true)
    expect(repositoryMatchesProject("github:crvouga/emulators")).toBe(true)
    expect(
      repositoryMatchesProject("git+https://github.com/crvouga/emulators.git/packages/core"),
    ).toBe(true)
  })

  test("rejects another repo, including one that only shares a name prefix", () => {
    expect(
      repositoryMatchesProject({ url: "git+https://github.com/crvouga/postgres-mem.git" }),
    ).toBe(false)
    expect(repositoryMatchesProject("git+https://github.com/crvouga/emulators-extra.git")).toBe(
      false,
    )
    expect(repositoryMatchesProject("https://github.com/other/emulators")).toBe(false)
    expect(repositoryMatchesProject(undefined)).toBe(false)
    expect(repositoryMatchesProject({})).toBe(false)
  })
})

describe("selectProjectPackages", () => {
  const emulators = { url: "git+https://github.com/crvouga/emulators.git" }

  test("keeps this repo's packages and public workspace packages, and leaves other npm projects out", () => {
    expect(
      selectProjectPackages({
        account: [
          { name: "@emulators/core", status: 200, repository: emulators },
          {
            name: "@crvouga/postgres-mem",
            status: 200,
            repository: { url: "git+https://github.com/crvouga/postgres-mem.git" },
          },
          { name: "@crvouga/result", status: 404 },
          {
            name: "headless-combobox",
            status: 200,
            repository: "git+https://github.com/someone/headless-combobox.git",
          },
          { name: "@emulators/stripe", status: 500 },
          {
            name: "@emulators/moved",
            status: 200,
            repository: "git+https://github.com/crvouga/somewhere-else.git",
          },
        ],
        workspacePublic: ["@emulators/paddle", "@emulators/core"],
      }),
    ).toEqual(["@emulators/core", "@emulators/paddle", "@emulators/stripe"])
  })

  test("a public workspace package is included when the account has not published it", () => {
    expect(
      selectProjectPackages({
        account: [],
        workspacePublic: ["@emulators/paddle"],
      }),
    ).toEqual(["@emulators/paddle"])
  })
})

describe("account package list", () => {
  test("reads package names from the account map", () => {
    expect(accountPackageNames({ "@emulators/core": "write" })).toEqual(["@emulators/core"])
    expect(accountPackageNames([])).toBeUndefined()
    expect(accountPackageNames(null)).toBeUndefined()
  })

  test("reads repository from the packument, then from the latest version", () => {
    const repository = { url: "git+https://github.com/crvouga/emulators.git" }
    expect(packumentRepository({ repository })).toEqual(repository)
    expect(
      packumentRepository({
        "dist-tags": { latest: "1.2.3" },
        versions: { "1.2.3": { repository } },
      }),
    ).toEqual(repository)
    expect(packumentRepository({})).toBeUndefined()
  })

  test("project package names are this repo's scope and name", () => {
    expect(isProjectPackageName("@emulators/stripe")).toBe(true)
    expect(isProjectPackageName("@crvouga/mockingbird-service-stripe")).toBe(true)
    expect(isProjectPackageName("@crvouga/postgres-mem")).toBe(false)
    expect(isProjectPackageName("headless-combobox")).toBe(false)
  })
})
