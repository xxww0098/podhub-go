package domain

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

// CursorRequest is a store plus one optional cursor.
type CursorRequest struct {
	StoreID string
	Cursor  string
}

func DecodeCursor(raw []byte, cursorKey string) (CursorRequest, error) {
	m, err := object(raw, "store_id", cursorKey)
	if err != nil {
		return CursorRequest{}, err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return CursorRequest{}, errJSON
	}
	cur, err := optString(m, cursorKey)
	if err != nil {
		return CursorRequest{}, err
	}
	req := CursorRequest{StoreID: store}
	if cur != nil {
		req.Cursor = strings.TrimSpace(*cur)
	}
	return req, nil
}

type reviewItem struct {
	ReviewID     string `json:"review_id"`
	Rating       int32  `json:"rating"`
	Text         string `json:"text"`
	SKU          string `json:"sku"`
	PublishedAt  string `json:"published_at"`
	Status       string `json:"status"`
	PhotosAmount int32  `json:"photos_amount"`
	VideosAmount int32  `json:"videos_amount"`
}

type reviewsView struct {
	Kind        string       `json:"kind"`
	Reason      string       `json:"reason"`
	Items       []reviewItem `json:"items"`
	HasNext     bool         `json:"has_next"`
	LastID      string       `json:"last_id"`
	Unprocessed *int32       `json:"unprocessed"`
}

func Reviews(req CursorRequest, fetch Fetch) (json.RawMessage, *contract.Fail) {
	body := map[string]any{"limit": 50, "sort_dir": "DESC", "status": "UNPROCESSED"}
	if req.Cursor != "" {
		body["last_id"] = req.Cursor
	}
	raw, _ := compact(body)
	var count Page
	list := fetch("POST", reviewList, raw)
	if req.Cursor == "" {
		count = fetch("POST", reviewCount, []byte(`{}`))
	}
	if PremiumPlus(list.Status, list.Body) {
		return mustData(reviewsView{Kind: "premium_plus_required", Reason: readMessage("读取口碑", reviewList, list.Status, list.Body, nil), Items: []reviewItem{}, LastID: ""}), nil
	}
	if f := readPage(list, "读取 Ozon 未回复评价", reviewList, contract.CodeVoice); f != nil {
		return nil, f
	}
	root := asObject(list.Body)
	rows := arr(root, "reviews")
	items := make([]reviewItem, 0, len(rows))
	seen := map[string]struct{}{}
	for _, row := range rows {
		id := strings.TrimSpace(fieldString(row, "id"))
		if id == "" {
			return nil, voiceFail("Ozon 评价响应不完整：存在空身份")
		}
		if _, ok := seen[id]; ok {
			return nil, voiceFail("Ozon 评价响应不完整：同页身份重复")
		}
		seen[id] = struct{}{}
		sku := fieldI64(row, "sku")
		rating := int32(fieldI64(row, "rating"))
		comments := fieldI64(row, "comments_amount")
		photos := fieldI64(row, "photos_amount")
		videos := fieldI64(row, "videos_amount")
		if sku <= 0 || rating < 1 || rating > 5 || comments < 0 || photos < 0 || videos < 0 {
			return nil, voiceFail("Ozon 评价响应不完整：存在非法计数或 SKU")
		}
		items = append(items, reviewItem{ReviewID: id, Rating: rating, Text: fieldString(row, "text"), SKU: strconv.FormatInt(sku, 10), PublishedAt: fieldString(row, "published_at"), Status: fieldString(row, "status"), PhotosAmount: int32(photos), VideosAmount: int32(videos)})
	}
	hasNext := fieldBool(root, "has_next")
	last := strings.TrimSpace(fieldString(root, "last_id"))
	if f := validatePage(hasNext, len(items) > 0, last, req.Cursor, "评价"); f != nil {
		return nil, f
	}
	var unprocessed *int32
	if req.Cursor == "" && count.Err == nil && count.Status >= 200 && count.Status < 300 {
		c := asObject(count.Body)
		processed, total, unp := fieldI64(c, "processed"), fieldI64(c, "total"), fieldI64(c, "unprocessed")
		if processed < 0 || total < 0 || unp < 0 {
			return nil, voiceFail("Ozon 评价计数响应不完整：存在负数")
		}
		v := int32(unp)
		unprocessed = &v
	}
	return mustData(reviewsView{Kind: "available", Items: items, HasNext: hasNext, LastID: last, Unprocessed: unprocessed}), nil
}

func voiceFail(msg string) *contract.Fail {
	return &contract.Fail{Status: 502, Code: contract.CodeVoice, Message: msg}
}

