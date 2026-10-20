import assert from "node:assert/strict"
import test from "node:test"
import type { OzonStoreView } from "@/bindings/commands"
import {
  cardStoreAvailability,
  composeSellerCredentialIssue,
  defaultListingCardStoreId,
} from "./store-availability"

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
    assignee_name: "qyh",
    assignee_membership_id: 1,
    assignee_email: "qyh@example.com",
    can_manage: true,
    can_edit_credential: true,
    permissions: { manage_store: true, edit_name: true, manage_key_grants: true, manage_tags: true, test_key: true, manage_key: true, delete_store: true },
    assignee_key_manage: true,
    ...overrides,
  }
}

test("card store availability uses Cloud custody and the active Workspace", () => {
  assert.deepEqual(cardStoreAvailability("store-h1", [store()]), {
    ready: true,
    label: "H1",
  })

  assert.deepEqual(cardStoreAvailability("store-old", [store({ id: "store-ready" })]), {
    ready: false,
    label: "不在当前 Workspace",
    issue: {
      title: "绑定店铺不在当前 Workspace",
      description: "这个上架方案绑定的店铺已删除或属于其他 Workspace，请编辑上架方案重新选择",
      action: "edit-card",
      actionLabel: "返回上架方案",
    },
  })

  assert.deepEqual(
    cardStoreAvailability("store-h1", [store({ needs_reentry: false, secret_status: "present" })]),
    { ready: true, label: "H1" },
  )
})

test("missing Seller credentials are an operable jump to 店铺", () => {
  const missing = store({ configured: false, cloud_store_uuid: "store-h1" })
  assert.deepEqual(composeSellerCredentialIssue("store-h1", [missing]), {
    title: "Workspace 店铺密钥未配置",
    description: "请到「店铺」为 H1 配置 Seller 密钥",
    action: "open-stores",
    actionLabel: "打开店铺",
  })
  assert.equal(composeSellerCredentialIssue("store-h1", [store()]), undefined)
  assert.equal(composeSellerCredentialIssue("", [store()]), undefined)
  assert.equal(composeSellerCredentialIssue("", [missing])?.action, "open-stores")
  assert.equal(composeSellerCredentialIssue("", [])?.actionLabel, "打开店铺")
})

test("a lapsed Seller key is an operable 密钥过期 issue, not a capacity one", () => {
  const now = Date.now()
  const expired = store({ key_expires_at_ms: now - 1 })
  assert.deepEqual(cardStoreAvailability("store-h1", [expired]), {
    ready: false,
    label: "H1",
    issue: {
      title: "店铺密钥已过期",
      description:
        "店铺密钥已过期；请在卖家后台重新生成密钥并在店铺设置登记后重新发送：H1",
      action: "open-stores",
      actionLabel: "打开店铺",
    },
  })
  // The same jump serves the create-dialog category fetch gate.
  assert.equal(composeSellerCredentialIssue("store-h1", [expired])?.title, "店铺密钥已过期")
  // A store with no key of its own still reads as unconfigured, not expired.
  assert.equal(
    composeSellerCredentialIssue(
      "store-h1",
      [store({ key_expires_at_ms: now - 1, configured: false })],
    )?.title,
    "Workspace 店铺密钥未配置",
  )
  // Future expiry and the legacy never-expiring key stay usable.
  assert.deepEqual(
    cardStoreAvailability("store-h1", [store({ key_expires_at_ms: now + 60_000 })]),
    { ready: true, label: "H1" },
  )
  assert.deepEqual(cardStoreAvailability("store-h1", [store({ key_expires_at_ms: null })]), {
    ready: true,
    label: "H1",
  })
})

test("default listing-card store prefers a configured fallback", () => {
  const ready = store()
  const other = store({
    id: "store-other",
    label: "Other",
    cloud_store_uuid: "store-other",
  })
  assert.equal(defaultListingCardStoreId([ready, other], "store-other"), "store-other")
  assert.equal(defaultListingCardStoreId([ready, other], ""), "store-h1")
  assert.equal(
    defaultListingCardStoreId(
      [store({ configured: false, cloud_store_uuid: "store-h1" })],
      "store-h1",
    ),
    "store-h1",
  )
})
