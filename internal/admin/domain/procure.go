package domain

import (
	"bytes"
	"strings"
	"unicode/utf8"
)

const (
	msgPickOrder = "请选择平台订单"
	msgPickProc  = "请选择采购尝试"
	msgRefLen    = "不能超过 128 个字符"
	msgCost      = "供货成本须为非负整数"
	maxRefChars  = 128
)

// ClaimInput is a claim body after strict JSON.
type ClaimInput struct {
	OrderID  string
	SourceID *string
	Channel  *string
	Cost     *int64
}

// ReceiptInput is a receipt body.
type ReceiptInput struct {
	Outcome string
	Ref     *string
	Note    *string
}

type claimBody struct {
	OrderID *string `json:"orderId"`
	Source  *string `json:"sourceId"`
	Channel *string `json:"channelSku"`
	Cost    *int64  `json:"supplierCostSnapshotCents"`
}

type receiptBody struct {
	Outcome *string `json:"outcome"`
	Ref     *string `json:"channelOrderRef"`
	Note    *string `json:"note"`
}

// ParseClaim requires orderId and optional trimmed text.
func ParseClaim(raw []byte) (ClaimInput, error) {
	var body claimBody
	if err := DecodeJSON(raw, &body); err != nil {
		return ClaimInput{}, err
	}
	if body.OrderID == nil {
		return ClaimInput{}, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	id := strings.TrimSpace(*body.OrderID)
	if id == "" {
		return ClaimInput{}, Fail(400, "VALIDATION", msgPickOrder)
	}
	source, err := optionalRef(body.Source)
	if err != nil {
		return ClaimInput{}, err
	}
	channel, err := optionalRef(body.Channel)
	if err != nil {
		return ClaimInput{}, err
	}
	if body.Cost != nil && *body.Cost < 0 {
		return ClaimInput{}, Fail(400, "VALIDATION", msgCost)
	}
	return ClaimInput{OrderID: id, SourceID: source, Channel: channel, Cost: body.Cost}, nil
}

// ParseReceipt accepts accepted, rejected, or unknown.
func ParseReceipt(raw []byte) (ReceiptInput, error) {
	var body receiptBody
	if err := DecodeJSON(raw, &body); err != nil {
		return ReceiptInput{}, err
	}
	if body.Outcome == nil {
		return ReceiptInput{}, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	switch *body.Outcome {
	case "accepted", "rejected", "unknown":
	default:
		return ReceiptInput{}, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	ref, err := optionalRef(body.Ref)
	if err != nil {
		return ReceiptInput{}, err
	}
	note, err := optionalRef(body.Note)
	if err != nil {
		return ReceiptInput{}, err
	}
	return ReceiptInput{Outcome: *body.Outcome, Ref: ref, Note: note}, nil
}

// RequireProcID trims a procurement path id.
func RequireProcID(raw string) (string, error) {
	id := strings.TrimSpace(raw)
	if id == "" {
		return "", Fail(400, "VALIDATION", msgPickProc)
	}
	return id, nil
}

// RequireOrderID trims an order path id.
func RequireOrderID(raw string) (string, error) {
	id := strings.TrimSpace(raw)
	if id == "" {
		return "", Fail(400, "VALIDATION", msgPickOrder)
	}
	return id, nil
}

func optionalRef(raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(trimmed) > maxRefChars {
		return nil, Fail(400, "VALIDATION", msgRefLen)
	}
	return &trimmed, nil
}

// ProductionFiles reads a snapshot. The field list is unconfirmed; accept mediaAssetId and contentHash.
// An array, or an object with files, is used. Any other shape is an empty list.
func ProductionFiles(raw []byte) []ProductionFile {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return []ProductionFile{}
	}
	var files []ProductionFile
	if raw[0] == '[' && unmarshalFiles(raw, &files) == nil && files != nil {
		return files
	}
	var wrap struct {
		Files []ProductionFile `json:"files"`
	}
	if raw[0] == '{' && unmarshalFiles(raw, &wrap) == nil && wrap.Files != nil {
		return wrap.Files
	}
	return []ProductionFile{}
}

func unmarshalFiles(raw []byte, dest any) error {
	return jsonUnmarshal(raw, dest)
}
