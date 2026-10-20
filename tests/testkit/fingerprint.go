package testkit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// headFingerprint is fixtures/cloud/seaorm-probe/expected-head-fingerprint.json
// from podhub a03d735. Capture matches migration/src/fingerprint/capture.rs.
type headFingerprint struct {
	Fingerprint struct {
		FormatVersion int       `json:"format_version"`
		Schema        string    `json:"schema"`
		Tables        []fpTable `json:"tables"`
	} `json:"fingerprint"`
}

type fpTable struct {
	Name        string         `json:"name"`
	Columns     []fpColumn     `json:"columns"`
	Indexes     []fpIndex      `json:"indexes"`
	Constraints []fpConstraint `json:"constraints"`
	RowSecurity fpRLS          `json:"row_security"`
	RowCount    int64          `json:"row_count"`
}

type fpColumn struct {
	Name      string  `json:"name"`
	Ordinal   int     `json:"ordinal_position"`
	SQLType   string  `json:"sql_type"`
	Nullable  bool    `json:"nullable"`
	Default   *string `json:"default"`
	Identity  string  `json:"identity"`
	Generated string  `json:"generated"`
}

type fpIndex struct {
	Name       string `json:"name"`
	Definition string `json:"definition"`
	Unique     bool   `json:"unique"`
	Primary    bool   `json:"primary"`
	Valid      bool   `json:"valid"`
}

type fpConstraint struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Definition string `json:"definition"`
	Validated  bool   `json:"validated"`
}

type fpRLS struct {
	Enabled  bool       `json:"enabled"`
	Forced   bool       `json:"forced"`
	Policies []fpPolicy `json:"policies"`
}

type fpPolicy struct {
	Name            string   `json:"name"`
	Command         string   `json:"command"`
	Permissive      bool     `json:"permissive"`
	Roles           []string `json:"roles"`
	UsingExpression *string  `json:"using_expression"`
	CheckExpression *string  `json:"check_expression"`
}

func loadHeadFingerprint() (*headFingerprint, error) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return nil, fmt.Errorf("runtime caller")
	}
	path := filepath.Join(filepath.Dir(file), "..", "integration", "testdata", "expected-head-fingerprint.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var fp headFingerprint
	if err := json.Unmarshal(raw, &fp); err != nil {
		return nil, err
	}
	if fp.Fingerprint.FormatVersion != 2 || len(fp.Fingerprint.Tables) != 132 {
		return nil, fmt.Errorf("fingerprint version %d tables %d", fp.Fingerprint.FormatVersion, len(fp.Fingerprint.Tables))
	}
	return &fp, nil
}

