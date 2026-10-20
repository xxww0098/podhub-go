package rules

import (
	"context"

	listing "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

// LoadEnabledBannedTags returns enabled rows in id order. exact and stem are
// the only modes. Anything else is skipped, matching store::parse_mode.
func LoadEnabledBannedTags(ctx context.Context, q *sqlc.Queries) ([]listing.Rule, error) {
	rows, err := q.ListEnabledBannedTags(ctx)
	if err != nil {
		return nil, err
	}
	rules := make([]listing.Rule, 0, len(rows))
	for _, row := range rows {
		switch row.MatchMode {
		case "exact", "stem":
			rules = append(rules, listing.Rule{Term: row.Term, MatchMode: row.MatchMode})
		}
	}
	return rules, nil
}
