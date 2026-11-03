package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

// catalogPromptLeafWire is one Ozon L3 leaf that currently has at least one Cloud
// prompt. The catalogue pools are global platform data, not tenant rows.
type catalogPromptLeafWire struct {
	DescriptionCategoryID int64 `json:"description_category_id"`
	TypeID                int64 `json:"type_id"`
}

type catalogPromptWire struct {
	PromptID              string    `json:"prompt_id"`
	Name                  string    `json:"name"`
	FileName              string    `json:"file_name"`
	DescriptionCategoryID int64     `json:"description_category_id"`
	TypeID                int64     `json:"type_id"`
	UpdatedAtMS           int64     `json:"updated_at_ms"`
	Content               *string   `json:"content"`
	FixedTags             *[]string `json:"fixed_tags"`
}

type promptLeavesData struct {
	Leaves []catalogPromptLeafWire `json:"leaves"`
}

type promptCategoryListData struct {
	Prompts []catalogPromptWire `json:"prompts"`
}

type catalogVideoWire struct {
	VideoID               string `json:"video_id"`
	Name                  string `json:"name"`
	VideoURL              string `json:"video_url"`
	DurationMS            int64  `json:"duration_ms"`
	DescriptionCategoryID int64  `json:"description_category_id"`
	TypeID                int64  `json:"type_id"`
	UpdatedAtMS           int64  `json:"updated_at_ms"`
}

type videoCategoryListData struct {
	Videos []catalogVideoWire `json:"videos"`
}

