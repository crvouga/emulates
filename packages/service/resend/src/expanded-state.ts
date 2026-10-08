import { getResendStore, type ProviderExpansion } from "@crvouga/mockingbird-http-provider"
import type { ResendState } from "./state.js"

export function syncToExpanded(state: ResendState, expansion: ProviderExpansion): void {
  const emails = getResendStore(expansion.store).emails
  for (const email of state.outbox.list()) {
    const existing = emails.findOneBy("uuid", email.id)
    const value = {
      uuid: email.id,
      from: email.from,
      to: email.toHeader,
      subject: email.subject,
      html: email.html,
      text: email.text,
      cc: email.cc,
      bcc: email.bcc,
      reply_to: email.replyTo,
      headers: email.headers,
      tags: email.tags,
      status: email.scheduledAt ? ("scheduled" as const) : ("delivered" as const),
      scheduled_at: email.scheduledAt,
      last_event: email.lastEvent ?? (email.scheduledAt ? "email.scheduled" : "email.delivered"),
    }
    if (existing) {
      const { status: _status, ...fields } = value
      if (
        Object.entries(fields).some(
          ([key, value]) =>
            JSON.stringify(existing[key as keyof typeof existing]) !== JSON.stringify(value),
        )
      )
        emails.update(existing.id, fields)
    } else emails.insert({ ...value, created_at: email.createdAt } as typeof value)
  }
}

export function syncFromExpanded(state: ResendState, expansion: ProviderExpansion): void {
  for (const email of getResendStore(expansion.store).emails.all()) {
    const existing = state.outbox.get(email.uuid)
    const value = {
      ...existing,
      id: email.uuid,
      from: email.from,
      to: email.to,
      toHeader: email.to,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.reply_to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      tags: email.tags,
      headers: email.headers,
      attachments: existing?.attachments ?? [],
      idempotencyKey: existing?.idempotencyKey ?? null,
      scheduledAt: email.scheduled_at,
      createdAt: existing?.createdAt ?? email.created_at,
      lastEvent: email.last_event,
    }
    if (existing) state.outbox.update(email.uuid, value)
    else state.outbox.record(value)
  }
}
