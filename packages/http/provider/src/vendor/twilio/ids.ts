/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { randomBytes } from "../core/crypto.js";

export function twilioSid(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

export function fixedSid(prefix: string): string {
  return `${prefix}${"0".repeat(32)}`;
}
