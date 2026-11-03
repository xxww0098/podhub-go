package storehttp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

const (
	// PathShippingReadiness reads one SKU shipping readiness for a store.
	PathShippingReadiness = "/api/workspaces/stores/{uuid}/shipping/readiness"
	// PathShippingEnsure reconciles a store and safely retries warehouse creation.
	PathShippingEnsure = "/api/workspaces/stores/{uuid}/shipping/ensure"
)

// ShippingActions is the seller shipping service port.
type ShippingActions interface {
	Readiness(ctx context.Context, orgID int64, storeUUID, sku string) (json.RawMessage, error)
	Ensure(ctx context.Context, orgID, userID int64, storeUUID, sku string) (json.RawMessage, error)
}

// ShippingError is a mapped shipping failure the assembly layer produces.
type ShippingError struct {
	Status  int
	Code    string
	Message string
}

func (e *ShippingError) Error() string { return e.Message }

func (h handler) shippingReadiness(w http.ResponseWriter, r *http.Request) {
	h.shipping(w, r, false)
}

func (h handler) shippingEnsure(w http.ResponseWriter, r *http.Request) {
	h.shipping(w, r, true)
}

func (h handler) shipping(w http.ResponseWriter, r *http.Request, ensure bool) {
	if h.Deps.Shipping == nil {
		writeErr(w, http.StatusNotImplemented, "该接口尚未实现", "NOT_IMPLEMENTED")
		return
	}
	p, ok := principal(w, r, h.Deps.Resolve)
	if !ok {
		return
	}
	if status, message, refused := workspace(p); refused {
		writeErr(w, status, message, "FORBIDDEN")
		return
	}
	uuid := strings.TrimSpace(chi.URLParam(r, "uuid"))
	if uuid == "" {
		writeErr(w, http.StatusBadRequest, "店铺标识不能为空", "VALIDATION")
		return
	}
	if ensure {
		if !access.CanManage(p.WorkspaceRole) {
			writeErr(w, http.StatusForbidden, access.MsgManager, "FORBIDDEN")
			return
		}
		if !jsonContent(r.Header.Get("Content-Type")) {
			writeErr(w, http.StatusBadRequest, "请求格式无效", "VALIDATION")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		var req struct {
			SKUID string `json:"sku_id"`
		}
		if dec.Decode(&req) != nil || strings.TrimSpace(req.SKUID) == "" {
			writeErr(w, http.StatusBadRequest, "sku_id 不能为空", "VALIDATION")
			return
		}
		raw, err := h.Deps.Shipping.Ensure(r.Context(), p.OrgID, p.UserID, uuid, strings.TrimSpace(req.SKUID))
		if err != nil {
			writeShippingErr(w, err)
			return
		}
		writeShippingData(w, "inject", raw)
		return
	}
	sku := strings.TrimSpace(r.URL.Query().Get("sku_id"))
	if sku == "" {
		writeErr(w, http.StatusBadRequest, "sku_id 不能为空", "VALIDATION")
		return
	}
	raw, err := h.Deps.Shipping.Readiness(r.Context(), p.OrgID, uuid, sku)
	if err != nil {
		writeShippingErr(w, err)
		return
	}
	writeShippingData(w, "readiness", raw)
}

func writeShippingData(w http.ResponseWriter, key string, raw json.RawMessage) {
	jsonwire.Write(w, http.StatusOK, map[string]any{
		"data": map[string]any{key: raw},
	})
}

func writeShippingErr(w http.ResponseWriter, err error) {
	var failure *ShippingError
	if errors.As(err, &failure) && failure != nil {
		writeErr(w, failure.Status, failure.Message, failure.Code)
		return
	}
	writeErr(w, http.StatusServiceUnavailable, access.MsgUnavailable, "INTERNAL")
}
