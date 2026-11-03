package readhttp

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/listing/read/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func (h Host) taskRecords(w http.ResponseWriter, r *http.Request) {
	p, ok := h.prepare(w, r)
	if !ok {
		return
	}
	filter, message := domain.ParseTaskRecordsQuery(r.URL.Query())
	if message != "" {
		writeErr(w, http.StatusBadRequest, message, "validation")
		return
	}
	if h.Pool == nil || h.ReadTaskRecords == nil {
		writeErr(w, http.StatusServiceUnavailable, "任务记录暂不可用，请稍后重试", "unavailable")
		return
	}
	var page domain.TaskRecordsPage
	err := db.InTx(r.Context(), h.Pool, db.App(p.OrgID), func(tx pgx.Tx) error {
		seat, found, err := loadSeat(r.Context(), tx, p.OrgID, p.UserID)
		if err != nil {
			return err
		}
		if !found {
			return halt{http.StatusForbidden, "工作空间成员当前不可用", "forbidden"}
		}
		if filter.StoreID != "" {
			if err := requireIntentStore(r.Context(), tx, p.OrgID, p.UserID, filter.StoreID); err != nil {
				return err
			}
		}
		page, err = h.ReadTaskRecords(r.Context(), tx, p.OrgID, p.UserID, seat.id, seat.manageAll, filter)
		return err
	})
	if h.writeTx(w, err) {
		jsonwire.Write(w, http.StatusOK, struct {
			Data domain.TaskRecordsPage `json:"data"`
		}{Data: page})
	}
}
