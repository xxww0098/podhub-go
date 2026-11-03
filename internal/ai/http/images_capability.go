package aihttp

import (
	"errors"
	"math"
	"net/http"

	"github.com/jackc/pgx/v5"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

type ImageSetCapability struct {
	Available    bool   `json:"available"`
	AccountID    string `json:"account_id,omitempty"`
	Model        string `json:"model,omitempty"`
	Count        int    `json:"count,omitempty"`
	UnitMicrofen int64  `json:"unit_microfen,omitempty"`
	SetMicrofen  int64  `json:"set_microfen,omitempty"`
}

func (h httpHandler) imageSetCapability(w http.ResponseWriter, r *http.Request) {
	principal, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	view := ImageSetCapability{}
	if h.deps.Images == nil || h.deps.Images.Account == nil {
		jsonwire.Write(w, http.StatusOK, view)
		return
	}
	accountID, err := h.deps.Images.Account(r.Context())
	if err != nil || accountID == "" {
		jsonwire.Write(w, http.StatusOK, view)
		return
	}
	var price billing.Price
	var found bool
	if h.deps.Wallet.CurrentForModel == nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	err = imageTx(r.Context(), h.deps.Deps, principal.OrgID, func(tx pgx.Tx) error {
		var e error
		price, found, e = h.deps.Wallet.CurrentForModel(r.Context(), tx, imageModel)
		return e
	})
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	if found {
		if unit, e := imageUnitPrice(price); e == nil {
			view = ImageSetCapability{Available: true, AccountID: accountID, Model: imageModel, Count: 3, UnitMicrofen: unit, SetMicrofen: 3 * unit}
		}
	}
	jsonwire.Write(w, http.StatusOK, view)
}

func imageUnitPrice(price billing.Price) (int64, error) {
	if price.BillingMode != billing.ModePerRequest || price.PerRequest <= 0 || price.MaxRequest < price.PerRequest {
		return 0, errors.New("image price unavailable")
	}
	quote, err := price.ChargeUsage(billing.Usage{})
	if err != nil || quote.Total <= 0 || quote.Total > math.MaxInt64/3 {
		return 0, errors.New("image price invalid")
	}
	return quote.Total, nil
}
