package storehttp

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/xxww0098/podhub-go/internal/store/contract"
)

const PathProductsExport = "/api/workspaces/products/export"

type ProductWorkspaceActions interface {
	ExportProductsCSV(context.Context, int64, int64, string, string, string, bool) ([]byte, *contract.APIError)
}

func (h handler) exportProducts(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.requireActor(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	includeGone := false
	if query.Has("includeGone") {
		value, err := strconv.ParseBool(query.Get("includeGone"))
		if err != nil {
			writeAPIError(w, contract.Validation(contract.MsgInvalidJSON))
			return
		}
		includeGone = value
	}
	raw, api := h.ProductWorkspace.ExportProductsCSV(r.Context(), p.OrgID, p.UserID, query.Get("storeId"), query.Get("status"), query.Get("q"), includeGone)
	if api != nil {
		writeAPIError(w, api)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="ozon-products-`+time.Now().UTC().Format("2006-01-02")+`.csv"`)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}
