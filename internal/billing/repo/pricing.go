package billingrepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
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

// Querier is the database surface price reads need.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}
