import { describe, expect, test } from "bun:test"
import {
  adminClientSource,
  bootAdmin,
  faultPresetList,
  highlightJsonText,
  isRecord,
  mountAdminBrand,
  mountSqlExplorer,
  startAdminBrand,
} from "./src/admin-client.js"
import { ADMIN_BRANDS_URL, renderAdminDocument } from "./src/admin-ui.js"
import {
  ADMIN_KEY_HEADER,
  Collection,
  createRuntime,
  NAMESPACE_HEADER,
  STANDARD_ADMIN_ROUTES,
} from "./src/index.js"

const call = (
  runtime: { fetch(request: Request): Promise<Response> },
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
) =>
  runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  )

const notes = () =>
  createRuntime({
    name: "notes",
    state: [
      {
        name: "events",
        label: "Events",
        description: "Audit rows",
        meta: { vendor: "notes" },
        fields: [{ name: "kind", kind: "string", optional: false }],
      },
    ],
    create: (context) => {
      const records = new Collection<{ text: string }>(context.sqlite, context.namespace, "notes")
      return {
        records,
        fetch: async () => new Response("ok"),
        reset: async () => {
          records.list().forEach((row) => {
            records.delete(row.id)
          })
        },
      }
    },
  })

describe("state", () => {
  test("declarations and live collections are one view", () => {
    const runtime = notes()
    const view = runtime.state()
    expect(view.namespace).toBe("default")
    expect(view.storageNamespace).toBe("notes")
    expect(view.collections.map((collection) => collection.name)).toEqual(["events", "notes"])
    const events = view.collections[0]
    expect(events).toMatchObject({
      source: "declared",
      count: 0,
      label: "Events",
      description: "Audit rows",
      meta: { vendor: "notes" },
    })
    expect(events?.fields[0]).toMatchObject({ name: "kind", kind: "string" })
    expect(view.collections[1]).toMatchObject({ source: "inferred", count: 0, label: "Notes" })
  })

  test("creates, reads, merges, replaces, and deletes a record", async () => {
    const runtime = notes()
    const before = runtime.timeline().head()?.id
    const created = await call(runtime, "POST", "/__admin/state/notes", {
      body: { id: "n1", value: { text: "hello", extra: 1 } },
    })
    expect(created.status).toBe(201)
    const record = (await created.json()) as { id: string; seq: number; value: { text: string } }
    expect(record).toMatchObject({ id: "n1", value: { text: "hello", extra: 1 } })
    expect(runtime.timeline().head()?.id).not.toBe(before)

    const duplicate = await call(runtime, "POST", "/__admin/state/notes", {
      body: { id: "n1", value: { text: "again" } },
    })
    expect(duplicate.status).toBe(409)

    const patched = await call(runtime, "PATCH", "/__admin/state/notes/n1", {
      body: { value: { text: "edited" } },
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ value: { text: "edited", extra: 1 } })

    const replaced = await call(runtime, "PUT", "/__admin/state/notes/n1", {
      body: { value: { text: "replaced" } },
    })
    expect(await replaced.json()).toMatchObject({ value: { text: "replaced" } })

    const page = await call(runtime, "GET", "/__admin/state/notes")
    const listed = (await page.json()) as { records: { id: string }[]; count: number }
    expect(listed.count).toBe(1)
    expect(listed.records.map((row) => row.id)).toEqual(["n1"])

    const mixed = runtime.state().collections.find((collection) => collection.name === "notes")
    expect(mixed?.source).toBe("inferred")
    expect(mixed?.fields.some((field) => field.name === "text" && field.kind === "string")).toBe(
      true,
    )

    const removed = await call(runtime, "DELETE", "/__admin/state/notes/n1")
    expect(removed.status).toBe(200)
    expect((await call(runtime, "GET", "/__admin/state/notes/n1")).status).toBe(404)
  })

  test("a write in one namespace stays there", async () => {
    const runtime = notes()
    const headers = { [NAMESPACE_HEADER]: "alpha" }
    expect(
      (
        await call(runtime, "POST", "/__admin/state/notes", {
          headers,
          body: { id: "n1", value: { text: "alpha" } },
        })
      ).status,
    ).toBe(201)
    const other = await call(runtime, "GET", "/__admin/state/notes", {
      headers: { [NAMESPACE_HEADER]: "beta" },
    })
    expect(((await other.json()) as { count: number }).count).toBe(0)
    const home = await call(runtime, "GET", "/__admin/state/notes", { headers })
    expect(((await home.json()) as { count: number }).count).toBe(1)
    expect(runtime.state("alpha").collections.find((c) => c.name === "notes")?.count).toBe(1)
  })

  test("rejects a collection name or a body the admin API cannot store", async () => {
    const runtime = notes()
    expect((await call(runtime, "GET", "/__admin/state/bad name")).status).toBe(400)
    expect(
      (await call(runtime, "POST", "/__admin/state/notes", { body: { value: undefined } })).status,
    ).toBe(400)
  })

  test("a service route cannot replace the shared state handler", async () => {
    const runtime = createRuntime({
      name: "notes",
      create: () => ({
        fetch: async () => new Response("ok"),
        reset: async () => {},
      }),
      admin: () => ({
        "GET /state": () => new Response("replaced", { status: 200 }),
        "GET /vendor": () => Response.json({ ok: true }),
      }),
    })
    const state = await call(runtime, "GET", "/__admin/state")
    expect(state.headers.get("content-type")).toContain("application/json")
    expect(await state.json()).toMatchObject({ collections: [] })
    expect(await (await call(runtime, "GET", "/__admin/vendor")).json()).toEqual({ ok: true })
    const listed = ((await (await call(runtime, "GET", "/__admin")).json()) as { routes: string[] })
      .routes
    for (const route of STANDARD_ADMIN_ROUTES) expect(listed).toContain(route)
    expect(listed).toContain("GET /vendor")
  })
})

