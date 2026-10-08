import {
  formatSlackView,
  getSlackStore,
  type ProviderExpansion,
} from "@crvouga/mockingbird-http-provider"
import { Collection } from "@crvouga/mockingbird-service"
import type { SlackMessage, SlackState } from "./state.js"

export function syncToExpanded(state: SlackState, expansion: ProviderExpansion): void {
  const ss = getSlackStore(expansion.store)
  const settings = state.current()
  expansion.store.meta.insert("native-slack-actor", {
    app_id: settings.appId,
    bot_id: settings.botId,
  })
  const team = ss.teams.all()[0]
  if (team)
    ss.teams.update(team.id, {
      team_id: settings.teamId,
      name: settings.teamName,
      domain: settings.teamDomain,
    })
  for (const { value: user } of state.users.list()) {
    const existing = ss.users.findOneBy("user_id", user.id)
    const value = {
      user_id: user.id,
      team_id: settings.teamId,
      name: user.name,
      real_name: user.real_name,
      email: user.email ?? "",
      is_admin: !user.is_bot,
      is_bot: user.is_bot,
      deleted: user.deleted,
      profile: {
        display_name: user.name,
        real_name: user.real_name,
        email: user.email ?? "",
        image_48: "",
        image_192: "",
      },
    }
    if (!existing)
      ss.users.insert({ ...value, last_activity: Math.floor(expansion.store.now() / 1000) })
    else if (
      existing.name !== user.name ||
      existing.real_name !== user.real_name ||
      existing.email !== user.email
    )
      ss.users.update(existing.id, { ...value, profile: { ...existing.profile, ...value.profile } })
  }
  for (const { value: channel } of state.channels.list()) {
    const existing = ss.channels.findOneBy("channel_id", channel.id)
    const value = {
      channel_id: channel.id,
      team_id: settings.teamId,
      name: channel.name,
      is_channel: true,
      is_private: channel.is_private,
      is_archived: channel.is_archived,
      topic: { value: "", creator: settings.botUserId, last_set: 0 },
      purpose: { value: "", creator: settings.botUserId, last_set: 0 },
      members: channel.is_member ? [settings.botUserId] : [],
      creator: settings.botUserId,
      num_members: channel.is_member ? 1 : 0,
    }
    if (!existing) ss.channels.insert(value)
    else if (
      existing.name !== channel.name ||
      existing.is_archived !== channel.is_archived ||
      existing.members.includes(settings.botUserId) !== channel.is_member
    )
      ss.channels.update(existing.id, {
        name: channel.name,
        is_archived: channel.is_archived,
        members: channel.is_member
          ? [...new Set([...existing.members, settings.botUserId])]
          : existing.members.filter((id) => id !== settings.botUserId),
      })
  }
  for (const { value: file } of state.files.list()) {
    const existing = ss.files.findOneBy("file_id", file.id)
    const value = {
      file_id: file.id,
      team_id: settings.teamId,
      user: settings.botUserId,
      name: file.name,
      title: file.title,
      mimetype: file.mimetype,
      filetype: file.filetype,
      pretty_type: file.filetype,
      mode: "hosted" as const,
      size: file.size,
      created: file.created,
      timestamp: file.created,
      url_private: "",
      url_private_download: "",
      permalink: "",
      is_external: false,
      external_type: "",
      is_public: false,
      public_url_shared: false,
      display_as_bot: false,
      editable: true,
      deleted: false,
      channels: [],
      groups: [],
      ims: [],
      shares: {},
    }
    if (!existing) ss.files.insert(value)
    else if (existing.title !== file.title) ss.files.update(existing.id, { title: file.title })
  }
  for (const { value: view } of state.views.list()) {
    const existing = ss.views.findOneBy("view_id", view.id)
    if (existing) continue
    const value = {
      view_id: view.id,
      team_id: settings.teamId,
      user_id: settings.botUserId,
      type: view.type === "home" ? ("home" as const) : ("modal" as const),
      blocks: Array.isArray(view.blocks) ? (view.blocks as Record<string, unknown>[]) : [],
      private_metadata: typeof view.private_metadata === "string" ? view.private_metadata : "",
      callback_id: typeof view.callback_id === "string" ? view.callback_id : "",
      external_id: typeof view.external_id === "string" ? view.external_id : "",
      title: (view.title as Record<string, unknown>) ?? null,
      submit: (view.submit as Record<string, unknown>) ?? null,
      close: (view.close as Record<string, unknown>) ?? null,
      state: (view.state as Record<string, unknown>) ?? { values: {} },
      hash: String(view.hash ?? ""),
      clear_on_close: view.clear_on_close === true,
      notify_on_close: view.notify_on_close === true,
      root_view_id: view.id,
      app_id: settings.appId,
      bot_id: settings.botId,
      created: Math.floor(expansion.store.now() / 1000),
      updated: Math.floor(expansion.store.now() / 1000),
    }
    ss.views.insert(value)
  }
  for (const message of state.outbox.list()) {
    if (message.ephemeral) continue
    const existing = ss.messages
      .findBy("channel_id", message.channel)
      .find((row) => row.ts === message.ts)
    const value = {
      ts: message.ts,
      channel_id: message.channel,
      user: message.user ?? settings.botUserId,
      text: message.text ?? "",
      type: "message" as const,
      ...(message.blocks ? { blocks: message.blocks as Record<string, unknown>[] } : {}),
      ...(message.attachments
        ? { attachments: message.attachments as Record<string, unknown>[] }
        : {}),
      ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
      ...(message.edited ? { edited: message.edited } : {}),
      reply_count: 0,
      reply_users: [],
      reactions: message.reactions,
    }
    if (existing) {
      if (
        existing.text !== value.text ||
        JSON.stringify(existing.reactions) !== JSON.stringify(value.reactions)
      )
        ss.messages.update(existing.id, value)
    } else ss.messages.insert(value)
    const marker = `native-message:${message.channel}:${message.ts}`
    if (!expansion.store.meta.has(marker)) expansion.store.meta.insert(marker, true)
  }
  // A native chat.delete must disappear from history as well.
  for (const message of ss.messages.all()) {
    if (
      expansion.store.meta.get(`native-message:${message.channel_id}:${message.ts}`) &&
      !state.outbox.get(`${message.channel_id}:${message.ts}`)
    )
      ss.messages.delete(message.id)
  }
}

