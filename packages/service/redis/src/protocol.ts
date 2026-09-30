import { fromLatin1, latin1, utf8 } from "./bytes.ts"

export type Protocol = 2 | 3

export type Reply =
  | { t: "simple"; v: string }
  | { t: "error"; v: string }
  | { t: "int"; v: number | bigint }
  | { t: "bulk"; v: Uint8Array | null }
  | { t: "array"; v: Reply[] | null }
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "double"; v: number }
  | { t: "map"; v: Array<[Reply, Reply]> }
  | { t: "push"; v: Reply[] }

export const ok = (): Reply => ({ t: "simple", v: "OK" })
export const queued = (): Reply => ({ t: "simple", v: "QUEUED" })
export const pong = (): Reply => ({ t: "simple", v: "PONG" })
export const simple = (v: string): Reply => ({ t: "simple", v })
export const err = (v: string): Reply => ({ t: "error", v })
export const int = (v: number | bigint): Reply => ({ t: "int", v })
export const bulk = (v: Uint8Array | string | null): Reply => ({
  t: "bulk",
  v: v === null ? null : typeof v === "string" ? utf8(v) : v,
})
export const arr = (v: Reply[] | null): Reply => ({ t: "array", v })
export const nil = (): Reply => ({ t: "bulk", v: null })
export const nilArray = (): Reply => ({ t: "array", v: null })
export const push = (v: Reply[]): Reply => ({ t: "push", v })
export const map = (v: Array<[Reply, Reply]>): Reply => ({ t: "map", v })

export const wrongType = (): Reply =>
  err("WRONGTYPE Operation against a key holding the wrong kind of value")

export function arityError(name: string): Reply {
  return err(`ERR wrong number of arguments for '${name}' command`)
}

export const syntaxError = (): Reply => err("ERR syntax error")

export function unknownCommand(name: string, args: Uint8Array[]): Reply {
  const shown = args
    .slice(0, 10)
    .map((arg) => `'${latin1(arg)}'`)
    .join(" ")
  const extra = shown.length > 0 ? `${shown} ` : ""
  return err(`ERR unknown command '${name}', with args beginning with: ${extra}`)
}

export const notInteger = (): Reply => err("ERR value is not an integer or out of range")
export const notFloat = (): Reply => err("ERR value is not a valid float")
export const noScript = (): Reply => err("NOSCRIPT No matching script. Please use EVAL.")
export const readonlyError = (): Reply =>
  err("READONLY You can't write against a read only replica.")
export const oomError = (): Reply => err("OOM command not allowed when used memory > 'maxmemory'.")
export const busyError = (): Reply =>
  err("BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.")
export const noAuth = (): Reply => err("NOAUTH Authentication required.")
export const wrongPass = (): Reply =>
  err("WRONGPASS invalid username-password pair or user is disabled.")
export function authWithoutPassword(password: string): Reply {
  return err(
    `ERR AUTH <${password}> called without any password configured for the default user. Are you sure your configuration is correct?`,
  )
}
export const clusterDisabled = (): Reply => err("ERR This instance has cluster support disabled")
export const noSuchKey = (): Reply => err("ERR no such key")
export const execWithoutMulti = (): Reply => err("ERR EXEC without MULTI")
export const discardWithoutMulti = (): Reply => err("ERR DISCARD without MULTI")
export const nestedMulti = (): Reply => err("ERR MULTI calls can not be nested")
export const execAbort = (): Reply =>
  err("EXECABORT Transaction discarded because of previous errors.")
export const scriptDenied = (): Reply => err("ERR This Redis command is not allowed from scripts")
export const notBusy = (): Reply => err("NOTBUSY No scripts in execution right now.")

export function pubsubOnly(name: string): Reply {
  return err(
    `ERR Can't execute '${name}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`,
  )
}

export function noPerm(name: string): Reply {
  return err(`NOPERM this user has no permissions to run the '${name}' command`)
}

