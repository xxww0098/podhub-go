/**
 * Shared Cloud row / Product Instance fixtures for the cloud fan-out tests.
 * The payload is the native send fixture, so the send rail can freeze it.
 */
import { listingProjection } from "../../../../tests/listing-row-fixture"
import type { AccountOverview, WorkflowDraftView } from "@/bindings/commands"
import { rowStatusView } from "../model/row-state"
import { nativePayload } from "../submit/send-test-support"

/** The standing a signed-in shell already holds; no Workspace keeps telemetry paused. */
export const SIGNED_IN: AccountOverview = { session: { authenticated: true }, workspaces: [], owned_count: 0, owned_limit: 0 }

export function cloudRow(id: string) {
  return {
    id, card_id: "card", store_id: "store", revision: 1, view_revision: 1, projection: listingProjection(),
    content_state: "ready", media_state: "ready", validation_state: "passed", submission_state: "none",
    draft: { values: { offer_id: { kind: "text" as const, value: id } }, complex_values: [] },
    validation_issues: [], media: { images: [], videos: [] }, ai: { candidates: [] },
    source: { fileName: `${id}.png` }, payload: nativePayload(id), updated_at_ms: 1,
    build: { state: "stale" as const, sources: [] },
  }
}

export function product(id: string): WorkflowDraftView {
  return {
    draft_id: id, kind: "instance", display_name: id,
    schema: { description_category_id: 1, type_id: 1, fields: [
      { key: "name", name: "Name", description: "", group_name: "Basic", editor: "text",
        source: "fixed", complex_group_collection: false, read_only: false, aspect: null,
        constraints: { required: true, collection: false }, options: [], options_truncated: false },
    ], complex_groups: [] },
    draft: cloudRow(id).draft, validation_state: "draft", issues: [],
    ai_prompt_id: "", ai_prompt: "", ai_prompt_file_name: "",
    psd_template_asset_id: "", psd_template_file_name: "", target_store_id: "store",
    ai_field_policy: { allowed_field_keys: [], protected_field_keys: [] },
    lifecycle: rowStatusView(cloudRow(id)).lifecycle, updated_at_ms: 1,
  }
}
