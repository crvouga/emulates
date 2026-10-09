# Slack incoming webhooks and Web API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **75**
- supported by the emulator: **75**
- parity enabled: **21**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `PostIncomingWebhook` | `POST /services/{team}/{bot}/{secret}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ChatPostMessage` | `POST /api/chat.postMessage` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ChatUpdate` | `POST /api/chat.update` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ChatPostEphemeral` | `POST /api/chat.postEphemeral` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ChatGetPermalinkGet` | `GET /api/chat.getPermalink` | ✅ supported | ✅ |  |
| `ChatGetPermalink` | `POST /api/chat.getPermalink` | ✅ supported | ✅ |  |
| `ReactionsAdd` | `POST /api/reactions.add` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ReactionsRemove` | `POST /api/reactions.remove` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ReactionsGetGet` | `GET /api/reactions.get` | ✅ supported | ✅ |  |
| `ReactionsGet` | `POST /api/reactions.get` | ✅ supported | ✅ |  |
| `AuthTestGet` | `GET /api/auth.test` | ✅ supported | ✅ |  |
| `AuthTest` | `POST /api/auth.test` | ✅ supported | ✅ |  |
| `ConversationsJoin` | `POST /api/conversations.join` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UsersInfoGet` | `GET /api/users.info` | ✅ supported | ✅ |  |
| `UsersInfo` | `POST /api/users.info` | ✅ supported | ✅ |  |
| `UsersLookupByEmailGet` | `GET /api/users.lookupByEmail` | ✅ supported | ✅ |  |
| `UsersLookupByEmail` | `POST /api/users.lookupByEmail` | ✅ supported | ✅ |  |
| `FilesInfoGet` | `GET /api/files.info` | ✅ supported | ✅ |  |
| `FilesInfo` | `POST /api/files.info` | ✅ supported | ✅ |  |
| `ViewsOpen` | `POST /api/views.open` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `AppsConnectionsOpen` | `POST /api/apps.connections.open` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GET /` | `GET /` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /api/files.list` | `GET /api/files.list` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/files.list` | `POST /api/files.list` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /api/pins.list` | `GET /api/pins.list` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/pins.list` | `POST /api/pins.list` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /api/users.getPresence` | `GET /api/users.getPresence` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/users.getPresence` | `POST /api/users.getPresence` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /api/users.profile.get` | `GET /api/users.profile.get` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/users.profile.get` | `POST /api/users.profile.get` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /files-pri/:fileId/:filename` | `GET /files-pri/{fileId}/{filename}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /oauth/v2/authorize` | `GET /oauth/v2/authorize` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/bookmarks.add` | `POST /api/bookmarks.add` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/bookmarks.edit` | `POST /api/bookmarks.edit` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/bookmarks.list` | `POST /api/bookmarks.list` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/bookmarks.remove` | `POST /api/bookmarks.remove` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/bots.info` | `POST /api/bots.info` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/chat.delete` | `POST /api/chat.delete` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/chat.deleteScheduledMessage` | `POST /api/chat.deleteScheduledMessage` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/chat.meMessage` | `POST /api/chat.meMessage` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/chat.scheduleMessage` | `POST /api/chat.scheduleMessage` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/chat.scheduledMessages.list` | `POST /api/chat.scheduledMessages.list` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.archive` | `POST /api/conversations.archive` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.close` | `POST /api/conversations.close` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.create` | `POST /api/conversations.create` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.history` | `POST /api/conversations.history` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.info` | `POST /api/conversations.info` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.invite` | `POST /api/conversations.invite` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.kick` | `POST /api/conversations.kick` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.leave` | `POST /api/conversations.leave` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.list` | `POST /api/conversations.list` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.mark` | `POST /api/conversations.mark` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.members` | `POST /api/conversations.members` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.open` | `POST /api/conversations.open` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.rename` | `POST /api/conversations.rename` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.replies` | `POST /api/conversations.replies` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.setPurpose` | `POST /api/conversations.setPurpose` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.setTopic` | `POST /api/conversations.setTopic` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/conversations.unarchive` | `POST /api/conversations.unarchive` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/files.completeUploadExternal` | `POST /api/files.completeUploadExternal` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/files.delete` | `POST /api/files.delete` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/files.getUploadURLExternal` | `POST /api/files.getUploadURLExternal` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/oauth.v2.access` | `POST /api/oauth.v2.access` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/pins.add` | `POST /api/pins.add` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/pins.remove` | `POST /api/pins.remove` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/team.info` | `POST /api/team.info` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/users.list` | `POST /api/users.list` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/users.profile.set` | `POST /api/users.profile.set` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/users.setPresence` | `POST /api/users.setPresence` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/views.generateTriggerId` | `POST /api/views.generateTriggerId` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/views.publish` | `POST /api/views.publish` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/views.push` | `POST /api/views.push` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/views.update` | `POST /api/views.update` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /oauth/v2/authorize/callback` | `POST /oauth/v2/authorize/callback` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /upload/v1/:fileId` | `POST /upload/v1/{fileId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
