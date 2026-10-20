package service

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	core "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	rules "github.com/xxww0098/podhub-go/internal/listing/rules/contract"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

// Prompt is one category_prompts row.
type Prompt struct {
	ID        string
	Name      string
	FileName  string
	Content   string
	Category  int64
	TypeID    int64
	FixedTags []string
	UpdatedAt int64
}

// PromptWrite is a create or replace body.
type PromptWrite struct {
	Name     string
	FileName string
	Content  string
	Category int64
	TypeID   int64
	Tags     []string
}

const promptReturning = `prompt_id, name, file_name, content, description_category_id, type_id, fixed_tags, updated_at_ms`

func scanPrompt(row pgx.Row) (Prompt, error) {
	var p Prompt
	var tags []byte
	err := row.Scan(&p.ID, &p.Name, &p.FileName, &p.Content, &p.Category, &p.TypeID, &tags, &p.UpdatedAt)
	if err != nil {
		return Prompt{}, err
	}
	p.FixedTags = []string{}
	if len(tags) > 0 {
		_ = json.Unmarshal(tags, &p.FixedTags)
	}
	if p.FixedTags == nil {
		p.FixedTags = []string{}
	}
	return p, nil
}

// CreatePrompt inserts a category prompt.
func (d Deps) CreatePrompt(ctx context.Context, actor Actor, in PromptWrite) (Prompt, error) {
	var out Prompt
	err := d.under(ctx, "提示词目录写入未启用", func(g *gate) error {
		norm, err := d.normalizePrompt(ctx, in)
		if err != nil {
			return err
		}
		id, err := NewPublicID()
		if err != nil {
			return fail(500, "INTERNAL", "服务暂不可用")
		}
		id = "prompt_" + strings.ReplaceAll(id, "-", "")
		public, err := d.publicID(ctx, g.tx, actor.UserID)
		if err != nil {
			return err
		}
		tags, err := jsonwire.Marshal(norm.Tags)
		if err != nil {
			return err
		}
		now := d.nowMS()
		out, err = scanPrompt(g.tx.QueryRow(ctx, `INSERT INTO public.category_prompts
    (prompt_id, description_category_id, type_id, name, file_name, content,
     fixed_tags, created_at_ms, updated_at_ms, created_by_account_uuid)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8, $9)
RETURNING `+promptReturning, id, norm.Category, norm.TypeID, norm.Name, norm.FileName, norm.Content, string(tags), now, public))
		if unique(err) {
			return fail(409, "CONFLICT", "提示词标识冲突，请重试")
		}
		if errors.Is(err, pgx.ErrNoRows) {
			slog.Error("新增提示词未返回记录")
			return fail(500, "INTERNAL", "服务暂不可用")
		}
		if err != nil {
			return err
		}
		return g.audit(ctx, orgAtLeastZero(actor.OrgID), actor.UserID, "admin", "category_prompt", out.ID, "POST", "/api/admin/prompts", "category_prompt_created", promptMessage(out))
	})
	return out, err
}

// UpdatePrompt replaces one prompt.
func (d Deps) UpdatePrompt(ctx context.Context, actor Actor, promptID string, in PromptWrite) (Prompt, error) {
	var out Prompt
	err := d.under(ctx, "提示词目录写入未启用", func(g *gate) error {
		norm, err := d.normalizePrompt(ctx, in)
		if err != nil {
			return err
		}
		tags, err := jsonwire.Marshal(norm.Tags)
		if err != nil {
			return err
		}
		now := d.nowMS()
		out, err = scanPrompt(g.tx.QueryRow(ctx, `UPDATE public.category_prompts
SET description_category_id = $2, type_id = $3, name = $4, file_name = $5, content = $6, fixed_tags = $7::jsonb, updated_at_ms = $8
WHERE prompt_id = $1
RETURNING `+promptReturning, promptID, norm.Category, norm.TypeID, norm.Name, norm.FileName, norm.Content, string(tags), now))
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "提示词不存在或已删除")
		}
		if err != nil {
			return err
		}
		return g.audit(ctx, orgAtLeastZero(actor.OrgID), actor.UserID, "admin", "category_prompt", out.ID, "PUT", "/api/admin/prompts/{prompt_id}", "category_prompt_updated", promptMessage(out))
	})
	return out, err
}

