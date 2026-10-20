package domain

import (
	"encoding/json"
	"strconv"
	"strings"
)

// FormatSSE is axum's Event Display order: id, event, data, then a blank line.
// data is one JSON line. A comment keep-alive is SSEKeepAlive, not this frame.
func FormatSSE(id, event string, data []byte) string {
	var b strings.Builder
	if id != "" {
		b.WriteString("id: ")
		b.WriteString(id)
		b.WriteByte('\n')
	}
	if event != "" {
		b.WriteString("event: ")
		b.WriteString(event)
		b.WriteByte('\n')
	}
	b.WriteString("data: ")
	b.Write(data)
	b.WriteString("\n\n")
	return b.String()
}

// RowRemoveData is ListingRowEventData for a removal. row is null.
func RowRemoveData(orgID int64, cardID, rowID string, seq int64) ([]byte, error) {
	return marshalEvent(struct {
		WorkspaceID string          `json:"workspaceId"`
		CardID      string          `json:"cardId"`
		Seq         string          `json:"seq"`
		RowID       string          `json:"rowId"`
		Row         json.RawMessage `json:"row"`
	}{
		WorkspaceID: strconv.FormatInt(orgID, 10),
		CardID:      cardID,
		Seq:         strconv.FormatInt(seq, 10),
		RowID:       rowID,
		Row:         json.RawMessage("null"),
	})
}

// CardInvalidateData is ListingCardEventData.
func CardInvalidateData(orgID int64, cardID, reason, template string, seq int64) ([]byte, error) {
	return marshalEvent(struct {
		WorkspaceID       string `json:"workspaceId"`
		CardID            string `json:"cardId"`
		Seq               string `json:"seq"`
		Reason            string `json:"reason"`
		PsdTemplateSha256 string `json:"psdTemplateSha256"`
	}{
		WorkspaceID:       strconv.FormatInt(orgID, 10),
		CardID:            cardID,
		Seq:               strconv.FormatInt(seq, 10),
		Reason:            reason,
		PsdTemplateSha256: template,
	})
}

// ResetData is the close payload for reset and resync_required.
func ResetData(orgID int64, cardID, reason string) ([]byte, error) {
	return marshalEvent(struct {
		WorkspaceID string `json:"workspaceId"`
		CardID      string `json:"cardId"`
		Reason      string `json:"reason"`
	}{
		WorkspaceID: strconv.FormatInt(orgID, 10),
		CardID:      cardID,
		Reason:      reason,
	})
}

func marshalEvent(v any) ([]byte, error) {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return []byte(strings.TrimRight(buf.String(), "\n")), nil
}
