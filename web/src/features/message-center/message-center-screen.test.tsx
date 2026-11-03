import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ComponentProps } from "react"
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
  assert.match(source, /\.messageCenterHistory/)
  assert.match(source, /sendAndReadMessage/)
  assert.match(source, /sendRequestOf\(/)
  assert.match(source, /draftRu/)
  assert.match(source, /发送俄文/)
  assert.match(source, /Dialog/)
  assert.match(source, /htmlFor="mc-draft-zh"/)
  assert.match(source, /htmlFor="mc-draft-ru"/)
  assert.match(source, /htmlFor="mc-store-search"/)
  assert.doesNotMatch(source, /from "@\/components\/ui\/sheet"/)
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
  assert.match(html, /aria-label="筛选店铺"/)
  assert.match(html, /编号 10/)
  assert.match(html, /12 条未读/)
  assert.match(html, /whitespace-nowrap/)
  assert.match(html, /ring-brand/)
  assert.match(html, /role="listbox"/)
})

test("empty store panel distinguishes no stores from an unreadable roster", () => {
  const props = {
    stores: [], total: 0, waiting: 0, selectedId: "", query: "", filter: "all" as const,
    onQuery: () => {}, onFilter: () => {}, onSelect: () => {},
  }
  const noStores = renderToStaticMarkup(<StoreColumn {...props} noStores onOpenStores={() => {}} />)
  assert.match(noStores, /还没有店铺/)
  assert.match(noStores, /打开店铺/)
  const unknown = renderToStaticMarkup(<StoreColumn {...props} loaded={false} />)
  assert.match(unknown, /店铺状态未知，请刷新/)
  assert.doesNotMatch(unknown, /还没有店铺/)
})

test("the customer-service destinations remain after fulfilment in the grouped navigation", () => {
  const html = renderToStaticMarkup(
    <NotificationsProvider>
      <AppShell screen="message-center" onScreenChange={() => {}} onSignedOut={() => {}}>{null}</AppShell>
    </NotificationsProvider>,
  )
  const supplyAt = html.indexOf("入仓供货")
  const messageAt = html.indexOf("客服消息")
  const voiceAt = html.indexOf("评价口碑")
  assert.ok(supplyAt >= 0 && messageAt > supplyAt && voiceAt > messageAt)
  assert.match(html, /批量上架/)
  assert.match(html, /aria-label="我的商品"/)
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
      message_id: "9",
      user_type: "Support",
      created_at: "2026-07-15T01:39:00Z",
      is_read: true,
      is_image: false,
      data: ["Здравствуйте"],
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
  props: Partial<ComponentProps<typeof ThreadColumn>> = {},
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
      {...props}
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
      query=""
      status="all"
      onKind={() => {}}
      onQuery={() => {}}
      onStatus={() => {}}
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

test("history renders the real message shape, sender and timestamp", () => {
  const html = renderThread(unreadSession, historyWithMessage)
  assert.match(html, /客服/)
  assert.match(html, /Здравствуйте/)
  assert.match(html, /dateTime="2026-07-15T01:39:00Z"|datetime="2026-07-15T01:39:00Z"/)
})

test("image messages are labelled and expose only safe image links", () => {
  const html = renderThread(unreadSession, {
    ...historyWithMessage,
    messages: [{
      message_id: "10", user_type: "NotificationUser", created_at: "", is_read: false, is_image: true,
      data: ["https://example.test/image.png", "javascript:alert(1)"],
    }],
  })
  assert.match(html, /平台通知/)
  assert.match(html, /图片消息/)
  assert.match(html, /href="https:\/\/example\.test\/image\.png"/)
  assert.match(html, /查看图片/)
  assert.doesNotMatch(html, /javascript:alert/)
})

test("missing message fields stay readable without crashing", () => {
  const html = renderThread(unreadSession, {
    ...historyWithMessage,
    messages: [null as unknown as MessageCenterHistoryView["messages"][number], { data: ["可读取内容"] } as MessageCenterHistoryView["messages"][number]],
  })
  assert.match(html, /发送方未知/)
  assert.match(html, /消息类型未知/)
  assert.match(html, /消息内容不可用/)
  assert.match(html, /可读取内容/)
})

test("filtering keeps the current conversation identified when it is hidden", () => {
  const html = renderToStaticMarkup(
    <SessionColumn
      kind="buyer"
      counts={{ buyer: 1, ticket: 0, platform: 0 }}
      sessions={[]}
      selectedKey={`${unreadSession.store_id}:${unreadSession.chat_id}`}
      query="未匹配"
      status="all"
      onKind={() => {}}
      onQuery={() => {}}
      onStatus={() => {}}
      onSelect={() => {}}
    />,
  )
  assert.match(html, /搜索会话编号或消息/)
  assert.match(html, /会话状态/)
  assert.match(html, /当前会话不在筛选结果中/)
  assert.match(html, /没有符合条件的会话/)
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

test("history from another store never appears under a matching chat ID", () => {
  const html = renderThread(unreadSession, { ...historyWithMessage, store_id: "another-store" })
  assert.doesNotMatch(html, /Здравствуйте/)
  assert.match(html, /正在读取会话/)
  assert.doesNotMatch(html, /暂无消息/)
})

test("a failed history read offers retry without claiming an empty conversation", () => {
  const html = renderThread(unreadSession, null, { historyFailed: true, onRetryHistory: () => {} })
  assert.match(html, /会话内容未能读取/)
  assert.match(html, /重试/)
  assert.doesNotMatch(html, /正在读取会话|暂无消息/)
})

test("a refresh failure retains the messages already read", () => {
  const html = renderThread(unreadSession, historyWithMessage, { historyFailed: true })
  assert.match(html, /会话内容未能读取/)
  assert.match(html, /Здравствуйте/)
})

test("a Chinese private draft cannot enable sending an empty Russian reply", () => {
  const html = renderThread(unreadSession, historyWithMessage, { draftZh: "这是私人备忘" })
  assert.match(html, /这是私人备忘/)
  assert.match(html, /本页未接入翻译/)
  const send = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes("发送俄文"))
  assert.ok(send)
  assert.match(send, /disabled/)
  assert.match(html, /id="mc-draft-ru"[^>]*lang="ru"/)
})

test("closed conversations and platform notices remain read-only", () => {
  for (const session of [
    { ...unreadSession, chat_status: "CLOSED" },
    { ...unreadSession, session_kind: "platform" },
  ]) {
    const html = renderThread(session, historyWithMessage)
    assert.doesNotMatch(html, /id="mc-draft-ru"|发送俄文/)
    assert.match(html, /无法回复|不支持回复/)
  }
})
