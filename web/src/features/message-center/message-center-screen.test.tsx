import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AppShell } from "@/app/app-shell"
import { NotificationsProvider } from "@/features/notifications/notifications"

import type {
  MessageCenterChatItem,
  MessageCenterHistoryView,
  MessageCenterInboxView,
  MessageCenterStoreView,
} from "@/bindings/commands"
import { SCREEN_LABELS } from "@/lib/app-screens"

import {
  MessageCenterResults,
  MessageCenterScreen,
  SessionColumn,
  StoreColumn,
  ThreadColumn,
} from "./message-center-screen"

const inbox: MessageCenterInboxView = {
  stores: [
    {
      store_id: "11111111-1111-4111-8111-111111111111",
      name: "010",
      store_number: "10",
      fetched: true,
      fail_reason: "",
      unread_count: 12,
      session_count: 22,
      waiting_reply: true,
      chats: [
        {
          store_id: "11111111-1111-4111-8111-111111111111",
          chat_id: "f430eb",
          chat_status: "OPENED",
          chat_type: "SELLER_SUPPORT",
          session_kind: "ticket",
          created_at: "2026-07-20T09:43:00Z",
          unread_count: 1,
          last_message_id: "88",
          preview: "买家要一份 sku block list.csv",
        },
      ],
    },
    {
      store_id: "",
      name: "096",
      store_number: "96",
      fetched: false,
      fail_reason: "没有可用的店铺会话",
      unread_count: 0,
      session_count: 0,
      waiting_reply: false,
      chats: [],
    },
  ],
  failed_stores: [
    { store_id: "", name: "096", reason: "没有可用的店铺会话" },
  ],
  waiting_reply_count: 413,
  platform_notification_count: 14415,
  store_count: 100,
  waiting_reply_store_count: 79,
  session_count: 1690,
  failed_store_count: 1,
}