func validatePage(hasNext, hasRows bool, cursor, requested, source string) *contract.Fail {
	if !hasNext {
		return nil
	}
	if !hasRows {
		return voiceFail("Ozon " + source + "响应不完整：非终页没有数据")
	}
	if strings.TrimSpace(cursor) == "" {
		return voiceFail("Ozon " + source + "响应不完整：非终页没有游标")
	}
	if cursor == requested {
		return voiceFail("Ozon " + source + "响应不完整：分页游标没有前进")
	}
	return nil
}

type questionItem struct {
	QuestionID  string `json:"question_id"`
	Text        string `json:"text"`
	SKU         string `json:"sku"`
	PublishedAt string `json:"published_at"`
	Status      string `json:"status"`
	AuthorName  string `json:"author_name"`
}

type questionsView struct {
	Kind        string         `json:"kind"`
	Reason      string         `json:"reason"`
	Items       []questionItem `json:"items"`
	HasNext     bool           `json:"has_next"`
	LastID      string         `json:"last_id"`
	Unprocessed *int32         `json:"unprocessed"`
}

func Questions(req CursorRequest, fetch Fetch) (json.RawMessage, *contract.Fail) {
	filter := map[string]any{"status": "UNPROCESSED"}
	body := map[string]any{"filter": filter, "limit": 50}
	if req.Cursor != "" {
		body["last_id"] = req.Cursor
	}
	raw, _ := compact(body)
	list := fetch("POST", questionList, raw)
	var count Page
	if req.Cursor == "" {
		count = fetch("POST", questionCount, []byte(`{}`))
	}
	if PremiumPlus(list.Status, list.Body) {
		return mustData(questionsView{Kind: "premium_plus_required", Reason: readMessage("读取口碑", questionList, list.Status, list.Body, nil), Items: []questionItem{}, LastID: ""}), nil
	}
	if f := readPage(list, "读取 Ozon 未回复提问", questionList, contract.CodeVoice); f != nil {
		return nil, f
	}
	root := asObject(list.Body)
	rows := arr(root, "questions")
	items := make([]questionItem, 0, len(rows))
	seen := map[string]struct{}{}
	for _, row := range rows {
		id := strings.TrimSpace(fieldString(row, "id"))
		if id == "" {
			return nil, voiceFail("Ozon 提问响应不完整：存在空身份")
		}
		if _, ok := seen[id]; ok {
			return nil, voiceFail("Ozon 提问响应不完整：同页身份重复")
		}
		seen[id] = struct{}{}
		sku := fieldI64(row, "sku")
		answers := fieldI64(row, "answers_count")
		if sku <= 0 || answers < 0 {
			return nil, voiceFail("Ozon 提问响应不完整：存在非法计数或 SKU")
		}
		items = append(items, questionItem{QuestionID: id, Text: fieldString(row, "text"), SKU: strconv.FormatInt(sku, 10), PublishedAt: fieldString(row, "published_at"), Status: fieldString(row, "status"), AuthorName: fieldString(row, "author_name")})
	}
	hasNext := fieldBool(root, "has_next")
	last := strings.TrimSpace(fieldString(root, "last_id"))
	if f := validatePage(hasNext, len(items) > 0, last, req.Cursor, "提问"); f != nil {
		return nil, f
	}
	var unprocessed *int32
	if req.Cursor == "" && count.Err == nil && count.Status >= 200 && count.Status < 300 {
		c := asObject(count.Body)
		for _, key := range []string{"all", "new", "processed", "unprocessed", "viewed"} {
			if fieldI64(c, key) < 0 {
				return nil, voiceFail("Ozon 提问计数响应不完整：存在负数")
			}
		}
		v := int32(fieldI64(c, "unprocessed"))
		unprocessed = &v
	}
	return mustData(questionsView{Kind: "available", Items: items, HasNext: hasNext, LastID: last, Unprocessed: unprocessed}), nil
}

type chatItem struct {
	ChatID        string `json:"chat_id"`
	ChatStatus    string `json:"chat_status"`
	ChatType      string `json:"chat_type"`
	CreatedAt     string `json:"created_at"`
	UnreadCount   int64  `json:"unread_count"`
	LastMessageID string `json:"last_message_id"`
}

type chatsView struct {
	Kind             string     `json:"kind"`
	Reason           string     `json:"reason"`
	Items            []chatItem `json:"items"`
	HasNext          bool       `json:"has_next"`
	Cursor           string     `json:"cursor"`
	TotalUnreadCount int64      `json:"total_unread_count"`
}

