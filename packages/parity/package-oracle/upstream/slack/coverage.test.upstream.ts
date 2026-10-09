/*! Adapted from vercel-labs/emulate (Apache-2.0), modified to exercise Mockingbird native services. See LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { describe, expect, it } from "vitest";
import { slackCoverageMatrix } from "./slack-coverage.upstream.js";
import { createSlackTestApp } from "./helpers.upstream.js";

interface RegisteredRoute {
  method: string;
  compiled: {
    pattern: string;
  };
}

function registeredSlackRoutes(): string[] {
  const { app } = createSlackTestApp();
  const routes = (app as unknown as { routes: RegisteredRoute[] }).routes;
  return routes.map((route) => `${route.method} ${route.compiled.pattern}`).sort();
}

function entryRoutes(entry: { route: string | string[] }): string[] {
  return Array.isArray(entry.route) ? entry.route : [entry.route];
}

describe("Slack coverage matrix", () => {
  it("has unique method entries", () => {
    const methods = slackCoverageMatrix.map((entry) => entry.method);
    expect(new Set(methods).size).toBe(methods.length);
  });

  it("maps every registered endpoint to at least one test file", () => {
    const currentEntries = slackCoverageMatrix.filter((entry) => entry.status !== "not_started");
    expect(currentEntries.length).toBeGreaterThan(0);
    expect(currentEntries.flatMap(entryRoutes).sort()).toEqual(registeredSlackRoutes());

    for (const entry of currentEntries) {
      for (const route of entryRoutes(entry)) {
        expect(route).toMatch(/^(GET|POST) /);
      }
      expect(entry.testedBy.length, entry.method).toBeGreaterThan(0);
    }
  });

  it("keeps planned gaps explicit", () => {
    const planned = slackCoverageMatrix.filter((entry) => entry.status === "not_started");
    expect(planned.map((entry) => entry.method)).toEqual(expect.arrayContaining(["views.interaction_simulation"]));
    for (const entry of planned) {
      expect(entry.notes).toMatch(/Planned|future/i);
    }
  });
});