test("breadcrumb names 客服消息 and the screen has no duplicate h1", () => {
  assert.equal(SCREEN_LABELS["message-center"], "客服消息")
  const source = readFileSync(
    new URL("./message-center-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(source, /<h1/)
})

test("stats paint waiting-reply, fetch-fail live notice, and send uses chats API", () => {
  const html = renderToStaticMarkup(<MessageCenterResults inbox={inbox} />)
  assert.match(html, /413 条等你回复/)
  assert.match(html, /平台通知/)
  assert.match(html, /14,415|14415/)
  assert.match(html, /100 家店/)
  assert.doesNotMatch(html, /role="alert"/)
  assert.doesNotMatch(html, /一家店拉不到消息/)
  assert.doesNotMatch(html, /查看店铺/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /aria-atomic="true"/)
  const source = readFileSync(
    new URL("./message-center-screen.tsx", import.meta.url),
    "utf8",
  )
  // Partial fetch failures ride the persistent toast host, not the stats bar.
  assert.match(source, /notifyLive\(\{/)
  assert.match(source, /failedStoresNotice\(next\.failed_stores\)/)
  assert.match(source, /id: MESSAGE_CENTER_READ_LIVE/)
  assert.match(source, /action: \{ label: "刷新"/)
  assert.match(source, /opsHttp\.messageCenterInbox/)
  assert.match(source, /opsHttp\.messageCenterHistory/)
  assert.match(source, /opsHttp\.messageCenterSend/)
  assert.match(source, /sendRequestOf\(/)
  assert.match(source, /draftRu/)
  assert.match(source, /发送俄文/)
  assert.match(source, /Dialog/)
  assert.match(source, /htmlFor="mc-draft-zh"/)
  assert.match(source, /htmlFor="mc-draft-ru"/)
  assert.match(source, /htmlFor="mc-store-search"/)
  assert.doesNotMatch(source, /from "@\/components\/ui\/sheet"/)
  assert.doesNotMatch(source, /\bw-64\b/)
  assert.doesNotMatch(source, /resizable/)
  assert.doesNotMatch(source, /from "@\/components\/ui\/command"/)
  assert.doesNotMatch(source, /fake send|假发送/)
})

test("store list shows unread on one line and a brand ring on the selected store", () => {
  const html = renderToStaticMarkup(
    <StoreColumn
      stores={inbox.stores}
      total={100}
      waiting={79}
      selectedId="11111111-1111-4111-8111-111111111111"
      query=""
      filter="all"
      onQuery={() => {}}
      onFilter={() => {}}
      onSelect={() => {}}
    />,
  )
  assert.match(html, /79\/100/)
  assert.match(html, /只看待回复 79/)
  assert.match(html, /编号 10/)
  assert.match(html, /12 条未读/)
  assert.match(html, /htmlFor="mc-store-search"|for="mc-store-search"/)
  assert.match(html, /whitespace-nowrap/)
  assert.match(html, /ring-brand/)
  assert.match(html, /role="listbox"/)
})

test("the screen module lives under 运维 after 供货 and before 口碑", () => {
  const html = renderToStaticMarkup(
    <NotificationsProvider>
      <AppShell screen="message-center" onScreenChange={() => {}} onSignedOut={() => {}}>{null}</AppShell>
    </NotificationsProvider>,
  )
  const supplyAt = html.indexOf("入仓供货")
  const messageAt = html.indexOf("客服消息")
  const voiceAt = html.indexOf("评价口碑")
  assert.ok(supplyAt >= 0 && messageAt > supplyAt && voiceAt > messageAt)
  assert.doesNotMatch(html, /批量上架|店铺商品/)
})

test("MessageCenterScreen is the exported workbench", () => {
  assert.equal(typeof MessageCenterScreen, "function")
})

// —— 会话未读数与线程内容一致 ——
// 列表徽标的未读来自会话元数据，线程内容来自 history 的「可见」消息，
// 两条口径在 Ozon 侧可以对不齐。下面三例固定走查契约：不允许
// 「徽标 1 + 面板暂无消息」同屏。

const threadStore: MessageCenterStoreView = {
  store_id: "11111111-1111-4111-8111-111111111111",
  name: "010",
  store_number: "10",
  fetched: true,
  fail_reason: "",
  unread_count: 1,
  session_count: 1,
  waiting_reply: true,
  chats: [],
}

const unreadSession: MessageCenterChatItem = {
  store_id: threadStore.store_id,
  chat_id: "84fb1202",
  chat_status: "OPENED",
  chat_type: "BUYER_SELLER",
  session_kind: "buyer",
  created_at: "2026-07-15T01:39:00Z",
  unread_count: 1,
  last_message_id: "9",
  preview: "",
}

const historyWithMessage: MessageCenterHistoryView = {
  store_id: threadStore.store_id,
  chat_id: unreadSession.chat_id,
  has_next: false,
  messages: [
    {
      items: ["Здравствуйте"],
      total: 1,
    },
  ],
}

const emptyHistory: MessageCenterHistoryView = {
  store_id: threadStore.store_id,
  chat_id: unreadSession.chat_id,
  has_next: false,
  messages: [],
}

function renderThread(
  session: MessageCenterChatItem,
  history: MessageCenterHistoryView | null,
) {
  return renderToStaticMarkup(
    <ThreadColumn
      store={threadStore}
      session={session}
      history={history}
      historyLoading={false}
      showOriginal={true}
      onShowOriginal={() => {}}
      draftZh=""
      draftRu=""
      onDraftZh={() => {}}
      onDraftRu={() => {}}
      replies={[]}
      sending={false}
      onSend={() => {}}
    />,
  )
}

test("unread=1 with a visible thread message keeps badge and thread in step", () => {
  const list = renderToStaticMarkup(
    <SessionColumn
      kind="buyer"
      counts={{ buyer: 1, ticket: 0, platform: 0 }}
      sessions={[unreadSession]}
      selectedKey={`${unreadSession.store_id}:${unreadSession.chat_id}`}
      onKind={() => {}}
      onSelect={() => {}}
    />,
  )
  const thread = renderThread(unreadSession, historyWithMessage)
  // 徽标披露未读 1，线程确实给出那条消息——现状不回归，占位不出现。
  assert.match(list, /1 条未读/)
  assert.match(thread, /Здравствуйте/)
  assert.doesNotMatch(thread, /暂无消息/)
  assert.doesNotMatch(thread, /暂不可见/)
})

test("empty thread with metadata unread shows the note, not 暂无消息", () => {
  const html = renderThread(unreadSession, emptyHistory)
  assert.match(html, /1 条消息暂不可见（已归档或过期）/)
  assert.doesNotMatch(html, /暂无消息/)
})

test("empty thread with zero unread still says 暂无消息", () => {
  const html = renderThread({ ...unreadSession, unread_count: 0 }, emptyHistory)
  assert.match(html, /暂无消息/)
  assert.doesNotMatch(html, /暂不可见/)
})
