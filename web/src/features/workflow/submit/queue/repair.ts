import type { SendFact } from "./types"
/** Only a definite item refusal without an unresolved Intent authorizes automatic repair. */
export function repairKind(fact: SendFact): "schema" | "media" | undefined {
  if (fact.state !== "rejected" || fact.canResume !== true || fact.admission) return undefined
  if (fact.code === "schema_stale") return "schema"
  if (fact.code === "media_expired") return "media"
  return undefined
}
