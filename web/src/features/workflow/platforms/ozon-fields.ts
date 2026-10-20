/** Field callbacks produce edits only. Native op2 owns Manual provenance and invalidation. */
import type { CardPayload, LeanRow, WorkflowCategoryDraft, WorkflowDraftValue } from "@/listing-core/types"

export type OzonFieldDecision = Readonly<{ value: WorkflowDraftValue }> | Readonly<{ clear: true }>

/** `current` is the row's own value, else the Card default unless the row cleared it. */
export type OzonFieldRule = (
  current: WorkflowDraftValue | undefined,
  context: Readonly<{ row: LeanRow; card: CardPayload }>,
) => OzonFieldDecision

export type OzonFieldRules = Readonly<Record<string, OzonFieldRule>>

export type FieldRuleRefusal = Readonly<{ field: string; code: "field_rule_failed" | "field_rule_invalid"; diagnostic?: string }>

function decisionValid(decision: unknown): decision is OzonFieldDecision {
  if (!decision || typeof decision !== "object") return false
  if ("clear" in decision) return decision.clear === true && !("value" in decision)
  const value = (decision as { value?: unknown }).value
  return !!value && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string"
}

/** Apply `rules` to a clone of `row`; `row` itself is never mutated. */
export function applyOzonFieldRules(
  row: LeanRow,
  card: CardPayload,
  rules: OzonFieldRules,
): Readonly<{ draft: WorkflowCategoryDraft }> | Readonly<{ refusal: FieldRuleRefusal }> {
  const keys = Object.keys(rules)
  if (keys.length === 0) return { draft: row.draft }
  const next = structuredClone(row.draft)
  next.cleared = [...(next.cleared ?? [])]
  for (const key of keys) {
    const cleared = next.cleared.includes(key)
    const current = next.values[key] ?? (cleared ? undefined : card.defaults?.values[key])
    let decision: unknown
    try {
      decision = rules[key]!(current === undefined ? undefined : structuredClone(current), { row, card })
    } catch (error) {
      return { refusal: { field: key, code: "field_rule_failed", diagnostic: String(error) } }
    }
    if (!decisionValid(decision)) return { refusal: { field: key, code: "field_rule_invalid" } }
    if ("clear" in decision) {
      delete next.values[key]
      if (!cleared) next.cleared.push(key)
    } else {
      next.values[key] = structuredClone(decision.value)
      next.cleared = next.cleared.filter((cleared) => cleared !== key)
    }

  }
  return { draft: next }
}
