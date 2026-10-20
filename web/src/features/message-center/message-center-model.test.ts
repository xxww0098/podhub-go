import assert from "node:assert/strict"
import test from "node:test"

import type {
  MessageCenterChatItem,
  MessageCenterInboxView,
  MessageCenterStoreView,
  OzonStoreView,
} from "@/bindings/commands"

import {
  discloseUnread,
  failedStoreCount,
  failedStoresNotice,
  filterSessions,
  filterStores,
  inboxRequestOf,
  inboxStoresFromRoster,
  invisibleUnreadNote,
  sendRequestOf,
  sessionKindOf,
  unreadLiveStatus,
} from "./message-center-model"

const chat = (
  overrides: Partial<MessageCenterChatItem> = {},
): MessageCenterChatItem => ({
  store_id: "11111111-1111-4111-8111-111111111111",
  chat_id: "c-buyer",
  chat_status: "OPENED",
  chat_type: "BUYER_SELLER",
  session_kind: "buyer",
  created_at: "2026-08-10T09:14:22Z",
  unread_count: 2,
  last_message_id: "9",
  preview: "",
  ...overrides,
})

const store = (
  overrides: Partial<MessageCenterStoreView> = {},
): MessageCenterStoreView => ({
  store_id: "11111111-1111-4111-8111-111111111111",
  name: "010",
  store_number: "10",
  fetched: true,
  fail_reason: "",
  unread_count: 2,
  session_count: 1,
  waiting_reply: true,
  chats: [chat()],
  ...overrides,
})

test("roster stores without a Cloud session stay in the inbox request", () => {
  const stores: OzonStoreView[] = [
    {
      id: "local-1",
      label: "有会话",
      client_id: "9",
      watermark_name: "",
      advertising_client_id: "",
      advertising_configured: false,
      configured: true,
      secret_status: "present",
      ref_id: "ref-1",
      updated_at_ms: 0,
      verified_at_ms: null,
      last_used_at_ms: null,
      active: true,
      cloud_store_uuid: "11111111-1111-4111-8111-111111111111",
      create_order: 9,
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
      id: "local-2",
      label: "无会话",
      client_id: "8",
      watermark_name: "",
      advertising_client_id: "",
      advertising_configured: false,
      configured: false,
      secret_status: "absent",
      ref_id: "ref-2",
      updated_at_ms: 0,
      verified_at_ms: null,
      last_used_at_ms: null,
      active: false,
      cloud_store_uuid: null,
      create_order: 8,
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
  const request = inboxRequestOf(inboxStoresFromRoster(stores))
  assert.equal(request.stores.length, 2)
  assert.equal(request.stores[1].store_id, "")
  assert.equal(request.stores[1].name, "无会话")
})

test("a lapsed Seller key never enters the inbox request", () => {
  const rosterStore: OzonStoreView = {
    id: "cloud-1",
    label: "过期店",
    client_id: "9",
    watermark_name: "",
    advertising_client_id: "",
    advertising_configured: false,
    configured: true,
    secret_status: "present",
    ref_id: "ref-1",
    updated_at_ms: 0,
    verified_at_ms: null,
    last_used_at_ms: null,
    active: false,
    cloud_store_uuid: "11111111-1111-4111-8111-111111111111",
    create_order: 9,
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
  }
  const request = inboxRequestOf(
    inboxStoresFromRoster([
      { ...rosterStore, key_expires_at_ms: Date.now() - 1 },
      { ...rosterStore, key_expires_at_ms: Date.now() + 60_000 },
      { ...rosterStore, key_expires_at_ms: null },
    ]),
  )
  // The expired Store is dropped; the future-dated and legacy keys stay.
  assert.equal(request.stores.length, 2)
  assert.ok(request.stores.every((row) => row.name === "过期店"))
})

test("failed stores are counted and empty success is not a fetch fail", () => {
  const view: MessageCenterInboxView = {
    stores: [
      store(),
      store({
        store_id: "22222222-2222-4222-8222-222222222222",
        name: "空店",
        fetched: true,
        unread_count: 0,
        session_count: 0,
        waiting_reply: false,
        chats: [],
      }),
      store({
        store_id: "",
        name: "无会话",
        fetched: false,
        fail_reason: "没有可用的店铺会话",
        unread_count: 0,
        session_count: 0,
        waiting_reply: false,
        chats: [],
      }),
      store({
        store_id: "33333333-3333-4333-8333-333333333333",
        name: "坏店",
        fetched: false,
        fail_reason: "CHAT_LIST_DOWN",
        unread_count: 0,
        session_count: 0,
        waiting_reply: false,
        chats: [],
      }),
    ],
    failed_stores: [
      { store_id: "", name: "无会话", reason: "没有可用的店铺会话" },
      {
        store_id: "33333333-3333-4333-8333-333333333333",
        name: "坏店",
        reason: "CHAT_LIST_DOWN",
      },
    ],
    waiting_reply_count: 2,
    platform_notification_count: 0,
    store_count: 4,
    waiting_reply_store_count: 1,
    session_count: 1,
    failed_store_count: 2,
  }
  assert.equal(failedStoreCount(view), 2)
  assert.equal(failedStoresNotice(view.failed_stores.slice(0, 1)), "一家店拉不到消息")
  assert.equal(failedStoresNotice(view.failed_stores), "2 家店拉不到消息")
  assert.equal(filterStores(view.stores, "", "waiting").length, 1)
  assert.equal(filterStores(view.stores, "无会话", "all")[0]?.name, "无会话")
})

test("session tabs keep buyer tickets and platform apart", () => {
  const chats = [
    chat(),
    chat({
      chat_id: "c-ticket",
      chat_type: "SELLER_SUPPORT",
      session_kind: "ticket",
    }),
    chat({
      chat_id: "c-note",
      chat_type: "Seller_Notification",
      session_kind: "platform",
    }),
  ]
  assert.equal(filterSessions(chats, "buyer").length, 1)
  assert.equal(filterSessions(chats, "ticket")[0]?.chat_id, "c-ticket")
  assert.equal(sessionKindOf(chats[2]), "platform")
})

test("send payload is the Russian text on chats.send_message_v1 types", () => {
  const request = sendRequestOf(
    "11111111-1111-4111-8111-111111111111",
    "c-buyer",
    "  Здравствуйте  ",
  )
  assert.equal(request.store_id, "11111111-1111-4111-8111-111111111111")
  assert.equal(request.chat_id, "c-buyer")
  assert.equal(request.text, "Здравствуйте")
  assert.equal(discloseUnread(413), "413")
  assert.equal(unreadLiveStatus(3), "3 条未读")
})

test("invisible-unread note discloses the metadata count", () => {
  assert.equal(invisibleUnreadNote(1), "1 条消息暂不可见（已归档或过期）")
  assert.equal(invisibleUnreadNote(1200), "1,200 条消息暂不可见（已归档或过期）")
  assert.equal(invisibleUnreadNote(0), "0 条消息暂不可见（已归档或过期）")
})