// captureSQL is the catalog query from capture.rs, including the two
// definition rewrites in normalize_pg_definition. goose and River tables are
// excluded here so they are not reported as extra business tables.
const captureSQL = `
SELECT COALESCE(json_agg(x ORDER BY x->>'name'), '[]'::json)::text FROM (
SELECT json_build_object(
  'name', c.relname,
  'columns', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', a.attname,
      'ordinal_position', a.attnum,
      'sql_type', pg_catalog.format_type(a.atttypid, a.atttypmod),
      'nullable', NOT a.attnotnull,
      'default', pg_catalog.pg_get_expr(ad.adbin, ad.adrelid),
      'identity', a.attidentity::text,
      'generated', a.attgenerated::text
    ) ORDER BY a.attnum), '[]'::json)
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  ),
  'indexes', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', ic.relname,
      'definition', pg_catalog.pg_get_indexdef(i.indexrelid),
      'unique', i.indisunique,
      'primary', i.indisprimary,
      'valid', i.indisvalid
    ) ORDER BY ic.relname), '[]'::json)
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = c.oid
  ),
  'constraints', (
    SELECT COALESCE(json_agg(json_build_object(
      'name', con.conname,
      'kind', CASE con.contype
         WHEN 'p' THEN 'primary_key' WHEN 'u' THEN 'unique'
         WHEN 'f' THEN 'foreign_key' WHEN 'c' THEN 'check'
         WHEN 'x' THEN 'exclusion' ELSE con.contype::text END,
      'definition', replace(replace(pg_catalog.pg_get_constraintdef(con.oid, true),
         '::character varying::text', '::character varying'), ']::text[]', ']'),
      'validated', con.convalidated
    ) ORDER BY con.conname), '[]'::json)
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = c.oid
  ),
  'row_security', json_build_object(
    'enabled', c.relrowsecurity,
    'forced', c.relforcerowsecurity,
    'policies', (
      SELECT COALESCE(json_agg(json_build_object(
        'name', p.polname,
        'command', p.polcmd::text,
        'permissive', p.polpermissive,
        'roles', ARRAY(SELECT CASE WHEN role_id = 0 THEN 'PUBLIC'
                                    ELSE pg_catalog.pg_get_userbyid(role_id)::text END
                        FROM unnest(p.polroles) AS role_id ORDER BY 1),
        'using_expression', pg_catalog.pg_get_expr(p.polqual, p.polrelid),
        'check_expression', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
      ) ORDER BY p.polname), '[]'::json)
      FROM pg_catalog.pg_policy p
      WHERE p.polrelid = c.oid
    )
  )
) AS x
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  AND c.relname <> 'goose_db_version'
  AND c.relname NOT LIKE 'river_%'
) s`

// postRustTables are goose versions after the Rust head fingerprint
// (00293). Column and policy checks still cover every fingerprint table.
var postRustTables = map[string]bool{
	"billing_settings":           true,
	"storage_object_refs":        true,
	"storage_objects":            true,
	"storage_uploads":            true,
	"subscription_events":        true,
	"subscription_quotes":        true,
	"subscriptions":              true,
	"transit_clear_runs":         true,
	"ai_billing_ratio_documents": true,
	"ai_consume_logs":            true,
	"error_digest":               true,
	"ozon_error_catalog":         true,
	"ozon_error_observation":     true,
	"ozon_error_sighting":        true,
	"store_rating_snapshots":     true,
	"store_rating_sync":          true,
	"store_rating_history":       true,
	"ozon_warehouses":            true,
	"ozon_delivery_methods":      true,
	"ozon_warehouse_sync":        true,
	"ozon_warehouse_intents":     true,
	"ozon_warehouse_fences":      true,
}

// postRustColumns are columns appended after the Rust head. The columns
// already in the fingerprint stay compared in order. 00315 adds the two
// browser-grant timestamps; they are not a second offer fence.
var postRustColumns = map[string][]fpColumn{
	"jobs": {
		{Name: "store_id", Ordinal: 29, SQLType: "uuid", Nullable: true},
		{Name: "member_id", Ordinal: 30, SQLType: "bigint", Nullable: true},
	},
	"organizations": {
		{Name: "store_limit", Ordinal: 17, SQLType: "bigint", Nullable: false, Default: strPtr("1")},
	},
	"payment_orders": {
		{Name: "subscription_snapshot", Ordinal: 30, SQLType: "jsonb", Nullable: true},
		{Name: "payment_deadline_at", Ordinal: 31, SQLType: "timestamp with time zone", Nullable: true},
		{Name: "fulfillment_failed_at", Ordinal: 32, SQLType: "timestamp with time zone", Nullable: true},
		{Name: "reconciliation_reason", Ordinal: 33, SQLType: "text", Nullable: true},
		{Name: "quote_id", Ordinal: 34, SQLType: "uuid", Nullable: true},
	},
	"workspace_psd_templates": {
		{Name: "object_id", Ordinal: 13, SQLType: "uuid", Nullable: true},
		{Name: "original_name", Ordinal: 14, SQLType: "text", Nullable: true},
	},
	"submission_intents": {
		{Name: "credential_granted_at", Ordinal: 22, SQLType: "timestamp with time zone", Nullable: true},
		{Name: "revoked_at", Ordinal: 23, SQLType: "timestamp with time zone", Nullable: true},
	},
	// 00330 appends the company-name columns. The earlier columns stay in place.
	"organization_stores": {
		{Name: "company_short_name", Ordinal: 23, SQLType: "character varying(255)", Nullable: true},
		{Name: "company_legal_name", Ordinal: 24, SQLType: "character varying(512)", Nullable: true},
		{Name: "name_source", Ordinal: 25, SQLType: "character varying(16)", Nullable: false, Default: strPtr("'auto'::character varying")},
		// 00331 appends seller-info columns. Tax identifiers are not columns.
		{Name: "company_currency", Ordinal: 26, SQLType: "character varying(8)", Nullable: true},
		{Name: "company_country", Ordinal: 27, SQLType: "character varying(8)", Nullable: true},
		{Name: "subscription_is_premium", Ordinal: 28, SQLType: "boolean", Nullable: true},
		{Name: "subscription_type", Ordinal: 29, SQLType: "character varying(32)", Nullable: true},
		{Name: "seller_info_synced_at", Ordinal: 30, SQLType: "timestamp with time zone", Nullable: true},
		{Name: "seller_key_status", Ordinal: 31, SQLType: "character varying(16)", Nullable: false, Default: strPtr("'unknown'::character varying")},
		{Name: "seller_key_reason", Ordinal: 32, SQLType: "character varying(16)", Nullable: true},
	},
}