// ListPromptLeaves serves GET /api/prompts/categories.
func (s *Server) ListPromptLeaves(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.catalogAssetActor(w, r); !ok {
		return
	}
	var leaves []catalogPromptLeafWire
	err := s.catalogAssetsRead(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `SELECT description_category_id, type_id
			FROM public.category_prompts
			GROUP BY description_category_id, type_id
			ORDER BY description_category_id, type_id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var leaf catalogPromptLeafWire
			if err := rows.Scan(&leaf.DescriptionCategoryID, &leaf.TypeID); err != nil {
				return err
			}
			leaves = append(leaves, leaf)
		}
		return rows.Err()
	})
	if err != nil {
		s.logCatalogAssetError("prompt leaves", err)
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data promptLeavesData `json:"data"`
	}{Data: promptLeavesData{Leaves: nonNilPromptLeaves(leaves)}})
}

// ListCategoryPrompts serves GET /api/prompts/category/{description_category_id}/{type_id}.
func (s *Server) ListCategoryPrompts(w http.ResponseWriter, r *http.Request) {
	p, ok := s.catalogAssetActor(w, r)
	if !ok {
		return
	}
	descriptionCategoryID, err := positivePathInt(r, "description_category_id")
	if err != nil {
		writeAdmin(w, http.StatusBadRequest, "分类参数无效", "VALIDATION")
		return
	}
	typeID, err := positivePathInt(r, "type_id")
	if err != nil {
		writeAdmin(w, http.StatusBadRequest, "分类参数无效", "VALIDATION")
		return
	}
	staff := access.IsPlatformStaff(p.PlatformRole)
	var prompts []catalogPromptWire
	err = s.catalogAssetsRead(r.Context(), func(tx pgx.Tx) error {
		query := `SELECT prompt_id, name, file_name, description_category_id, type_id, updated_at_ms, content, fixed_tags
			FROM public.category_prompts
			WHERE description_category_id=$1 AND type_id=$2
			ORDER BY name, prompt_id`
		if !staff {
			query = `SELECT prompt_id, name, file_name, description_category_id, type_id, updated_at_ms, NULL::text, NULL::jsonb
				FROM public.category_prompts
				WHERE description_category_id=$1 AND type_id=$2
				ORDER BY name, prompt_id`
		}
		rows, err := tx.Query(r.Context(), query, descriptionCategoryID, typeID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var prompt catalogPromptWire
			var content *string
			var fixedTags []byte
			if err := rows.Scan(&prompt.PromptID, &prompt.Name, &prompt.FileName,
				&prompt.DescriptionCategoryID, &prompt.TypeID, &prompt.UpdatedAtMS, &content, &fixedTags); err != nil {
				return err
			}
			if staff {
				prompt.Content = content
				if fixedTags != nil {
					var tags []string
					if err := json.Unmarshal(fixedTags, &tags); err != nil {
						return err
					}
					prompt.FixedTags = &tags
				}
			}
			prompts = append(prompts, prompt)
		}
		return rows.Err()
	})
	if err != nil {
		s.logCatalogAssetError("category prompts", err)
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data promptCategoryListData `json:"data"`
	}{Data: promptCategoryListData{Prompts: nonNilPrompts(prompts)}})
}

// ListCategoryVideos serves GET /api/videos/category/{description_category_id}/{type_id}.
func (s *Server) ListCategoryVideos(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.catalogAssetActor(w, r); !ok {
		return
	}
	descriptionCategoryID, err := positivePathInt(r, "description_category_id")
	if err != nil {
		writeAdmin(w, http.StatusBadRequest, "分类参数无效", "VALIDATION")
		return
	}
	typeID, err := positivePathInt(r, "type_id")
	if err != nil {
		writeAdmin(w, http.StatusBadRequest, "分类参数无效", "VALIDATION")
		return
	}
	var videos []catalogVideoWire
	err = s.catalogAssetsRead(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `SELECT video_id, name, video_url, duration_ms,
			description_category_id, type_id, updated_at_ms
			FROM public.category_videos
			WHERE description_category_id=$1 AND type_id=$2
			ORDER BY name, video_id`, descriptionCategoryID, typeID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var video catalogVideoWire
			if err := rows.Scan(&video.VideoID, &video.Name, &video.VideoURL, &video.DurationMS,
				&video.DescriptionCategoryID, &video.TypeID, &video.UpdatedAtMS); err != nil {
				return err
			}
			videos = append(videos, video)
		}
		return rows.Err()
	})
	if err != nil {
		s.logCatalogAssetError("category videos", err)
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data videoCategoryListData `json:"data"`
	}{Data: videoCategoryListData{Videos: nonNilVideos(videos)}})
}

func (s *Server) catalogAssetActor(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	p, refusal, err := s.principal(r)
	if err != nil {
		writeAdmin(w, http.StatusInternalServerError, access.MsgUnavailable, "INTERNAL")
		return access.Principal{}, false
	}
	if refusal != nil {
		writeAdmin(w, refusal.Status, refusal.Message, adminCode(refusal))
		return access.Principal{}, false
	}
	if p.UserID <= 0 {
		writeAdmin(w, http.StatusUnauthorized, access.MsgUnauthenticated, "AUTH_INVALID")
		return access.Principal{}, false
	}
	return p, true
}

func (s *Server) catalogAssetsRead(ctx context.Context, fn func(pgx.Tx) error) error {
	if s == nil || s.Pool == nil {
		return errors.New("catalog asset store unavailable")
	}
	return db.InTx(ctx, s.Pool, db.AppRole(), fn)
}

func (s *Server) logCatalogAssetError(scope string, err error) {
	slog.Error("catalog asset read", "scope", scope, "err", err)
}

func positivePathInt(r *http.Request, name string) (int64, error) {
	value := strings.TrimSpace(chi.URLParam(r, name))
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, errors.New("invalid category coordinates")
	}
	return parsed, nil
}

func nonNilPromptLeaves(values []catalogPromptLeafWire) []catalogPromptLeafWire {
	if values == nil {
		return []catalogPromptLeafWire{}
	}
	return values
}

func nonNilPrompts(values []catalogPromptWire) []catalogPromptWire {
	if values == nil {
		return []catalogPromptWire{}
	}
	return values
}

func nonNilVideos(values []catalogVideoWire) []catalogVideoWire {
	if values == nil {
		return []catalogVideoWire{}
	}
	return values
}
