/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import type { Collection, Store } from "../core/index.js";
import type {
  ClerkUser,
  ClerkEmailAddress,
  ClerkOrganization,
  ClerkOrganizationMembership,
  ClerkOrganizationInvitation,
  ClerkSession,
  ClerkOAuthApplication,
} from "./entities.js";

export interface ClerkStore {
  users: Collection<ClerkUser>;
  emailAddresses: Collection<ClerkEmailAddress>;
  organizations: Collection<ClerkOrganization>;
  memberships: Collection<ClerkOrganizationMembership>;
  invitations: Collection<ClerkOrganizationInvitation>;
  sessions: Collection<ClerkSession>;
  oauthApps: Collection<ClerkOAuthApplication>;
}

export function getClerkStore(store: Store): ClerkStore {
  return {
    users: store.collection<ClerkUser>("clerk.users", ["clerk_id", "username"]),
    emailAddresses: store.collection<ClerkEmailAddress>("clerk.emails", ["email_id", "user_id", "email_address"]),
    organizations: store.collection<ClerkOrganization>("clerk.orgs", ["clerk_id", "slug"]),
    memberships: store.collection<ClerkOrganizationMembership>("clerk.memberships", [
      "membership_id",
      "org_id",
      "user_id",
    ]),
    invitations: store.collection<ClerkOrganizationInvitation>("clerk.invitations", ["invitation_id", "org_id"]),
    sessions: store.collection<ClerkSession>("clerk.sessions", ["clerk_id", "user_id"]),
    oauthApps: store.collection<ClerkOAuthApplication>("clerk.oauth_apps", ["app_id", "client_id"]),
  };
}