func strPtr(s string) *string { return &s }

// postRustIndexes are indexes appended after the Rust head.
var postRustIndexes = map[string]map[string]bool{
	"jobs":                {"jobs_drain_store_idx": true, "jobs_drain_member_idx": true},
	"payment_orders":      {"payment_orders_deadline_idx": true, "payment_orders_quote_uidx": true},
	"organization_stores": {"ix_organization_stores_company_legal": true},
}

// postRustConstraints are constraints appended after the Rust head.
var postRustConstraints = map[string]map[string]bool{
	"jobs":                    {"jobs_store_id_fkey": true, "jobs_member_id_fkey": true},
	"organizations":           {"organizations_store_limit_check": true},
	"payment_orders":          {"payment_orders_quote_id_fkey": true, "payment_orders_reconciliation_reason_check": true, "payment_orders_subscription_snapshot_shape": true},
	"workspace_psd_templates": {"workspace_psd_templates_object_id_fkey": true},
	"organization_stores": {
		"ck_organization_stores_name_source":       true,
		"ck_organization_stores_seller_key_status": true,
		"ck_organization_stores_seller_key_reason": true,
	},
}

// intentionalFunctions are routines added after the Rust head.
// Their bodies are still required to appear in the goose SQL. Every other
// non-extension function stays at 35: the Rust head count of 34 plus
// prune_aged_inbox from migration 00300.
var intentionalFunctions = map[string]bool{
	"storage_key_fence":                    true,
	"lock_storage_key_shared":              true,
	"try_lock_storage_key_exclusive":       true,
	"storage_ref_candidates":               true,
	"sync_storage_object_refs":             true,
	"subscription_term_month_start":        true,
	"payment_order_subscription_immutable": true,
	"billing_payment_order_org":            true,
	"billing_lock_payment_order":           true,
	"billing_lock_redeem_code":             true,
	"billing_consume_redeem_code":          true,
	"billing_replay_candidates":            true,
	"billing_owner_paid_orders":            true,
	"billing_payment_order_brief":          true,
}

