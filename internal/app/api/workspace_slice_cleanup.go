package api

import (
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
)

func (s *Server) updateWorkspaceSliceCleanup(w http.ResponseWriter, r *http.Request) {
	actor, _, err := s.mediaActor(r, "")
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if actor.WorkspaceRole != "owner" {
		writeMediaFailure(w, workspaceStorageOwnerRequired())
		return
	}
	var in struct {
		Mode string  `json:"cleanup_mode"`
		Time *string `json:"cleanup_time"`
	}
	if decodeMedia(r, &in) != nil {
		writeMediaFailure(w, mediaInvalid())
		return
	}
	var minute *int32
	if in.Mode == "daily" && in.Time != nil {
		parsed, parseErr := time.Parse("15:04", *in.Time)
		if parseErr == nil && parsed.Format("15:04") == *in.Time {
			value := int32(parsed.Hour()*60 + parsed.Minute())
			minute = &value
		}
	}
	if (in.Mode == "daily" && minute == nil) || (in.Mode == "manual" && in.Time != nil) || (in.Mode != "daily" && in.Mode != "manual") {
		writeMediaFailure(w, &mediaFailure{400, "VALIDATION", "请选择手动清理或有效的每日清理时间"})
		return
	}
	err = s.ownerStorageTx(r.Context(), actor, func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended('workspace-slice-storage:'||$1::bigint::text,0))`, actor.OrgID); err != nil {
			return err
		}
		row, err := mediarepo.ActiveSliceStorage(r.Context(), tx, actor.OrgID, s.SliceStorageKey)
		if err != nil {
			return err
		}
		if row == nil {
			return &mediaFailure{422, "VALIDATION", "请先配置切片 R2"}
		}
		if (minute == nil && row.ClearAtMinute == nil) || (minute != nil && row.ClearAtMinute != nil && *minute == *row.ClearAtMinute) {
			return nil
		}
		var running bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM public.transit_clear_runs
			WHERE bucket_identity=$1 AND status='running' AND lease_until>clock_timestamp())`, media.SliceClearIdentity("daily", row.Account.ID)).Scan(&running); err != nil {
			return err
		}
		if running {
			return &mediaFailure{409, "WORKSPACE_STORAGE_BUSY", "自动清理正在进行，请稍后重试"}
		}
		return mediarepo.SetSliceCleanupPolicy(r.Context(), tx, actor.OrgID, actor.UserID, row.Account.ID, minute)
	})
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	s.getWorkspaceSliceStorage(w, r)
}
