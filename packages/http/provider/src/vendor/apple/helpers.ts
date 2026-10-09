/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { randomBytes } from "../core/crypto.js";

/**
 * Generate a pairwise subject ID in Apple's format: "XXXXXX.hex32.XXXX"
 */
export function generateAppleUid(): string {
  const prefix = randomBytes(3).toString("hex").toUpperCase();
  const middle = randomBytes(16).toString("hex");
  const suffix = randomBytes(2).toString("hex").toUpperCase();
  return `${prefix}.${middle}.${suffix}`;
}

/**
 * Generate a private relay email address.
 */
export function generatePrivateRelayEmail(): string {
  const id = randomBytes(12).toString("hex");
  return `${id}@privaterelay.appleid.com`;
}
