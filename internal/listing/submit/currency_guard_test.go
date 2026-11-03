package submit

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestRequireStoreCurrencyRefusesAConflictingSend(t *testing.T) {
	pool, ctx := draftParityDB(t)
	orgID, userID := seedDraftOrg(t, ctx, pool, 96212)
	storeID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_stores(org_id,uuid,create_order,name,company_currency)
		VALUES($1,$2::uuid,1,'Draft','CNY')`, orgID, storeID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { purgeDraft(context.Background(), pool, orgID, userID) })

	check := func(currency, wantKind string) {
		t.Helper()
		ready := []frozen{{importBody: json.RawMessage(
			`{"items":[{"offer_id":"offer","currency_code":"` + currency + `"}]}`)}}
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
			t.Fatal(err)
		}
		err = requireStoreCurrency(ctx, tx, orgID, storeID, ready)
		var st Status
		switch {
		case wantKind == "" && err != nil:
			t.Fatalf("currency %q: %v", currency, err)
		case wantKind != "" && (!errors.As(err, &st) || st.Kind != wantKind):
			t.Fatalf("currency %q: err=%v want kind %s", currency, err, wantKind)
		}
	}

	check("RUB", "currency_mismatch")
	check(" cny ", "")
	check("", "")
	// A store that has never been read from /v1/seller/info has no contract
	// currency yet; the guard must not guess one and block every send.
	if _, err := pool.Exec(ctx, `
		UPDATE organization_stores SET company_currency=''
		 WHERE org_id=$1 AND uuid=$2::uuid`, orgID, storeID); err != nil {
		t.Fatal(err)
	}
	check("RUB", "")
}

func TestFrozenCurrencyReadsOneItem(t *testing.T) {
	cases := []struct{ body, want string }{
		{`{"items":[{"currency_code":" cny "}]}`, "CNY"},
		{`{"items":[]}`, ""},
		{`{"items":[{"currency_code":"RUB"},{"currency_code":"CNY"}]}`, ""},
		{`not json`, ""},
	}
	for _, tc := range cases {
		if got := frozenCurrency(json.RawMessage(tc.body)); got != tc.want {
			t.Fatalf("frozenCurrency(%s)=%q want %q", tc.body, got, tc.want)
		}
	}
}
