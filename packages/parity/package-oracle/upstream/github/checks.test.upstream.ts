/*! Adapted from vercel-labs/emulate (Apache-2.0), modified to exercise Mockingbird native services. See LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "../core.js";
import { Store } from "../core.js";
import { WebhookDispatcher } from "../core.js";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "../core.js";
import { githubPlugin, seedFromConfig } from "../../../../http/provider/src/vendor/github/index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
  });

  return app;
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), "Content-Type": "application/json" };
}

describe("GitHub checks routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it("lists check runs and suites for refs containing slashes", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;

    const nestedRef = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/heads/feature/nested", sha: head.sha }),
    });
    expect(nestedRef.status).toBe(201);

    const created = await app.request(`${base}/repos/octocat/hello-world/check-runs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "CI", head_sha: head.sha, status: "completed", conclusion: "success" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: number; head_sha: string };

    const runsByNestedRef = await app.request(`${base}/repos/octocat/hello-world/commits/feature/nested/check-runs`, {
      headers: authHeaders(),
    });
    expect(runsByNestedRef.status).toBe(200);
    expect(await runsByNestedRef.json()).toEqual(
      expect.objectContaining({
        total_count: 1,
        check_runs: [expect.objectContaining({ id: createdBody.id, head_sha: head.sha })],
      }),
    );

    const suitesByNestedRef = await app.request(
      `${base}/repos/octocat/hello-world/commits/feature/nested/check-suites`,
      { headers: authHeaders() },
    );
    expect(suitesByNestedRef.status).toBe(200);
    expect(await suitesByNestedRef.json()).toEqual(
      expect.objectContaining({
        total_count: 1,
        check_suites: [expect.objectContaining({ head_sha: head.sha })],
      }),
    );

    const runsBySha = await app.request(`${base}/repos/octocat/hello-world/commits/${head.sha}/check-runs`, {
      headers: authHeaders(),
    });
    expect(runsBySha.status).toBe(200);
    expect(((await runsBySha.json()) as { check_runs: Array<{ id: number }> }).check_runs[0].id).toBe(createdBody.id);
  });

  it("preserves check run filters and returns not found for unknown refs", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;

    for (const body of [
      { name: "CI", head_sha: head.sha, status: "completed", conclusion: "success" },
      { name: "Lint", head_sha: head.sha, status: "in_progress" },
      { name: "CI", head_sha: head.sha, status: "queued" },
    ]) {
      const created = await app.request(`${base}/repos/octocat/hello-world/check-runs`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      expect(created.status).toBe(201);
    }

    const filtered = await app.request(
      `${base}/repos/octocat/hello-world/commits/main/check-runs?check_name=CI&status=completed`,
      { headers: authHeaders() },
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toEqual(
      expect.objectContaining({
        total_count: 1,
        check_runs: [expect.objectContaining({ name: "CI", status: "completed" })],
      }),
    );

    const allRuns = await app.request(
      `${base}/repos/octocat/hello-world/commits/main/check-runs?check_name=CI&filter=all`,
      { headers: authHeaders() },
    );
    expect(allRuns.status).toBe(200);
    expect(await allRuns.json()).toEqual(
      expect.objectContaining({
        total_count: 2,
        check_runs: [
          expect.objectContaining({ name: "CI", status: "queued" }),
          expect.objectContaining({ name: "CI", status: "completed" }),
        ],
      }),
    );

    const missingRuns = await app.request(`${base}/repos/octocat/hello-world/commits/missing/ref/check-runs`, {
      headers: authHeaders(),
    });
    expect(missingRuns.status).toBe(404);

    const missingSuites = await app.request(`${base}/repos/octocat/hello-world/commits/missing/ref/check-suites`, {
      headers: authHeaders(),
    });
    expect(missingSuites.status).toBe(404);
  });
});
