import { type ComposableAdminApi, composeAdminApis } from "@emulates/admin-ui"

const ADMIN_BRANDS_URL = "https://emulates.chrisvouga.dev/brands.json"

/** One independently usable admin API. Its UI is supplied by the composed facade. */
export type MockAdmin = {
  id: string
  label: string
  fetch: (request: Request) => Promise<Response>
}

/** Compose independent APIs without merging their state or control planes. */
export const composeMockAdmins = (admins: readonly MockAdmin[]) =>
  composeAdminApis(
    admins.map(
      (admin): ComposableAdminApi => ({
        ...admin,
        service: admin.id,
        adminPrefix: "/__admin",
        adminKeyHeader: "x-emulates-admin-key",
        standardRoutes: [],
      }),
    ),
    { brandsUrl: ADMIN_BRANDS_URL, title: "Emulates lab testing" },
  )