describe("admin ui", () => {
  test("health links the shell, and the shell does not need the admin key", async () => {
    const runtime = createRuntime({
      name: "notes",
      adminKey: "secret",
      create: () => ({
        fetch: async () => new Response("ok"),
        reset: async () => {},
      }),
      adminUi: {
        panels: [
          {
            id: "extra",
            title: "Extra",
            description: "A bespoke view",
            html: "<p>panel</p>",
            script: "root.dataset.mounted = 'yes'",
          },
        ],
      },
    })
    const health = (await (await call(runtime, "GET", "/__admin/health")).json()) as {
      adminUi: string
    }
    expect(health.adminUi).toBe("/__admin/ui")

    const shell = await call(runtime, "GET", "/__admin/ui")
    expect(shell.status).toBe(200)
    expect(shell.headers.get("content-type")).toContain("text/html")
    const html = await shell.text()
    expect(html).toContain("notes admin")
    expect(html).toContain('name="viewport"')
    expect(html).toContain("prefers-color-scheme")
    expect(html).toContain("data-mockingbird-admin")
    expect(html).toContain(ADMIN_BRANDS_URL)
    expect(html).toContain('id="vendor"')
    expect(html).not.toContain("https://stripe.com")
    expect((await call(runtime, "GET", "/__admin/ui/")).status).toBe(200)

    const locked = await call(runtime, "GET", "/__admin/state")
    expect(locked.status).toBe(401)
    const manifestLocked = await call(runtime, "GET", "/__admin/ui/manifest")
    expect(manifestLocked.status).toBe(401)

    const headers = { [ADMIN_KEY_HEADER]: "secret" }
    const manifest = await call(runtime, "GET", "/__admin/ui/manifest", { headers })
    expect(manifest.status).toBe(200)
    expect(await manifest.json()).toMatchObject({
      service: "notes",
      panels: [{ id: "extra", title: "Extra", html: "<p>panel</p>" }],
    })
    expect((await call(runtime, "GET", "/__admin/state", { headers })).status).toBe(200)
  })

  test("render can wrap the shared document", async () => {
    const runtime = createRuntime({
      name: "notes",
      create: () => ({
        fetch: async () => new Response("ok"),
        reset: async () => {},
      }),
      adminUi: {
        render: ({ service, defaultHtml }) =>
          `<!-- ${service} -->${defaultHtml()}<!-- end ${service} -->`,
      },
    })
    const html = await (await call(runtime, "GET", "/__admin/ui")).text()
    expect(html.startsWith("<!-- notes -->")).toBe(true)
    expect(html).toContain("<!DOCTYPE html>")
    expect(html.endsWith("<!-- end notes -->")).toBe(true)
  })

  test("the embedded script calls its boot function by the name that function declares", () => {
    const html = renderAdminDocument("stripe")
    const script = html.slice(
      html.lastIndexOf("<script>\n") + "<script>\n".length,
      html.lastIndexOf("\n</script>"),
    )
    const declared = [...script.matchAll(/^function (\w+)\(/gm)].map((match) => match[1])
    const call = script.trim().split("\n").at(-1) ?? ""
    const callee = /^(\w+)\(/.exec(call)?.[1]
    expect(callee).toBe(bootAdmin.name)
    expect(declared.at(-1)).toBe(callee)
    // A later copy of this module is renamed by the bundler. The call has to read
    // the name at runtime; a literal `bootAdmin(` throws and the section buttons stay dead.
    expect(adminClientSource.toString()).toContain("bootAdmin.name")
    expect(bootAdmin.toString()).toContain(`${mountSqlExplorer.name}(`)
    expect(html).toContain(`function ${mountSqlExplorer.name}(`)
  })

  test("JSON is syntax highlighted without allowing markup through", () => {
    const highlighted = highlightJsonText(
      '{"name":"<script>alert(1)</script>","count":42,"ready":true,"empty":null}',
    )
    expect(highlighted).toContain('class="json-key"')
    expect(highlighted).toContain('class="json-string"')
    expect(highlighted).toContain('class="json-number"')
    expect(highlighted).toContain('class="json-boolean"')
    expect(highlighted).toContain('class="json-null"')
    expect(highlighted).toContain("&lt;script&gt;")
    expect(highlighted).not.toContain("<script>")

    const html = renderAdminDocument("notes")
    expect(html).toContain('class="json-editor"')
    expect(html).toContain("highlightJsonText")
    expect(html).toContain('aria-live="polite"')
  })

  test("clearing an empty journal tells you the click finished", () => {
    const html = renderAdminDocument("notes")
    expect(html).toContain("Clearing...")
    expect(html).toContain("Cleared")
    expect(html).toContain('classList.add("pressed")')
  })

  test("the header chip is painted from a remote record, never from the bundle", async () => {
    const html = renderAdminDocument("stripe")
    expect(html).toContain(mountAdminBrand.toString())
    expect(html).toContain(startAdminBrand.toString())
    expect(html).not.toContain("https://stripe.com")
    expect(html).not.toContain("https://docs.stripe.com")

    type Node = {
      tag: string
      hidden: boolean
      children: Node[]
      className: string
      textContent: string
      href: string
      src: string
      title: string
      style: { borderColor: string }
      append: (...nodes: Node[]) => void
      replaceChildren: () => void
      setAttribute: (name: string, value: string) => void
      removeAttribute: (name: string) => void
    }
    const createElement = (tag: string): Node => {
      const node: Node = {
        tag,
        hidden: false,
        children: [],
        className: "",
        textContent: "",
        href: "",
        src: "",
        title: "",
        style: { borderColor: "" },
        append(...nodes) {
          this.children.push(...nodes)
        },
        replaceChildren() {
          this.children = []
        },
        setAttribute() {},
        removeAttribute() {},
      }
      return node
    }
    const paint = async (
      catalog: unknown,
      search = "",
      page = "http://127.0.0.1:8787/__admin/ui",
    ) => {
      const host = createElement("div")
      host.hidden = true
      let requested = ""
      const document = {
        createElement,
        querySelector: () => ({ getAttribute: () => "stripe" }),
      }
      const location = { href: page, origin: new URL(page).origin }
      const fetch = (url: string) => {
        requested = url
        return Promise.resolve({
          ok: catalog !== "fail",
          json: async () => catalog,
        })
      }
      const run = new Function(
        "$",
        "params",
        "location",
        "fetch",
        "document",
        "brandsUrl",
        `${isRecord.toString()}\n${mountAdminBrand.toString()}\n${startAdminBrand.toString()}\nstartAdminBrand({ document, $, params, location, fetch, brandsUrl })`,
      )
      run(
        (id: string) => (id === "vendor" ? host : null),
        new URLSearchParams(search),
        location,
        fetch,
        document,
        ADMIN_BRANDS_URL,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      return { host, requested }
    }
    const stripe = {
      stripe: {
        vendor: "Stripe",
        website: "https://stripe.com",
        docs: "https://docs.stripe.com/api",
        guide: "https://mockingbird.chrisvouga.dev/services/stripe",
        logo: "https://mockingbird.chrisvouga.dev/brands/stripe.svg",
        color: "#635bff",
        description: "Payments.",
      },
    }

    const shown = await paint(stripe)
    expect(shown.requested).toBe(ADMIN_BRANDS_URL)
    expect(shown.host.hidden).toBe(false)
    const text = shown.host.children.map((node) => node.textContent)
    expect(text).toEqual(["", "Stripe", "·", "stripe.com", "·", "Docs", "·", "API"])
    const links = shown.host.children.filter((node) => node.tag === "a")
    expect(links.map((node) => node.href)).toEqual([
      "https://stripe.com/",
      "https://mockingbird.chrisvouga.dev/services/stripe",
      "https://docs.stripe.com/api",
    ])
    expect(shown.host.children[0]?.src).toBe("https://mockingbird.chrisvouga.dev/brands/stripe.svg")
    expect(shown.host.children[0]?.style.borderColor).toBe("#635bff")
    expect(shown.host.children[1]?.title).toBe("Payments.")

    const local = await paint(stripe, "brands=http://127.0.0.1:4321/brands.json")
    expect(local.requested).toBe("http://127.0.0.1:4321/brands.json")
    const remote = await paint(stripe, "brands=https://evil.example/brands.json")
    expect(remote.requested).toBe(ADMIN_BRANDS_URL)

    const hostile = await paint({
      stripe: {
        vendor: "<img src=x onerror=alert(1)>",
        website: "javascript:alert(1)",
        docs: "data:text/html,hi",
        guide: "https://mockingbird.chrisvouga.dev/services/stripe",
        logo: "javascript:alert(1)",
      },
    })
    expect(hostile.host.hidden).toBe(false)
    expect(hostile.host.children.some((node) => node.tag === "img")).toBe(false)
    expect(hostile.host.children.map((node) => node.href).filter(Boolean)).toEqual([
      "https://mockingbird.chrisvouga.dev/services/stripe",
    ])
    expect(hostile.host.children.some((node) => node.textContent.includes("<img"))).toBe(true)

    const missing = await paint({})
    expect(missing.host.hidden).toBe(true)
    const offline = await paint("fail")
    expect(offline.host.hidden).toBe(true)
  })

  test("fault presets are a list, so the faults page can map them", () => {
    const html = renderAdminDocument("junction")
    expect(html).toContain(faultPresetList.toString())
    expect(html).toContain("faultPresetList(presets).presets")
    expect(
      faultPresetList({ presets: [{ name: "sandbox_user_quota" }, { name: "rate_limited" }] }),
    ).toEqual({
      presets: [{ name: "sandbox_user_quota" }, { name: "rate_limited" }],
    })
    expect(faultPresetList({})).toEqual({ presets: [] })
    expect(() => faultPresetList({ presets: { rate_limited: { status: 429 } } })).toThrow(
      /not a list/,
    )
  })

  test("an extension is listed on the manifest and a reserved id is rejected", async () => {
    const runtime = createRuntime({
      name: "notes",
      create: () => ({
        fetch: async () => new Response("ok"),
        reset: async () => {},
      }),
      adminUi: {
        extensions: [{ kind: "sql", description: "Browse tables and run queries." }],
      },
    })
    const manifest = (await (await call(runtime, "GET", "/__admin/ui/manifest")).json()) as {
      extensions: { kind: string; id: string; title: string; description?: string }[]
    }
    expect(manifest.extensions).toEqual([
      {
        kind: "sql",
        id: "sql",
        title: "SQL",
        description: "Browse tables and run queries.",
      },
    ])
    expect(() =>
      createRuntime({
        name: "notes",
        create: () => ({
          fetch: async () => new Response("ok"),
          reset: async () => {},
        }),
        adminUi: { extensions: [{ kind: "sql", id: "state" }] },
      }),
    ).toThrow(/reserved/)
  })

  test("a panel id the shell cannot mount is rejected up front", () => {
    expect(() =>
      createRuntime({
        name: "notes",
        create: () => ({
          fetch: async () => new Response("ok"),
          reset: async () => {},
        }),
        adminUi: { panels: [{ id: "Not Ok", title: "X", html: "" }] },
      }),
    ).toThrow(/admin panel id/)
  })
})
