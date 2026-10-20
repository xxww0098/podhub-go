package billingrepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const priceColumns = `id, model, billing_mode,
    input_microfen_per_million, cached_input_microfen_per_million,
    output_microfen_per_million, reasoning_microfen_per_million,
    per_request_microfen, max_request_microfen, effective_from`

func scanPrice(row pgx.Row) (Price, time.Time, error) {
	var price Price
	var from time.Time
	err := row.Scan(&price.ID, &price.Model, &price.BillingMode, &price.Input, &price.CachedInput, &price.Output, &price.Reasoning, &price.PerRequest, &price.MaxRequest, &from)
	return price, from, err
}

// CurrentForModel returns the in-effect price, or false when the model was never priced.
func CurrentForModel(ctx context.Context, q Querier, model string) (Price, bool, error) {
	price, _, err := scanPrice(q.QueryRow(ctx, `
		SELECT `+priceColumns+`
		  FROM ai_price_schedules
		 WHERE model = $1 AND effective_from <= clock_timestamp()
		 LIMIT 1`, model))
	if err != nil {
		if err == pgx.ErrNoRows {
			return Price{}, false, nil
		}
		return Price{}, false, err
	}
	return price, true, nil
}

// CurrentAll lists in-effect prices ordered by model.
func CurrentAll(ctx context.Context, q Querier) ([]Price, error) {
	rows, err := q.Query(ctx, `
		SELECT `+priceColumns+`
		  FROM ai_price_schedules
		 WHERE effective_from <= clock_timestamp()
		 ORDER BY model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Price
	for rows.Next() {
		price, _, err := scanPrice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, price)
	}
	return out, rows.Err()
}

// Publish upserts one model. In-flight requests keep the copy on ai_requests.
func Publish(ctx context.Context, pool *pgxpool.Pool, actorID int64, request PublishRequest) (Price, error) {
	row := pool.QueryRow(ctx, `
		INSERT INTO ai_price_schedules
		    (model, billing_mode,
		     input_microfen_per_million, cached_input_microfen_per_million,
		     output_microfen_per_million, reasoning_microfen_per_million,
		     per_request_microfen, max_request_microfen,
		     effective_from, created_by_user_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp(), $9)
		ON CONFLICT (model) DO UPDATE SET
		    billing_mode = EXCLUDED.billing_mode,
		    input_microfen_per_million = EXCLUDED.input_microfen_per_million,
		    cached_input_microfen_per_million = EXCLUDED.cached_input_microfen_per_million,
		    output_microfen_per_million = EXCLUDED.output_microfen_per_million,
		    reasoning_microfen_per_million = EXCLUDED.reasoning_microfen_per_million,
		    per_request_microfen = EXCLUDED.per_request_microfen,
		    max_request_microfen = EXCLUDED.max_request_microfen,
		    effective_from = clock_timestamp(),
		    created_by_user_id = EXCLUDED.created_by_user_id
		RETURNING id, model, billing_mode, input_microfen_per_million,
		          cached_input_microfen_per_million, output_microfen_per_million,
		          reasoning_microfen_per_million, per_request_microfen,
		          max_request_microfen, effective_from`,
		request.Model, request.BillingMode, request.Input, request.CachedInput, request.Output, request.Reasoning, request.PerRequest, request.MaxRequest, actorID)
	price, _, err := scanPrice(row)
	if err == pgx.ErrNoRows {
		return Price{}, errString("price publication returned no row")
	}
	return price, err
}

// Unpublish deletes the current row. False means the model had no price.
func Unpublish(ctx context.Context, pool *pgxpool.Pool, model string) (bool, error) {
	tag, err := pool.Exec(ctx, `DELETE FROM ai_price_schedules WHERE model = $1`, model)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

type errString string

func (e errString) Error() string { return string(e) }

// Querier is the database surface price reads need.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}
