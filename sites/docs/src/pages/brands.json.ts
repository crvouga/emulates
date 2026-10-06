import catalog from "virtual:emulators/catalog"
import type { APIRoute } from "astro"
import { adminBrands } from "../lib/admin-brands.ts"

/**
 * Logo, website, vendor API reference, and our guide for every service.
 * Admin shells fetch this cross-origin; the payload is not part of the mock bundles.
 */
export const GET: APIRoute = () =>
  new Response(JSON.stringify(adminBrands(catalog.services)), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  })
