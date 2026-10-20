import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { OzonStoreView } from "@/bindings/commands"
import { bindFormIssues, CardBindForm } from "./card-bind-form"
import { emptyTreeSelection } from "@/features/category-schema/category-tree"

function store(overrides: Partial<OzonStoreView> = {}): OzonStoreView {
  return {
    id: "store-h1",
    label: "H1",
    client_id: "4293909",
    watermark_name: "",
    advertising_client_id: "",
    advertising_configured: false,
    configured: true,
    secret_status: "absent",
    ref_id: "ozon:store-h1",
    updated_at_ms: 0,
    verified_at_ms: 1,
    last_used_at_ms: null,
    active: false,
    cloud_store_uuid: "store-h1",
    create_order: 1,
    cloud_status: "active",
    manual_disabled: false,
    quota_suspended: false,
    cloud_revision: 1,
    credential_revision: 2,
    needs_reentry: true,
    can_manage: true,
    can_edit_credential: true,
    permissions: { manage_store: true, edit_name: true, manage_key_grants: true, manage_tags: true, test_key: true, manage_key: true, delete_store: true },
    assignee_key_manage: true,
    ...overrides,
  }
}

const bindHandlers = {
  onNameChange: () => undefined,
  onStoreChange: () => undefined,
  onSelectL1: () => undefined,
  onSelectL2: () => undefined,
  onSelectType: () => undefined,
  onRefreshTree: () => undefined,
  onPickPsd: () => undefined,
  onPromptChange: () => undefined,
}

test("failed submit lists each missing 上架基础信息 field for the toast detail", () => {
  const issues = bindFormIssues({
    idPrefix: "compose",
    name: "",
    descriptionCategoryId: 0,
    typeId: 0,
    promptId: "",
  })
  assert.deepEqual(
    issues.map((issue) => issue.fieldId),
    ["compose-name", "compose-category-search", "compose-prompt"],
  )
})

test("a Card with a category and prompt saves without a Store or a PSD", () => {
  const issues = bindFormIssues({
    idPrefix: "compose",
    name: "装饰画",
    descriptionCategoryId: 17027906,
    typeId: 91976,
    promptId: "prompt-1",
  })
  assert.deepEqual(issues, [])

  const html = renderToStaticMarkup(
    <CardBindForm
      idPrefix="compose"
      name="装饰画"
      tree={[]}
      selection={{ l1Id: 1, l2Id: 17027906, descriptionCategoryId: 17027906, typeId: 91976 }}
      stores={[]}
      storeId=""
      psdFileName=""
      prompts={[]}
      promptId="prompt-1"
      {...bindHandlers}
    />,
  )
  assert.match(html, /店铺.*可选 · 发送前绑定/s)
  assert.match(html, /PSD.*可选 · 切片前绑定/s)
})

test("missing Seller credentials SSR exposes an enabled Stores button", () => {
  let opened = 0
  const html = renderToStaticMarkup(
    <CardBindForm
      idPrefix="compose"
      name=""
      tree={[]}
      selection={emptyTreeSelection()}
      stores={[store({ configured: false })]}
      storeId="store-h1"
      psdFileName=""
      prompts={[]}
      promptId=""
      onOpenStores={() => {
        opened += 1
      }}
      {...bindHandlers}
    />,
  )

  assert.match(html, /role="status"/)
  assert.match(html, /Workspace 店铺密钥未配置/)
  assert.match(html, />打开店铺</)
  assert.match(html, /重新拉取/)
  assert.doesNotMatch(html, /先刷新类目/)
  assert.doesNotMatch(html, /选择一级类目/)
  const buttonAt = html.indexOf(">打开店铺<")
  const start = html.lastIndexOf("<button", buttonAt)
  const tag = html.slice(start, html.indexOf(">", buttonAt) + 1)
  assert.match(tag, /type="button"/)
  assert.doesNotMatch(tag, / disabled[=>]/)
  assert.equal(opened, 0)

})


test("缺少提示词时提交摘要列出提示词缺失", () => {
  const issues = bindFormIssues({
    idPrefix: "compose",
    name: "数字油画 · 40×50cm",
    descriptionCategoryId: 1,
    typeId: 2,
    promptId: "",
  })
  assert.deepEqual(
    issues.map((issue) => issue.fieldId),
    ["compose-prompt"],
  )
})
