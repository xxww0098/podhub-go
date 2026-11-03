package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	ratingsdomain "github.com/xxww0098/podhub-go/internal/ratings/domain"
	ratingsrepo "github.com/xxww0098/podhub-go/internal/ratings/repo"
)

type ratingsRuntimeFixture struct {
	identityRuntimeFixture
	server                                *httptest.Server
	org, member, membership               int64
	assigned, unassigned, empty, foreign  string
	ownerToken, memberToken, foreignToken string
}

type ratingsHTTPResult struct {
	status int
	body   []byte
	header http.Header
	err    error
}

func newRatingsRuntimeFixture(t *testing.T) ratingsRuntimeFixture {
	t.Helper()
	base := newIdentityRuntimeFixture(t)
	server := httptest.NewServer(base.handler)
	t.Cleanup(server.Close)
	f := ratingsRuntimeFixture{identityRuntimeFixture: base, server: server, assigned: uuid.NewString(), unassigned: uuid.NewString(), empty: uuid.NewString(), foreign: uuid.NewString()}
	var foreignOrg int64
	if err := f.fixture.QueryRow(f.ctx, `SELECT id FROM organizations WHERE owner_user_id=96311`).Scan(&f.org); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT id FROM organizations WHERE owner_user_id=96312`).Scan(&foreignOrg); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `INSERT INTO account_users(public_id,email,password_hash,name,created_at,updated_at) SELECT gen_random_uuid()::text,'ratings-member@example.invalid',password_hash,'Ratings member',clock_timestamp(),clock_timestamp() FROM account_users WHERE id=96311 RETURNING id`).Scan(&f.member); err != nil {
		t.Fatal(err)
	}
	f.membership = seedCompanyMember(t, f.ctx, f.fixture, f.org, f.member, "member", 2)
	seedCompanyStore(t, f.ctx, f.fixture, f.org, f.assigned, 1, "Assigned ratings", &f.membership)
	seedCompanyStore(t, f.ctx, f.fixture, f.org, f.unassigned, 2, "Unassigned ratings", nil)
	seedCompanyStore(t, f.ctx, f.fixture, f.org, f.empty, 3, "No ratings", nil)
	seedCompanyStore(t, f.ctx, f.fixture, foreignOrg, f.foreign, 1, "Foreign ratings", nil)
	f.ownerToken = f.login(t, "a96311@example.invalid")
	f.memberToken = f.login(t, "ratings-member@example.invalid")
	f.foreignToken = f.login(t, "a96312@example.invalid")
	// Local inputs exercise the parser and real storage; no Seller call is made.
	items, dropped, err := ratingsdomain.Parse([]byte(`{"ratings":[
		{"rating":"review","name":"Review","status":"OK","value_type":"REVIEW_SCORE","current_value":1,"past_value":0},
		{"rating":"unknown","name":"Unknown","status":"UNKNOWN","value_type":"RATIO","current_value":9,"past_value":8},
		{"rating":"future","name":"Future","status":"MYSTERY","value_type":"FUTURE_TYPE","current_value":7},
		{"rating":"missing","name":"Missing","status":"OK","value_type":"RATIO","current_value":null,"past_value":2},
		{"rating":"zero","name":"Zero","status":"OK","value_type":"RATIO","current_value":0}
	]}`))
	if err != nil || dropped != 0 {
		t.Fatalf("parse local ratings: dropped=%d err=%v", dropped, err)
	}
	repo := ratingsrepo.New(f.runtime)
	at := time.Now().UTC().Add(-time.Hour)
	if _, err := repo.Apply(f.ctx, f.org, f.assigned, items, at, ratingsdomain.DefaultRanks()); err != nil {
		t.Fatal(err)
	}
	for i := 2; i <= 3; i++ {
		value := fmt.Sprint(i)
		if _, err := repo.Apply(f.ctx, f.org, f.assigned, []ratingsdomain.Rating{{Key: "review", Name: "Review", Status: "OK", ValueType: "REVIEW_SCORE", Current: &value}}, at.Add(time.Duration(i)*time.Minute), ratingsdomain.DefaultRanks()); err != nil {
			t.Fatal(err)
		}
	}
	f.assertClean(t)
	return f
}

func (f ratingsRuntimeFixture) call(method, path, body, token string) ratingsHTTPResult {
	r, err := http.NewRequestWithContext(f.ctx, method, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		return ratingsHTTPResult{err: err}
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", uuid.NewString())
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := f.server.Client().Do(r)
	if err != nil {
		return ratingsHTTPResult{err: err}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	return ratingsHTTPResult{status: response.StatusCode, body: raw, header: response.Header, err: err}
}

func (f ratingsRuntimeFixture) login(t *testing.T, email string) string {
	t.Helper()
	result := f.call(http.MethodPost, "/api/auth/login", fmt.Sprintf(`{"email":%q,"password":"original-password"}`, email), "")
	var payload struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if result.err != nil || result.status != http.StatusOK || json.Unmarshal(result.body, &payload) != nil || payload.Data.Token == "" {
		t.Fatalf("production login: status=%d body=%s err=%v", result.status, result.body, result.err)
	}
	return payload.Data.Token
}

func (f ratingsRuntimeFixture) get(t *testing.T, store, suffix, token string, want int) ratingsHTTPResult {
	t.Helper()
	result := f.call(http.MethodGet, "/api/workspaces/stores/"+store+"/ratings"+suffix, "", token)
	if result.err != nil || result.status != want {
		t.Fatalf("ratings%s: status=%d want=%d body=%s err=%v", suffix, result.status, want, result.body, result.err)
	}
	if result.header.Get("Cache-Control") != "no-store" {
		t.Errorf("ratings response is cacheable: %q", result.header.Get("Cache-Control"))
	}
	return result
}

func TestRatingsProductionRoleHTTP(t *testing.T) {
	f := newRatingsRuntimeFixture(t)
	t.Run("visibility and current authorization", func(t *testing.T) {
		for _, suffix := range []string{"", "/history"} {
			f.get(t, f.assigned, suffix, "", http.StatusUnauthorized)
			f.get(t, f.assigned, suffix, f.ownerToken, http.StatusOK)
			f.get(t, f.unassigned, suffix, f.ownerToken, http.StatusOK)
			f.get(t, f.assigned, suffix, f.memberToken, http.StatusOK)
			f.get(t, f.unassigned, suffix, f.memberToken, http.StatusNotFound)
			f.get(t, f.foreign, suffix, f.ownerToken, http.StatusNotFound)
			f.get(t, f.assigned, suffix, f.foreignToken, http.StatusNotFound)
		}
		for _, change := range []string{"manual_disabled", "quota_suspended"} {
			if _, err := f.fixture.Exec(f.ctx, `UPDATE organization_members SET `+change+`=true WHERE id=$1`, f.membership); err != nil {
				t.Fatal(err)
			}
			for _, suffix := range []string{"", "/history"} {
				f.get(t, f.assigned, suffix, f.memberToken, http.StatusForbidden)
			}
			if _, err := f.fixture.Exec(f.ctx, `UPDATE organization_members SET `+change+`=false WHERE id=$1`, f.membership); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=$1`, f.member); err != nil {
			t.Fatal(err)
		}
		for _, suffix := range []string{"", "/history"} {
			f.get(t, f.assigned, suffix, f.memberToken, http.StatusUnauthorized)
		}
		if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET disabled_at=NULL WHERE id=$1`, f.member); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("unknown and zero stay distinct", func(t *testing.T) {
		result := f.get(t, f.assigned, "", f.memberToken, http.StatusOK)
		var payload struct {
			Items []struct {
				Key       string   `json:"rating_key"`
				Status    string   `json:"status"`
				Type      string   `json:"value_type"`
				Current   *float64 `json:"current_value"`
				Past      *float64 `json:"past_value"`
				NoData    bool     `json:"no_data"`
				Direction string   `json:"direction"`
			} `json:"items"`
		}
		if err := json.Unmarshal(result.body, &payload); err != nil {
			t.Fatal(err)
		}
		if len(payload.Items) != 5 {
			t.Fatalf("ratings count=%d", len(payload.Items))
		}
		for _, item := range payload.Items {
			switch item.Key {
			case "unknown", "missing":
				if !item.NoData || item.Current != nil || item.Past != nil || item.Direction != "no_data" {
					t.Errorf("unknown invented value: %+v", item)
				}
			case "zero":
				if item.NoData || item.Current == nil || *item.Current != 0 {
					t.Errorf("zero disappeared: %+v", item)
				}
			case "future":
				if item.NoData || item.Status != "MYSTERY" || item.Type != "FUTURE_TYPE" || item.Current == nil || *item.Current != 7 {
					t.Errorf("future type changed: %+v", item)
				}
			case "review":
				if item.Current == nil || *item.Current != 3 || item.Direction != "up" {
					t.Errorf("latest/previous values: %+v", item)
				}
			}
		}
		for _, suffix := range []string{"", "/history"} {
			empty := f.get(t, f.empty, suffix, f.ownerToken, http.StatusOK)
			if !strings.Contains(string(empty.body), `"items":[]`) {
				t.Fatalf("empty ratings: %s", empty.body)
			}
		}
	})
	t.Run("history keyset and filters", func(t *testing.T) {
		type row struct {
			ID      int64   `json:"id"`
			Key     string  `json:"rating_key"`
			Current float64 `json:"current_value"`
		}
		type page struct {
			Items []row  `json:"items"`
			Next  *int64 `json:"next_cursor"`
		}
		result := f.get(t, f.assigned, "/history?rating_key=review&limit=2", f.memberToken, http.StatusOK)
		var first page
		if err := json.Unmarshal(result.body, &first); err != nil {
			t.Fatal(err)
		}
		if len(first.Items) != 2 || first.Next == nil || first.Items[0].Current != 3 || first.Items[1].Current != 2 || *first.Next != first.Items[1].ID {
			t.Fatalf("first history page: %s", result.body)
		}
		result = f.get(t, f.assigned, fmt.Sprintf("/history?rating_key=review&limit=2&cursor=%d", *first.Next), f.memberToken, http.StatusOK)
		var second page
		if err := json.Unmarshal(result.body, &second); err != nil {
			t.Fatal(err)
		}
		if len(second.Items) != 1 || second.Next != nil || second.Items[0].Current != 1 || second.Items[0].ID >= *first.Next || second.Items[0].Key != "review" {
			t.Fatalf("second history page: %s", result.body)
		}
		for _, query := range []string{"limit=0", "limit=101", "limit=bad", "cursor=0", "cursor=-1", "cursor=bad"} {
			f.get(t, f.assigned, "/history?"+query, f.memberToken, http.StatusBadRequest)
		}
		unknown := f.get(t, f.assigned, "/history?rating_key=absent", f.memberToken, http.StatusOK)
		if !strings.Contains(string(unknown.body), `"items":[]`) || !strings.Contains(string(unknown.body), `"next_cursor":null`) {
			t.Fatalf("missing key: %s", unknown.body)
		}
	})
	var snapshots, history, notifications int
	if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM store_rating_snapshots WHERE org_id=$1),(SELECT count(*) FROM store_rating_history WHERE org_id=$1),(SELECT count(*) FROM notifications WHERE kind='store_rating_worsened')`, f.org).Scan(&snapshots, &history, &notifications); err != nil || snapshots != 5 || history != 7 || notifications != 0 {
		t.Fatalf("read side effects snapshots=%d history=%d notes=%d err=%v", snapshots, history, notifications, err)
	}
	f.assertClean(t)
}

