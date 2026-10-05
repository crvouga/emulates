/** Raw-fetch contact flow from issue #280. No internal store access. */
export const client = (fetchImpl: typeof fetch, origin: string, key = "mock_brevo_key") => ({
  create: (email: string, externalId: string, lists: number[] = []) =>
    fetchImpl(`${origin}/v3/contacts`, {
      method: "POST",
      headers: { "api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ email, ext_id: externalId, updateEnabled: false, listIds: lists }),
    }),
  updateEmail: (externalId: string, email: string) =>
    fetchImpl(`${origin}/v3/contacts/${encodeURIComponent(externalId)}?identifierType=ext_id`, {
      method: "PUT",
      headers: { "api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ attributes: { EMAIL: email } }),
    }),
  remove: (email: string) =>
    fetchImpl(`${origin}/v3/contacts/${encodeURIComponent(email)}?identifierType=email_id`, {
      method: "DELETE",
      headers: { "api-key": key },
    }),
  get: (id: number | string) =>
    fetchImpl(`${origin}/v3/contacts/${encodeURIComponent(id)}`, { headers: { "api-key": key } }),
})