// DeletePrompt removes one prompt and returns the path id.
func (d Deps) DeletePrompt(ctx context.Context, actor Actor, promptID string) error {
	return d.under(ctx, "提示词目录写入未启用", func(g *gate) error {
		row, err := scanPrompt(g.tx.QueryRow(ctx, `DELETE FROM public.category_prompts WHERE prompt_id = $1 RETURNING `+promptReturning, promptID))
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "提示词不存在或已删除")
		}
		if err != nil {
			return err
		}
		return g.audit(ctx, orgAtLeastZero(actor.OrgID), actor.UserID, "admin", "category_prompt", promptID, "DELETE", "/api/admin/prompts/{prompt_id}", "category_prompt_deleted", promptMessage(row))
	})
}

func promptMessage(p Prompt) map[string]any {
	tags := p.FixedTags
	if tags == nil {
		tags = []string{}
	}
	return map[string]any{
		"summary":               p.Name,
		"descriptionCategoryId": p.Category,
		"typeId":                p.TypeID,
		"fileName":              p.FileName,
		"fixedTags":             tags,
	}
}

func (d Deps) normalizePrompt(ctx context.Context, in PromptWrite) (PromptWrite, error) {
	if in.Category <= 0 || in.TypeID <= 0 {
		return PromptWrite{}, fail(400, "VALIDATION", "缺少有效的三级类目标识")
	}
	name, err := domain.PromptName(in.Name)
	if err != nil {
		return PromptWrite{}, fail(400, "VALIDATION", err.Error())
	}
	file, err := domain.PromptFile(in.FileName)
	if err != nil {
		return PromptWrite{}, fail(400, "VALIDATION", err.Error())
	}
	content, err := domain.CanonicalBrief(in.Content)
	if err != nil {
		return PromptWrite{}, fail(400, "VALIDATION", err.Error())
	}
	if err := domain.FixedTags(in.Tags); err != nil {
		return PromptWrite{}, fail(400, "VALIDATION", err.Error())
	}
	if err := d.forbid(ctx, in.Tags); err != nil {
		return PromptWrite{}, err
	}
	in.Name, in.FileName, in.Content = name, file, content
	return in, nil
}

func (d Deps) forbid(ctx context.Context, tags []string) error {
	if d.Engine == nil || d.Pool == nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	load := func(ctx context.Context) ([]core.Rule, error) {
		rows, err := d.Pool.Query(ctx, `SELECT term, match_mode FROM public.banned_tags WHERE enabled ORDER BY id`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []core.Rule
		for rows.Next() {
			var term, mode string
			if err := rows.Scan(&term, &mode); err != nil {
				return nil, err
			}
			if mode == "exact" || mode == "stem" {
				out = append(out, core.Rule{Term: term, MatchMode: mode})
			}
		}
		return out, rows.Err()
	}
	var (
		ruleset []core.Rule
		err     error
	)
	if rules.EnabledBannedTags != nil {
		ruleset, err = rules.EnabledBannedTags(ctx, load)
	} else {
		ruleset, err = load(ctx)
	}
	if err != nil {
		return mapDB(err, 500, "INTERNAL", "服务暂不可用")
	}
	out, err := d.Engine.Call(ctx, "partition", "", "", "", tags, ruleset)
	if err != nil {
		slog.Error("banned tags", "err", err)
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	if out.Banned {
		msg := out.Message
		if msg == "" {
			msg = "标签含受限词，不能保存：" + strings.Join(out.Rejected, "、")
		}
		return fail(400, "VALIDATION", msg)
	}
	return nil
}

func (d Deps) publicID(ctx context.Context, q execer, userID int64) (string, error) {
	var id string
	err := q.QueryRow(ctx, `SELECT public_id FROM account_users WHERE id = $1`, userID).Scan(&id)
	if err != nil {
		return "", err
	}
	return id, nil
}
