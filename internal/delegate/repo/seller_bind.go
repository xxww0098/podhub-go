package delegaterepo

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

const (
	usableMember = `m.status = 'active' AND NOT m.manual_disabled AND NOT m.quota_suspended`
	openStates   = `'awaiting_setup', 'ready', 'dispatched', 'in_production', 'shipped'`
	orderCols    = `order_id::text, store_id::text, posting_number, seller_note, state, cancel_requested, posting_snapshot, logistics, created_at_ms, updated_at_ms`
)

func mapDB(err error) error {
	if err == nil {
		return nil
	}
	var api *contract.APIError
	if errors.As(err, &api) {
		return err
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "55P03":
			return contract.Locked()
		case "P0M01":
			return contract.MediaGone()
		}
	}
	return err
}

func (r Repo) readTx(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	if r.pool == nil || r.begin == nil {
		return contract.ErrUnavailable
	}
	var fnErr error
	err := db.InTx(ctx, r.pool, db.App(orgID), func(tx pgx.Tx) error {
		fnErr = mapDB(fn(tx))
		return fnErr
	})
	if err == nil || fnErr != nil {
		return err
	}
	return mapDB(err)
}

func (r Repo) writeTx(ctx context.Context, orgID, nowMS int64, fn func(pgx.Tx) error) error {
	if r.pool == nil || r.begin == nil {
		return contract.ErrUnavailable
	}
	var fnErr error
	err := db.InTx(ctx, r.pool, db.App(orgID), func(tx pgx.Tx) error {
		defer writer.Forget(tx)
		if fnErr = guardLease(ctx, tx, nowMS); fnErr != nil {
			return fnErr
		}
		if fnErr = lockOrg(ctx, tx, orgID); fnErr != nil {
			return fnErr
		}
		fnErr = mapDB(fn(tx))
		return fnErr
	})
	if err == nil || fnErr != nil {
		return err
	}
	return mapDB(err)
}

func guardLease(ctx context.Context, tx pgx.Tx, nowMS int64) error {
	_, err := writer.Assert(ctx, tx, "entitlement", writer.ProcessIdentity(), nowMS, contract.MsgWritesDisabled)
	if writer.IsDisabled(err) {
		return contract.WritesDisabled()
	}
	return mapDB(err)
}

func lockOrg(ctx context.Context, tx pgx.Tx, orgID int64) error {
	var dissolved bool
	err := tx.QueryRow(ctx, `
		SELECT dissolved_at IS NOT NULL
		  FROM organizations WHERE id = $1
		   FOR NO KEY UPDATE`, orgID).Scan(&dissolved)
	if errors.Is(err, pgx.ErrNoRows) || dissolved {
		return contract.NotFound("工作空间不存在")
	}
	return mapDB(err)
}

