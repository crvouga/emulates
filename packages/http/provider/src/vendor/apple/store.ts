/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { Store, type Collection } from "../core/index.js";
import type { AppleUser, AppleOAuthClient } from "./entities.js";

export interface AppleStore {
  users: Collection<AppleUser>;
  oauthClients: Collection<AppleOAuthClient>;
}

export function getAppleStore(store: Store): AppleStore {
  return {
    users: store.collection<AppleUser>("apple.users", ["uid", "email"]),
    oauthClients: store.collection<AppleOAuthClient>("apple.oauth_clients", ["client_id"]),
  };
}
