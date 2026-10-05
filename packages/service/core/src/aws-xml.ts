import { XMLParser, XMLValidator } from "fast-xml-parser"

/** AWS XML uses string scalars; callers convert numbers according to the service model. */
export const awsParseXml = (source: string): Record<string, unknown> => {
  if (/<!DOCTYPE|<!ENTITY/i.test(source) || XMLValidator.validate(source) !== true)
    throw new TypeError("Malformed XML")
  return new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    processEntities: true,
  }).parse(source) as Record<string, unknown>
}

export const awsXmlEscape = (value: unknown): string =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")

export const awsXml = (value: unknown, listTag = "member"): string => {
  if (value === null || value === undefined) return ""
  if (Array.isArray(value)) return value.map((item) => `<${listTag}>${awsXml(item, listTag)}</${listTag}>`).join("")
  if (typeof value !== "object") return awsXmlEscape(value)
  return Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) =>
    `<${key}>${awsXml(item, listTag)}</${key}>`).join("")
}