func audit(ctx context.Context, tx pgx.Tx, orgID, userID int64, entityType, entityID, method, path, action string, message any) error {
	raw, err := json.Marshal(message)
	if err != nil {
		return err
	}
	leaseID, fence := writer.AuditArgs(tx)
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_logs
		    (org_id, user_id, module, entity_type, entity_id, api_method, api_path,
		     action, status, result, message, shop_id, created_at_ms, created_at,
		     actor_kind, support_grant_id, writer_lease_id, writer_fence_token)
		VALUES ($1, $2, 'delegate', $3, $4, $5, $6,
		        $7, 'success', 'applied', $8, NULL,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        clock_timestamp(), 'user', NULL, $9, $10)`,
		orgID, userID, entityType, entityID, method, path, action, string(raw), leaseID, fence)
	return err
}

// ListSources reads listed factories that accept delegate work.
func (r Repo) ListSources(ctx context.Context, orgID int64) ([]contract.Source, error) {
	var out []contract.Source
	err := r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT source_id, name, country, icon
			  FROM sc_sources
			 WHERE listed AND accepts_delegate
			 ORDER BY created_at_ms, source_id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row contract.Source
			if err := rows.Scan(&row.SourceID, &row.Name, &row.Country, &row.Icon); err != nil {
				return err
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if out == nil {
		out = []contract.Source{}
	}
	return out, err
}

// StoreGate is require_store_usable. Disabled and quota are not checked.
func (r Repo) StoreGate(ctx context.Context, orgID, userID int64, canManage bool, storeID string) (string, error) {
	id, ok := domain.NormalizeUUID(storeID)
	if !ok {
		return "", contract.NotFound("店铺不存在")
	}
	var got string
	err := r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		var found string
		var err error
		found, err = visibleStore(ctx, tx, orgID, userID, canManage, id)
		got = found
		return err
	})
	return got, err
}

func visibleStore(ctx context.Context, tx pgx.Tx, orgID, userID int64, canManage bool, storeUUID string) (string, error) {
	var store string
	var assignee, membership *int64
	err := tx.QueryRow(ctx, `
		SELECT s.uuid::text, s.assignee_membership_id, m.id
		  FROM organization_stores s
		  LEFT JOIN organization_members m
		    ON m.org_id = s.org_id AND m.user_id = $3 AND `+usableMember+`
		 WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL
		 LIMIT 1`, orgID, storeUUID, userID).Scan(&store, &assignee, &membership)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", contract.NotFound("店铺不存在")
	}
	if err != nil {
		return "", err
	}
	if membership == nil {
		return "", contract.Forbidden("工作空间成员当前不可用")
	}
	if !canManage && (assignee == nil || *assignee != *membership) {
		return "", contract.NotFound("店铺不存在")
	}
	return strings.ToLower(store), nil
}

// VisibleStoreUUIDs is the operator's store cut. Managers pass canManage and still filter with the flag.
func (r Repo) VisibleStoreUUIDs(ctx context.Context, orgID, userID int64, canManage bool) ([]string, error) {
	var out []string
	err := r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT s.uuid::text
			  FROM organization_stores s
			  JOIN organization_members m
			    ON m.org_id = s.org_id AND m.user_id = $2 AND `+usableMember+`
			 WHERE s.org_id = $1 AND s.deleted_at_ms IS NULL
			   AND ($3 OR s.assignee_membership_id = m.id)`, orgID, userID, canManage)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			out = append(out, strings.ToLower(id))
		}
		return rows.Err()
	})
	return out, err
}

// SealedCredential is contract.SealedCredential.
type SealedCredential = contract.SealedCredential

// AdmitStore is the posting and create-order store check, including credential presence.
func (r Repo) AdmitStore(ctx context.Context, orgID, userID int64, canManage bool, storeID string, nowMS int64) (SealedCredential, error) {
	id, ok := domain.NormalizeUUID(storeID)
	if !ok {
		return SealedCredential{}, contract.NotFound("店铺不存在")
	}
	var cred SealedCredential
	err := r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		var manual, quota bool
		var assignee, membership *int64
		var expires *int64
		var keyID *string
		var version *int16
		var revision *int64
		err := tx.QueryRow(ctx, `
			SELECT s.org_id, s.id, s.uuid::text, s.manual_disabled, s.quota_suspended, s.assignee_membership_id,
			       m.id, c.credential_revision, c.client_id, c.key_id, c.nonce, c.ciphertext, c.wrapped_dek, c.dek_nonce,
			       c.key_fingerprint, c.envelope_version, c.key_expires_at_ms
			  FROM organization_stores s
			  LEFT JOIN organization_members m
			    ON m.org_id = s.org_id AND m.user_id = $3 AND `+usableMember+`
			  LEFT JOIN store_seller_credentials c ON c.store_id = s.id AND c.org_id = s.org_id
			 WHERE s.org_id = $1 AND s.uuid = $2::uuid AND s.deleted_at_ms IS NULL
			 LIMIT 1`, orgID, id, userID).Scan(
			&cred.OrgID, &cred.StorePK, &cred.StoreUUID, &manual, &quota, &assignee, &membership,
			&revision, &cred.ClientID, &keyID, &cred.Nonce, &cred.Ciphertext, &cred.WrappedDEK, &cred.DEKNonce,
			&cred.KeyFingerprint, &version, &expires,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.NotFound("店铺不存在")
		}
		if err != nil {
			return err
		}
		if membership == nil {
			return contract.Forbidden("工作空间成员当前不可用")
		}
		if !canManage && (assignee == nil || *assignee != *membership) {
			return contract.NotFound("店铺不存在")
		}
		if manual {
			return contract.Forbidden("店铺已停用，无法使用")
		}
		if quota {
			return contract.Conflict("店铺配额已挂起，无法使用")
		}
		if expires != nil && *expires <= nowMS {
			return contract.Conflict("Seller 密钥已过期，请在卖家后台重新生成后登记")
		}
		if keyID == nil || *keyID == "" || len(cred.Ciphertext) == 0 {
			return contract.Conflict("Store 尚未登记密钥")
		}
		cred.KeyID = *keyID
		if version != nil {
			cred.EnvelopeVersion = *version
		}
		if revision != nil {
			cred.CredentialRevision = *revision
		}
		cred.StoreUUID = strings.ToLower(cred.StoreUUID)
		return nil
	})
	return cred, err
}

