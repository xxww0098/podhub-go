package aihttp

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// A timed-out POST may not have delivered its set id. Lookup never purchases
// or retries inference, so the original key remains safe across page reloads.
func (h httpHandler) imageSetLookup(w http.ResponseWriter, r *http.Request) {
	principal, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	key, ok := Key(r.Header.Get("Idempotency-Key"))
	if !ok {
		writeResp(w, fail(400, "VALIDATION", "请求缺少有效的 Idempotency-Key 请求头"))
		return
	}
	var id string
	err := imageTx(r.Context(), h.deps.Deps, principal.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `SELECT id::text FROM ai_image_sets WHERE org_id=$1 AND idempotency_key=$2`, principal.OrgID, key).Scan(&id)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeResp(w, fail(404, "NOT_FOUND", "套图请求不存在"))
		return
	}
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	h.writeImageSet(w, r, principal.OrgID, id)
}
