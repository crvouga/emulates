/**
 * Repo-scoped, short-lived GitHub tokens minted from the CLI, for `bun github:resolve-issues`.
 *
 * GitHub has no API that creates a personal access token. A GitHub App's user access token is the
 * closest thing, and a CLI can mint one with the device flow from nothing but the app's public
 * client id. It reaches only what both the app and the user can reach: the app is installed on this
 * repository alone, with the short permission list in APP_PERMISSIONS (no workflows, administration,
 * secrets or variables). It expires after 8 hours, and commits and PRs made with it are the user's.
 *
 * One-time setup, by the repository owner: `bun github:resolve-issues setup`.
 *   1. It creates the app from a manifest (a browser round trip to a localhost page) and keeps
 *      only the app's public client id and slug, in APP_CONFIG_PATH. The app's private key and
 *      client secret are dropped unread, so nothing can ever act as the app itself.
 *   2. You enable the device flow in the app's settings and install the app on this repository only.
 *   3. `setup` again mints a token and checks all of that.
 *
 * Every token is checked before use (checkTokenReach), by the command and again in the job. It must
 * be a user access token (ghu_), for exactly one installation, on exactly this repository, with no
 * permission beyond APP_PERMISSIONS.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const APP_CONFIG_PATH = ".github/resolve-issues-app.json"

/** What the agents' token may do. Anything else an installation grants is refused. */
export const APP_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  metadata: "read",
  contents: "write", // push the agent's branch (main is protected by the ruleset)
  issues: "write", // claim, comment, relabel, close
  pull_requests: "write", // open and edit the PR
  actions: "write", // dispatch Parity (bun run parity:remote); read run logs for /pr-ready
  checks: "read", // /pr-ready waits on the PR's checks
  statuses: "read",
}

/** A user access token that outlives this is refused: the app must keep token expiration on. */
export const MAX_TOKEN_LIFETIME_S = 8 * 60 * 60

export interface AppConfig {
  clientId: string
  slug: string
}

export function loadAppConfig(root: string): AppConfig | undefined {
  const path = join(root, APP_CONFIG_PATH)
  if (!existsSync(path)) return undefined
  const config = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>
  if (typeof config.clientId !== "string" || typeof config.slug !== "string") {
    throw new Error(`${APP_CONFIG_PATH} must hold { "clientId", "slug" }`)
  }
  return { clientId: config.clientId, slug: config.slug }
}

/** The manifest `setup` registers the app from: no webhook, no events, APP_PERMISSIONS only. */
export function appManifest(repo: string, owner: string, redirectUrl: string) {
  const name = `${repo.split("/")[1]}-agents-${owner}`.slice(0, 34)
  return {
    name,
    url: `https://github.com/${repo}`,
    description: `Short-lived tokens that reach ${repo} only, for bun github:resolve-issues agents.`,
    public: false,
    redirect_url: redirectUrl,
    hook_attributes: { url: `https://github.com/${repo}`, active: false },
    default_permissions: APP_PERMISSIONS,
    default_events: [],
    request_oauth_on_install: false,
  }
}

// --- Reach -----------------------------------------------------------------------------------------

export interface Installation {
  id: number
  repository_selection: string
  permissions: Record<string, string>
}

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 }

/** Everything wrong with what a token reaches; empty when it is exactly `repo` with APP_PERMISSIONS. */
export function reachProblems(
  installations: Installation[],
  repositories: string[],
  repo: string,
): string[] {
  const problems: string[] = []
  if (installations.length !== 1) {
    problems.push(`it reaches ${installations.length} installations of the app, not exactly one`)
  }
  for (const installation of installations) {
    if (installation.repository_selection !== "selected") {
      problems.push(`the app is installed on all repositories, not only ${repo}`)
    }
    for (const [permission, level] of Object.entries(installation.permissions)) {
      const allowed = APP_PERMISSIONS[permission]
      if (!allowed || (LEVEL[level] ?? Number.POSITIVE_INFINITY) > (LEVEL[allowed] ?? 0)) {
        problems.push(
          `it has ${permission}: ${level}; the agents get ${allowed ?? "no such permission"}`,
        )
      }
    }
  }
  const reached = repositories.map((r) => r.toLowerCase())
  if (reached.length !== 1 || reached[0] !== repo.toLowerCase()) {
    problems.push(`it reaches ${repositories.join(", ") || "no repository"}, not ${repo} alone`)
  }
  return problems
}