// ListBindings returns the store's bindings with assets and the member warning.
func (r Repo) ListBindings(ctx context.Context, orgID int64, storeID string) ([]contract.Binding, error) {
	var out []contract.Binding
	err := r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		var err error
		out, err = loadBindings(ctx, tx, orgID, storeID, "")
		return err
	})
	return out, err
}

func loadBindings(ctx context.Context, tx pgx.Tx, orgID int64, storeID, bindingID string) ([]contract.Binding, error) {
	rows, err := tx.Query(ctx, `
		SELECT b.binding_id::text, b.store_id::text, b.offer_id, b.note, b.active, b.revision,
		       b.created_at_ms, b.updated_at_ms,
		       s.source_id, s.name, s.country, s.icon,
		       public.delegate_source_active_member_count(b.source_id)
		  FROM delegate_bindings b
		  JOIN sc_sources s ON s.source_id = b.source_id
		 WHERE b.org_id = $1
		   AND ($2 = '' OR b.store_id = $2::uuid)
		   AND ($3 = '' OR b.binding_id = $3::uuid)
		 ORDER BY b.created_at_ms, b.binding_id`, orgID, storeID, bindingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var bindings []contract.Binding
	for rows.Next() {
		var row contract.Binding
		var members int64
		if err := rows.Scan(&row.BindingID, &row.StoreID, &row.OfferID, &row.Note, &row.Active, &row.Revision,
			&row.CreatedAtMS, &row.UpdatedAtMS, &row.Source.SourceID, &row.Source.Name, &row.Source.Country, &row.Source.Icon, &members); err != nil {
			return nil, err
		}
		row.Warning = domain.MemberWarning(members)
		row.Assets = []contract.Asset{}
		bindings = append(bindings, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if len(bindings) > 0 {
		ids := make([]string, len(bindings))
		for i := range bindings {
			ids[i] = bindings[i].BindingID
		}
		assets, err := loadAssets(ctx, tx, ids)
		if err != nil {
			return nil, err
		}
		by := map[string][]contract.Asset{}
		for _, asset := range assets {
			by[asset.BindingID] = append(by[asset.BindingID], asset)
		}
		for i := range bindings {
			if rows := by[bindings[i].BindingID]; rows != nil {
				bindings[i].Assets = rows
			}
		}
	}
	if bindings == nil {
		bindings = []contract.Binding{}
	}
	return bindings, nil
}

func loadAssets(ctx context.Context, tx pgx.Tx, bindingIDs []string) ([]contract.Asset, error) {
	if len(bindingIDs) == 0 {
		return []contract.Asset{}, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT asset_id::text, binding_id::text, file_name, sha256, bytes, mime, position,
		       verified_at_ms, created_at_ms
		  FROM delegate_assets
		 WHERE binding_id = ANY($1::uuid[])
		 ORDER BY position, created_at_ms, asset_id`, bindingIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []contract.Asset{}
	for rows.Next() {
		var row contract.Asset
		if err := rows.Scan(&row.AssetID, &row.BindingID, &row.FileName, &row.SHA256, &row.Bytes, &row.Mime, &row.Position, &row.VerifiedAtMS, &row.CreatedAtMS); err != nil {
			return nil, err
		}
		row.Verified = row.VerifiedAtMS != nil
		out = append(out, row)
	}
	return out, rows.Err()
}

// BindingStore is binding_store_for_actor.
func (r Repo) BindingStore(ctx context.Context, orgID, userID int64, canManage bool, bindingID string) (storeID, binding string, err error) {
	binding, ok := domain.NormalizeUUID(bindingID)
	if !ok {
		return "", "", contract.NotFound("绑定不存在")
	}
	err = r.readTx(ctx, orgID, func(tx pgx.Tx) error {
		storeID, err = bindingStore(ctx, tx, orgID, userID, canManage, binding)
		return err
	})
	return storeID, binding, err
}

func bindingStore(ctx context.Context, tx pgx.Tx, orgID, userID int64, canManage bool, bindingID string) (string, error) {
	var store string
	err := tx.QueryRow(ctx, `
		SELECT b.store_id::text
		  FROM delegate_bindings b
		  JOIN organization_stores s ON s.org_id = b.org_id AND s.uuid = b.store_id
		  JOIN organization_members m ON m.org_id = s.org_id AND m.user_id = $3 AND `+usableMember+`
		 WHERE b.binding_id = $1::uuid AND b.org_id = $2
		   AND s.deleted_at_ms IS NULL
		   AND (($4 AND m.role IN ('owner', 'manager')) OR s.assignee_membership_id = m.id)
		 LIMIT 1`, bindingID, orgID, userID, canManage).Scan(&store)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", contract.NotFound("绑定不存在")
	}
	return strings.ToLower(store), err
}

// CreateBinding inserts or revives one binding, then promotes open lines.
func (r Repo) CreateBinding(ctx context.Context, orgID, userID int64, storeID, offerID, sourceID, note string, auto bool, nowMS int64) (contract.Binding, error) {
	var out contract.Binding
	err := r.writeTx(ctx, orgID, nowMS, func(tx pgx.Tx) error {
		var existing *string
		var active bool
		err := tx.QueryRow(ctx, `
			SELECT binding_id::text, active
			  FROM delegate_bindings
			 WHERE org_id = $1 AND store_id = $2::uuid AND offer_id = $3
			 LIMIT 1`, orgID, storeID, offerID).Scan(&existing, &active)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if existing != nil && active {
			return contract.Conflict("该商品已有绑定，请通过改绑更新")
		}
		if err := requireSource(ctx, tx, sourceID); err != nil {
			return err
		}
		var bindingID string
		if existing != nil {
			bindingID = *existing
			if _, err := tx.Exec(ctx, `
				UPDATE delegate_bindings
				   SET source_id = $4, note = $5, active = true,
				       revision = revision + 1, updated_at_ms = $6
				 WHERE binding_id = $1::uuid AND org_id = $2 AND store_id = $3::uuid`,
				bindingID, orgID, storeID, sourceID, note, nowMS); err != nil {
				return err
			}
		} else {
			if err := requireMirror(ctx, tx, orgID, storeID, offerID); err != nil {
				return err
			}
			err := tx.QueryRow(ctx, `
				INSERT INTO delegate_bindings
				    (org_id, store_id, offer_id, source_id, note, active, revision, created_by, created_at_ms, updated_at_ms)
				VALUES ($1, $2::uuid, $3, $4, $5, true, 1, $6, $7, $7)
				ON CONFLICT (org_id, store_id, offer_id) DO NOTHING
				RETURNING binding_id::text`, orgID, storeID, offerID, sourceID, note, userID, nowMS).Scan(&bindingID)
			if errors.Is(err, pgx.ErrNoRows) {
				return contract.Conflict("该商品已有绑定")
			}
			if err != nil {
				return err
			}
		}
		if _, err := promote(ctx, tx, orgID, storeID, []string{offerID}, bindingID, auto, nowMS); err != nil {
			return err
		}
		if err := audit(ctx, tx, orgID, userID, "delegate_binding", bindingID, "POST", "/api/seller/delegate/bindings", "delegate_binding_created", struct {
			StoreID  string `json:"storeId"`
			OfferID  string `json:"offerId"`
			SourceID string `json:"sourceId"`
		}{storeID, offerID, sourceID}); err != nil {
			return err
		}
		rows, err := loadBindings(ctx, tx, orgID, "", bindingID)
		if err != nil {
			return err
		}
		if len(rows) != 1 {
			return contract.NotFound("绑定不存在")
		}
		out = rows[0]
		return nil
	})
	return out, err
}

func requireSource(ctx context.Context, tx pgx.Tx, sourceID string) error {
	var listed, accepts bool
	err := tx.QueryRow(ctx, `SELECT listed, accepts_delegate FROM sc_sources WHERE source_id = $1 LIMIT 1`, sourceID).Scan(&listed, &accepts)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.NotFound("厂家不存在")
	}
	if err != nil {
		return err
	}
	if !listed || !accepts {
		return contract.Unprocessable("该厂家未开放委托生产")
	}
	return nil
}

func requireMirror(ctx context.Context, tx pgx.Tx, orgID int64, storeID, offerID string) error {
	var synced int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*)::bigint FROM store_products sp
		  JOIN organization_stores s ON s.id = sp.store_pk AND s.org_id = sp.org_id
		 WHERE sp.org_id = $1 AND s.uuid = $2::uuid`, orgID, storeID).Scan(&synced); err != nil {
		return err
	}
	if synced == 0 {
		return contract.Unprocessable("该店铺还没有同步过商品，请先去商品页同步")
	}
	var one int
	err := tx.QueryRow(ctx, `
		SELECT 1 FROM store_products sp
		  JOIN organization_stores s ON s.id = sp.store_pk AND s.org_id = sp.org_id
		 WHERE sp.org_id = $1 AND s.uuid = $2::uuid AND sp.offer_id = $3
		 LIMIT 1`, orgID, storeID, offerID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.Unprocessable("商品不在店铺镜像中，请先同步商品")
	}
	return err
}

// PatchBinding is the CAS update.
func (r Repo) PatchBinding(ctx context.Context, orgID, userID int64, canManage bool, bindingID string, expected int64, sourceID, note *string, active *bool, auto bool, nowMS int64) (contract.Binding, error) {
	var out contract.Binding
	err := r.writeTx(ctx, orgID, nowMS, func(tx pgx.Tx) error {
		storeID, err := bindingStore(ctx, tx, orgID, userID, canManage, bindingID)
		if err != nil {
			return err
		}
		if sourceID != nil {
			if err := requireSource(ctx, tx, *sourceID); err != nil {
				return err
			}
		}
		var offerID string
		err = tx.QueryRow(ctx, `
			UPDATE delegate_bindings
			   SET source_id = COALESCE($4, source_id),
			       note = COALESCE($5, note),
			       active = COALESCE($6, active),
			       revision = revision + 1,
			       updated_at_ms = $7
			 WHERE binding_id = $1::uuid AND org_id = $2 AND revision = $3 AND store_id = $8::uuid
			 RETURNING store_id::text, offer_id`,
			bindingID, orgID, expected, sourceID, note, active, nowMS, storeID).Scan(&storeID, &offerID)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.Conflict("绑定已被更新，请刷新后重试")
		}
		if err != nil {
			return err
		}
		if _, err := promote(ctx, tx, orgID, storeID, []string{offerID}, bindingID, auto, nowMS); err != nil {
			return err
		}
		if err := audit(ctx, tx, orgID, userID, "delegate_binding", bindingID, "PATCH", "/api/seller/delegate/bindings/{binding_id}", "delegate_binding_updated", struct {
			StoreID  string  `json:"storeId"`
			OfferID  string  `json:"offerId"`
			SourceID *string `json:"sourceId"`
			Active   *bool   `json:"active"`
		}{storeID, offerID, sourceID, active}); err != nil {
			return err
		}
		rows, err := loadBindings(ctx, tx, orgID, "", bindingID)
		if err != nil {
			return err
		}
		if len(rows) != 1 {
			return contract.NotFound("绑定不存在")
		}
		out = rows[0]
		return nil
	})
	return out, err
}

// DeleteBinding refuses while an order line still points at the binding.
func (r Repo) DeleteBinding(ctx context.Context, orgID, userID int64, canManage bool, bindingID string, nowMS int64) error {
	return r.writeTx(ctx, orgID, nowMS, func(tx pgx.Tx) error {
		storeID, err := bindingStore(ctx, tx, orgID, userID, canManage, bindingID)
		if err != nil {
			return err
		}
		var refs int64
		if err := tx.QueryRow(ctx, `SELECT count(*)::bigint FROM delegate_order_lines WHERE binding_id = $1::uuid`, bindingID).Scan(&refs); err != nil {
			return err
		}
		if refs > 0 {
			return contract.Conflict("委托单仍引用该绑定，无法删除，只能停用")
		}
		tag, err := tx.Exec(ctx, `DELETE FROM delegate_bindings WHERE binding_id = $1::uuid AND org_id = $2 AND store_id = $3::uuid`, bindingID, orgID, storeID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return contract.NotFound("绑定不存在")
		}
		return audit(ctx, tx, orgID, userID, "delegate_binding", bindingID, "DELETE", "/api/seller/delegate/bindings/{binding_id}", "delegate_binding_deleted", map[string]any{})
	})
}

// AssetIdentity is contract.AssetIdentity.
type AssetIdentity = contract.AssetIdentity

// CommitAsset inserts or replays one verified asset.
// reload and reverify run inside the write transaction after the store is re-read.
func (r Repo) CommitAsset(ctx context.Context, orgID, userID int64, canManage bool, in AssetIdentity, auto bool, nowMS int64, reload, reverify func() error) (contract.Asset, error) {
	var out contract.Asset
	err := r.writeTx(ctx, orgID, nowMS, func(tx pgx.Tx) error {
		storeID, err := bindingStore(ctx, tx, orgID, userID, canManage, in.BindingID)
		if err != nil {
			return err
		}
		if storeID != in.StoreID {
			return contract.Conflict("绑定店铺已变化，请重新授权上传")
		}
		var revision int64
		err = tx.QueryRow(ctx, `SELECT revision FROM platform_integration_config WHERE singleton = true FOR SHARE`).Scan(&revision)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.Conflict("存储配置已变化，请重新授权上传")
		}
		if err != nil {
			return err
		}
		if reload != nil {
			if err := reload(); err != nil {
				return err
			}
		}
		if reverify != nil {
			if err := reverify(); err != nil {
				return contract.Conflict("上传授权已变化或过期，请重新授权上传")
			}
		}
		var existingBinding, sha, mime string
		var bytes int64
		var verified *int64
		var assetID string
		err = tx.QueryRow(ctx, `
			SELECT asset_id::text, binding_id::text, sha256, bytes, mime, verified_at_ms
			  FROM delegate_assets WHERE org_id = $1 AND object_key = $2`, orgID, in.Key).Scan(&assetID, &existingBinding, &sha, &bytes, &mime, &verified)
		if err == nil {
			if err := domain.ReplayAsset(existingBinding, in.BindingID, sha, mime, bytes, verified, in.SHA, in.Mime, in.Bytes); err != nil {
				return err
			}
			assets, err := loadAssets(ctx, tx, []string{in.BindingID})
			if err != nil {
				return err
			}
			for _, asset := range assets {
				if asset.AssetID == assetID {
					out = asset
					return nil
				}
			}
			return contract.Conflict("已有素材身份与确认回执不一致")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var offerID string
		if err := tx.QueryRow(ctx, `SELECT offer_id FROM delegate_bindings WHERE binding_id = $1::uuid`, in.BindingID).Scan(&offerID); err != nil {
			return err
		}
		replayed := false
		err = tx.QueryRow(ctx, `
			INSERT INTO delegate_assets
			    (org_id, binding_id, object_key, object_url, sha256, bytes, mime, file_name, position, verified_at_ms, created_at_ms)
			VALUES ($1, $2::uuid, $3, '', $4, $5, $6, $7, $8, $9, $9)
			ON CONFLICT (org_id, object_key) DO NOTHING
			RETURNING asset_id::text`,
			orgID, in.BindingID, in.Key, in.SHA, in.Bytes, in.Mime, in.FileName, in.Position, nowMS).Scan(&assetID)
		if errors.Is(err, pgx.ErrNoRows) {
			replayed = true
			err = tx.QueryRow(ctx, `
				SELECT asset_id::text, binding_id::text, sha256, bytes, mime, verified_at_ms
				  FROM delegate_assets WHERE org_id = $1 AND object_key = $2`, orgID, in.Key).Scan(&assetID, &existingBinding, &sha, &bytes, &mime, &verified)
			if errors.Is(err, pgx.ErrNoRows) {
				return contract.Conflict("素材并发变化，请重新确认")
			}
			if err != nil {
				return err
			}
			if err := domain.ReplayAsset(existingBinding, in.BindingID, sha, mime, bytes, verified, in.SHA, in.Mime, in.Bytes); err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if _, err := promote(ctx, tx, orgID, storeID, []string{offerID}, in.BindingID, auto, nowMS); err != nil {
			return err
		}
		if !replayed {
			if err := audit(ctx, tx, orgID, userID, "delegate_asset", assetID, "POST", "/api/seller/delegate/assets", "delegate_asset_verified", struct {
				BindingID string `json:"bindingId"`
				ObjectKey string `json:"objectKey"`
			}{in.BindingID, in.Key}); err != nil {
				return err
			}
		}
		assets, err := loadAssets(ctx, tx, []string{in.BindingID})
		if err != nil {
			return err
		}
		for _, asset := range assets {
			if asset.AssetID == assetID {
				out = asset
				return nil
			}
		}
		return contract.Internal()
	})
	return out, err
}

// DeletedAsset is contract.DeletedAsset.
type DeletedAsset = contract.DeletedAsset

// DeleteAsset removes the row, recomputes the store, and reports whether the bucket object is unreferenced.
func (r Repo) DeleteAsset(ctx context.Context, orgID, userID int64, canManage bool, assetID string, auto bool, nowMS int64) (DeletedAsset, error) {
	var out DeletedAsset
	err := r.writeTx(ctx, orgID, nowMS, func(tx pgx.Tx) error {
		var storeID string
		err := tx.QueryRow(ctx, `
			SELECT a.object_key, b.store_id::text
			  FROM delegate_assets a
			  JOIN delegate_bindings b ON b.binding_id = a.binding_id
			  JOIN organization_stores s ON s.org_id = b.org_id AND s.uuid = b.store_id
			  JOIN organization_members m ON m.org_id = s.org_id AND m.user_id = $3 AND `+usableMember+`
			 WHERE a.asset_id = $1::uuid AND a.org_id = $2
			   AND s.deleted_at_ms IS NULL
			   AND ($4 OR s.assignee_membership_id = m.id)
			 LIMIT 1`, assetID, orgID, userID, canManage).Scan(&out.ObjectKey, &storeID)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.NotFound("素材不存在")
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM delegate_assets WHERE asset_id = $1::uuid AND org_id = $2`, assetID, orgID); err != nil {
			return err
		}
		if err := recomputeStore(ctx, tx, orgID, storeID, auto, nowMS); err != nil {
			return err
		}
		var refs int64
		if err := tx.QueryRow(ctx, `SELECT count(*)::bigint FROM delegate_dispatch_assets WHERE asset_id = $1::uuid AND org_id = $2`, assetID, orgID).Scan(&refs); err != nil {
			return err
		}
		out.AssetID = assetID
		out.Reclaimed = refs == 0
		return audit(ctx, tx, orgID, userID, "delegate_asset", assetID, "DELETE", "/api/seller/delegate/assets/{asset_id}", "delegate_asset_deleted", map[string]any{
			"objectKey": out.ObjectKey, "referencedByDispatches": refs,
		})
	})
	return out, err
}