// intentionalRLSPolicies are FORCE RLS policies added in migration 00294.
// They are not in the Rust head fingerprint. The enabled/forced flags and
// these policy names are skipped. Columns, indexes, constraints, and every
// other policy on the same table are still compared.
var intentionalRLSPolicies = map[string]map[string]bool{
	"payment_orders": {
		"tenant_isolation": true,
		"worker_claim":     true,
		"billing_lookup":   true,
	},
	"member_seat_lots": {
		"tenant_isolation": true,
		"worker_claim":     true,
	},
	"member_seat_lot_credits": {
		"tenant_isolation": true,
		"worker_claim":     true,
	},
	"redeem_codes": {
		"worker_claim":   true,
		"billing_lookup": true,
	},
	"ai_requests": {
		"tenant_isolation": true,
		"worker_claim":     true,
	},
	"sc_orders": {
		"tenant_isolation": true,
		"worker_claim":     true,
	},
	"sc_order_lines": {
		"tenant_isolation": true,
		"worker_claim":     true,
	},
}

func compareHeadFingerprint(t failer, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	fp, err := loadHeadFingerprint()
	if err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := pool.QueryRow(ctx, captureSQL).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var got []fpTable
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]fpTable{}
	for _, table := range fp.Fingerprint.Tables {
		want[table.Name] = table
	}
	have := map[string]fpTable{}
	for _, table := range got {
		have[table.Name] = table
	}
	var missing, extra []string
	for name := range want {
		if _, ok := have[name]; !ok {
			missing = append(missing, name)
		}
	}
	for name := range have {
		if _, ok := want[name]; !ok {
			// 00293 adds tables after the Rust head. They are not in the
			// fingerprint and must not be reported as a schema-name gap.
			if postRustTables[name] {
				continue
			}
			extra = append(extra, name)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	if len(missing) != 0 || len(extra) != 0 {
		t.Fatalf("schema name gap missing=%v extra=%v", missing, extra)
	}
	var diffs []string
	for _, name := range sortedKeys(want) {
		diffs = append(diffs, diffTable(want[name], have[name])...)
	}
	if len(diffs) > 0 {
		n := len(diffs)
		if n > 30 {
			diffs = diffs[:30]
		}
		t.Fatalf("schema gap %d (showing %d):\n%s", n, len(diffs), strings.Join(diffs, "\n"))
	}
	diffs = diffRowCounts(ctx, pool, want)
	if len(diffs) > 0 {
		t.Fatalf("row-count gap:\n%s", strings.Join(diffs, "\n"))
	}
}

// stepMarkerRows is the head fingerprint count for seaql_migration_steps.
// The Rust migrator inserts one marker per recorded step. This replay does
// not. Every other head row count must match.
const stepMarkerRows = 79

func diffRowCounts(ctx context.Context, pool *pgxpool.Pool, want map[string]fpTable) []string {
	var diffs []string
	for _, name := range sortedKeys(want) {
		var n int64
		q := fmt.Sprintf("SELECT count(*) FROM public.%s", quoteIdent(name))
		if err := pool.QueryRow(ctx, q).Scan(&n); err != nil {
			return []string{name + ": " + err.Error()}
		}
		exp := want[name].RowCount
		if name == "plans" {
			// 00344 retires ultra and leaves the four subscription tiers.
			exp = 4
		}
		if name == "seaql_migration_steps" {
			if exp != stepMarkerRows || n != 0 {
				diffs = append(diffs, fmt.Sprintf("seaql_migration_steps expected fingerprint %d and replay 0, got fingerprint %d replay %d", stepMarkerRows, exp, n))
			}
			continue
		}
		if n != exp {
			diffs = append(diffs, fmt.Sprintf("%s rows %d want %d", name, n, exp))
		}
	}
	return diffs
}

func sameColumn(w, g fpColumn) bool {
	return w.Name == g.Name && w.Ordinal == g.Ordinal && w.SQLType == g.SQLType && w.Nullable == g.Nullable && w.Identity == g.Identity && w.Generated == g.Generated && sameString(w.Default, g.Default)
}

// 00347 replaces the seat-sale constraints with subscription-order constraints.
var subscriptionConstraints = map[string]string{
	"payment_orders_product_known":            `CHECK (product::text = ANY (ARRAY['subscription'::character varying, 'wallet_topup'::character varying, 'platform_goods'::character varying, 'member_seats'::character varying]))`,
	"payment_orders_product_shape":            `CHECK (product::text = 'subscription'::text AND subscription_snapshot IS NOT NULL AND member_seats IS NULL AND topup_microfen IS NULL OR product::text = 'wallet_topup'::text AND topup_microfen > 0 OR product::text = 'platform_goods'::text AND topup_microfen IS NULL AND (member_seats IS NULL OR member_seats = 0))`,
	"payment_orders_purchase_agreement_valid": `CHECK (product::text <> 'subscription'::text AND purchase_agreement IS NULL OR product::text = 'subscription'::text AND jsonb_typeof(purchase_agreement) = 'object'::text AND purchase_agreement ?& ARRAY['version'::text, 'title'::text, 'effective_at'::text, 'content'::text, 'accepted_at'::text, 'accepted_by'::text] AND jsonb_typeof(purchase_agreement -> 'version'::text) = 'string'::text AND jsonb_typeof(purchase_agreement -> 'title'::text) = 'string'::text AND jsonb_typeof(purchase_agreement -> 'effective_at'::text) = 'string'::text AND jsonb_typeof(purchase_agreement -> 'content'::text) = 'string'::text AND jsonb_typeof(purchase_agreement -> 'accepted_at'::text) = 'string'::text AND jsonb_typeof(purchase_agreement -> 'accepted_by'::text) = 'string'::text AND length(purchase_agreement ->> 'version'::text) > 0 AND length(purchase_agreement ->> 'content'::text) > 0 AND length(purchase_agreement ->> 'accepted_at'::text) > 0 AND (purchase_agreement ->> 'accepted_by'::text) = created_by_user_id::text)`,
}

func sameConstraintDef(table, name, want, got string) bool {
	if table == "payment_orders" {
		if definition, ok := subscriptionConstraints[name]; ok {
			return got == definition
		}
	}
	if want == got {
		return true
	}
	switch table + " " + name {
	case "writer_leases writer_leases_domain_known":
		return strings.Replace(got, ", 'billing'::character varying", "", 1) == want
	case "notifications ck_notifications_kind":
		// 00337 appends the in-app rating kind. The previous five stay, in order.
		return strings.Replace(got, ", 'store_rating_worsened'::text", "", 1) == want
	case "ai_requests ai_requests_total_is_sum":
		const oldTail = "total_microfen = per_request_microfen"
		const newTail = "(per_request_microfen - total_microfen) >= 0 AND (per_request_microfen - total_microfen) <= 1"
		return strings.Replace(got, newTail, oldTail, 1) == want
	default:
		return false
	}
}

func diffTable(want, got fpTable) []string {
	var diffs []string
	gotColumns := got.Columns
	if extra := postRustColumns[want.Name]; len(extra) > 0 {
		if len(gotColumns) != len(want.Columns)+len(extra) {
			diffs = append(diffs, fmt.Sprintf("%s columns %d want %d plus %d post-rust", want.Name, len(gotColumns), len(want.Columns), len(extra)))
		} else {
			tail := gotColumns[len(want.Columns):]
			gotColumns = gotColumns[:len(want.Columns)]
			for i := range extra {
				if !sameColumn(extra[i], tail[i]) {
					diffs = append(diffs, fmt.Sprintf("%s post-rust column %s: got %+v want %+v", want.Name, extra[i].Name, tail[i], extra[i]))
				}
			}
		}
	}
	if len(want.Columns) != len(gotColumns) {
		diffs = append(diffs, fmt.Sprintf("%s columns %d want %d", want.Name, len(gotColumns), len(want.Columns)))
	} else {
		for i := range want.Columns {
			w, g := want.Columns[i], gotColumns[i]
			if (want.Name == "account_users" || want.Name == "organizations") && w.Name == "plan" {
				w.Default = strPtr("'free'::character varying")
			}
			if !sameColumn(w, g) {
				diffs = append(diffs, fmt.Sprintf("%s column %s: got %+v want %+v", want.Name, w.Name, g, w))
			}
		}
	}
	wi, gi := indexMap(want.Indexes), indexMap(got.Indexes)
	for name := range postRustIndexes[want.Name] {
		delete(gi, name)
	}
	if msg := nameGapIndexes(want.Name+" index", wi, gi); msg != "" {
		diffs = append(diffs, msg)
	}
	for name, w := range wi {
		g, ok := gi[name]
		if !ok {
			continue
		}
		if w.Definition != g.Definition || w.Unique != g.Unique || w.Primary != g.Primary || w.Valid != g.Valid {
			diffs = append(diffs, fmt.Sprintf("%s index %s:\n got %s\n want %s", want.Name, name, g.Definition, w.Definition))
		}
	}
	wc, gc := consMap(want.Constraints), consMap(got.Constraints)
	for name := range postRustConstraints[want.Name] {
		delete(gc, name)
	}
	// 00307 drops the subset check. The copied formula stores provider
	// counts even when cache exceeds prompt or reasoning exceeds completion.
	if want.Name == "payment_orders" {
		delete(wc, "payment_orders_credit_shape")
		delete(wc, "payment_orders_member_seat_terms")
	}
	if want.Name == "ai_requests" {
		delete(wc, "ai_requests_token_details_within_totals")
	}
	if msg := setGap(want.Name+" constraint", keysOf(wc), keysOf(gc)); msg != "" {
		diffs = append(diffs, msg)
	}
	for name, w := range wc {
		g, ok := gc[name]
		if !ok {
			continue
		}
		if w.Kind != g.Kind || w.Validated != g.Validated || !sameConstraintDef(want.Name, name, w.Definition, g.Definition) {
			diffs = append(diffs, fmt.Sprintf("%s constraint %s:\n got %s %s\n want %s %s", want.Name, name, g.Kind, g.Definition, w.Kind, w.Definition))
		}
	}
	allowedRLS := intentionalRLSPolicies[want.Name]
	if allowedRLS == nil && (want.RowSecurity.Enabled != got.RowSecurity.Enabled || want.RowSecurity.Forced != got.RowSecurity.Forced) {
		diffs = append(diffs, fmt.Sprintf("%s rls enabled/forced got %v/%v want %v/%v", want.Name, got.RowSecurity.Enabled, got.RowSecurity.Forced, want.RowSecurity.Enabled, want.RowSecurity.Forced))
	}
	wp, gp := polMap(want.RowSecurity.Policies), polMap(got.RowSecurity.Policies)
	if msg := policyGap(want.Name, wp, gp, allowedRLS); msg != "" {
		diffs = append(diffs, msg)
	}
	for name, w := range wp {
		g, ok := gp[name]
		if !ok {
			continue
		}
		if w.Command != g.Command || w.Permissive != g.Permissive || strings.Join(w.Roles, ",") != strings.Join(g.Roles, ",") || !sameString(w.UsingExpression, g.UsingExpression) || !sameString(w.CheckExpression, g.CheckExpression) {
			diffs = append(diffs, fmt.Sprintf("%s policy %s got %+v want %+v", want.Name, name, g, w))
		}
	}
	return diffs
}

func indexMap(items []fpIndex) map[string]fpIndex {
	out := map[string]fpIndex{}
	for _, item := range items {
		out[item.Name] = item
	}
	return out
}

func consMap(items []fpConstraint) map[string]fpConstraint {
	out := map[string]fpConstraint{}
	for _, item := range items {
		out[item.Name] = item
	}
	return out
}

func polMap(items []fpPolicy) map[string]fpPolicy {
	out := map[string]fpPolicy{}
	for _, item := range items {
		out[item.Name] = item
	}
	return out
}

func keysOf(m map[string]fpConstraint) map[string]struct{} {
	out := map[string]struct{}{}
	for k := range m {
		out[k] = struct{}{}
	}
	return out
}

func policyGap(table string, want, got map[string]fpPolicy, allowed map[string]bool) string {
	var missing, extra []string
	for name := range want {
		if _, ok := got[name]; !ok {
			missing = append(missing, name)
		}
	}
	for name := range got {
		if _, ok := want[name]; ok {
			continue
		}
		if allowed[name] {
			continue
		}
		extra = append(extra, name)
	}
	if len(missing) == 0 && len(extra) == 0 {
		return ""
	}
	sort.Strings(missing)
	sort.Strings(extra)
	return fmt.Sprintf("%s policy missing %v extra %v", table, missing, extra)
}

func nameGapIndexes(label string, want map[string]fpIndex, got map[string]fpIndex) string {
	wk, gk := map[string]struct{}{}, map[string]struct{}{}
	for k := range want {
		wk[k] = struct{}{}
	}
	for k := range got {
		gk[k] = struct{}{}
	}
	return setGap(label, wk, gk)
}

func setGap(label string, want, got map[string]struct{}) string {
	var missing, extra []string
	for name := range want {
		if _, ok := got[name]; !ok {
			missing = append(missing, name)
		}
	}
	for name := range got {
		if _, ok := want[name]; !ok {
			extra = append(extra, name)
		}
	}
	if len(missing) == 0 && len(extra) == 0 {
		return ""
	}
	sort.Strings(missing)
	sort.Strings(extra)
	return fmt.Sprintf("%s missing %v extra %v", label, missing, extra)
}

func sortedKeys(m map[string]fpTable) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func sameString(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

type failer interface {
	Helper()
	Fatal(args ...any)
	Fatalf(format string, args ...any)
}

var spaceRE = regexp.MustCompile(`\s+`)

func migrationUpText() (string, error) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("runtime caller")
	}
	dir := filepath.Join(filepath.Dir(file), "..", "..", "db", "migrations")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	var b strings.Builder
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return "", err
		}
		up := string(raw)
		if i := strings.Index(up, "-- +goose Down"); i >= 0 {
			up = up[:i]
		}
		b.WriteString(up)
		b.WriteByte('\n')
	}
	return spaceRE.ReplaceAllString(b.String(), " "), nil
}

