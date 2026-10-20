package adminrepo

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

func (r Repo) ListGrants(ctx context.Context, actor contract.Actor) ([]domain.GrantView, error) {
	var out []domain.GrantView
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, grantSelect+`
			 WHERE user_id = $1 AND scope_kind = 'supplier_catalog' AND org_id IS NOT DISTINCT FROM NULL::bigint
			 ORDER BY created_at DESC, id`, actor.UserID)
		if err != nil {
			return mapDB(err)
		}
		defer rows.Close()
		out = []domain.GrantView{}
		for rows.Next() {
			row, err := scanGrant(rows)
			if err != nil {
				return err
			}
			out = append(out, row)
		}
		return mapDB(rows.Err())
	})
	return out, err
}

func (r Repo) CreateGrant(ctx context.Context, actor contract.Actor, in domain.GrantInput) (domain.GrantView, string, error) {
	var view domain.GrantView
	var token string
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		if in.Sources != nil {
			for _, id := range *in.Sources {
				var found string
				err := tx.QueryRow(ctx, `SELECT source_id FROM sc_sources WHERE source_id = $1`, id).Scan(&found)
				if errors.Is(err, pgx.ErrNoRows) {
					return &contract.Fail{Kind: contract.KindValidation, Message: "源库不存在"}
				}
				if err != nil {
					return mapDB(err)
				}
			}
		}
		var role string
		err := tx.QueryRow(ctx, `
			SELECT role FROM account_users WHERE id = $1 AND disabled_at IS NULL FOR SHARE`, actor.UserID).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && role != "admin" && role != "super_admin") {
			return forbidden("当前授权已变化，请刷新后重试")
		}
		if err != nil {
			return mapDB(err)
		}
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return internal()
		}
		token = "opa_" + base64.RawURLEncoding.EncodeToString(raw)
		sum := sha256.Sum256([]byte(token))
		hash := hex.EncodeToString(sum[:])
		prefix := token[:len("opa_")+8]
		var sources any
		if in.Sources != nil {
			sources = *in.Sources
		}
		var id string
		err = tx.QueryRow(ctx, `
			INSERT INTO automation_grants (
			    user_id, org_id, scope_kind, source_ids, name, token_hash, token_prefix, actions, expires_at)
			VALUES ($1, NULL, 'supplier_catalog', $2::text[], $3, $4, $5, $6::text[],
			        CASE WHEN $7::bigint IS NULL THEN NULL
			             ELSE clock_timestamp() + ($7::text || ' days')::interval END)
			RETURNING id::text`,
			actor.UserID, sources, in.Name, hash, prefix, in.Actions, in.Expires).Scan(&id)
		if err != nil {
			return mapDB(err)
		}
		rows, err := tx.Query(ctx, grantSelect+` WHERE id = $1::uuid`, id)
		if err != nil {
			return mapDB(err)
		}
		defer rows.Close()
		if !rows.Next() {
			return internal()
		}
		view, err = scanGrant(rows)
		return err
	})
	return view, token, err
}

func (r Repo) RevokeGrant(ctx context.Context, actor contract.Actor, id string) (string, error) {
	var removed string
	err := r.withTx(ctx, actor.OrgID, func(tx pgx.Tx) error {
		var got string
		var org *int64
		err := tx.QueryRow(ctx, `
			SELECT id::text, org_id FROM automation_grants
			 WHERE id = $1::uuid AND user_id = $2 AND scope_kind = 'supplier_catalog'
			   AND org_id IS NOT DISTINCT FROM NULL::bigint
			 FOR UPDATE`, id, actor.UserID).Scan(&got, &org)
		if errors.Is(err, pgx.ErrNoRows) {
			return notFound("授权不存在")
		}
		if err != nil {
			return mapDB(err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.automation_grant_id', $1, true)`, got); err != nil {
			return mapDB(err)
		}
		for _, table := range []string{"automation_call_receipts", "automation_executions"} {
			if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE grant_id = $1::uuid`, got); err != nil {
				return mapDB(err)
			}
		}
		tag, err := tx.Exec(ctx, `
			DELETE FROM automation_grants
			 WHERE id = $1::uuid AND user_id = $2 AND scope_kind = 'supplier_catalog'
			   AND org_id IS NOT DISTINCT FROM NULL::bigint`, got, actor.UserID)
		if err != nil {
			return mapDB(err)
		}
		if tag.RowsAffected() != 1 {
			return notFound("授权不存在")
		}
		removed = got
		return nil
	})
	return removed, err
}

const grantSelect = `
SELECT id::text, name, scope_kind, source_ids, actions, token_prefix,
       COALESCE((EXTRACT(EPOCH FROM created_at) * 1000)::bigint, 0),
       CASE WHEN expires_at IS NULL THEN NULL ELSE (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint END,
       CASE WHEN last_used_at IS NULL THEN NULL ELSE (EXTRACT(EPOCH FROM last_used_at) * 1000)::bigint END,
       CASE WHEN revoked_at IS NULL THEN NULL ELSE (EXTRACT(EPOCH FROM revoked_at) * 1000)::bigint END
  FROM automation_grants`

func scanGrant(rows pgx.Rows) (domain.GrantView, error) {
	var row domain.GrantView
	var sources []string
	var actions []string
	if err := rows.Scan(&row.ID, &row.Name, &row.ScopeKind, &sources, &actions, &row.TokenPrefix,
		&row.CreatedAtMs, &row.ExpiresAtMs, &row.LastUsedAtMs, &row.RevokedAtMs); err != nil {
		return domain.GrantView{}, mapDB(err)
	}
	row.SourceIDs = &sources
	if sources == nil {
		row.SourceIDs = nil
	}
	if actions == nil {
		actions = []string{}
	}
	row.Actions = actions
	return row, nil
}