const CRLF = utf8("\r\n")

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0
  for (const part of parts) size += part.length
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function formatDouble(value: number): string {
  if (Number.isNaN(value)) return "nan"
  if (value === Infinity) return "inf"
  if (value === -Infinity) return "-inf"
  if (Object.is(value, -0)) return "-0"
  if (Number.isInteger(value)) return String(value)
  return String(value)
}

export function encodeReply(reply: Reply, protocol: Protocol = 2): Uint8Array {
  const parts: Uint8Array[] = []
  const text = (value: string) => {
    parts.push(utf8(value))
  }
  const walk = (value: Reply): void => {
    switch (value.t) {
      case "simple":
        text(`+${value.v}\r\n`)
        return
      case "error":
        text(`-${value.v}\r\n`)
        return
      case "int":
        text(`:${value.v.toString()}\r\n`)
        return
      case "bulk":
        if (value.v === null) {
          text(protocol === 3 ? "_\r\n" : "$-1\r\n")
          return
        }
        text(`$${value.v.length}\r\n`)
        parts.push(value.v)
        parts.push(CRLF)
        return
      case "array":
        if (value.v === null) {
          text(protocol === 3 ? "_\r\n" : "*-1\r\n")
          return
        }
        text(`*${value.v.length}\r\n`)
        for (const item of value.v) walk(item)
        return
      case "null":
        text(protocol === 3 ? "_\r\n" : "$-1\r\n")
        return
      case "bool":
        if (protocol === 3) text(value.v ? "#t\r\n" : "#f\r\n")
        else text(value.v ? ":1\r\n" : ":0\r\n")
        return
      case "double":
        if (protocol === 3) text(`,${formatDouble(value.v)}\r\n`)
        else walk(bulk(formatDouble(value.v)))
        return
      case "map":
        if (protocol === 3) {
          text(`%${value.v.length}\r\n`)
          for (const [key, item] of value.v) {
            walk(key)
            walk(item)
          }
          return
        }
        text(`*${value.v.length * 2}\r\n`)
        for (const [key, item] of value.v) {
          walk(key)
          walk(item)
        }
        return
      case "push":
        text(protocol === 3 ? `>${value.v.length}\r\n` : `*${value.v.length}\r\n`)
        for (const item of value.v) walk(item)
        return
      default: {
        const never: never = value
        throw new Error(`unknown reply ${(never as Reply).t}`)
      }
    }
  }
  walk(reply)
  return concat(parts)
}

export class RespParser {
  private buf = new Uint8Array(0)
  private pos = 0

  push(chunk: Uint8Array): Reply[] {
    if (this.pos > 0) this.buf = this.buf.slice(this.pos)
    this.pos = 0
    if (chunk.length > 0) {
      const next = new Uint8Array(this.buf.length + chunk.length)
      next.set(this.buf)
      next.set(chunk, this.buf.length)
      this.buf = next
    }
    const out: Reply[] = []
    while (this.pos < this.buf.length) {
      const saved = this.pos
      const reply = this.tryOne()
      if (reply === undefined) {
        this.pos = saved
        break
      }
      out.push(reply)
    }
    return out
  }

  private tryOne(): Reply | undefined {
    if (this.pos >= this.buf.length) return undefined
    const marker = this.buf[this.pos] ?? 0
    if (
      marker !== 43 &&
      marker !== 45 &&
      marker !== 58 &&
      marker !== 36 &&
      marker !== 42 &&
      marker !== 95 &&
      marker !== 35 &&
      marker !== 44 &&
      marker !== 37 &&
      marker !== 126 &&
      marker !== 62 &&
      marker !== 33
    ) {
      return this.inline()
    }
    this.pos++
    if (marker === 43) {
      const line = this.readLine()
      if (line === null) return undefined
      return simple(line)
    }
    if (marker === 45) {
      const line = this.readLine()
      if (line === null) return undefined
      return err(line)
    }
    if (marker === 58) {
      const line = this.readLine()
      if (line === null) return undefined
      if (!/^-?\d+$/.test(line)) return err("ERR protocol error: invalid integer")
      const value = BigInt(line)
      return int(
        value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(value)
          : value,
      )
    }
    if (marker === 36) return this.bulk()
    if (marker === 42) return this.aggregate("array")
    if (marker === 95) {
      const line = this.readLine()
      if (line === null) return undefined
      return { t: "null" }
    }
    if (marker === 35) {
      const line = this.readLine()
      if (line === null) return undefined
      return { t: "bool", v: line === "t" }
    }
    if (marker === 44) {
      const line = this.readLine()
      if (line === null) return undefined
      return { t: "double", v: Number(line) }
    }
    if (marker === 37) return this.map()
    if (marker === 126) return this.aggregate("set")
    if (marker === 62) return this.aggregate("push")
    if (marker === 33) return this.bulk()
    return undefined
  }

