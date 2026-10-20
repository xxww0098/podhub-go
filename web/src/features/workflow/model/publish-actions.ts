import type { components } from "@/api/schema"
import type { ListingIntent } from "@/bindings/http-listing-intents"
import type { Solution } from "./publish-solutions-native"

/** An issue's allowance alone never supplies identity, permission, or an implementation. */
export function allowedPublishActions(
  solution: Solution,
  issue: components["schemas"]["ListingIssue"],
  capability: { current: boolean; permitted: boolean; callbacks: readonly components["schemas"]["ListingIssueAction"][] },
): components["schemas"]["ListingIssueAction"][] {
  if (!capability.current || !capability.permitted || issue.resolved_at_ms != null || issue.dispatch_evidence === "unknown") return []
  return solution.actions.filter((action) => issue.allowed_actions.includes(action) && capability.callbacks.includes(action))
}

export function sameIntent(left: ListingIntent, right: ListingIntent): boolean {
  return !!left.id && !!left.listing_row_id && !!left.store_id && !!left.client_operation_id
    && left.id === right.id && left.listing_row_id === right.listing_row_id && left.store_id === right.store_id
    && left.client_operation_id === right.client_operation_id && left.row_revision === right.row_revision
}