// The existing query tracer runs before BEGIN is sent. Identify the Gate
// caller in the stack so this does not depend on the number of auth queries.
type ratingsGateBarrier struct {
	entered, release chan struct{}
	once             sync.Once
}

func (b *ratingsGateBarrier) OnStart(ctx context.Context, span sdktrace.ReadWriteSpan) {
	if span.Name() != "pgx.query" {
		return
	}
	begin := false
	for _, attribute := range span.Attributes() {
		if string(attribute.Key) == "db.operation.name" && attribute.Value.AsString() == "BEGIN" {
			begin = true
		}
	}
	if !begin {
		return
	}
	var pcs [64]uintptr
	frames := runtime.CallersFrames(pcs[:runtime.Callers(2, pcs[:])])
	for {
		frame, more := frames.Next()
		if frame.Function == "github.com/xxww0098/podhub-go/internal/ratings/repo.(*Repo).Gate" {
			b.once.Do(func() {
				close(b.entered)
				select {
				case <-b.release:
				case <-ctx.Done():
				}
			})
			return
		}
		if !more {
			return
		}
	}
}
func (*ratingsGateBarrier) OnEnd(sdktrace.ReadOnlySpan)      {}
func (*ratingsGateBarrier) Shutdown(context.Context) error   { return nil }
func (*ratingsGateBarrier) ForceFlush(context.Context) error { return nil }