  private inline(): Reply | undefined {
    const line = this.readLine()
    if (line === null) return undefined
    if (line.length === 0) return arr([])
    const parts: string[] = []
    let current = ""
    let quote: string | null = null
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (quote) {
        if (ch === quote) quote = null
        else current += ch ?? ""
        continue
      }
      if (ch === "'" || ch === '"') {
        quote = ch
        continue
      }
      if (ch === " ") {
        if (current.length > 0) {
          parts.push(current)
          current = ""
        }
        continue
      }
      current += ch ?? ""
    }
    if (current.length > 0) parts.push(current)
    return arr(parts.map((part) => bulk(fromLatin1(part))))
  }

  private readLine(): string | null {
    for (let i = this.pos; i < this.buf.length; i++) {
      if (this.buf[i] !== 10) continue
      let end = i
      if (end > this.pos && this.buf[end - 1] === 13) end--
      const line = latin1(this.buf.subarray(this.pos, end))
      this.pos = i + 1
      return line
    }
    return null
  }

  private bulk(): Reply | undefined {
    const line = this.readLine()
    if (line === null) return undefined
    const size = Number(line)
    if (!Number.isInteger(size)) return err("ERR protocol error: invalid bulk length")
    if (size < 0) return nil()
    if (this.buf.length < this.pos + size + 2) return undefined
    const value = this.buf.slice(this.pos, this.pos + size)
    this.pos += size + 2
    return { t: "bulk", v: value }
  }

  private aggregate(kind: "array" | "push" | "set"): Reply | undefined {
    const line = this.readLine()
    if (line === null) return undefined
    const count = Number(line)
    if (!Number.isInteger(count)) return err("ERR protocol error: invalid multibulk length")
    if (count < 0) return nilArray()
    const items: Reply[] = []
    for (let i = 0; i < count; i++) {
      const item = this.tryOne()
      if (item === undefined) return undefined
      items.push(item)
    }
    if (kind === "push") return push(items)
    return arr(items)
  }

  private map(): Reply | undefined {
    const line = this.readLine()
    if (line === null) return undefined
    const count = Number(line)
    if (!Number.isInteger(count) || count < 0) return err("ERR protocol error: invalid map length")
    const pairs: Array<[Reply, Reply]> = []
    for (let i = 0; i < count; i++) {
      const key = this.tryOne()
      if (key === undefined) return undefined
      const value = this.tryOne()
      if (value === undefined) return undefined
      pairs.push([key, value])
    }
    return map(pairs)
  }
}

export function asCommand(reply: Reply): { name: string; args: Uint8Array[] } | Reply {
  if (reply.t !== "array" || reply.v === null || reply.v.length === 0) {
    return err("ERR protocol error: expected command array")
  }
  const name = reply.v[0]
  if (name?.t !== "bulk" || name.v === null) return err("ERR protocol error: expected command name")
  const args: Uint8Array[] = []
  for (let i = 1; i < reply.v.length; i++) {
    const arg = reply.v[i]
    if (arg?.t !== "bulk" || arg.v === null)
      return err("ERR protocol error: expected bulk argument")
    args.push(arg.v)
  }
  return { name: latin1(name.v), args }
}
