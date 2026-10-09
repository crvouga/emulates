/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { Store, type Collection } from "../core/index.js";
import type {
  ResendEmail,
  ResendDomain,
  ResendApiKey,
  ResendAudience,
  ResendContact,
  ResendIdempotencyRecord,
} from "./entities.js";

export interface ResendStore {
  emails: Collection<ResendEmail>;
  idempotencyKeys: Collection<ResendIdempotencyRecord>;
  domains: Collection<ResendDomain>;
  apiKeys: Collection<ResendApiKey>;
  audiences: Collection<ResendAudience>;
  contacts: Collection<ResendContact>;
}

export function getResendStore(store: Store): ResendStore {
  return {
    emails: store.collection<ResendEmail>("resend.emails", ["uuid"]),
    idempotencyKeys: store.collection<ResendIdempotencyRecord>("resend.idempotency_keys", ["idempotency_key"]),
    domains: store.collection<ResendDomain>("resend.domains", ["uuid", "name"]),
    apiKeys: store.collection<ResendApiKey>("resend.api_keys", ["uuid"]),
    audiences: store.collection<ResendAudience>("resend.audiences", ["uuid"]),
    contacts: store.collection<ResendContact>("resend.contacts", ["uuid", "audience_id"]),
  };
}