const api = async (token: string, path: string) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`)
  return response.json()
}

/** What is wrong with `token` for the agents on `repo`; empty when it is safe to hand over. */
export async function checkTokenReach(token: string, repo: string): Promise<string[]> {
  if (!token.startsWith("ghu_")) {
    return ["it is not a GitHub App user access token (ghu_…), so its reach cannot be bounded"]
  }
  const { installations } = (await api(token, "/user/installations?per_page=100")) as {
    installations: Installation[]
  }
  const repositories: string[] = []
  for (const installation of installations) {
    const listed = (await api(
      token,
      `/user/installations/${installation.id}/repositories?per_page=100`,
    )) as { repositories: { full_name: string }[] }
    repositories.push(...listed.repositories.map((r) => r.full_name))
  }
  return reachProblems(installations, repositories, repo)
}

// --- Device flow -----------------------------------------------------------------------------------

const post = async (url: string, body: Record<string, string>) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  })
  return (await response.json()) as Record<string, unknown>
}

export interface MintedToken {
  token: string
  /** Seconds; undefined when the app's tokens do not expire. */
  expiresIn: number | undefined
}

/**
 * Mint a user access token with the device flow. `prompt` shows the user the code to enter. The
 * refresh token GitHub also returns is dropped: a job gets one token, and it expires.
 */
export async function deviceFlowToken(
  config: AppConfig,
  prompt: (userCode: string, verificationUri: string) => void,
): Promise<MintedToken> {
  const settings = `https://github.com/settings/apps/${config.slug}`
  const explain = (error: unknown) =>
    error === "device_flow_disabled"
      ? `the app's device flow is off: tick "Enable Device Flow" at ${settings}`
      : error === "access_denied"
        ? "you declined the authorization"
        : error === "Not Found"
          ? `GitHub does not know the client id in ${APP_CONFIG_PATH}; run bun github:resolve-issues setup --new`
          : error === "expired_token"
            ? "the code expired before it was entered; run the command again"
            : `GitHub refused the device flow (${String(error)})`

  const start = await post("https://github.com/login/device/code", { client_id: config.clientId })
  if (start.error) throw new Error(explain(start.error))
  prompt(String(start.user_code), String(start.verification_uri))

  let interval = Number(start.interval ?? 5)
  const deadline = Date.now() + Number(start.expires_in ?? 900) * 1000
  while (Date.now() < deadline) {
    await Bun.sleep(interval * 1000)
    const polled = await post("https://github.com/login/oauth/access_token", {
      client_id: config.clientId,
      device_code: String(start.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
    if (typeof polled.access_token === "string") {
      return {
        token: polled.access_token,
        expiresIn: typeof polled.expires_in === "number" ? polled.expires_in : undefined,
      }
    }
    if (polled.error === "authorization_pending") continue
    if (polled.error === "slow_down") {
      interval = Number(polled.interval ?? interval + 5)
      continue
    }
    throw new Error(explain(polled.error))
  }
  throw new Error(explain("expired_token"))
}

// --- App creation ----------------------------------------------------------------------------------

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Register the app from its manifest: serve a localhost page that posts the manifest to GitHub,
 * take the code GitHub redirects back with, and convert it. Only the public client id and slug are
 * kept; the private key, client secret and webhook secret in the response are never stored or shown.
 */
export async function createApp(
  repo: string,
  owner: string,
  openUrl: (url: string) => void,
): Promise<AppConfig> {
  const state = crypto.randomUUID()
  let resolveCode: (code: string) => void = () => {}
  const code = new Promise<string>((resolve) => {
    resolveCode = resolve
  })
  const server = Bun.serve({
    hostname: "localhost",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/") {
        const manifest = appManifest(repo, owner, `http://localhost:${server.port}/created`)
        const action = `https://github.com/settings/apps/new?state=${state}`
        return new Response(
          `<!doctype html><title>Create the agents' GitHub App</title>
<form id="f" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button>Create the GitHub App on GitHub</button></form>
<script>document.getElementById("f").submit()</script>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        )
      }
      if (url.pathname === "/created" && url.searchParams.get("state") === state) {
        const received = url.searchParams.get("code")
        if (received) resolveCode(received)
        return new Response("The app is created. Return to your terminal.")
      }
      return new Response("Not found", { status: 404 })
    },
  })
  try {
    const page = `http://localhost:${server.port}/`
    console.log(`Opening ${page} to create the app on GitHub (open it yourself if nothing opens).`)
    openUrl(page)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("the app was not created within 15 minutes")),
        15 * 60_000,
      )
    })
    const received = await Promise.race([code, timeout]).finally(() => clearTimeout(timer))
    const response = await fetch(`https://api.github.com/app-manifests/${received}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json" },
    })
    if (!response.ok) throw new Error(`converting the app manifest: HTTP ${response.status}`)
    const created = (await response.json()) as { client_id?: unknown; slug?: unknown }
    if (typeof created.client_id !== "string" || typeof created.slug !== "string") {
      throw new Error("GitHub's manifest conversion returned no client id")
    }
    return { clientId: created.client_id, slug: created.slug }
  } finally {
    server.stop(true)
  }
}
