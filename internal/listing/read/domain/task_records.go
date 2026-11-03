package domain

import (
	"net/url"
	"strconv"
	"time"
)

type TaskRecordFilter struct {
	Kind, Status, StoreID, CursorID string
	CursorMicros                    int64
	Limit                           int
}

type TaskRecord struct {
	ID             string     `json:"id"`
	Kind           string     `json:"kind"`
	StoreID        *string    `json:"store_id"`
	StoreName      string     `json:"store_name"`
	Title          string     `json:"title"`
	CardID         *string    `json:"card_id"`
	RowID          *string    `json:"row_id"`
	State          string     `json:"state"`
	ErrorCode      string     `json:"error_code"`
	ExternalTaskID *string    `json:"external_task_id"`
	Attempt        *int       `json:"attempt"`
	NextAttemptAt  *time.Time `json:"next_attempt_at"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

type TaskRecordsPage struct {
	Items      []TaskRecord `json:"items"`
	NextCursor *string      `json:"next_cursor"`
}

func ParseTaskRecordsQuery(q url.Values) (TaskRecordFilter, string) {
	f := TaskRecordFilter{Limit: 50}
	for key, values := range q {
		if len(values) != 1 {
			return f, "请求格式无效"
		}
		switch key {
		case "kind", "status", "storeId", "cursor", "limit":
		default:
			return f, "请求格式无效"
		}
	}
	f.Kind, f.Status = q.Get("kind"), q.Get("status")
	switch f.Kind {
	case "", "listing", "product_sync", "media":
	default:
		return f, "任务类型无效"
	}
	switch f.Status {
	case "", "active", "attention", "finished", "cancelled":
	default:
		return f, "任务状态无效"
	}
	if q.Has("storeId") {
		id, ok := CanonicalUUID(q.Get("storeId"))
		if !ok {
			return f, "店铺编号无效"
		}
		f.StoreID = id
	}
	if q.Has("cursor") {
		f.CursorMicros, f.CursorID = ParseCursor(q.Get("cursor"))
		if f.CursorID == "" {
			return f, "分页标识无效，请重新读取"
		}
	}
	if q.Has("limit") {
		limit, err := strconv.Atoi(q.Get("limit"))
		if err != nil || limit < 1 || limit > 100 {
			return f, "每页数量必须为 1–100"
		}
		f.Limit = limit
	}
	return f, ""
}
