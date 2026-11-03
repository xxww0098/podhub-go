package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	"github.com/xxww0098/podhub-go/internal/media/jobs/slicepurge"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func (s *Server) workspaceSliceAccount(r *http.Request, writing bool) (access.Principal, sign.Account, error) {
	actor, _, err := s.mediaActor(r, "")
	if err != nil {
		return actor, sign.Account{}, err
	}
	if writing && actor.WorkspaceRole != "owner" {
		return actor, sign.Account{}, workspaceStorageOwnerRequired()
	}
	account, ok := s.mediaAccount(r.Context(), actor)
	if !ok {
		return actor, sign.Account{}, &mediaFailure{409, "WORKSPACE_STORAGE_NOT_READY", "请等待工作空间所有者完成存储桶创建"}
	}
	return actor, account, nil
}

func (s *Server) listWorkspaceSliceObjects(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	_, account, err := s.workspaceSliceAccount(r, false)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	prefix := r.URL.Query().Get("prefix")
	if len(prefix) > 512 || strings.Contains(prefix, "..") || strings.HasPrefix(prefix, "/") {
		writeMediaFailure(w, mediaInvalid())
		return
	}
	page, err := r2.ListObjects(r.Context(), account, account.KeyPrefix+"uploads/"+prefix, r.URL.Query().Get("cursor"), 100, true)
	if err != nil {
		writeMediaFailure(w, &mediaFailure{502, "WORKSPACE_STORAGE_LIST_FAILED", "无法读取存储桶内容，请重试"})
		return
	}
	base := account.KeyPrefix + "uploads/"
	for i := range page.Folders {
		page.Folders[i] = strings.TrimPrefix(page.Folders[i], base)
	}
	jsonwire.Write(w, 200, page)
}

func (s *Server) workspaceSliceStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	_, account, err := s.workspaceSliceAccount(r, false)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var count, size uint64
	cursor := ""
	complete := false
	// shortcut: at most 100,000 objects per on-demand scan; use provider metrics
	// when workspaces regularly exceed this size. Partial totals stay explicit.
	for page := 0; page < 100; page++ {
		objects, err := r2.ListObjects(ctx, account, account.KeyPrefix+"uploads/", cursor, 1000, false)
		if err != nil {
			writeMediaFailure(w, &mediaFailure{502, "WORKSPACE_STORAGE_STATS_FAILED", "容量统计未完成，请重试"})
			return
		}
		for _, object := range objects.Objects {
			count++
			size += object.Size
		}
		if objects.Next == "" {
			complete = true
			break
		}
		cursor = objects.Next
	}
	jsonwire.Write(w, 200, map[string]any{"objects": count, "bytes": size, "complete": complete, "observed_at": s.now().Format(time.RFC3339)})
}

func ownedSliceObject(account sign.Account, key string) bool {
	_, ok := objectkey.ParseUploadKey(key)
	return ok && strings.HasPrefix(key, account.KeyPrefix+"uploads/")
}