export function syncFromExpanded(state: SlackState, expansion: ProviderExpansion): void {
  const ss = getSlackStore(expansion.store)
  const settings = state.current()
  for (const channel of ss.channels.all()) {
    if (channel.team_id !== settings.teamId) continue
    const value = {
      id: channel.channel_id,
      name: channel.name,
      is_private: channel.is_private,
      is_archived: channel.is_archived,
      is_member: channel.members.includes(settings.botUserId),
      created: Math.floor(Date.parse(channel.created_at) / 1000),
    }
    if (state.channels.has(value.id)) state.channels.update(value.id, value)
    else state.channels.insert(value.id, value)
  }
  for (const user of ss.users.all()) {
    if (user.team_id !== settings.teamId) continue
    const value = {
      id: user.user_id,
      name: user.name,
      real_name: user.real_name,
      email: user.email,
      is_bot: user.is_bot,
      deleted: user.deleted,
      tz: "UTC",
    }
    if (state.users.has(value.id)) state.users.update(value.id, value)
    else state.users.insert(value.id, value)
  }
  for (const file of ss.files.all()) {
    if (file.deleted) {
      state.files.delete(file.file_id)
      continue
    }
    const value = {
      id: file.file_id,
      name: file.name,
      title: file.title,
      mimetype: file.mimetype,
      filetype: file.filetype,
      size: file.size,
      created: file.created,
    }
    if (state.files.has(file.file_id)) state.files.update(file.file_id, value)
    else state.files.insert(file.file_id, value)
  }
  for (const view of ss.views.all()) {
    const value = formatSlackView(view)
    if (state.views.has(view.view_id)) state.views.update(view.view_id, value)
    else state.views.insert(view.view_id, value)
  }
  for (const message of ss.messages.all()) {
    const id = `${message.channel_id}:${message.ts}`
    const existing = state.outbox.get(id)
    const value: SlackMessage = {
      ...existing,
      id,
      to: existing?.to ?? [message.channel_id],
      createdAt: existing?.createdAt ?? message.created_at,
      source: existing?.source ?? "api",
      method: existing?.method ?? "chat.postMessage",
      webhook: existing?.webhook ?? null,
      channel: message.channel_id,
      text: message.text,
      blocks: message.blocks ?? null,
      attachments: message.attachments ?? null,
      thread_ts: message.thread_ts ?? null,
      ts: message.ts,
      user: message.user,
      ephemeral: false,
      edited: message.edited ?? null,
      reactions: message.reactions,
      unfurl_links: message.unfurl_links ?? null,
      workspace: settings.teamId,
    }
    if (existing) state.outbox.update(id, value)
    else state.outbox.record(value)
    if (!expansion.store.meta.has(`native-message:${id}`))
      expansion.store.meta.insert(`native-message:${id}`, true)
  }
  const outbox = new Collection<SlackMessage>(expansion.sqlite, expansion.namespace, "outbox")
  for (const message of outbox.list())
    if (
      expansion.store.meta.has(`native-message:${message.id}`) &&
      !ss.messages.all().some((row) => `${row.channel_id}:${row.ts}` === message.id)
    )
      outbox.delete(message.id)
}
