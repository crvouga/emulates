/** The shared admin surface for any service, database, or other data source. */
export type MockAdmin = {
  id: string
  label: string
  fetch: (request: Request) => Promise<Response>
}
