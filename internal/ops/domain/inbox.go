package domain

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

const inboxChatLimit = 100

type InboxStore struct {
	StoreID     string
	Name        string
	StoreNumber string
}

func DecodeInbox(raw []byte) ([]InboxStore, error) {
	m, err := object(raw, "stores")
	if err != nil {
		return nil, err
	}
	rawStores, ok := m["stores"]
	if !ok {
		return nil, errJSON
	}
	var rows []map[string]json.RawMessage
	if json.Unmarshal(rawStores, &rows) != nil {
		return nil, errJSON
	}
	out := make([]InboxStore, 0, len(rows))
	for _, row := range rows {
		store, ok, err := rawString(row, "store_id")
		if err != nil || !ok {
			return nil, errJSON
		}
		name, ok, err := rawString(row, "name")
		if err != nil || !ok {
			return nil, errJSON
		}
		num, _, err := rawString(row, "store_number")
		if err != nil {
			return nil, err
		}
		out = append(out, InboxStore{StoreID: store, Name: name, StoreNumber: num})
	}
	return out, nil
}

type inboxChat struct {
	StoreID       string `json:"store_id"`
	ChatID        string `json:"chat_id"`
	ChatStatus    string `json:"chat_status"`
	ChatType      string `json:"chat_type"`
	SessionKind   string `json:"session_kind"`
	CreatedAt     string `json:"created_at"`
	UnreadCount   int64  `json:"unread_count"`
	LastMessageID string `json:"last_message_id"`
	Preview       string `json:"preview"`
}

// StoreInbox is one store after its chat list, success or row failure.
type StoreInbox struct {
	StoreID      string      `json:"store_id"`
	Name         string      `json:"name"`
	StoreNumber  string      `json:"store_number"`
	Fetched      bool        `json:"fetched"`
	FailReason   string      `json:"fail_reason"`
	UnreadCount  int64       `json:"unread_count"`
	SessionCount int64       `json:"session_count"`
	WaitingReply bool        `json:"waiting_reply"`
	Chats        []inboxChat `json:"chats"`
}

type failedStore struct {
	StoreID string `json:"store_id"`
	Name    string `json:"name"`
	Reason  string `json:"reason"`
}

type inboxView struct {
	Stores                    []StoreInbox  `json:"stores"`
	FailedStores              []failedStore `json:"failed_stores"`
	WaitingReplyCount         int64         `json:"waiting_reply_count"`
	PlatformNotificationCount int64         `json:"platform_notification_count"`
	StoreCount                int64         `json:"store_count"`
	WaitingReplyStoreCount    int64         `json:"waiting_reply_store_count"`
	SessionCount              int64         `json:"session_count"`
	FailedStoreCount          int64         `json:"failed_store_count"`
}

// FetchInbox reads one store. admit is the caller's admission message; empty means the store was admitted.
func FetchInbox(ref InboxStore, admit string, fetch Fetch) StoreInbox {
	view := StoreInbox{StoreID: ref.StoreID, Name: ref.Name, StoreNumber: ref.StoreNumber, Chats: []inboxChat{}}
	if strings.TrimSpace(ref.StoreID) == "" {
		view.FailReason = "没有可用的店铺会话"
		return view
	}
	if admit != "" {
		view.FailReason = admit
		return view
	}
	body, _ := compact(map[string]any{"filter": map[string]any{}, "limit": inboxChatLimit})
	page := fetch("POST", chatList, body)
	if page.Err != nil && page.Status == 0 {
		if f := Egress(page.Err, contract.CodeMessage); f != nil {
			view.FailReason = f.Message
			return view
		}
	}
	if page.Status < 200 || page.Status >= 300 {
		view.FailReason = readMessage("读取 Ozon 聊天", chatList, page.Status, page.Body, page.Err)
		return view
	}
	root := asObject(page.Body)
	rows := arr(root, "chats")
	seen := map[string]struct{}{}
	for _, row := range rows {
		chat := nested(row, "chat")
		id := strings.TrimSpace(fieldString(chat, "chat_id"))
		unread := fieldI64(row, "unread_count")
		if unread < 0 {
			view.FailReason = "Ozon 聊天响应不完整：存在负数未读计数"
			view.Chats = []inboxChat{}
			return view
		}
		if chat == nil || id == "" {
			view.FailReason = "Ozon 聊天响应不完整：存在空身份"
			view.Chats = []inboxChat{}
			return view
		}
		if _, ok := seen[id]; ok {
			view.FailReason = "Ozon 聊天响应不完整：同页身份重复"
			view.Chats = []inboxChat{}
			return view
		}
		seen[id] = struct{}{}
		if unread < 0 {
			unread = 0
		}
		kind := sessionKind(fieldString(chat, "chat_type"))
		view.Chats = append(view.Chats, inboxChat{
			StoreID: ref.StoreID, ChatID: id, ChatStatus: fieldString(chat, "chat_status"),
			ChatType: fieldString(chat, "chat_type"), SessionKind: kind,
			CreatedAt: fieldString(chat, "created_at"), UnreadCount: unread,
			LastMessageID: fieldString(row, "last_message_id"), Preview: "",
		})
		view.UnreadCount += unread
	}
	sort.Slice(view.Chats, func(i, j int) bool {
		if view.Chats[i].UnreadCount != view.Chats[j].UnreadCount {
			return view.Chats[i].UnreadCount > view.Chats[j].UnreadCount
		}
		return view.Chats[i].CreatedAt > view.Chats[j].CreatedAt
	})
	view.Fetched = true
	view.SessionCount = int64(len(view.Chats))
	view.WaitingReply = view.UnreadCount > 0
	return view
}

func sessionKind(chatType string) string {
	switch strings.ToUpper(strings.TrimSpace(chatType)) {
	case "BUYER_SELLER":
		return "buyer"
	case "SELLER_SUPPORT":
		return "ticket"
	default:
		return "platform"
	}
}

// AggregateInbox keeps request order. Rust buffer_unordered does not; that difference is documented.
func AggregateInbox(stores []StoreInbox) json.RawMessage {
	view := inboxView{
		Stores: stores, FailedStores: []failedStore{},
		StoreCount: int64(len(stores)),
	}
	if view.Stores == nil {
		view.Stores = []StoreInbox{}
	}
	for _, st := range stores {
		if !st.Fetched {
			view.FailedStores = append(view.FailedStores, failedStore{StoreID: st.StoreID, Name: st.Name, Reason: st.FailReason})
			continue
		}
		view.SessionCount += st.SessionCount
		if st.WaitingReply {
			view.WaitingReplyCount += st.UnreadCount
			view.WaitingReplyStoreCount++
		}
		for _, chat := range st.Chats {
			if chat.SessionKind == "platform" {
				view.PlatformNotificationCount++
			}
		}
	}
	view.FailedStoreCount = int64(len(view.FailedStores))
	return mustData(view)
}
