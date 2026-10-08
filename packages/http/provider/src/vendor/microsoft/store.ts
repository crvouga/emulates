/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { Store, type Collection } from "../core/index.js";
import type { MicrosoftUser, MicrosoftOAuthClient } from "./entities.js";

export interface MicrosoftStore {
  users: Collection<MicrosoftUser>;
  oauthClients: Collection<MicrosoftOAuthClient>;
}

export function getMicrosoftStore(store: Store): MicrosoftStore {
  return {
    users: store.collection<MicrosoftUser>("microsoft.users", ["oid", "email"]),
    oauthClients: store.collection<MicrosoftOAuthClient>("microsoft.oauth_clients", ["client_id"]),
  };
}
