package cataloghttp

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
)

// Principal is the account the session resolved.
type Principal struct {
	UserID int64
}

// Refusal is an authentication answer.
type Refusal struct {
	Status  int
	Message string
}

// Session is the identity seam. internal/app adapts the process resolver.
type Session interface {
	Resolve(r *http.Request) (*Principal, *Refusal, error)
}

// Actions is the catalogue service the handlers call.
type Actions interface {
	Sources(ctx context.Context, userID int64) (contract.SourceListData, error)
	Detail(ctx context.Context, userID int64, sourceID string) (contract.SourceDetail, error)
	Rows(ctx context.Context, userID int64, sourceID string) (contract.RowListData, error)
	Row(ctx context.Context, userID int64, sourceID, productID string) (contract.CatalogRow, error)
	CreateRow(ctx context.Context, userID int64, sourceID string, in contract.RowInput, now int64) (contract.CatalogRow, error)
	UpdateRow(ctx context.Context, userID int64, sourceID, productID string, in contract.RowInput, now int64) (contract.CatalogRow, error)
	SetPublished(ctx context.Context, userID int64, sourceID, productID string, on bool, now int64) (contract.CatalogRow, error)
	DeleteRow(ctx context.Context, userID int64, sourceID, productID string, now int64) error
}

// Deps is the mount input.
type Deps struct {
	Session Session
	Actions Actions
	Now     func() time.Time
}

// Mount registers the routes.
//
// There is deliberately no /price route here: platformPriceCents is read-only
// for a catalog manager (doc 8.2 marks the platform price as staff-only), and
// a route that does not exist cannot be reached by a future client.
func Mount(r chi.Router, d Deps) {
	r.Route("/api/supplier-catalog", func(r chi.Router) {
		r.Get("/sources", d.sources)
		r.Get("/sources/{source_id}", d.detail)
		r.Get("/sources/{source_id}/rows", d.rows)
		r.Post("/sources/{source_id}/rows", d.createRow)
		r.Get("/sources/{source_id}/rows/{product_id}", d.row)
		r.Put("/sources/{source_id}/rows/{product_id}", d.updateRow)
		r.Delete("/sources/{source_id}/rows/{product_id}", d.deleteRow)
		r.Post("/sources/{source_id}/rows/{product_id}/publish", d.publish)
		r.Post("/sources/{source_id}/rows/{product_id}/unpublish", d.unpublish)
	})
}

func (d Deps) now() int64 {
	if d.Now == nil {
		return time.Now().UnixMilli()
	}
	return d.Now().UnixMilli()
}

