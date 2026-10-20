package identity

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
)

func strictJSON(r *http.Request, dest any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(dest)
}

func asInt64Ptr(v any) *int64 {
	switch n := v.(type) {
	case int64:
		return &n
	case int32:
		x := int64(n)
		return &x
	default:
		return nil
	}
}

func pgInt(v pgtype.Int8) *int64 {
	if !v.Valid {
		return nil
	}
	n := v.Int64
	return &n
}
