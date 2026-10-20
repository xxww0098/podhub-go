import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CardStorePicker } from "./card-store-picker"
import type { OzonStoreView } from "@/bindings/commands"

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
    cloud_store_uuid: "cloud-1",
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
    cloud_store_uuid: "cloud-2",
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
    permissions: { manage_store: true, edit_name: true, manage_key_grants: true, manage_tags: true, test_key: true, manage_key: true, delete_store: true },
  },
]

const source = readFileSync(new URL("./card-store-picker.tsx", import.meta.url), "utf8")

test("绑定店铺弹层文案：勾选后自动保存，歧义措辞不再出现", () => {
  // 「勾选后关闭自动保存」读作两个动作（勾选、关闭），实际勾选即存。
  assert.match(source, /勾选后自动保存/)
  assert.doesNotMatch(source, /勾选后关闭自动保存/)
})

test("勾选即关：一次勾选立即收起并落盘；未改动的关闭不写", () => {
  // 每次勾选/取消都走 handleDraftChange → 立即 commitSelection（收起 +
  // 按需写），不再要求点外部收起。模块测试无 DOM 交互，行为以接线为准，
  // 交互路径由浏览器走查页覆盖。
  assert.match(source, /onChange=\{handleDraftChange\}/)
  assert.match(source, /function handleDraftChange\([\s\S]*?commitSelection\(next\)/)
  // 取消路径仍在：commitSelection 先比对 formatStoreIds，选择未变就不触发
  // onCommit——点外部/Esc 关闭一个没动过的弹层是一次也不写。
  assert.match(source, /formatStoreIds\(ids\) === formatStoreIds\(savedIds\)/)
})

test("bound trigger paints chips with the full roster label", () => {
  const html = renderToStaticMarkup(
    <CardStorePicker
      storeIdString="store_1,store_2"
      stores={stores}
      onCommit={async () => true}
    />,
  )
  assert.match(html, /aria-label="店铺绑定：店铺1、店铺2"/)
  assert.match(html, /data-testid="card-store-chips"/)
  assert.match(html, /店铺1/)
})

test("unbound trigger stays the dashed 绑定店铺 affordance", () => {
  const html = renderToStaticMarkup(
    <CardStorePicker
      storeIdString=""
      stores={stores}
      onCommit={async () => true}
    />,
  )
  assert.match(html, /aria-label="绑定店铺"/)
  assert.match(html, /绑定店铺/)
})