func (s *Server) downloadWorkspaceSliceObject(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	_, account, err := s.workspaceSliceAccount(r, false)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	key := r.URL.Query().Get("key")
	if !ownedSliceObject(account, key) {
		writeMediaFailure(w, mediaInvalid())
		return
	}
	filename := key[strings.LastIndex(key, "/")+1:]
	raw, _, err := sign.PresignURL(account, http.MethodGet, key, "", s.now(), 5*time.Minute, [][2]string{{"response-content-disposition", `attachment; filename="` + filename + `"`}}, nil)
	if err != nil {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	jsonwire.Write(w, 200, map[string]string{"url": raw})
}

func (s *Server) deleteWorkspaceSliceObjects(w http.ResponseWriter, r *http.Request) {
	actor, account, err := s.workspaceSliceAccount(r, true)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if !s.SliceDeleteAllowed {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	var in struct {
		Keys   []string `json:"keys"`
		Prefix *string  `json:"prefix"`
	}
	if decodeMedia(r, &in) != nil || (in.Prefix != nil) == (in.Keys != nil) || len(in.Keys) > 100 {
		writeMediaFailure(w, mediaInvalid())
		return
	}
	if in.Prefix != nil {
		root := account.KeyPrefix + "uploads/"
		relative := strings.TrimPrefix(*in.Prefix, root)
		normalized, prefixErr := objectkey.NormalizePrefix(relative)
		if !strings.HasPrefix(*in.Prefix, root) || relative == "" || len(relative) > 512 || prefixErr != nil || normalized != relative {
			writeMediaFailure(w, mediaInvalid())
			return
		}
		page, err := r2.ListObjects(r.Context(), account, *in.Prefix, "", 100, false)
		if err != nil || len(page.Folders) != 0 || len(page.Objects) == 0 && page.Next != "" {
			writeMediaFailure(w, &mediaFailure{502, "WORKSPACE_STORAGE_LIST_FAILED", "无法完整读取待删除目录，请重试"})
			return
		}
		for _, object := range page.Objects {
			in.Keys = append(in.Keys, object.Key)
		}
	} else if len(in.Keys) == 0 {
		writeMediaFailure(w, mediaInvalid())
		return
	}
	boundary := s.now().Add(-16 * time.Minute)
	seen := map[string]bool{}
	for _, key := range in.Keys {
		parsed, ok := objectkey.ParseUploadKey(key)
		if !ok || !ownedSliceObject(account, key) || seen[key] {
			writeMediaFailure(w, mediaInvalid())
			return
		}
		if !time.UnixMilli(parsed.BatchMS).Before(boundary) {
			writeMediaFailure(w, &mediaFailure{409, "WORKSPACE_STORAGE_UPLOAD_ACTIVE", "图片上传链接仍可能有效，请在上传后 16 分钟再删除"})
			return
		}
		seen[key] = true
	}
	err = s.ownerStorageTx(r.Context(), actor, func(tx pgx.Tx) error {
		if err := s.currentTransit(r.Context(), tx, actor, account); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended('transit-upload-quota:' || $1::bigint::text, 0))`, actor.OrgID); err != nil {
			return err
		}
		prefix := ""
		if in.Prefix != nil {
			prefix = *in.Prefix
		}
		var active bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM media_object_leases
			WHERE org_id=$1 AND media_account_id=$2 AND retired_at IS NULL AND deleted_at IS NULL AND last_hit_at>clock_timestamp()-interval '16 minutes'
			AND (object_key=ANY($3) OR ($4<>'' AND starts_with(object_key,$4))))`, actor.OrgID, account.ID, in.Keys, prefix).Scan(&active); err != nil {
			return err
		}
		if active {
			return &mediaFailure{409, "WORKSPACE_STORAGE_UPLOAD_ACTIVE", "图片上传链接仍可能有效，请在上传后 16 分钟再删除"}
		}
		_, err := tx.Exec(r.Context(), `UPDATE media_object_leases SET retired_at=clock_timestamp(),updated_at=clock_timestamp() WHERE org_id=$1 AND media_account_id=$2 AND object_key=ANY($3) AND retired_at IS NULL`, actor.OrgID, account.ID, in.Keys)
		return err
	})
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if len(in.Keys) == 0 {
		jsonwire.Write(w, 200, map[string]any{"deleted": 0, "failed_keys": []string{}, "has_more": false})
		return
	}
	result, err := (slicepurge.AccountOrigin{Account: account, Before: boundary}).Delete(r.Context(), in.Keys)
	if err != nil {
		writeMediaFailure(w, &mediaFailure{502, "WORKSPACE_STORAGE_DELETE_UNCONFIRMED", "删除结果未确认，请刷新对象列表核对"})
		return
	}
	hasMore := false
	if in.Prefix != nil {
		remaining, err := r2.ListObjects(r.Context(), account, *in.Prefix, "", 1, false)
		if err != nil {
			writeMediaFailure(w, &mediaFailure{502, "WORKSPACE_STORAGE_DELETE_UNCONFIRMED", "删除后未能核对目录，请刷新列表后重试"})
			return
		}
		hasMore = len(remaining.Objects) != 0 || len(remaining.Folders) != 0 || remaining.Next != ""
	}
	jsonwire.Write(w, 200, map[string]any{"deleted": result.Deleted, "failed_keys": result.FailedKeys, "has_more": hasMore})
}