func Chats(req CursorRequest, fetch Fetch) (json.RawMessage, *contract.Fail) {
	body := map[string]any{"filter": map[string]any{}, "limit": 50}
	if req.Cursor != "" {
		body["cursor"] = req.Cursor
	}
	raw, _ := compact(body)
	page := fetch("POST", "/v3/chat/list", raw)
	if PremiumPlus(page.Status, page.Body) {
		return mustData(chatsView{Kind: "premium_plus_required", Reason: readMessage("读取口碑", "/v3/chat/list", page.Status, page.Body, nil), Items: []chatItem{}, Cursor: ""}), nil
	}
	if f := readPage(page, "读取 Ozon 聊天", "/v3/chat/list", contract.CodeVoice); f != nil {
		return nil, f
	}
	root := asObject(page.Body)
	total := fieldI64(root, "total_unread_count")
	rows := arr(root, "chats")
	items := make([]chatItem, 0, len(rows))
	seen := map[string]struct{}{}
	for _, row := range rows {
		chat := nested(row, "chat")
		id := strings.TrimSpace(fieldString(chat, "chat_id"))
		if chat == nil || id == "" {
			return nil, voiceFail("Ozon 聊天响应不完整：存在空身份")
		}
		if _, ok := seen[id]; ok {
			return nil, voiceFail("Ozon 聊天响应不完整：同页身份重复")
		}
		seen[id] = struct{}{}
		unread := fieldI64(row, "unread_count")
		if total < 0 || unread < 0 {
			return nil, voiceFail("Ozon 聊天响应不完整：存在负数未读计数")
		}
		items = append(items, chatItem{ChatID: id, ChatStatus: fieldString(chat, "chat_status"), ChatType: fieldString(chat, "chat_type"), CreatedAt: fieldString(chat, "created_at"), UnreadCount: unread, LastMessageID: fieldString(row, "last_message_id")})
	}
	if total < 0 {
		return nil, voiceFail("Ozon 聊天响应不完整：存在负数未读计数")
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].UnreadCount != items[j].UnreadCount {
			return items[i].UnreadCount > items[j].UnreadCount
		}
		return items[i].CreatedAt > items[j].CreatedAt
	})
	hasNext := fieldBool(root, "has_next")
	cursor := strings.TrimSpace(fieldString(root, "cursor"))
	if f := validatePage(hasNext, len(items) > 0, cursor, req.Cursor, "聊天"); f != nil {
		return nil, f
	}
	return mustData(chatsView{Kind: "available", Items: items, HasNext: hasNext, Cursor: cursor, TotalUnreadCount: total}), nil
}

type historyView struct {
	StoreID  string           `json:"store_id"`
	ChatID   string           `json:"chat_id"`
	Messages []historyMessage `json:"messages"`
	HasNext  bool             `json:"has_next"`
}

type historyMessage struct {
	MessageID string   `json:"message_id"`
	UserType  string   `json:"user_type"`
	CreatedAt string   `json:"created_at"`
	IsRead    bool     `json:"is_read"`
	IsImage   bool     `json:"is_image"`
	Data      []string `json:"data"`
}

func History(storeID, chatID string, fetch Fetch) (json.RawMessage, *contract.Fail) {
	if strings.TrimSpace(chatID) == "" {
		return nil, contract.Validation("会话身份无效")
	}
	body, _ := compact(map[string]any{"chat_id": strings.TrimSpace(chatID), "direction": "Backward", "limit": 50})
	page := fetch("POST", chatHistory, body)
	if f := readPage(page, "读取 Ozon 聊天记录", chatHistory, contract.CodeMessage); f != nil {
		return nil, f
	}
	root := asObject(page.Body)
	rows := arr(root, "messages")
	msgs := make([]historyMessage, 0, len(rows))
	for _, row := range rows {
		user := nested(row, "user")
		data := []string{}
		if raw, ok := row["data"]; ok {
			_ = json.Unmarshal(raw, &data)
		}
		msgs = append(msgs, historyMessage{
			MessageID: fieldString(row, "message_id"),
			UserType:  fieldString(user, "type"),
			CreatedAt: fieldString(row, "created_at"),
			IsRead:    fieldBool(row, "is_read"),
			IsImage:   fieldBool(row, "is_image"),
			Data:      data,
		})
	}
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return mustData(historyView{StoreID: strings.TrimSpace(storeID), ChatID: strings.TrimSpace(chatID), Messages: msgs, HasNext: fieldBool(root, "has_next")}), nil
}
