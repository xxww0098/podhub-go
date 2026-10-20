package adminhttp

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
)

func (h handler) catalog(w http.ResponseWriter, r *http.Request, rt Route, s Session) {
	if st, msg, code := gateSuper(s); st != 0 {
		writeShippingErr(w, st, msg, code)
		return
	}
	svc := depPtr[service.Catalog](h.Deps, "Catalog")
	if svc == nil {
		writeShippingErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
		return
	}
	actor := domain.Actor{UserID: s.UserID, OrgID: s.OrgID, PublicID: s.PublicID}
	ctx := r.Context()
	switch rt.Method + " " + rt.Path {
	case http.MethodGet + " /api/admin/platform-catalog":
		body, err := svc.List(ctx)
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/platform-catalog/products":
		body, err := svc.CreateProduct(ctx, actor, rawBody(r))
		writeShippingResult(w, http.StatusCreated, body, err)
	case http.MethodPut + " /api/admin/platform-catalog/products/{product_id}":
		body, err := svc.UpdateProduct(ctx, actor, chi.URLParam(r, "product_id"), rawBody(r))
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/platform-catalog/products/{product_id}/publish":
		body, err := svc.PublishProduct(ctx, actor, chi.URLParam(r, "product_id"), rawBody(r), true)
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/platform-catalog/products/{product_id}/unpublish":
		body, err := svc.PublishProduct(ctx, actor, chi.URLParam(r, "product_id"), rawBody(r), false)
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/platform-catalog/products/{product_id}/images/upload":
		body, err := svc.InitImage(ctx, actor, "product", chi.URLParam(r, "product_id"), rawBody(r))
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/platform-catalog/products/{product_id}/images":
		body, err := svc.ConfirmImage(ctx, actor, "product", chi.URLParam(r, "product_id"), rawBody(r))
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/platform-catalog/skus":
		body, err := svc.CreateSKU(ctx, actor, rawBody(r))
		writeShippingResult(w, http.StatusCreated, body, err)
	case http.MethodPut + " /api/admin/platform-catalog/skus/{sku_id}":
		body, err := svc.UpdateSKU(ctx, actor, chi.URLParam(r, "sku_id"), rawBody(r))
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/platform-catalog/skus/{sku_id}/images/upload":
		body, err := svc.InitImage(ctx, actor, "sku", chi.URLParam(r, "sku_id"), rawBody(r))
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/platform-catalog/skus/{sku_id}/images":
		body, err := svc.ConfirmImage(ctx, actor, "sku", chi.URLParam(r, "sku_id"), rawBody(r))
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/platform-catalog/skus/{sku_id}/price":
		body, err := svc.SetPrice(ctx, actor, chi.URLParam(r, "sku_id"), rawBody(r))
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/platform-catalog/skus/{sku_id}/publish":
		body, err := svc.PublishSKU(ctx, actor, chi.URLParam(r, "sku_id"), rawBody(r), true)
		writeShippingResult(w, http.StatusOK, body, err)
	case http.MethodPost + " /api/admin/platform-catalog/skus/{sku_id}/unpublish":
		body, err := svc.PublishSKU(ctx, actor, chi.URLParam(r, "sku_id"), rawBody(r), false)
		writeShippingResult(w, http.StatusOK, body, err)
	default:
		writeShippingErr(w, http.StatusNotImplemented, "not_ported", "not_ported")
	}
}
