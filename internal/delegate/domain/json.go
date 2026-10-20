package domain

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

// AdminCommand is one staff-authorized write. NewID is called once per packet.
type AdminCommand struct {
	UserID  int64
	OrderID string
	NowMS   int64
	NewID   func() string
}

// AdminStore is the transactional port. The repository implements it.
type AdminStore interface {
	Dispatch(ctx context.Context, cmd AdminCommand, in DispatchInput) (json.RawMessage, error)
	Receipt(ctx context.Context, cmd AdminCommand, in ReceiptInput) (json.RawMessage, error)
	Cancel(ctx context.Context, cmd AdminCommand) (json.RawMessage, error)
}

// DispatchInput is a decoded admin dispatch body.
type DispatchInput struct {
	SourceID string
	LineIDs  []string
}

// DecodeDispatch folds every JSON rejection into the fixed validation sentence.
// A nil body is that rejection. sourceId trims to empty. lineIds dedupe.
func DecodeDispatch(body []byte) (DispatchInput, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return DispatchInput{}, contract.Validation("请求格式无效")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var raw struct {
		SourceID *string  `json:"sourceId"`
		LineIDs  []string `json:"lineIds"`
	}
	if err := dec.Decode(&raw); err != nil || dec.More() {
		return DispatchInput{}, contract.Validation("请求格式无效")
	}
	out := DispatchInput{}
	if raw.SourceID != nil {
		out.SourceID = strings.TrimSpace(*raw.SourceID)
	}
	ids, err := NormalizeLineIDs(raw.LineIDs)
	if err != nil {
		return DispatchInput{}, err
	}
	out.LineIDs = ids
	return out, nil
}

// ReceiptInput is a decoded admin receipt body.
type ReceiptInput struct {
	TrackingNo string
	Note       string
}

// DecodeReceipt trims and caps both strings at 1000 scalars.
func DecodeReceipt(body []byte) (ReceiptInput, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return ReceiptInput{}, contract.Validation("请求格式无效")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var raw struct {
		TrackingNo *string `json:"trackingNo"`
		Note       *string `json:"note"`
	}
	if err := dec.Decode(&raw); err != nil || dec.More() {
		return ReceiptInput{}, contract.Validation("请求格式无效")
	}
	var tracking, note string
	if raw.TrackingNo != nil {
		tracking = *raw.TrackingNo
	}
	if raw.Note != nil {
		note = *raw.Note
	}
	tracking, err := NormalizeNote(tracking, "运单号")
	if err != nil {
		return ReceiptInput{}, err
	}
	note, err = NormalizeNote(note, "备注")
	if err != nil {
		return ReceiptInput{}, err
	}
	return ReceiptInput{TrackingNo: tracking, Note: note}, nil
}