func (d Deps) sources(w http.ResponseWriter, r *http.Request) {
	p, ok := d.principal(w, r)
	if !ok {
		return
	}
	data, err := d.Actions.Sources(r.Context(), p.UserID)
	if err != nil {
		d.fail(w, err)
		return
	}
	if data.Sources == nil {
		data.Sources = []contract.SourceSummary{}
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) detail(w http.ResponseWriter, r *http.Request) {
	p, ok := d.principal(w, r)
	if !ok {
		return
	}
	data, err := d.Actions.Detail(r.Context(), p.UserID, chi.URLParam(r, "source_id"))
	if err != nil {
		d.fail(w, err)
		return
	}
	if data.PropDefs == nil {
		data.PropDefs = []contract.PropDef{}
	}
	if data.Rows == nil {
		data.Rows = []contract.CatalogRow{}
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) rows(w http.ResponseWriter, r *http.Request) {
	p, ok := d.principal(w, r)
	if !ok {
		return
	}
	data, err := d.Actions.Rows(r.Context(), p.UserID, chi.URLParam(r, "source_id"))
	if err != nil {
		d.fail(w, err)
		return
	}
	if data.Rows == nil {
		data.Rows = []contract.CatalogRow{}
	}
	writeData(w, http.StatusOK, data)
}

func (d Deps) row(w http.ResponseWriter, r *http.Request) {
	p, ok := d.principal(w, r)
	if !ok {
		return
	}
	row, err := d.Actions.Row(r.Context(), p.UserID, chi.URLParam(r, "source_id"), chi.URLParam(r, "product_id"))
	if err != nil {
		d.fail(w, err)
		return
	}
	writeData(w, http.StatusOK, row)
}

func (d Deps) createRow(w http.ResponseWriter, r *http.Request) {
	p, ok := d.principal(w, r)
	if !ok {
		return
	}
	in, err := decodeRowInput(r)
	if err != nil {
		d.fail(w, err)
		return
	}
	row, err := d.Actions.CreateRow(r.Context(), p.UserID, chi.URLParam(r, "source_id"), in, d.now())
	if err != nil {
		d.fail(w, err)
		return
	}
	writeData(w, http.StatusCreated, row)
}

func (d Deps) updateRow(w http.ResponseWriter, r *http.Request) {
	p, ok := d.principal(w, r)
	if !ok {
		return
	}
	in, err := decodeRowInput(r)
	if err != nil {
		d.fail(w, err)
		return
	}
	row, err := d.Actions.UpdateRow(r.Context(), p.UserID, chi.URLParam(r, "source_id"), chi.URLParam(r, "product_id"), in, d.now())
	if err != nil {
		d.fail(w, err)
		return
	}
	writeData(w, http.StatusOK, row)
}

func (d Deps) deleteRow(w http.ResponseWriter, r *http.Request) {
	p, ok := d.principal(w, r)
	if !ok {
		return
	}
	if err := d.Actions.DeleteRow(r.Context(), p.UserID, chi.URLParam(r, "source_id"), chi.URLParam(r, "product_id"), d.now()); err != nil {
		d.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d Deps) publish(w http.ResponseWriter, r *http.Request)   { d.setPublished(w, r, true) }
func (d Deps) unpublish(w http.ResponseWriter, r *http.Request) { d.setPublished(w, r, false) }

func (d Deps) setPublished(w http.ResponseWriter, r *http.Request, on bool) {
	p, ok := d.principal(w, r)
	if !ok {
		return
	}
	row, err := d.Actions.SetPublished(r.Context(), p.UserID, chi.URLParam(r, "source_id"), chi.URLParam(r, "product_id"), on, d.now())
	if err != nil {
		d.fail(w, err)
		return
	}
	writeData(w, http.StatusOK, row)
}

// rowWire is the request body. costCents and shippingCostCents are writable
// here even though they are absent from the response: that asymmetry IS the
// rule from doc 8.3, not an oversight.
type rowWire struct {
	Title                 string          `json:"title"`
	PlatformCode          string          `json:"platformCode"`
	VariantGroup          string          `json:"variantGroup"`
	DescriptionCategoryID *int64          `json:"descriptionCategoryId"`
	TypeID                *int64          `json:"typeId"`
	SuggestedRetail       *int64          `json:"suggestedRetailCents"`
	SuggestedOld          *int64          `json:"suggestedOldPriceCents"`
	CostCents             *int64          `json:"costCents"`
	ShippingCents         *int64          `json:"shippingCostCents"`
	LeadTime              string          `json:"leadTime"`
	Size                  string          `json:"size"`
	Material              string          `json:"material"`
	Craft                 string          `json:"craft"`
	GrossWeightG          *int64          `json:"grossWeightG"`
	Brand                 string          `json:"brand"`
	PackWidthMM           *int64          `json:"packWidthMm"`
	PackHeightMM          *int64          `json:"packHeightMm"`
	PackDepthMM           *int64          `json:"packDepthMm"`
	PackWeightG           *int64          `json:"packWeightG"`
	Contents              string          `json:"contents"`
	Gallery               json.RawMessage `json:"gallery"`
	PSD                   json.RawMessage `json:"psd"`
	Videos                json.RawMessage `json:"productVideos"`
	Description           string          `json:"description"`
	InternalNote          string          `json:"internalNote"`
	Props                 json.RawMessage `json:"props"`
	Revision              *int64          `json:"revision"`
	Archived              bool            `json:"archived"`
}

func decodeRowInput(r *http.Request) (contract.RowInput, error) {
	var w rowWire
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 2<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&w); err != nil {
		return contract.RowInput{}, contract.Invalid()
	}
	return contract.RowInput{
		Title: w.Title, PlatformCode: w.PlatformCode, VariantGroup: w.VariantGroup,
		DescriptionCategoryID: w.DescriptionCategoryID, TypeID: w.TypeID,
		SuggestedRetail: w.SuggestedRetail, SuggestedOld: w.SuggestedOld,
		CostCents: w.CostCents, ShippingCents: w.ShippingCents,
		LeadTime: w.LeadTime, Size: w.Size, Material: w.Material, Craft: w.Craft,
		GrossWeightG: w.GrossWeightG, Brand: w.Brand,
		PackWidthMM: w.PackWidthMM, PackHeightMM: w.PackHeightMM,
		PackDepthMM: w.PackDepthMM, PackWeightG: w.PackWeightG,
		Contents: w.Contents, Gallery: w.Gallery, PSD: w.PSD, Videos: w.Videos,
		Description: w.Description, InternalNote: w.InternalNote, Props: w.Props,
		ExpectedRevision: w.Revision, Archived: w.Archived,
	}, nil
}

func (d Deps) principal(w http.ResponseWriter, r *http.Request) (Principal, bool) {
	if d.Session == nil {
		writeErr(w, http.StatusUnauthorized, "未登录", "AUTH_INVALID")
		return Principal{}, false
	}
	p, refusal, err := d.Session.Resolve(r)
	if err != nil {
		slog.Error("supplier-catalog access", "err", err)
		writeErr(w, http.StatusInternalServerError, contract.MsgUnavailable, "INTERNAL")
		return Principal{}, false
	}
	if refusal != nil {
		writeErr(w, refusal.Status, refusal.Message, "FORBIDDEN")
		return Principal{}, false
	}
	if p == nil {
		writeErr(w, http.StatusUnauthorized, "未登录", "AUTH_INVALID")
		return Principal{}, false
	}
	return *p, true
}

func (d Deps) fail(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	if f, ok := contract.AsFault(err); ok {
		if len(f.Missing) > 0 {
			writeJSON(w, f.Status, map[string]any{
				"error": f.Message, "code": f.Code, "missing": f.Missing,
			})
			return
		}
		writeErr(w, f.Status, f.Message, f.Code)
		return
	}
	slog.Error("supplier-catalog", "err", err)
	writeErr(w, http.StatusInternalServerError, contract.MsgUnavailable, "INTERNAL")
}

func writeData(w http.ResponseWriter, status int, data any) { writeJSON(w, status, data) }

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, map[string]string{"error": message, "code": code})
}

var _ = errors.Is
