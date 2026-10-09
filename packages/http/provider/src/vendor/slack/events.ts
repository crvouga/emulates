/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { randomUUID } from "../core/crypto.js";
import type { Context, Store } from "../core/index.js";
import { getSlackStore } from "./store.js";

export function buildSlackEventEnvelope(teamId: string, event: Record<string, unknown>, clockNow: () => number = Date.now) {
  return {
    type: "event_callback" as const,
    team_id: teamId,
    event_id: `Ev${randomUUID().replaceAll("-", "")}`,
    event_time: Math.floor(clockNow() / 1000),
    event,
  };
}

export function resolveSlackEventTeamId(c: Context, store: Store, fallbackTeamId?: string): string {
  const slackStore = getSlackStore(store);
  const token = c.get("authToken");
  const tokenTeamId = token ? slackStore.tokens.findOneBy("token", token)?.team_id : undefined;
  return tokenTeamId ?? fallbackTeamId ?? slackStore.teams.all()[0]?.team_id ?? "T000000001";
}
