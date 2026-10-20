import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { OzonStoreView } from "@/bindings/commands"
import { CardStoreChips } from "./card-store-chips"

function store(id: string, label: string): OzonStoreView {
  return {
    id,
    label,
    client_id: id,
    watermark_name: "",
    advertising_client_id: "",
    advertising_configured: false,
    configured: true,
    secret_status: "present",
    ref_id: id,
    updated_at_ms: 1,
    verified_at_ms: null,
    last_used_at_ms: null,
    active: true,
    cloud_store_uuid: id,
    create_order: null,
    cloud_status: "active",
    manual_disabled: null,
    quota_suspended: null,
    cloud_revision: null,
    credential_revision: null,
    needs_reentry: false,
    can_manage: true,
    can_edit_credential: true,
    permissions: { manage_store: true, edit_name: true, manage_key_grants: true, manage_tags: true, test_key: true, manage_key: true, delete_store: true },
    assignee_key_manage: true,
  }
}

test("card store chips stay nowrap and disclose overflow", () => {
  const html = renderToStaticMarkup(
    <CardStoreChips
      storeIdString="s1,s2,s3,s4"
      stores={[
        store("s1", "莫斯科仓"),
        store("s2", "彼得堡仓"),
        store("s3", "喀山仓"),
        store("s4", "新西伯利亚仓"),
      ]}
    />,
  )
  assert.match(html, /data-testid="card-store-chips"/)
  assert.match(html, /whitespace-nowrap/)
  assert.match(html, /莫斯科仓/)
  assert.match(html, /彼得堡仓/)
  assert.doesNotMatch(html, />喀山仓</)
  assert.match(html, /\+2/)
  assert.match(html, /title="喀山仓、新西伯利亚仓"/)
  assert.doesNotMatch(html, /flex-wrap/)
})
