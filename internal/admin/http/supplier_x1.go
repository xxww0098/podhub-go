package adminhttp

import (
	"io"
	"mime"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

func (h handler) dispatchX1(w http.ResponseWriter, r *http.Request, rt Route, actor contract.Actor) bool {
	fam := familyOf(rt.Path)
	svc := h.svc()
	source := chi.URLParam(r, "source_id")
	product := chi.URLParam(r, "product_id")
	switch rt.Method + " " + rt.Path {
	case "POST /api/admin/supplier-db-storage/directories":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		out, err := svc.CreateDirectory(r.Context(), actor, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusCreated, out)
		return true
	case "GET /api/admin/supplier-db-storage/objects":
		prefix, cursor, qerr := storageQuery(r)
		if qerr != "" {
			writeQuery(w, qerr)
			return true
		}
		page, err := svc.ListObjects(r.Context(), actor, prefix, cursor)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, page)
		return true
	case "POST /api/admin/supplier-db-storage/objects/delete":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		out, err := svc.DeleteObjects(r.Context(), actor, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, out)
		return true
	case "POST /api/admin/supplier-db-storage/objects/move":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		out, err := svc.MoveObject(r.Context(), actor, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, out)
		return true
	case "POST /api/admin/supplier-db-storage/uploads":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		out, err := svc.IssueStorageUpload(r.Context(), actor, body, r.Header.Get("x-podhub-store-checksum"))
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, uploadEnvelope(out))
		return true
	case "POST /api/admin/supplier-db-storage/uploads/confirm":
		body, ok := readStrictJSON(w, r, fam, domain.ConfirmBodyLimit)
		if !ok {
			return true
		}
		out, err := svc.ConfirmStorageUpload(r.Context(), actor, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, out)
		return true
	case "GET /api/admin/supplier-dbs/{source_id}":
		out, err := svc.Detail(r.Context(), actor, source)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, out)
		return true
	case "POST /api/admin/supplier-dbs/{source_id}/rows":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		row, err := svc.CreateRow(r.Context(), actor, source, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusCreated, rowEnvelope(row))
		return true
	case "PUT /api/admin/supplier-dbs/{source_id}/rows/{product_id}":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		row, err := svc.UpdateRow(r.Context(), actor, source, product, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, rowEnvelope(row))
		return true
	case "GET /api/admin/supplier-dbs/{source_id}/rows/{product_id}/ozon-config":
		cfg, err := svc.LoadOzon(r.Context(), actor, source, product)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, configEnvelope(cfg))
		return true
	case "PUT /api/admin/supplier-dbs/{source_id}/rows/{product_id}/ozon-config":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		cfg, err := svc.SaveOzon(r.Context(), actor, source, product, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, configEnvelope(cfg))
		return true
	case "POST /api/admin/supplier-dbs/{source_id}/rows/{product_id}/price":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		row, err := svc.AdjustPrice(r.Context(), actor, source, product, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, rowEnvelope(row))
		return true
	case "GET /api/admin/supplier-dbs/{source_id}/rows/{product_id}/prompt/diff":
		revision, qerr := diffRevision(r)
		if qerr != "" {
			writeQuery(w, qerr)
			return true
		}
		out, err := svc.PromptDiff(r.Context(), actor, source, product, revision)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, out)
		return true
	case "POST /api/admin/supplier-dbs/{source_id}/rows/{product_id}/prompt/preview":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		out, err := svc.PreviewPrompt(body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, out)
		return true
	case "POST /api/admin/supplier-dbs/{source_id}/rows/{product_id}/prompt/publish":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		out, err := svc.PublishPrompt(r.Context(), actor, source, product, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, out)
		return true
	case "POST /api/admin/supplier-dbs/{source_id}/rows/{product_id}/publish":
		row, err := svc.PublishRow(r.Context(), actor, source, product, true)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, rowEnvelope(row))
		return true
	case "POST /api/admin/supplier-dbs/{source_id}/rows/{product_id}/unpublish":
		row, err := svc.PublishRow(r.Context(), actor, source, product, false)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, rowEnvelope(row))
		return true
	case "POST /api/admin/supplier-dbs/{source_id}/uploads":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		out, err := svc.IssueRowUpload(r.Context(), actor, source, body, r.Header.Get("x-podhub-store-checksum"))
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, uploadEnvelope(out))
		return true
	case "POST /api/admin/supplier-dbs/{source_id}/uploads/abort":
		body, ok := readStrictJSON(w, r, fam, domain.ConfirmBodyLimit)
		if !ok {
			return true
		}
		if err := svc.AbortRowUpload(r.Context(), actor, source, body); err != nil {
			writeFail(w, fam, err)
			return true
		}
		w.WriteHeader(http.StatusNoContent)
		return true
	case "POST /api/admin/supplier-dbs/{source_id}/uploads/confirm":
		body, ok := readStrictJSON(w, r, fam, domain.ConfirmBodyLimit)
		if !ok {
			return true
		}
		out, err := svc.ConfirmRowUpload(r.Context(), actor, source, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, out)
		return true
	case "POST /api/admin/supplier-prompts/sync":
		out, err := svc.SyncPrompts(r.Context(), actor)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, out)
		return true
	case "PATCH /api/admin/supplier-prompts/{product_id}":
		body, ok := readStrictJSON(w, r, fam, domain.BodyLimitBytes)
		if !ok {
			return true
		}
		out, err := svc.PatchPrompt(r.Context(), actor, product, body)
		if err != nil {
			writeFail(w, fam, err)
			return true
		}
		writeData(w, http.StatusOK, struct {
			Prompt domain.Prompt `json:"prompt"`
		}{out})
		return true
	default:
		return false
	}
}

func rowEnvelope(row domain.RowData) any {
	return struct {
		Row domain.RowData `json:"row"`
	}{row}
}

func configEnvelope(cfg domain.OzonConfig) any {
	return struct {
		Config domain.OzonConfig `json:"config"`
	}{cfg}
}

func uploadEnvelope(body domain.UploadBody) any {
	return struct {
		Upload domain.UploadBody `json:"upload"`
	}{body}
}

func readStrictJSON(w http.ResponseWriter, r *http.Request, fam string, limit int) ([]byte, bool) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		writeFamily(w, fam, http.StatusBadRequest, "请求格式无效", contract.KindValidation)
		return nil, false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, int64(limit)+1))
	if err != nil || len(raw) > limit {
		writeFamily(w, fam, http.StatusBadRequest, "请求格式无效", contract.KindValidation)
		return nil, false
	}
	return raw, true
}

func writeQuery(w http.ResponseWriter, detail string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusBadRequest)
	_, _ = io.WriteString(w, "Failed to deserialize query string: "+detail)
}

func storageQuery(r *http.Request) (string, *string, string) {
	q := r.URL.Query()
	for key := range q {
		if key != "prefix" && key != "cursor" {
			return "", nil, "unknown field `" + key + "`, expected `prefix` or `cursor`"
		}
	}
	prefix := ""
	if vs := q["prefix"]; len(vs) > 0 {
		prefix = vs[0]
	}
	var cursor *string
	if vs := q["cursor"]; len(vs) > 0 {
		c := vs[0]
		cursor = &c
	}
	return prefix, cursor, ""
}

func diffRevision(r *http.Request) (*int32, string) {
	vs, ok := r.URL.Query()["revision"]
	if !ok || len(vs) == 0 {
		return nil, ""
	}
	n, err := strconv.ParseInt(vs[0], 10, 32)
	if err != nil {
		return nil, "revision: invalid digit found in string"
	}
	v := int32(n)
	return &v, ""
}
