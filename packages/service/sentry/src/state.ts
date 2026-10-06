import { Collection, IdSequence } from "@emulators/service"
import type { SqliteClient } from "@emulators/sqlite-client"
import type { JsonObject, SealedBytes } from "./protocol.js"

export type ProjectFixture = {
  id: string
  slug: string
  name: string
  organization: { id: string; slug: string; name: string }
  publicKey: string
}
/** Obviously synthetic DSN fixture, accepted by the real SDK's DSN parser. */
export const DEFAULT_PROJECT: ProjectFixture = {
  id: "1",
  slug: "fixture",
  name: "Fixture project",
  organization: { id: "1", slug: "fixture-org", name: "Fixture organization" },
  publicKey: `${"0".repeat(31)}1`,
}
export type CapturedEvent = {
  event_id: string
  projectId: string
  receivedAt: string
  timestamp: number
  type: string
  title: string
  groupId: string | null
  data: JsonObject
}
export type IssueRecord = {
  id: string
  projectId: string
  fingerprint: string
  title: string
  level: string
  count: number
  firstSeen: string
  lastSeen: string
  status: "unresolved" | "resolved" | "ignored"
  latestEventId: string
}
export type AttachmentRecord = {
  id: string
  eventId: string
  projectId: string
  name: string
  contentType: string
  size: number
  raw: SealedBytes
}
export type CapturedEnvelope = {
  id: string
  projectId: string
  eventId: string | null
  receivedAt: string
  headers: JsonObject
  items: { type: string; bytes: number; headers: JsonObject; rejected: boolean }[]
  raw: SealedBytes
}
export type SentrySettings = {
  grouping: "exception" | "message"
  sensitivePaths: string[]
  rejectItems: string[]
}
export class SentryState {
  readonly projects: Collection<ProjectFixture>
  readonly events: Collection<CapturedEvent>
  readonly issues: Collection<IssueRecord>
  readonly envelopes: Collection<CapturedEnvelope>
  readonly attachments: Collection<AttachmentRecord>
  readonly sessions: Collection<JsonObject>
  readonly clientReports: Collection<JsonObject>
  readonly releases: Collection<JsonObject>
  readonly settings: Collection<SentrySettings>
  readonly ids: IdSequence
  private readonly initialProjects: readonly ProjectFixture[]
  constructor(
    sqlite: SqliteClient,
    namespace: string,
    projects: readonly ProjectFixture[],
    private readonly initialSettings: SentrySettings,
  ) {
    this.initialProjects = projects.map((p) => structuredClone(p))
    this.projects = new Collection(sqlite, namespace, "projects")
    this.events = new Collection(sqlite, namespace, "events")
    this.issues = new Collection(sqlite, namespace, "issues")
    this.envelopes = new Collection(sqlite, namespace, "envelopes")
    this.attachments = new Collection(sqlite, namespace, "attachments")
    this.sessions = new Collection(sqlite, namespace, "sessions")
    this.clientReports = new Collection(sqlite, namespace, "client_reports")
    this.releases = new Collection(sqlite, namespace, "releases")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "sentry")
    this.ensureSeeded()
  }
  ensureSeeded(): void {
    if (this.settings.has("current")) return
    for (const project of this.initialProjects) this.projects.insert(project.id, project)
    this.settings.insert("current", structuredClone(this.initialSettings))
  }
  current(): SentrySettings {
    return this.settings.get("current") as SentrySettings
  }
  project(org: string, id: string): ProjectFixture | undefined {
    return this.projects
      .list()
      .find(
        ({ value: p }) =>
          (p.id === id || p.slug === id) &&
          (p.organization.id === org || p.organization.slug === org),
      )?.value
  }
  eventKey(project: string, event: string): string {
    return `${project}:${event}`
  }
  nextEventId(): string {
    return [...this.ids.next("", 16)].map((c) => c.charCodeAt(0).toString(16)).join("")
  }
  clearProject(projectId: string): void {
    for (const collection of [
      this.events,
      this.issues,
      this.envelopes,
      this.attachments,
      this.sessions,
      this.clientReports,
      this.releases,
    ]) {
      for (const row of collection.list()) {
        if (row.value.projectId === projectId) collection.delete(row.id)
      }
    }
  }
}
