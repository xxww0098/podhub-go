import test from "node:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { StoreCheckList, StoreMultiSelect } from "./store-multi-select"
import type { OzonStoreView } from "@/bindings/commands"

test("StoreMultiSelect renders cleanly without crash", () => {
  const stores: OzonStoreView[] = [
    {
      id: "store_1",
      label: "店铺1",
      client_id: "client_1",
      watermark_name: "",
      advertising_client_id: "",
      advertising_configured: false,
      configured: true,
      secret_status: "present",
      ref_id: "ref_1",
      updated_at_ms: 1000,
      verified_at_ms: null,
      last_used_at_ms: null,
      active: true,
      cloud_store_uuid: null,
      create_order: null,
      cloud_status: null,
      manual_disabled: null,
      quota_suspended: null,
      cloud_revision: null,
      credential_revision: null,
      needs_reentry: false,
      can_manage: true,
    can_edit_credential: true,
    assignee_key_manage: true,
    permissions: { manage_store: true, edit_name: true, manage_key_grants: true, manage_tags: true, test_key: true, manage_key: true, delete_store: true },
    },
    {
      id: "store_2",
      label: "店铺2",
      client_id: "client_2",
      watermark_name: "",
      advertising_client_id: "",
      advertising_configured: false,
      configured: true,
      secret_status: "present",
      ref_id: "ref_2",
      updated_at_ms: 1000,
      verified_at_ms: null,
      last_used_at_ms: null,
      active: false,
      cloud_store_uuid: null,
      create_order: null,
      cloud_status: null,
      manual_disabled: null,
      quota_suspended: null,
      cloud_revision: null,
      credential_revision: null,
      needs_reentry: false,
      can_manage: true,
    can_edit_credential: true,
    assignee_key_manage: true,
    permissions: { manage_store: true, edit_name: true, manage_key_grants: true, manage_tags: true, test_key: true, manage_key: true, delete_store: true },
    },
  ]

  const html = renderToStaticMarkup(
    <StoreMultiSelect
      stores={stores}
      selectedStoreIds={["store_1", "store_2"]}
      onChange={() => {}}
    />,
  )

  assert.ok(html.includes("店铺1、店铺2"))
  assert.ok(!html.includes("已选 2 家店铺："))
  assert.ok(!html.includes("client_1"))
})

test("StoreMultiSelect handles empty and unconfigured stores safely", () => {
  const html = renderToStaticMarkup(
    <StoreMultiSelect
      stores={[]}
      selectedStoreIds={[]}
      onChange={() => {}}
    />,
  )

  assert.ok(html.includes("选择绑定店铺"))
})

test("a lapsed key is badged 密钥已过期 instead of a generic unavailable", () => {
  const expired: OzonStoreView = {
    id: "store-old",
    label: "过期店",
    client_id: "client_old",
    watermark_name: "",
    advertising_client_id: "",
    advertising_configured: false,
    configured: true,
    secret_status: "present",
    ref_id: "ref_old",
    updated_at_ms: 1000,
    verified_at_ms: null,
    last_used_at_ms: null,
    key_expires_at_ms: Date.now() - 1,
    active: false,
    cloud_store_uuid: "cloud-old",
    create_order: null,
    cloud_status: "active",
    manual_disabled: false,
    quota_suspended: false,
    cloud_revision: 1,
    credential_revision: 1,
    needs_reentry: false,
    can_manage: true,
    can_edit_credential: true,
    assignee_key_manage: true,
    permissions: { manage_store: true, edit_name: true, manage_key_grants: true, manage_tags: true, test_key: false, manage_key: true, delete_store: true },
  }

  // The closed `StoreMultiSelect` trigger paints only labels, so the row's
  // badge is read from the list the picker mounts when opened.
  const html = renderToStaticMarkup(
    <StoreCheckList
      stores={[expired]}
      selectedStoreIds={[]}
      onChange={() => {}}
    />,
  )

  assert.ok(html.includes("密钥已过期"))
  // A new binding is barred until the key is re-registered.
  assert.ok(html.includes("disabled"))
})
