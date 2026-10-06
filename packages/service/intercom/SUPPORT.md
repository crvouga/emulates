# Intercom REST API 2.11 (Emulates subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **14**
- supported by the emulator: **14**
- parity enabled: **14**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `SearchContacts` | `POST /contacts/search` | ✅ supported | ✅ |  |
| `ListContacts` | `GET /contacts` | ✅ supported | ✅ |  |
| `CreateContact` | `POST /contacts` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetContact` | `GET /contacts/{contact_id}` | ✅ supported | ✅ |  |
| `UpdateContact` | `PUT /contacts/{contact_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListConversations` | `GET /conversations` | ✅ supported | ✅ |  |
| `CreateConversation` | `POST /conversations` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SearchConversations` | `POST /conversations/search` | ✅ supported | ✅ |  |
| `GetConversation` | `GET /conversations/{conversation_id}` | ✅ supported | ✅ |  |
| `UpdateConversation` | `PUT /conversations/{conversation_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ReplyConversation` | `POST /conversations/{conversation_id}/reply` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ManageConversation` | `POST /conversations/{conversation_id}/parts` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListAdmins` | `GET /admins` | ✅ supported | ✅ |  |
| `GetMe` | `GET /me` | ✅ supported | ✅ |  |
