import type { PublishProblem } from "../../model/publish-problem"
import type { WbAdapterIssue } from "./adapter"

export type WbProblemContext = Readonly<{ recordId: string; variantCount: number }>

/** Both the adapter and a reloaded preview retain the same native location.
 * Canonical normalization checks external representation before displaying it. */
export function wbPublishProblem(issue: WbAdapterIssue, context: WbProblemContext): PublishProblem {
  return { ...issue.key, field: issue.field, location: {
    platform: "wb", recordId: context.recordId, variantCount: context.variantCount,
    scope: issue.scope, field: issue.field, characteristicId: issue.characteristicId, variantIndex: issue.variantIndex,
  } }
}
