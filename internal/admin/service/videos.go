package service

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// Video is one category_videos row.
type Video struct {
	ID        string
	Name      string
	URL       string
	Duration  int64
	Category  int64
	TypeID    int64
	UpdatedAt int64
}

// VideoWrite is a create or replace body.
type VideoWrite struct {
	Name     string
	URL      string
	Duration int64
	Category int64
	TypeID   int64
}

const videoReturning = `video_id, name, video_url, duration_ms, description_category_id, type_id, updated_at_ms`

func scanVideo(row pgx.Row) (Video, error) {
	var v Video
	err := row.Scan(&v.ID, &v.Name, &v.URL, &v.Duration, &v.Category, &v.TypeID, &v.UpdatedAt)
	return v, err
}

func videoMessage(v Video) map[string]any {
	return map[string]any{
		"summary":               v.Name,
		"descriptionCategoryId": v.Category,
		"typeId":                v.TypeID,
		"videoUrl":              v.URL,
	}
}

func normalizeVideo(in VideoWrite) (VideoWrite, error) {
	if in.Category <= 0 || in.TypeID <= 0 {
		return VideoWrite{}, fail(400, "VALIDATION", "缺少有效的三级类目标识")
	}
	name, err := domain.VideoName(in.Name)
	if err != nil {
		return VideoWrite{}, fail(400, "VALIDATION", err.Error())
	}
	url, err := domain.VideoURL(in.URL)
	if err != nil {
		return VideoWrite{}, fail(400, "VALIDATION", err.Error())
	}
	if err := domain.VideoDuration(in.Duration); err != nil {
		return VideoWrite{}, fail(400, "VALIDATION", err.Error())
	}
	in.Name, in.URL = name, url
	return in, nil
}

// CreateVideo inserts a pool row.
func (d Deps) CreateVideo(ctx context.Context, actor Actor, in VideoWrite) (Video, error) {
	var out Video
	err := d.under(ctx, "视频池写入未启用", func(g *gate) error {
		norm, err := normalizeVideo(in)
		if err != nil {
			return err
		}
		id, err := NewPublicID()
		if err != nil {
			return fail(500, "INTERNAL", "服务暂不可用")
		}
		id = "video_" + stringsReplace(id)
		public, err := d.publicID(ctx, g.tx, actor.UserID)
		if err != nil {
			return err
		}
		now := d.nowMS()
		out, err = scanVideo(g.tx.QueryRow(ctx, `INSERT INTO public.category_videos
   (video_id, description_category_id, type_id, name, video_url, duration_ms,
    created_at_ms, updated_at_ms, created_by_account_uuid)
VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
RETURNING `+videoReturning, id, norm.Category, norm.TypeID, norm.Name, norm.URL, norm.Duration, now, public))
		if unique(err) {
			return fail(409, "CONFLICT", "视频标识冲突，请重试")
		}
		if errors.Is(err, pgx.ErrNoRows) {
			slog.Error("新增视频未返回记录")
			return fail(500, "INTERNAL", "服务暂不可用")
		}
		if err != nil {
			return err
		}
		return g.audit(ctx, orgAtLeastZero(actor.OrgID), actor.UserID, "admin", "category_video", out.ID, "POST", "/api/admin/videos", "category_video_created", videoMessage(out))
	})
	return out, err
}

// UpdateVideo replaces one pool row.
func (d Deps) UpdateVideo(ctx context.Context, actor Actor, videoID string, in VideoWrite) (Video, error) {
	var out Video
	err := d.under(ctx, "视频池写入未启用", func(g *gate) error {
		norm, err := normalizeVideo(in)
		if err != nil {
			return err
		}
		now := d.nowMS()
		out, err = scanVideo(g.tx.QueryRow(ctx, `UPDATE public.category_videos
SET description_category_id = $2, type_id = $3, name = $4, video_url = $5, duration_ms = $6, updated_at_ms = $7
WHERE video_id = $1
RETURNING `+videoReturning, videoID, norm.Category, norm.TypeID, norm.Name, norm.URL, norm.Duration, now))
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "视频不存在或已删除")
		}
		if err != nil {
			return err
		}
		return g.audit(ctx, orgAtLeastZero(actor.OrgID), actor.UserID, "admin", "category_video", out.ID, "PUT", "/api/admin/videos/{video_id}", "category_video_updated", videoMessage(out))
	})
	return out, err
}

// DeleteVideo removes one pool row. The origin object is left in place.
func (d Deps) DeleteVideo(ctx context.Context, actor Actor, videoID string) error {
	return d.under(ctx, "视频池写入未启用", func(g *gate) error {
		row, err := scanVideo(g.tx.QueryRow(ctx, `DELETE FROM public.category_videos WHERE video_id = $1 RETURNING `+videoReturning, videoID))
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "视频不存在或已删除")
		}
		if err != nil {
			return err
		}
		return g.audit(ctx, orgAtLeastZero(actor.OrgID), actor.UserID, "admin", "category_video", videoID, "DELETE", "/api/admin/videos/{video_id}", "category_video_deleted", videoMessage(row))
	})
}

func stringsReplace(id string) string {
	out := make([]byte, 0, 32)
	for i := 0; i < len(id); i++ {
		if id[i] != '-' {
			out = append(out, id[i])
		}
	}
	return string(out)
}