func compareRoutineBodies(t failer, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	up, err := migrationUpText()
	if err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `
		SELECT p.proname, p.prosrc
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'public'
		  AND p.proname NOT LIKE 'river_%'
		  AND NOT EXISTS (
		    SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
		  )
		ORDER BY p.proname`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var funcs, added int
	for rows.Next() {
		var name, src string
		if err := rows.Scan(&name, &src); err != nil {
			t.Fatal(err)
		}
		norm := spaceRE.ReplaceAllString(strings.TrimSpace(src), " ")
		if !strings.Contains(up, norm) {
			t.Fatalf("function %s body is not contained in the goose SQL", name)
		}
		if intentionalFunctions[name] {
			added++
			continue
		}
		funcs++
	}
	// 35 includes prune_aged_inbox from migration 00300. It is not a
	// Rust function. Its body must still be contained in the goose SQL.
	if funcs != 35 {
		t.Fatalf("non-extension functions %d, want 35", funcs)
	}
	if added != len(intentionalFunctions) {
		t.Fatalf("intentional post-Rust functions %d, want %d", added, len(intentionalFunctions))
	}
	trows, err := pool.Query(ctx, `
		SELECT t.tgname
		FROM pg_trigger t
		JOIN pg_class c ON c.oid = t.tgrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND NOT t.tgisinternal
		ORDER BY t.tgname`)
	if err != nil {
		t.Fatal(err)
	}
	defer trows.Close()
	var triggers int
	for trows.Next() {
		var name string
		if err := trows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		triggers++
		if !strings.Contains(up, "TRIGGER "+name) && !strings.Contains(up, "TRIGGER\n"+name) && !strings.Contains(up, "trigger "+name) {
			t.Fatalf("trigger %s is not named in the goose SQL", name)
		}
	}
	if triggers != 28 {
		t.Fatalf("triggers %d, want 28", triggers)
	}
}
