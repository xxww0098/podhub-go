package aihttp

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
)

func imageSetByKey(ctx context.Context, deps Deps, org int64, key, inputHash string) (id string, conflict bool, err error) {
	err = imageTx(ctx, deps, org, func(tx pgx.Tx) error {
		var got string
		e := tx.QueryRow(ctx, `SELECT id::text,input_sha256 FROM ai_image_sets WHERE org_id=$1 AND idempotency_key=$2`, org, key).Scan(&id, &got)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil
		}
		conflict = e == nil && got != inputHash
		return e
	})
	return
}

// All three independent request holds and the group commit together. No
// external call can start when the wallet cannot cover the complete set.
func openImageSet(ctx context.Context, deps Deps, org, user int64, key, inputHash, sourceHash, model, account string, price billing.Price, amount int64) (id string, holds []openedHold, resp Response) {
	id = uuid.NewString()
	err := imageTx(ctx, deps, org, func(tx pgx.Tx) error {
		if refusal := assertBilling(ctx, tx); refusal.Status != 0 {
			resp = refusal
			return errors.New("billing disabled")
		}
		// Serialize only this tenant/key. The second creator reads the first result.
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('ai-image-set'),hashtext($1))`, fmt.Sprintf("%d:%s", org, key)); e != nil {
			return e
		}
		var existing, hash string
		e := tx.QueryRow(ctx, `SELECT id::text,input_sha256 FROM ai_image_sets WHERE org_id=$1 AND idempotency_key=$2`, org, key).Scan(&existing, &hash)
		if e == nil {
			id = existing
			if hash != inputHash {
				resp = fail(409, "IDEMPOTENCY_CONFLICT", "相同请求编号已用于其他图片或配置")
			}
			return nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO ai_image_sets(id,org_id,user_id,idempotency_key,input_sha256,source_sha256,model) VALUES($1::uuid,$2,$3,$4,$5,$6,$7)`, id, org, user, key, inputHash, sourceHash, model); e != nil {
			return e
		}
		for ordinal := 0; ordinal < 3; ordinal++ {
			publicID, e := newPublicID()
			if e != nil {
				return e
			}
			opened := openedHold{PublicID: publicID, UserID: user, Held: amount, Price: price}
			e = tx.QueryRow(ctx, `INSERT INTO ai_requests(public_id,org_id,user_id,idempotency_key,operation,model,upstream_account_id,status,price_schedule_id,billing_mode,per_request_microfen,input_microfen_per_million,cached_input_microfen_per_million,output_microfen_per_million,reasoning_microfen_per_million,held_microfen,api_format)
    VALUES($1,$2,$3,$4,'image',$5,$6,'held',$7,'per_request',$8,$9,$10,$11,$12,$13,'images_generations') RETURNING id,created_at`, publicID, org, user, "image-set:"+id+fmt.Sprint(":", ordinal), model, account, price.ID, price.PerRequest, price.Input, price.CachedInput, price.Output, price.Reasoning, amount).Scan(&opened.ID, &opened.CreatedAt)
			if e != nil {
				return e
			}
			if deps.Wallet.HoldTx == nil {
				return errWalletNotWired
			}
			if _, e = deps.Wallet.HoldTx(ctx, tx, org, publicID, &opened.ID, amount); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO ai_image_set_items(set_id,org_id,ordinal,request_id) VALUES($1::uuid,$2,$3,$4)`, id, org, ordinal, opened.ID); e != nil {
				return e
			}
			holds = append(holds, opened)
		}
		return nil
	})
	if err != nil {
		slog.Error("image set hold", "err", err)
		holds = nil
		var funds *billing.Error
		if errors.As(err, &funds) && funds.Insufficient {
			return "", nil, fail(402, "INSUFFICIENT_BALANCE", "AI 余额不足")
		}
		if resp.Status != 0 {
			return "", nil, resp
		}
		return "", nil, fail(500, "INTERNAL", "服务暂不可用")
	}
	return
}

func pinImageSource(ctx context.Context, deps Deps, org int64, id, object string) error {
	return imageTx(ctx, deps, org, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `UPDATE ai_image_sets SET source_object_id=$3::uuid WHERE id=$1::uuid AND org_id=$2 AND source_object_id IS NULL`, id, org, object)
		if e == nil && tag.RowsAffected() != 1 {
			return errors.New("image source changed")
		}
		return e
	})
}
func dispatchImage(ctx context.Context, deps Deps, org, requestID int64) error {
	return imageTx(ctx, deps, org, func(tx pgx.Tx) error {
		if refusal := assertBilling(ctx, tx); refusal.Status != 0 {
			return errors.New("image billing authority lost")
		}
		tag, e := tx.Exec(ctx, `UPDATE ai_requests SET status='dispatching',dispatched_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND org_id=$2 AND operation='image' AND status='held'`, requestID, org)
		if e == nil && tag.RowsAffected() != 1 {
			return errors.New("image request changed")
		}
		return e
	})
}

func readImageSet(ctx context.Context, deps Deps, org int64, id string) (view ImageSetView, err error) {
	type assetRef struct {
		index                       int
		object, key, hash, identity string
	}
	var assets []assetRef
	err = imageTx(ctx, deps, org, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx, `SELECT id::text,model,source_sha256 FROM ai_image_sets WHERE id=$1::uuid AND org_id=$2`, id, org).Scan(&view.ID, &view.Model, &view.SourceSHA256); e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `SELECT i.ordinal,r.public_id,r.status,r.error_class,r.charged_microfen,r.updated_at,COALESCE(o.id::text,''),COALESCE(o.object_key,''),COALESCE(encode(o.sha256,'hex'),''),COALESCE(o.bucket_identity,'')
   FROM ai_image_set_items i JOIN ai_requests r ON r.id=i.request_id AND r.org_id=i.org_id
   LEFT JOIN storage_objects o ON o.id=i.object_id AND o.owner_org_id=i.org_id AND o.state='live'
   WHERE i.set_id=$1::uuid AND i.org_id=$2 ORDER BY i.ordinal`, id, org)
		if e != nil {
			return e
		}
		defer rows.Close()
		ready, processing, unknown := 0, false, false
		for rows.Next() {
			var item ImageSetItem
			var updated time.Time
			var object, key, hash, identity string
			if e = rows.Scan(&item.Ordinal, &item.RequestID, &item.Status, &item.ErrorClass, &item.Charged, &updated, &object, &key, &hash, &identity); e != nil {
				return e
			}
			if object != "" {
				item.Status = "ready"
				assets = append(assets, assetRef{len(view.Items), object, key, hash, identity})
				ready++
			} else if item.Status == "held" || item.Status == "dispatching" {
				if time.Since(updated) > imageDeadline+time.Minute {
					item.Status = "unknown"
					unknown = true
				} else {
					item.Status = "processing"
					processing = true
				}
			} else if item.Status == "unbilled_unknown" || item.Status == "settled" {
				item.Status = "unknown"
				unknown = true
			}
			view.Items = append(view.Items, item)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		if len(view.Items) != 3 {
			return errors.New("image set incomplete")
		}
		switch {
		case ready == 3:
			view.Status = "ready"
		case processing:
			view.Status = "processing"
		case ready > 0:
			view.Status = "partial"
		case unknown:
			view.Status = "unknown"
		default:
			view.Status = "failed"
		}
		return nil
	})
	if err != nil {
		return
	}
	for _, asset := range assets {
		if deps.Images == nil || deps.Images.PublicURL == nil {
			return view, errors.New("image storage unavailable")
		}
		var publicURL string
		publicURL, err = deps.Images.PublicURL(ctx, asset.identity, asset.key)
		if err != nil {
			return
		}
		if publicURL == "" {
			return view, errors.New("image public URL unavailable")
		}
		view.Items[asset.index].Asset = &ImageAsset{ObjectID: asset.object, URL: publicURL, SHA256: asset.hash}
	}
	return
}

// A long model call must not let the existing 60s billing authority expire.
// Assert refreshes only a still-live lease owned by this exact process. A
// revocation/foreign writer cancels the operation; this never grants authority.
func keepImageAuthority(ctx context.Context, deps Deps, org int64, cancelOperation context.CancelFunc) func() {
	keep, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-keep.Done():
				return
			case <-ticker.C:
				pulse, stop := context.WithTimeout(context.Background(), 5*time.Second)
				err := imageTx(pulse, deps, org, func(tx pgx.Tx) error {
					if refusal := assertBilling(pulse, tx); refusal.Status != 0 {
						return errors.New("image billing authority lost")
					}
					return nil
				})
				stop()
				if err != nil {
					cancelOperation()
					return
				}
			}
		}
	}()
	return func() { cancel(); <-done }
}

func reconcileImageSet(ctx context.Context, deps Deps, org int64, id string) error {
	var stranded []openedHold
	err := imageTx(ctx, deps, org, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT r.id,r.public_id,r.user_id,r.held_microfen FROM ai_requests r JOIN ai_image_set_items i ON i.request_id=r.id AND i.org_id=r.org_id WHERE i.org_id=$1 AND i.set_id=$2::uuid AND r.status IN('held','dispatching') AND r.updated_at<clock_timestamp()-interval '5 minutes'`, org, id)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var row openedHold
			if e = rows.Scan(&row.ID, &row.PublicID, &row.UserID, &row.Held); e != nil {
				return e
			}
			stranded = append(stranded, row)
		}
		return rows.Err()
	})
	if err != nil {
		return err
	}
	for _, row := range stranded {
		if err = releaseRequest(ctx, deps, org, row, "unbilled_unknown", "image_recovered_unknown", nil); err != nil {
			return err
		}
	}
	return nil
}
