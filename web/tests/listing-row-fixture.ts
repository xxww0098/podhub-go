import type { components } from "../src/api/schema"

type Projection = components["schemas"]["ListingRowProjection"]

/** Explicit mock Cloud verdict; no client-side business inference. */
export function listingProjection(overrides: Partial<Projection> = {}): Projection {
  return {
    stage: "ready_to_publish", ai: "ready", media: "ready", fields: "valid",
    image_total: 0, image_completed: 0,
    readiness: {
      ready_to_publish: true, can_start_publish_attempt: true,
      blockers: [], allowed_actions: ["edit_fields", "publish"],
    },
    current_issue_status: "absent", can_resume: false, submission_receipt_status: "absent",
    ...overrides,
  }
}

/** A complete wire row; each test supplies its changed Cloud verdict explicitly. */
export function listingRow(overrides: Partial<import("../src/bindings/listing-projection").ListingRowView> = {}): import("../src/bindings/listing-projection").ListingRowView {
  return {
    id: "a", card_id: "card", revision: 1, view_revision: 1,
    content_state: "draft", media_state: "pending", validation_state: "stale", submission_state: "none",
    projection: listingProjection({ stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", readiness: {
      ready_to_publish: false, can_start_publish_attempt: false,
      blockers: ["ai_pending", "media_pending", "fields_dirty"], allowed_actions: ["prepare", "edit_fields"],
    } }),
    draft: { values: {}, complex_values: [] }, validation_issues: [],
    media: {}, ai: {}, source: {}, payload: {}, updated_at_ms: 0,
    build: { state: "stale", sources: [] },
    ...overrides,
  }
}
