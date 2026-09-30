/**
 * Socket Mode tickets and connection records.
 *
 * The HTTP handler (portable) mints tickets. The Node server binds a transport when the
 * WebSocket upgrades. Nothing here imports Node, so the published fetch entry stays portable.
 */

export type SocketState = "pending" | "open" | "closing" | "closed"

export type SocketRecord = {
  namespace: string
  appId: string
  ticket: string
  connectedAt: string | null
  state: SocketState
  reconnectCount: number
  helloLatencyMs: number
  closeAfterHello: boolean
  abnormalClose: boolean
  /** Close with a `warning` disconnect when this many ms have passed. `null` keeps it open. */
  lifetimeMs: number | null
}

export type SocketTransport = {
  disconnect(reason: string, code: number): void
  destroy(): void
}

export type IssueSocketInput = {
  namespace: string
  appId: string
  helloLatencyMs: number
  closeAfterHello: boolean
  abnormalClose: boolean
  lifetimeMs: number | null
}

const records = new Map<string, SocketRecord>()
const transports = new Map<string, SocketTransport>()
/** How many tickets this namespace has been issued, including closed ones. */
const issued = new Map<string, number>()

const publicRecord = (record: SocketRecord): SocketRecord => ({
  namespace: record.namespace,
  appId: record.appId,
  ticket: record.ticket,
  connectedAt: record.connectedAt,
  state: record.state,
  reconnectCount: record.reconnectCount,
  helloLatencyMs: record.helloLatencyMs,
  closeAfterHello: record.closeAfterHello,
  abnormalClose: record.abnormalClose,
  lifetimeMs: record.lifetimeMs,
})

export const issueSocketTicket = (input: IssueSocketInput): SocketRecord => {
  const prior = issued.get(input.namespace) ?? 0
  issued.set(input.namespace, prior + 1)
  const record: SocketRecord = {
    ...input,
    ticket: crypto.randomUUID(),
    connectedAt: null,
    state: "pending",
    reconnectCount: prior,
  }
  records.set(record.ticket, record)
  return publicRecord(record)
}

/**
 * Claim a pending ticket for one WebSocket. A second upgrade, or a ticket that already
 * closed, fails: Slack tickets are single-use.
 */
export const claimSocketTicket = (ticket: string): SocketRecord | undefined => {
  const record = records.get(ticket)
  if (!record || record.state !== "pending") return undefined
  record.state = "open"
  record.connectedAt = new Date().toISOString()
  return publicRecord(record)
}

export const socketRecord = (ticket: string): SocketRecord | undefined => {
  const record = records.get(ticket)
  return record ? publicRecord(record) : undefined
}

export const openSocketCount = (namespace: string): number => {
  let count = 0
  for (const record of records.values()) {
    if (record.namespace === namespace && record.state === "open") count += 1
  }
  return count
}

export const listSocketConnections = (namespace?: string): SocketRecord[] =>
  [...records.values()]
    .filter((record) => namespace === undefined || record.namespace === namespace)
    .map(publicRecord)

export const bindSocketTransport = (ticket: string, transport: SocketTransport): void => {
  transports.set(ticket, transport)
}

export const unbindSocketTransport = (ticket: string): void => {
  transports.delete(ticket)
}

export const markSocketClosed = (ticket: string): void => {
  const record = records.get(ticket)
  if (!record || record.state === "closed") return
  record.state = "closed"
  transports.delete(ticket)
}

/** Send Slack's disconnect envelope to every open socket in the namespace. */
export const disconnectSockets = (namespace: string, reason: string, code: number): number => {
  let closed = 0
  for (const record of records.values()) {
    if (record.namespace !== namespace || record.state !== "open") continue
    record.state = "closing"
    closed += 1
    const transport = transports.get(record.ticket)
    if (transport) transport.disconnect(reason, code)
    else record.state = "closed"
  }
  return closed
}

/** Drop every socket and ticket for a namespace. Used by reset. */
export const closeSocketNamespace = (namespace: string): void => {
  for (const record of [...records.values()]) {
    if (record.namespace !== namespace) continue
    transports.get(record.ticket)?.destroy()
    transports.delete(record.ticket)
    records.delete(record.ticket)
  }
  issued.delete(namespace)
}
