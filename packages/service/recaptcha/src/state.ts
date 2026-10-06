import { Collection, IdSequence } from "@emulators/service"
import type { SqliteClient } from "@emulators/sqlite-client"

export type Site = { siteKey: string; secret: string }
export type Settings = {
  sites: Site[]
  score: number
  scores: Record<string, number>
  action?: string
  hostname?: string
  executeError: boolean
  expired: boolean
  replayed: boolean
  errorCodes: string[]
}
export type Token = {
  token: string
  siteKey: string
  action: string
  hostname: string
  score: number
  issuedAt: number
  used: boolean
  errorCodes: string[]
}
export type Attempt = { at: number; success: boolean; errors: string[] }
export const DEFAULT_SETTINGS: Settings = {
  sites: [{ siteKey: "mock_site", secret: "mock_secret" }],
  score: 0.9,
  scores: {},
  executeError: false,
  expired: false,
  replayed: false,
  errorCodes: [],
}

export class RecaptchaState {
  readonly tokens: Collection<Token>
  readonly attempts: Collection<Attempt>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence
  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: Partial<Settings>,
  ) {
    this.tokens = new Collection(sqlite, namespace, "tokens")
    this.attempts = new Collection(sqlite, namespace, "attempts")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, `recaptcha:${namespace}`)
    this.ensureSeeded()
  }
  ensureSeeded(): void {
    if (!this.settings.has("settings"))
      this.settings.insert("settings", structuredClone({ ...DEFAULT_SETTINGS, ...this.seed }))
  }
  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }
  update(patch: Partial<Settings>): Settings {
    const settings = { ...this.current(), ...patch }
    this.settings.insert("settings", settings)
    return settings
  }
}
