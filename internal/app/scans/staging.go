package scans

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// cleanupPassPages deletes staging pages whose generation is not the store's
// current refresh_generation. One store per tick.
//
// The generation commit deletes its own pages; this sweep is the backstop for
// a generation that was voided or superseded mid-walk, whose pages would
// otherwise sit in the UNLOGGED table until the next crash empties it.
func cleanupPassPages(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var n int64
	err := asWorker(ctx, pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			WITH victim AS (
			    SELECT os.id AS store_pk, s.refresh_generation
			      FROM store_product_sync s
			      JOIN organization_stores os ON os.uuid = s.store_id
			     WHERE EXISTS (
			           SELECT 1 FROM store_product_pass_pages p
			            WHERE p.store_pk = os.id
			              AND p.generation <> s.refresh_generation)
			     ORDER BY os.id
			     LIMIT 1
			)
			DELETE FROM store_product_pass_pages p
			 USING victim v
			 WHERE p.store_pk = v.store_pk
			   AND p.generation <> v.refresh_generation`)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		return nil
	})
	return n > 0, err
}
