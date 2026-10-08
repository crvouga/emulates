/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { randomUUID } from "../core/crypto.js";

/** Default tenant ID used when none is configured */
export const DEFAULT_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/**
 * Generate a Microsoft-style object ID (UUID v4 format).
 */
export function generateOid(): string {
  return randomUUID();
}
