package readhttp

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

func (h Host) deleteRow(w http.ResponseWriter, r *http.Request) {
	if crossOriginWrite(r) {
		writeCSRF(w)
		return
	}
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	id, ok := queryID(r)
	if !ok {
		writeErr(w, 400, "商品行编号无效", "validation")
		return
	}
	if !h.requireRow(w, r, p, id) {
		return
	}
	err := h.mediaTx(r.Context(), p, func(tx pgx.Tx) error {
		var content, media, submission string
		err := tx.QueryRow(r.Context(), `SELECT content_state,media_state,submission_state FROM listing_rows WHERE org_id=$1 AND id=$2::uuid FOR UPDATE`, p.OrgID, id).Scan(&content, &media, &submission)
		if errors.Is(err, pgx.ErrNoRows) {
			return rowRefuse{404, "商品行不存在", "not_found"}
		}
		if err != nil {
			return err
		}
		if content == "recognizing" || media == "processing" || media == "uploading" || submission == "queued" || submission == "submitting" || submission == "unknown" {
			return rowRefuse{409, "请先停止准备或处理发布回执，再删除商品", "conflict"}
		}
		_, err = tx.Exec(r.Context(), `DELETE FROM listing_rows WHERE org_id=$1 AND id=$2::uuid`, p.OrgID, id)
		return err
	})
	if err != nil {
		mediaError(w, err)
		return
	}
	mediaData(w, map[string]any{"id": id})
}