func TestRatingsRechecksAuthorityBeforeGate(t *testing.T) {
	f := newRatingsRuntimeFixture(t)
	for _, suffix := range []string{"", "/history"} {
		for _, change := range []string{"account disabled", "workspace dissolved", "membership disabled", "assignment removed", "unchanged"} {
			t.Run(suffix+"/"+change, func(t *testing.T) {
				barrier := &ratingsGateBarrier{entered: make(chan struct{}), release: make(chan struct{})}
				previous := otel.GetTracerProvider()
				provider := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.AlwaysSample()), sdktrace.WithSpanProcessor(barrier))
				otel.SetTracerProvider(provider)
				defer func() { otel.SetTracerProvider(previous); _ = provider.Shutdown(context.Background()) }()
				defer func() {
					_, _ = f.fixture.Exec(f.ctx, `UPDATE account_users SET disabled_at=NULL WHERE id=$1`, f.member)
					_, _ = f.fixture.Exec(f.ctx, `UPDATE organizations SET dissolved_at=NULL WHERE id=$1`, f.org)
					_, _ = f.fixture.Exec(f.ctx, `UPDATE organization_members SET manual_disabled=false WHERE id=$1`, f.membership)
					_, _ = f.fixture.Exec(f.ctx, `UPDATE organization_stores SET assignee_membership_id=$1 WHERE uuid=$2::uuid`, f.membership, f.assigned)
				}()
				done := make(chan ratingsHTTPResult, 1)
				go func() {
					done <- f.call(http.MethodGet, "/api/workspaces/stores/"+f.assigned+"/ratings"+suffix, "", f.memberToken)
				}()
				select {
				case <-barrier.entered:
				case result := <-done:
					t.Fatalf("request never entered Gate: status=%d body=%s err=%v", result.status, result.body, result.err)
				case <-time.After(5 * time.Second):
					close(barrier.release)
					t.Fatal("request did not reach Gate BEGIN")
				}
				var err error
				want := http.StatusForbidden
				switch change {
				case "account disabled":
					_, err = f.fixture.Exec(f.ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=$1`, f.member)
				case "workspace dissolved":
					_, err = f.fixture.Exec(f.ctx, `UPDATE organizations SET dissolved_at=clock_timestamp() WHERE id=$1`, f.org)
					want = http.StatusNotFound
				case "membership disabled":
					_, err = f.fixture.Exec(f.ctx, `UPDATE organization_members SET manual_disabled=true WHERE id=$1`, f.membership)
				case "assignment removed":
					_, err = f.fixture.Exec(f.ctx, `UPDATE organization_stores SET assignee_membership_id=NULL WHERE uuid=$1::uuid`, f.assigned)
					want = http.StatusNotFound
				case "unchanged":
					want = http.StatusOK
				}
				close(barrier.release)
				if err != nil {
					t.Fatal(err)
				}
				select {
				case result := <-done:
					if result.err != nil || result.status != want {
						t.Errorf("new authority ignored: status=%d want=%d body=%s err=%v", result.status, want, result.body, result.err)
					}
					if want != http.StatusOK && strings.Contains(string(result.body), `"rating_key"`) {
						t.Error("refused actor received rating data")
					}
				case <-f.ctx.Done():
					t.Fatal(f.ctx.Err())
				}
			})
		}
	}
	f.assertClean(t)
}
