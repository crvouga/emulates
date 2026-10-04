# Shared admin UI

React and Ant Design power the complete service admin shell: layout, menus, tables,
forms, dialogs, theme switching, and loading/error/success feedback. All structured
data uses Ant Design Table with bounded columns, horizontal scrolling, search,
sorting, pagination, and expandable JSON details.

`bun run build` compiles a production browser bundle and exports it as a string.
Service runtimes import that string without importing React or accessing the DOM.
Each published service bundles the document locally; administration works without
a CDN, in Bun, Node, a standalone browser page, or the docs example's Shadow DOM.
The bundle includes notices and license texts for its third-party dependencies.

The client calls the existing admin API through the document's scoped fetch.
Ant Design's StyleProvider and ConfigProvider keep styles and portals within the
embedded document. Hosts dispatch `mockingbird:unmount` before detaching the document
to dispose the React root. Service-owned manifest panels keep their existing API
and can return a cleanup function from their script.

SQL engines use the same UI as HTTP services. SQL changes remain in the live
database. State writes, clock controls, fault injection, journals, route execution,
namespaces, keys, branches, and checkpoints retain their existing server contracts.
