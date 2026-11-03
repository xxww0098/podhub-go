package adminhttp

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
)

func decodeCouponBody(w http.ResponseWriter, r *http.Request, out any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		writeCloud(w, http.StatusBadRequest, "VALIDATION", "请求格式无效")
		return false
	}
	if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
		writeCloud(w, http.StatusBadRequest, "VALIDATION", "请求只能包含一个对象")
		return false
	}
	return true
}

func (h handler) createCoupon(w http.ResponseWriter, r *http.Request, actor domain.Actor) {
	var request struct {
		billing.CouponSpec
		MaxUses *int `json:"max_uses"`
	}
	if !decodeCouponBody(w, r, &request) {
		return
	}
	if request.MaxUses == nil {
		h.writeFault(w, famAdmin, domain.Validation("VALIDATION", "请指定可用次数或不限次数"))
		return
	}
	spec := request.CouponSpec
	spec.MaxUses = *request.MaxUses
	spec, err := billing.ValidateCouponSpec(spec, time.Now())
	if err != nil {
		h.writeFault(w, famAdmin, domain.Validation("VALIDATION", err.Error()))
		return
	}
	body, err := h.AdminB.CreateCoupon(r.Context(), actor, spec)
	h.replyStatus(w, famAdmin, http.StatusCreated, body, err)
}

func (h handler) setCouponEnabled(w http.ResponseWriter, r *http.Request, actor domain.Actor) {
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if !decodeCouponBody(w, r, &body) {
		return
	}
	code, ok := billing.CanonicalCouponCode(chi.URLParam(r, "code"))
	if !ok || body.Enabled == nil {
		h.writeFault(w, famAdmin, domain.Validation("VALIDATION", "请指定有效优惠码与启用状态"))
		return
	}
	response, err := h.AdminB.SetCouponEnabled(r.Context(), actor, code, *body.Enabled)
	h.reply(w, famAdmin, response, err)
}
