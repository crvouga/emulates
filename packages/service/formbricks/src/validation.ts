/**
 * Formbricks' response validation (`validateResponseData` in `apps/web/modules/api/lib/validation.ts`
 * → `validateBlockResponses` in `packages/surveys/src/lib/validation/evaluator.ts`), trimmed to the
 * structural checks: required elements, choice membership for choice elements without an "other"
 * option, and the implicit email / url / phone rules of openText elements.
 * `present-only` (default, Formbricks after #7292) checks only elements present in `data`.
 * `finished-validates-all` (Formbricks before #7292, commit 7c8a760) checks every element when
 * `finished` is true, and only the present ones when it is false.
 * Custom `validation.rules` are not evaluated.
 *
 * The "other" length check is separate (`validateOtherOptionLengthForMultipleChoice` in
 * `apps/web/modules/api/v2/lib/element.ts`) and the response route runs it before this.
 */
import type { ResponseValidation, Survey } from "./state.js"

type Element = {
  id: string
  type?: string
  required?: boolean
  inputType?: string
  rows?: unknown[]
  choices?: { id: string; label?: { default?: string } & Record<string, string> }[]
}

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0)

const EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
const PHONE = /^[\d+][\d+\- ]*\d$/
const validUrl = (value: string) => {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

const REQUIRED = "Please fill out this field"
const INVALID_FORMAT = "Please enter a valid format"

/** Every element of a survey: from `blocks[].elements`, else the legacy `questions[]`. */
export const surveyElements = (survey: Survey): Element[] => {
  const blocks = Array.isArray(survey.blocks) ? (survey.blocks as { elements?: unknown }[]) : []
  const fromBlocks = blocks.flatMap((b) =>
    b && Array.isArray(b.elements) ? (b.elements as Element[]) : [],
  )
  const elements =
    fromBlocks.length > 0
      ? fromBlocks
      : Array.isArray(survey.questions)
        ? (survey.questions as Element[])
        : []
  return elements.filter((e) => typeof e === "object" && e !== null)
}

const requiredError = (element: Element, value: unknown): boolean => {
  if (!element.required || element.type === "cta") return false
  if (element.type === "ranking") return !Array.isArray(value) || value.length < 1
  if (element.type === "matrix") {
    if (isEmpty(value)) return true
    if (typeof value === "object" && value !== null && !Array.isArray(value) && element.rows) {
      return !Object.values(value).some((v) => v !== "" && v !== null && v !== undefined)
    }
    return false
  }
  return isEmpty(value)
}

/** `validateChoiceMembership`: a choice element without "other" only takes its choice ids / labels. */
const invalidOption = (element: Element, value: unknown, language: string): boolean => {
  if (element.type !== "multipleChoiceSingle" && element.type !== "multipleChoiceMulti")
    return false
  if (!Array.isArray(element.choices)) return false
  if (element.choices.some((c) => c.id === "other") || isEmpty(value)) return false
  const known = new Set<string>()
  for (const choice of element.choices) {
    known.add(choice.id)
    const label = choice.label?.[language] ?? choice.label?.default
    if (label) known.add(label)
  }
  const submitted = Array.isArray(value) ? value : [value]
  return submitted.some((v) => v !== "" && (typeof v !== "string" || !known.has(v)))
}

export type ValidateResponseDataOptions = {
  /** Defaults to post-#7292 `present-only`. */
  validation?: ResponseValidation
  /** Read only when `validation` is `finished-validates-all`. */
  finished?: boolean
}

/** `MAX_OTHER_OPTION_LENGTH` in `apps/web/lib/constants.ts`. */
const MAX_OTHER_OPTION_LENGTH = 250

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * `getLocalizedValue` (`apps/web/lib/i18n/utils.ts`): the exact language key when it is a
 * non-empty string, otherwise "". An i18n object is one that has a `default` key. No fallback.
 */
const localizedLabel = (label: unknown, language: string): string => {
  if (!isRecord(label) || !Object.hasOwn(label, "default")) return ""
  const text = label[language]
  return typeof text === "string" && text !== "" ? text : ""
}

/** A choice label in `language` equals `value` (`validateOtherOptionLength`). */
const matchesChoiceLabel = (choices: unknown[], value: string, language: string): boolean =>
  choices.some(
    (choice) =>
      isRecord(choice) &&
      isRecord(choice.label) &&
      localizedLabel(choice.label, language) === value,
  )

const entryOverLimit = (value: string, choices: unknown[], language: string): boolean =>
  !matchesChoiceLabel(choices, value, language) && value.length > MAX_OTHER_OPTION_LENGTH

const answerOverLimit = (answer: unknown, choices: unknown[], language: string): boolean => {
  if (typeof answer === "string") return entryOverLimit(answer, choices, language)
  if (!Array.isArray(answer)) return false
  return answer.some((item) => typeof item === "string" && entryOverLimit(item, choices, language))
}

/**
 * `validateOtherOptionLengthForMultipleChoice`. The id of the first multiple-choice element
 * whose answer (a string, or any string in an array) matches no choice label in `language`
 * (`default` when the response omits language) and is longer than 250 characters.
 */
export const otherOptionOverLimit = (
  survey: Survey,
  data: Record<string, unknown>,
  language?: string,
): string | undefined => {
  const responseLanguage = language ?? "default"
  for (const [questionId, answer] of Object.entries(data)) {
    const question = surveyElements(survey).find((element) => element.id === questionId)
    if (!question?.choices) continue
    if (question.type !== "multipleChoiceSingle" && question.type !== "multipleChoiceMulti") {
      continue
    }
    if (answerOverLimit(answer, question.choices, responseLanguage)) return questionId
  }
  return undefined
}

/** `{<elementId>: [messages]}`, or `null` when the response passes. */
export const validateResponseData = (
  survey: Survey,
  data: Record<string, unknown>,
  language = "en",
  options: ValidateResponseDataOptions = {},
): Record<string, string[]> | null => {
  const elements = surveyElements(survey)
  const presentIds = new Set(Object.keys(data))
  const selected =
    options.validation === "finished-validates-all" && options.finished === true
      ? elements
      : elements.filter((element) => presentIds.has(element.id))
  const errors: Record<string, string[]> = {}
  for (const element of selected) {
    const value = data[element.id]
    const messages: string[] = []
    if (requiredError(element, value)) messages.push(REQUIRED)
    if (invalidOption(element, value, language)) messages.push(INVALID_FORMAT)
    if (element.type === "openText" && typeof value === "string" && value !== "") {
      if (element.inputType === "email" && !EMAIL.test(value)) {
        messages.push("Please enter a valid email address")
      } else if (element.inputType === "url" && !validUrl(value)) {
        messages.push("Please enter a valid URL")
      } else if (element.inputType === "phone" && !PHONE.test(value)) {
        messages.push("Please enter a valid phone number")
      }
    }
    if (messages.length > 0) errors[element.id] = messages
  }
  return Object.keys(errors).length === 0 ? null : errors
}
