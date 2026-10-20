package readhttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

// ErrNotWritten is a 501. The handler must not insert or update.
var ErrNotWritten = errors.New("该写入需要 listing-core，尚未移植，没有写入")

// CreateCard is the decoded create body. Payload is the raw JSON value.
type CreateCard struct {
	Title             string
	StoreID           *string
	Payload           json.RawMessage
	CreateMode        string
	ApplyActivePack   bool
	FieldPackID       *string
	SourceCardID      *string
	SupplierProductID *string
}

// CreateRefusal is a validation failure that happens before any insert.
type CreateRefusal struct {
	Message string
}

// ValidateCreate applies write_new_card's checks that do not read a store
// roster or decode a card. ok means those later steps are all that remain.
func ValidateCreate(body CreateCard) (CreateRefusal, bool) {
	if body.CreateMode != "fromSupplier" && body.SupplierProductID != nil {
		return CreateRefusal{"supplierProductId 仅用于 fromSupplier"}, false
	}
	switch body.CreateMode {
	case "fromPack":
		return CreateRefusal{"不再支持字段包导入"}, false
	case "blank":
		if refusal, ok := refuseExtra(body, false); !ok {
			return refusal, false
		}
		if payloadHasSupplier(body.Payload) {
			return CreateRefusal{"请从平台货源选择规格创建方案"}, false
		}
		return CreateRefusal{}, true
	case "copyCard":
		if refusal, ok := refuseExtra(body, true); !ok {
			return refusal, false
		}
		if body.SourceCardID == nil || strings.TrimSpace(*body.SourceCardID) == "" {
			return CreateRefusal{"copyCard 需要 sourceCardId"}, false
		}
		return CreateRefusal{}, true
	case "fromSupplier":
		if refusal, ok := refuseExtra(body, false); !ok {
			return refusal, false
		}
		if body.SourceCardID != nil || !payloadIsNull(body.Payload) {
			return CreateRefusal{"fromSupplier 不接受 payload 或 sourceCardId"}, false
		}
		if body.SupplierProductID == nil || strings.TrimSpace(*body.SupplierProductID) == "" {
			return CreateRefusal{"fromSupplier 需要 supplierProductId"}, false
		}
		return CreateRefusal{}, true
	default:
		return CreateRefusal{"请求格式无效"}, false
	}
}

func refuseExtra(body CreateCard, allowSource bool) (CreateRefusal, bool) {
	if body.FieldPackID != nil {
		return CreateRefusal{"此创建方式不接受 fieldPackId"}, false
	}
	if !allowSource && body.SourceCardID != nil {
		return CreateRefusal{"此创建方式不接受 sourceCardId"}, false
	}
	if body.ApplyActivePack {
		return CreateRefusal{"不再支持字段包套用"}, false
	}
	return CreateRefusal{}, true
}

func payloadIsNull(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null"))
}

func payloadHasSupplier(raw json.RawMessage) bool {
	if payloadIsNull(raw) {
		return false
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return false
	}
	value, ok := obj["supplierProductId"]
	if !ok {
		return false
	}
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null"))
}

// CreateKeyPair is the row-create idempotency pair. Both absent is allowed.
func CreateKeyPair(key, fingerprint *string) error {
	if key == nil && fingerprint == nil {
		return nil
	}
	if key == nil || fingerprint == nil {
		return errors.New("createKey 与 requestFingerprint 必须同时提交")
	}
	if err := identToken("createKey", *key); err != nil {
		return err
	}
	return identToken("requestFingerprint", *fingerprint)
}

func identToken(label, raw string) error {
	raw = strings.TrimSpace(raw)
	if len(raw) < 1 || len(raw) > 128 {
		return errors.New(label + " 必须是 1..=128 位的 [A-Za-z0-9._:-] 标识")
	}
	for _, r := range raw {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '.' || r == '_' || r == ':' || r == '-':
		default:
			return errors.New(label + " 必须是 1..=128 位的 [A-Za-z0-9._:-] 标识")
		}
	}
	return nil
}
