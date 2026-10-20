import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { shouldOpenAccount } from "../src/features/stores/stores-error"

// The roster commands moved into their own hook so every entry point answers a
// refusal the same way; these assertions follow them there.
const storeCommands = readFileSync(
  new URL("../src/features/stores/use-store-commands.ts", import.meta.url),
  "utf8",
)
/** The editor's permission gates moved with its state into \`use-store-editor\`. */
const storeEditor = readFileSync(
  new URL("../src/features/stores/use-store-editor.ts", import.meta.url),
  "utf8",
)

test("only not-signed-in errors route Store verification to Settings", () => {
  assert.equal(
    shouldOpenAccount({
      code: "cloud_auth_required",
      message: "register",
      remediation: null,
    }),
    true,
  )
  assert.equal(
    shouldOpenAccount({
      code: "cloud_auth_invalid",
      message: "register",
      remediation: null,
    }),
    true,
  )
  assert.equal(shouldOpenAccount({ code: "ozon_credentials_rejected" }), false)
  assert.equal(shouldOpenAccount(new Error("network")), false)
  assert.equal(shouldOpenAccount("account_not_authenticated"), false)
})

// The editor's 可选配置 side panel died with the device secret file: the
// watermark name and the Performance API credentials only ever lived in
// `secrets.json`, and Cloud has no home for them.
test("the store editor edits the Seller identity and nothing that has no Cloud home", () => {
  const source = readFileSync(
    new URL("../src/features/stores/stores-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(source, /OptionalConfigTrigger|store-optional-panel|可选配置/)
  assert.doesNotMatch(source, /watermarkName|advertisingClientId|advertisingClientSecret/)
  assert.doesNotMatch(source, /<details/)
  assert.match(source, /id="store-api-key"/)
  assert.match(source, /允许指派人管理密钥/)
  assert.doesNotMatch(source, /指派人密钥权限/)
})

test("new store draft accepts credentials in one step", () => {
  const source = readFileSync(
    new URL("../src/features/stores/stores-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(storeEditor, /const canManageKey =\s*draft && !draft\.id \? true/)
  assert.match(storeCommands, /async function saveKey\(\)/)
  assert.match(storeCommands, /integrationsUpsertOzonStore/)
  assert.match(storeCommands, /integrationsCreateOzonStore/)
  assert.doesNotMatch(source, /先保存店铺名称，再登记密钥/)
  assert.doesNotMatch(source, /disabled=\{!draft.id \|\| !canManageKey/)
})

test("store roster exposes recent use and slot-releasing removal", () => {
  const source = readFileSync(
    new URL("../src/features/stores/stores-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /<TableHead>归属<\/TableHead>/)
  assert.match(source, /<TableHead>分组<\/TableHead>/)
  assert.doesNotMatch(source, /<TableHead>密钥<\/TableHead>/)
  assert.match(source, /<TableHead>最近使用<\/TableHead>/)
  assert.match(source, /期末余额/)
  assert.match(source, /store\.assignee_email/)
  assert.match(source, /store\.last_used_at_ms/)
  // 名额门集中在 createStoreGate：canCreate 与禁用文案同源，不再分叉。
  assert.match(source, /input\.storesUsed >= input\.storeLimit/)
  assert.match(source, /移除店铺并释放名额/)
  assert.match(source, /只删除托管密钥，店铺仍占用名额/)
})

// Every Store is the Workspace's; the 归属 column names its one Assignee or reads
// 未分配 (docs/workspace-store-credentials.md §6). The private / shared split is gone.
test("store roster names the assignee and lets a manager reassign", () => {
  const source = readFileSync(
    new URL("../src/features/stores/stores-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(source, /私有|工作空间共享|owner_name|owner_membership_id/)
  assert.match(source, /store\.assignee_name \?/)
  assert.match(source, /未分配/)
  assert.match(storeCommands, /integrationsAssignOzonStore/)
  // The picker is painted only for a manager; a member reads a plain label.
  assert.match(source, /permissions\.manage_store && members \?/)
})

test("store mutation actions follow the Workspace role, not merely having a Workspace", () => {
  const source = readFileSync(
    new URL("../src/features/stores/stores-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /store\.permissions\.manage_key/)
  assert.match(source, /store\.permissions\.manage_store/)
  assert.match(source, /没有修改这家店的权限/)
  assert.match(source, /mutateDisabledReason !== undefined/)
  assert.match(storeEditor, /workspaceRole === "owner" \|\| workspaceRole === "manager"/)
  // The create gate is one pure function: its canCreate and the disabled
  // tooltip reason share a chain, so a grey button can never lose its why.
  assert.match(source, /const \{ canCreate, disabledReason: createDisabledReason \} = createStoreGate/)
  assert.doesNotMatch(source, /只有 Workspace 所有者或管理员可以新增店铺/)
})

// Multi-select only ever offers what a single row can do: row checkboxes are
// gated by canDeleteStore, so batch delete never mixes in stores the operator
// cannot remove; batch test reuses the same Cloud verification command.
test("store roster multi-selects with checkboxes and batch actions", () => {
  const source = readFileSync(
    new URL("../src/features/stores/stores-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /indeterminate=\{\s*someManageableSelected && !allManageableSelected/)
  assert.match(source, /disabled=\{!canDeleteStore\(store\)\}/)
  assert.match(source, /selectedStores\.map\(\(store\) => store\.id\)/)
  assert.match(storeCommands, /async function testStores\(/)
  assert.match(storeCommands, /async function deleteStores\(/)
})

// The keyword search narrows the painted roster exactly like the tag filter:
// matching lives in store-search.ts, the toolbar reports the narrowed count,
// and a zero-match keyword paints the filtered-empty state instead of a bare
// header with no rows.
test("store roster filters by keyword on the left of the toolbar", () => {
  const source = readFileSync(
    new URL("../src/features/stores/stores-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /filterStoresBySearch/)
  assert.match(source, /aria-label="搜索店铺"/)
  assert.match(source, /显示 \{visibleStores\.length\} 家/)
  assert.match(source, /visibleStores\.length === 0/)
})

