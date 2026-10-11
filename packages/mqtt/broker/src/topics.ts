/**
 * Topic Names and Topic Filters (MQTT 5.0 section 4.7).
 * https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901241
 */

const encoder = new TextEncoder()

/** UTF-8 length, which is what every MQTT string limit counts. */
export const utf8Length = (value: string): number => encoder.encode(value).length

/** 4.7.3: at least one character, no null character, at most 65,535 UTF-8 bytes. */
const wellFormed = (value: string): boolean =>
  value.length > 0 && !value.includes("\u0000") && utf8Length(value) <= 0xffff

/** A Topic Name a PUBLISH may carry: well formed and free of wildcard characters (4.7.1). */
export const isValidTopicName = (topic: string): boolean =>
  wellFormed(topic) && !topic.includes("+") && !topic.includes("#")

/**
 * A Topic Filter a SUBSCRIBE may carry: `#` only as the whole last level, `+` only as a whole
 * level (4.7.1.2, 4.7.1.3).
 */
export const isValidTopicFilter = (filter: string): boolean => {
  if (!wellFormed(filter)) return false
  const levels = filter.split("/")
  return levels.every((level, index) => {
    if (level === "#") return index === levels.length - 1
    if (level === "+") return true
    return !level.includes("#") && !level.includes("+")
  })
}

/** `$share/{ShareName}/{filter}` (4.8.2). */
export const isSharedSubscription = (filter: string): boolean => filter.startsWith("$share/")

/**
 * Whether `filter` matches `topic`. `topic` is compared level by level as literal text, so a
 * caller may also ask whether one filter covers another's exact spelling.
 *
 * 4.7.2: a filter starting with a wildcard does not match a Topic Name starting with `$`.
 * 4.7.1.2: `sport/#` also matches `sport`; a vendor that excludes the parent level passes
 * `parentLevel: false`.
 */
export const topicMatches = (
  filter: string,
  topic: string,
  options: { parentLevel?: boolean } = {},
): boolean => {
  const first = filter[0]
  if (topic.startsWith("$") && (first === "+" || first === "#")) return false
  const filterLevels = filter.split("/")
  const topicLevels = topic.split("/")
  for (let index = 0; index < filterLevels.length; index++) {
    const level = filterLevels[index]
    if (level === "#") return index < topicLevels.length || options.parentLevel !== false
    if (index >= topicLevels.length) return false
    if (level !== "+" && level !== topicLevels[index]) return false
  }
  return filterLevels.length === topicLevels.length
}
