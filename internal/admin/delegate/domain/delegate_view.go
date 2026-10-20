package domain

import (
	"bytes"
	"encoding/json"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	delegatecontract "github.com/xxww0098/podhub-go/internal/admin/delegate/contract"
)

// EncodeCursor is `{ms}:{orderId}` for the last kept row.
func EncodeCursor(ms int64, orderID string) string {
	return corecontract.Itoa64(ms) + ":" + orderID
}

// ProjectPostingSnapshot keeps status, substatus, in_process_at, shipment_date in that order.
func ProjectPostingSnapshot(raw []byte) json.RawMessage {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return json.RawMessage(`{}`)
	}
	buf := bytes.NewBufferString("{")
	first := true
	for _, key := range []string{"status", "substatus", "in_process_at", "shipment_date"} {
		v, ok := m[key]
		if !ok {
			continue
		}
		if !first {
			buf.WriteByte(',')
		}
		first = false
		k, _ := json.Marshal(key)
		buf.Write(k)
		buf.WriteByte(':')
		buf.Write(bytes.TrimSpace(v))
	}
	buf.WriteByte('}')
	return buf.Bytes()
}

// ProjectReceipt reads the snake_case jsonb. Nil means the ledger omits receipt.
func ProjectReceipt(raw []byte) *delegatecontract.ReceiptView {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	out := &delegatecontract.ReceiptView{}
	any := false
	if s, ok := jsonString(m["tracking_no"]); ok && s != "" {
		out.TrackingNo = &s
		any = true
	}
	if s, ok := jsonString(m["note"]); ok && s != "" {
		out.Note = &s
		any = true
	}
	if s, ok := jsonString(m["reason"]); ok && s != "" {
		out.Reason = &s
		any = true
	}
	if s, ok := jsonString(m["recorded_by"]); ok && s != "" {
		out.RecordedBy = &s
		any = true
	}
	if n, ok := jsonInt(m["at_ms"]); ok {
		out.AtMs = &n
		any = true
	}
	if !any {
		return nil
	}
	return out
}

func jsonString(raw json.RawMessage) (string, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

func jsonInt(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return 0, false
	}
	num, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := num.Int64()
	if err != nil {
		return 0, false
	}
	return i, true
}

// StringList keeps only JSON strings from a jsonb array.
func StringList(raw []byte) []string {
	out := []string{}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return out
	}
	for _, el := range arr {
		if s, ok := jsonString(el); ok {
			out = append(out, s)
		}
	}
	return out
}

// Page trims the limit+1 probe row into hasNext and cursor.
func Page(rows []delegatecontract.OrderRow, limit int64) delegatecontract.OrderListResponse {
	var out delegatecontract.OrderListResponse
	out.Data.Orders = rows
	out.Data.Cursor = ""
	if int64(len(rows)) > limit {
		out.Data.HasNext = true
		out.Data.Orders = rows[:limit]
		last := out.Data.Orders[len(out.Data.Orders)-1]
		out.Data.Cursor = EncodeCursor(last.CreatedAtMs, last.OrderID)
	}
	if out.Data.Orders == nil {
		out.Data.Orders = []delegatecontract.OrderRow{}
	}
	return out
}
