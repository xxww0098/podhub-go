package integration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/ai"
	aicontract "github.com/xxww0098/podhub-go/internal/ai/contract"
	"github.com/xxww0098/podhub-go/internal/app"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/internal/identity"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	readhttp "github.com/xxww0098/podhub-go/internal/listing/read/http"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

type recognitionClaim struct {
	Job struct {
		ID      string         `json:"id"`
		Key     string         `json:"idempotency_key"`
		Payload aicontract.Pin `json:"payload"`
	} `json:"job"`
	Lease   aicontract.Lease `json:"lease"`
	Seconds int64            `json:"lease_seconds"`
}

func runListingRecognitionCases(t *testing.T, f listingMediaTest, apiPool *pgxpool.Pool, router chi.Router, host readhttp.Host, resolver access.Resolver) {
	t.Helper()
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	checkContract := func(t *testing.T, method, path string, rec *httptest.ResponseRecorder) {
		t.Helper()
		if err := spec.CheckResponse(method, path, rec.Code, rec.Header(), rec.Body.Bytes()); err != nil {
			t.Fatalf("response contract: %v\n%s", err, rec.Body.Bytes())
		}
	}
	t.Run("recognition_production_empty_catalog", func(t *testing.T) {
		t.Setenv("CLOUD_INTEGRATION_CONFIG_KEY", strings.Repeat("recognition-test-key-", 3))
		actual := app.Handler(apiPool)
		first := get(t, actual, "/api/ai/prices", f.cookie)
		if first.Code != 200 || !strings.Contains(first.Body.String(), `"ocr_models":[]`) || !strings.Contains(first.Body.String(), `"default_ocr_model":""`) {
			t.Fatalf("production unconfigured models %d %s", first.Code, first.Body.String())
		}
		if _, err := f.pool.Exec(f.ctx, `DELETE FROM ai_price_schedules`); err != nil {
			t.Fatal(err)
		}
		rec := get(t, actual, "/api/ai/prices", f.cookie)
		if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"default_ocr_model":"","ocr_models":[],"prices":[]}` {
			t.Fatalf("production empty price catalog %d %s", rec.Code, rec.Body.String())
		}
	})
	const prompt = `{"product_type_ru":"Кружка","facts_ru":"керамическая 330 мл"}`
	sha := sha256.Sum256([]byte(prompt))
	promptSHA := hex.EncodeToString(sha[:])
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO category_prompts(prompt_id,description_category_id,type_id,name,file_name,content,created_at_ms,updated_at_ms,created_by_account_uuid,fixed_tags) VALUES('recognition-test',17027906,91976,'Recognition','recognition.txt',$1,1,1,'test','["#кружка"]')`, prompt); err != nil {
		t.Fatal(err)
	}
	seedMatchingLease(t, f.ctx, f.pool, "billing", "recognition test")
	insertPrice(t, f.ctx, f.pool, "recognition-test-model")
	if _, err := billingrepo.Adjust(f.ctx, f.pool, f.org, "recognition-seed", 300_000_000, "recognition test"); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int64
	var mode atomic.Int64
	providerStarted := make(chan struct{})
	providerRelease := make(chan struct{})
	valid, _ := json.Marshal(map[string]any{"id": "ocr-fixture", "model": "recognition-test-model", "choices": []any{map[string]any{"message": map[string]any{"content": `{"state":"clear","theme_ru":"Белая кружка","description_ru":"На рисунке белая кружка стоит на столе рядом с листьями. Фон украшен плавными линиями и зелёными узорами.","tags":["#белая_кружка","#кружка_на_столе","#листья_рядом_с_кружкой","#узоры_вокруг_кружки","#кружка_среди_линий"]}`}}}, "usage": map[string]any{"prompt_tokens": 20, "completion_tokens": 40}})
	runtime := &ai.OCRRuntime{
		Authorize: host.AuthorizeOCR, Settle: host.SettleOCR,
		Validate: host.ValidateOCR,
		Models: func(context.Context) ([]string, string, error) {
			return []string{"recognition-test-model"}, "recognition-test-model", nil
		},
		Resolve: func(context.Context, aicontract.Routing) (ai.OCRProvider, error) {
			return ai.OCRProvider{AccountID: "recognition-test", Model: "recognition-test-model", Complete: func(ctx context.Context, b []byte) (int, []byte, error) {
				calls.Add(1)
				if !strings.Contains(string(b), "Опиши рисунок для карточки товара") || !strings.Contains(string(b), "data:image/png;base64,") {
					return 0, nil, errors.New("unpinned provider input")
				}
				if mode.Load() == 5 && strings.Contains(string(b), "500 мл") {
					return 0, nil, errors.New("product facts leaked to the model")
				}
				if mode.Load() == 1 {
					return 0, nil, errors.New("unknown provider outcome")
				}
				if mode.Load() == 3 {
					bad := strings.Replace(string(valid), "Белая кружка", "Гора и японская деревня", 1)
					return 200, []byte(bad), nil
				}
				if mode.Load() == 2 {
					return 400, []byte(`{"error":"invalid"}`), nil
				}
				if mode.Load() == 4 {
					close(providerStarted)
					select {
					case <-providerRelease:
					case <-ctx.Done():
						return 0, nil, ctx.Err()
					}
				}
				return 200, valid, nil
			}}, nil
		},
		Issue: func(context.Context, access.Principal, aicontract.Claim, aicontract.Binding, aicontract.Image) (any, error) {
			return map[string]any{"upload_ticket": "verified-test-ticket"}, nil
		},
		Read: func(_ context.Context, _ access.Principal, _ aicontract.Claim, _ aicontract.Binding, ticket string) ([]byte, string, error) {
			if ticket != "verified-test-ticket" {
				return nil, "", errors.New("missing test bytes")
			}
			return []byte("fixture pixels"), "image/png", nil
		},
	}
	ai.Register(router, ai.HTTPDeps{Deps: ai.Deps{Pool: apiPool, Wallet: aiWalletPort(), OCR: runtime}, Access: resolver})
	newRow := func() (listingMediaRow, string) {
		row, card := f.newRow()
		if _, err := f.pool.Exec(f.ctx, `UPDATE listing_cards SET payload=payload||jsonb_build_object('aiPromptId','recognition-test','aiPromptSha256',$2::text) WHERE id=$1::uuid`, card, promptSHA); err != nil {
			t.Fatal(err)
		}
		return row, card
	}
	claim := func(row string, operation string) (recognitionClaim, listingMediaPlan) {
		plan := listingMediaData[listingMediaPlan](t, f.post("/api/listing/rows/"+row+"/prepare", f.cookie, map[string]any{"operation": operation, "renderer_contract_version": "browser-wasm-v2"}))
		var job string
		for _, run := range plan.Jobs {
			if run.Kind == "ai.recognize" {
				job = run.ID
			}
		}
		if job == "" {
			t.Fatal("recognition not enqueued", plan)
		}
		got := listingMediaData[recognitionClaim](t, f.post("/api/listing/jobs/"+job+"/claim", f.cookie, nil))
		if got.Job.ID != job || got.Seconds != 30 || got.Job.Key == "" || got.Job.Payload.Prompt.SHA256 != promptSHA {
			t.Fatalf("claim invalid %+v", got)
		}
		return got, plan
	}
	request := func(method, path, cookie string, c recognitionClaim, key string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
		req.Header.Set("Cookie", cookie)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("X-Listing-Job-Id", c.Job.ID)
		req.Header.Set("X-Listing-Lease-Owner", c.Lease.Owner)
		req.Header.Set("X-Listing-Lease-Epoch", strconv.FormatInt(c.Lease.Epoch, 10))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	t.Run("recognition_price_admin_uses_normal_role", func(t *testing.T) {
		t.Setenv("CLOUD_INTEGRATION_CONFIG_KEY", strings.Repeat("recognition-test-key-", 3))
		var user int64
		var oldRole string
		if err := f.pool.QueryRow(f.ctx, `SELECT u.id,u.role FROM account_users u JOIN organizations o ON o.owner_user_id=u.id WHERE o.id=$1`, f.org).Scan(&user, &oldRole); err != nil {
			t.Fatal(err)
		}
		var previousAdmin int64
		if err := f.pool.QueryRow(f.ctx, `SELECT id FROM account_users WHERE role='super_admin'`).Scan(&previousAdmin); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='user' WHERE id=$1`, previousAdmin); err != nil {
			t.Fatal(err)
		}
		defer func() {
			f.pool.Exec(f.ctx, `UPDATE account_users SET role=$2 WHERE id=$1`, user, oldRole)
			f.pool.Exec(f.ctx, `UPDATE account_users SET role='super_admin' WHERE id=$1`, previousAdmin)
		}()
		if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='super_admin' WHERE id=$1`, user); err != nil {
			t.Fatal(err)
		}

		actual := app.Handler(apiPool)
		runAdminRuntimeRoleCases(t, f, apiPool, actual)
		runAdminConfigRuntimeCases(t, f, actual)
		invoke := func(method string, body string) *httptest.ResponseRecorder {
			req := httptest.NewRequest(method, "/api/admin/ai/prices", strings.NewReader(body))
			req.Header.Set("Cookie", f.cookie)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			actual.ServeHTTP(rec, req)
			return rec
		}
		saved := invoke("PUT", `{"model":"recognition-admin-priced","billing_mode":"per_request","input_microfen_per_million":0,"cached_input_microfen_per_million":0,"output_microfen_per_million":0,"reasoning_microfen_per_million":0,"per_request_microfen":1000000,"max_request_microfen":1000000}`)
		if saved.Code != 200 || !strings.Contains(saved.Body.String(), `"data":{"prices":`) || !strings.Contains(saved.Body.String(), `"model":"recognition-admin-priced"`) {
			t.Fatalf("normalrole publish price %d %s", saved.Code, saved.Body.String())
		}
		checkContract(t, "PUT", "/api/admin/ai/prices", saved)
		readback := invoke("GET", "")
		if readback.Code != 200 || readback.Body.String() != saved.Body.String() {
			t.Fatalf("normalrole price readback %d %s", readback.Code, readback.Body.String())
		}
		checkContract(t, "GET", "/api/admin/ai/prices", readback)
		if member := get(t, actual, "/api/admin/ai/prices", f.other); member.Code != 403 {
			t.Fatalf("non-admin price access %d %s", member.Code, member.Body.String())
		}
		removed := invoke("DELETE", `{"model":"recognition-admin-priced"}`)
		if removed.Code != 200 || !strings.Contains(removed.Body.String(), `"data":{"prices":`) || strings.Contains(removed.Body.String(), `"model":"recognition-admin-priced"`) {
			t.Fatalf("normalrole remove price %d %s", removed.Code, removed.Body.String())
		}
		checkContract(t, "DELETE", "/api/admin/ai/prices", removed)
	})

	t.Run("recognition_normal_role_purchase_settle_readback", func(t *testing.T) {
		row, _ := newRow()
		var unpaidPayload []byte
		if err := f.pool.QueryRow(f.ctx, `SELECT payload FROM listing_rows WHERE org_id=$1 AND id=$2::uuid`, f.org, row.ID).Scan(&unpaidPayload); err != nil {
			t.Fatal(err)
		}
		c, plan := claim(row.ID, "prepare")
		if len(plan.Jobs) != 2 {
			t.Fatalf("combined prepare %+v", plan)
		}
		prices := get(t, router, "/api/ai/prices", f.cookie)
		if prices.Code != 200 || !strings.Contains(prices.Body.String(), `"ocr_models":["recognition-test-model"]`) {
			t.Fatalf("prices %d %s", prices.Code, prices.Body.String())
		}
		checkContract(t, "GET", "/api/ai/prices", prices)
		missing := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "missing"})
		if missing.Code != 409 || calls.Load() != 0 {
			t.Fatalf("missing bytes purchased %d %s", missing.Code, missing.Body.String())
		}
		var count int
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM ai_requests WHERE org_id=$1`, f.org).Scan(&count); err != nil || count != 0 {
			t.Fatal("missing bytes created receipt", count, err)
		}
		bought := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"})
		if bought.Code != 200 {
			t.Fatalf("purchase %d %s", bought.Code, bought.Body.String())
		}
		checkContract(t, "POST", "/api/ai/ocr/completions", bought)
		data := listingMediaData[struct {
			Row struct {
				ID       string          `json:"id"`
				Revision int64           `json:"revision"`
				Payload  json.RawMessage `json:"payload"`
			} `json:"listing_row"`
			Billing struct {
				ID      string `json:"request_id"`
				Charged int64  `json:"charged_microfen"`
			} `json:"billing"`
		}](t, bought)
		if data.Row.ID != row.ID || data.Row.Revision != row.Revision+1 || data.Billing.Charged <= 0 || !strings.Contains(string(data.Row.Payload), "Белая кружка") {
			t.Fatalf("purchase did not persist row %+v body=%s", data, bought.Body.String())
		}
		type completedRow struct {
			ID         string          `json:"id"`
			Revision   int64           `json:"revision"`
			Content    string          `json:"content_state"`
			Media      string          `json:"media_state"`
			Validation string          `json:"validation_state"`
			Submission string          `json:"submission_state"`
			Payload    json.RawMessage `json:"payload"`
			Projection struct {
				AI        string `json:"ai"`
				Readiness struct {
					Ready    bool     `json:"ready_to_publish"`
					CanSend  bool     `json:"can_start_publish_attempt"`
					Blockers []string `json:"blockers"`
				} `json:"readiness"`
			} `json:"projection"`
		}
		assertRecognized := func() completedRow {
			t.Helper()
			got := listingMediaData[completedRow](t, get(t, router, "/api/listing/rows/"+row.ID, f.cookie))
			fieldsBlocked, aiPending := false, false
			for _, blocker := range got.Projection.Readiness.Blockers {
				fieldsBlocked = fieldsBlocked || blocker == "fields_invalid"
				aiPending = aiPending || blocker == "ai_pending"
			}
			if got.ID != row.ID || got.Content != "ready" || got.Projection.AI != "ready" || got.Validation != "blocked" || got.Submission != "none" || got.Projection.Readiness.Ready || got.Projection.Readiness.CanSend || !fieldsBlocked || aiPending {
				t.Fatalf("valid paid recognition must complete while missing publication fields stay blocked: %+v", got)
			}
			var copy struct {
				Draft struct {
					Values map[string]struct {
						Value string `json:"value"`
					} `json:"values"`
				} `json:"draft"`
				AI struct {
					Summary struct {
						Tags []string `json:"tags"`
					} `json:"summary"`
				} `json:"ai"`
			}
			if json.Unmarshal(got.Payload, &copy) != nil || len(copy.AI.Summary.Tags) != 6 || copy.AI.Summary.Tags[0] != "#кружка" || !strings.Contains(copy.Draft.Values["attribute:4191:0"].Value, "Фон украшен плавными линиями") || len(strings.Fields(copy.Draft.Values["attribute:23171:0"].Value)) != 6 {
				t.Fatalf("visual description and five tags did not survive row persistence: %s", got.Payload)
			}
			return got
		}
		assertNoRepurchase := func() {
			t.Helper()
			var jobs, receipts int
			var charged int64
			if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM jobs WHERE org_id=$1 AND aggregate_id=$2::uuid AND kind='ai.recognize'),count(*),COALESCE(sum(charged_microfen),0)::bigint FROM ai_requests WHERE org_id=$1 AND job_id=$3::uuid`, f.org, row.ID, c.Job.ID).Scan(&jobs, &receipts, &charged); err != nil || jobs != 1 || receipts != 1 || charged != data.Billing.Charged || calls.Load() != 1 {
				t.Fatalf("recovery repeated paid work: jobs=%d receipts=%d charged=%d calls=%d err=%v", jobs, receipts, charged, calls.Load(), err)
			}
		}
		initial := assertRecognized()
		var initialDBPayload []byte
		var initialDBRevision int64
		if err := f.pool.QueryRow(f.ctx, `SELECT payload,revision FROM listing_rows WHERE org_id=$1 AND id=$2::uuid`, f.org, row.ID).Scan(&initialDBPayload, &initialDBRevision); err != nil {
			t.Fatal(err)
		}
		var originalDBPayload any
		if json.Unmarshal(initialDBPayload, &originalDBPayload) != nil {
			t.Fatal("invalid persisted recognition payload")
		}
		// Reproduce the historical state error without altering the saved result.
		for _, recovery := range []string{"new_command", "GET", "POST", "settle"} {
			if _, err := f.pool.Exec(f.ctx, `UPDATE listing_rows SET content_state='draft' WHERE org_id=$1 AND id=$2::uuid`, f.org, row.ID); err != nil {
				t.Fatal(err)
			}
			switch recovery {
			case "new_command":
				plan := listingMediaData[listingMediaPlan](t, f.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, map[string]any{"operation": "recognize", "command_id": "recognition-repair-paid-success"}))
				if len(plan.Jobs) != 0 || plan.Outcome != "prepared" {
					t.Fatalf("new command must recover the paid success without a claim: %+v", plan)
				}
			case "GET", "POST":
				var body any
				if recovery == "POST" {
					body = map[string]any{"upload_ticket": "verified-test-ticket"}
				}
				restored := request(recovery, "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, body)
				if restored.Code != 200 || !strings.Contains(restored.Body.String(), `"listing_row":`) {
					t.Fatalf("%s paid recovery: %d %s", recovery, restored.Code, restored.Body.String())
				}
			case "settle":
				restored := f.post("/api/listing/rows/"+row.ID+"/ai/settle", f.cookie, map[string]any{"job_id": c.Job.ID, "lease": c.Lease, "request_id": data.Billing.ID})
				if restored.Code != 200 {
					t.Fatalf("explicit paid recovery: %d %s", restored.Code, restored.Body.String())
				}
			}
			restored := assertRecognized()
			var originalPayload, restoredPayload any
			if json.Unmarshal(initial.Payload, &originalPayload) != nil || json.Unmarshal(restored.Payload, &restoredPayload) != nil || restored.Revision != data.Row.Revision || !reflect.DeepEqual(originalPayload, restoredPayload) {
				t.Fatalf("%s recovery changed saved content or advanced revision", recovery)
			}
			var persisted []byte
			var revision int64
			if err := f.pool.QueryRow(f.ctx, `SELECT payload,revision FROM listing_rows WHERE org_id=$1 AND id=$2::uuid`, f.org, row.ID).Scan(&persisted, &revision); err != nil {
				t.Fatal(err)
			}
			var persistedPayload any
			if json.Unmarshal(persisted, &persistedPayload) != nil || revision != initialDBRevision || !reflect.DeepEqual(originalDBPayload, persistedPayload) {
				t.Fatalf("%s recovery rewrote the persisted result", recovery)
			}
			assertNoRepurchase()
		}
		replay := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"})
		if replay.Code != 200 || calls.Load() != 1 {
			t.Fatalf("replay purchased %d %s calls=%d", replay.Code, replay.Body.String(), calls.Load())
		}
		settled := f.post("/api/listing/rows/"+row.ID+"/ai/settle", f.cookie, map[string]any{"job_id": c.Job.ID, "lease": c.Lease, "request_id": data.Billing.ID})
		view := listingMediaData[listingMediaRow](t, settled)
		if view.Revision != data.Row.Revision {
			t.Fatal("settle replay advanced revision")
		}
		failedAfterSuccess := f.post("/api/listing/rows/"+row.ID+"/ai/fail", f.cookie, map[string]any{"job_id": c.Job.ID, "lease": c.Lease})
		if failedAfterSuccess.Code != 200 {
			t.Fatalf("success fail idempotence %d %s", failedAfterSuccess.Code, failedAfterSuccess.Body.String())
		}
		f.jobState(c.Job.ID, "succeeded")
		replayWrong := c
		replayWrong.Job.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		if rec := request("POST", "/api/ai/ocr/completions", f.cookie, replayWrong, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"}); rec.Code != 404 {
			t.Fatalf("receipt bound to another job %d %s", rec.Code, rec.Body.String())
		}

		refreshed := get(t, router, "/api/listing/rows/"+row.ID+"?include=ocrRecovery&jobId="+c.Job.ID, f.cookie)
		if refreshed.Code != 200 || !strings.Contains(refreshed.Body.String(), `"result_usable":true`) || !strings.Contains(refreshed.Body.String(), "Белая кружка") {
			t.Fatalf("readback %d %s", refreshed.Code, refreshed.Body.String())
		}
		cross := f.post("/api/listing/rows/"+row.ID+"/ai/settle", f.other, map[string]any{"job_id": c.Job.ID, "lease": c.Lease, "request_id": data.Billing.ID})
		if cross.Code != 404 {
			t.Fatalf("cross organization settle %d %s", cross.Code, cross.Body.String())
		}
		wrong := c.Lease
		wrong.Epoch++
		stale := f.post("/api/listing/rows/"+row.ID+"/ai/settle", f.cookie, map[string]any{"job_id": c.Job.ID, "lease": wrong, "request_id": data.Billing.ID})
		if stale.Code != 409 {
			t.Fatalf("stale epoch %d %s", stale.Code, stale.Body.String())
		}

		// A new combined command only continues media for this already-paid input.
		combined := listingMediaData[listingMediaPlan](t, f.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, map[string]any{"operation": "prepare", "renderer_contract_version": "browser-wasm-v2", "command_id": "recognition-finish-media-after-paid-success"}))
		if len(combined.Jobs) != 1 || combined.Jobs[0].Kind != "media.render" {
			t.Fatalf("combined command repeated recognition instead of continuing media: %+v", combined)
		}
		assertNoRepurchase()
		rendered := listingMediaData[struct {
			Applied bool            `json:"applied"`
			Row     listingMediaRow `json:"row"`
		}](t, f.post("/api/listing/rows/"+row.ID+"/media", f.cookie, listingRenderBody(listingMediaRow{ID: row.ID, Revision: data.Row.Revision}, combined.Jobs[0], 1)))
		if !rendered.Applied || rendered.Row.MediaState != "rendered" {
			t.Fatalf("render after recognition: %+v", rendered)
		}
		upload := f.plan(row.ID, "upload", "recognition-upload-after-paid-success")
		key := f.lease(rendered.Row, 0, "verified")
		confirmed := listingMediaData[listingMediaReceipt](t, f.confirm(row.ID, upload.ID, 0, key, "test"))
		if !confirmed.Applied || confirmed.MediaState != "ready" {
			t.Fatalf("upload after recognition: %+v", confirmed)
		}
		if completed := assertRecognized(); completed.Media != "ready" {
			t.Fatalf("media completion demoted the recognized row: %+v", completed)
		}
		assertNoRepurchase()

		// An older parser rejected the paid result before writing any copy to the row.
		if _, err := f.pool.Exec(f.ctx, `UPDATE listing_rows SET payload=$3::jsonb,content_state='failed' WHERE org_id=$1 AND id=$2::uuid`, f.org, row.ID, string(unpaidPayload)); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(f.ctx, `UPDATE jobs SET state='failed',last_error_code='ocr_contract_violation',lease_owner=NULL,lease_until=NULL WHERE org_id=$1 AND id=$2::uuid`, f.org, c.Job.ID); err != nil {
			t.Fatal(err)
		}
		if stale := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"}); stale.Code != 409 {
			t.Fatalf("a failed job must not reopen its expired purchase lease: %d %s", stale.Code, stale.Body.String())
		}
		// A still-active attempt must not race a historical paid writeback.
		var mediaJob, mediaState string
		if err := f.pool.QueryRow(f.ctx, `SELECT id::text,state FROM jobs WHERE org_id=$1 AND aggregate_id=$2::uuid AND kind='media.render' LIMIT 1`, f.org, row.ID).Scan(&mediaJob, &mediaState); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(f.ctx, `UPDATE jobs SET kind='ai.recognize',state='queued' WHERE id=$1::uuid`, mediaJob); err != nil {
			t.Fatal(err)
		}
		blocked := f.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, map[string]any{"operation": "recognize"})
		if _, err := f.pool.Exec(f.ctx, `UPDATE jobs SET kind='media.render',state=$2 WHERE id=$1::uuid`, mediaJob, mediaState); err != nil {
			t.Fatal(err)
		}
		if blocked.Code != 409 || !strings.Contains(blocked.Body.String(), "ocr_recovery_required") {
			t.Fatalf("paid recovery overtook an active attempt: %d %s", blocked.Code, blocked.Body.String())
		}
		for i := 0; i < 2; i++ {
			plan := listingMediaData[listingMediaPlan](t, f.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, map[string]any{"operation": "recognize"}))
			if len(plan.Jobs) != 0 || plan.Outcome != "prepared" {
				t.Fatalf("paid failed receipt must recover without another purchase: %+v", plan)
			}
			assertRecognized()
			f.jobState(c.Job.ID, "succeeded")
			assertNoRepurchase()
		}
	})
	t.Run("recognition_preflight_failure_preserves_safe_reason_without_purchase", func(t *testing.T) {
		for code, message := range map[string]string{
			"workflow_source_missing":               "本机没有该源图，请重新导入后再识别",
			"workflow_recognition_contract_changed": "识图处理版本已变化，请刷新后重新准备",
			"untrusted private details":             "识图步骤未完成，请检查原图、商品事实和模型配置后重试",
		} {
			t.Run(code, func(t *testing.T) {
				row, _ := newRow()
				c, _ := claim(row.ID, "recognize")
				before := calls.Load()
				failed := f.post("/api/listing/rows/"+row.ID+"/ai/fail", f.cookie, map[string]any{"job_id": c.Job.ID, "lease": c.Lease, "error_code": code})
				if failed.Code != 200 || !strings.Contains(failed.Body.String(), message) || strings.Contains(failed.Body.String(), "untrusted private details") || calls.Load() != before {
					t.Fatalf("preflight failure lost its safe reason or purchased: %d %s", failed.Code, failed.Body.String())
				}
				f.jobState(c.Job.ID, "failed")
				var receipts int
				if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM ai_requests WHERE job_id=$1::uuid`, c.Job.ID).Scan(&receipts); err != nil || receipts != 0 {
					t.Fatal("preflight created a paid receipt", receipts, err)
				}
			})
		}
	})
	t.Run("user_model_routing_cannot_create_a_job_or_purchase", func(t *testing.T) {
		row, _ := newRow()
		before := calls.Load()
		for _, operation := range []string{"recognize", "prepare"} {
			for _, routing := range []any{map[string]any{"primary_model": "recognition-test-model"}, map[string]any{"primary_model": "recognition-test-model", "backup_model": "another"}, nil} {
				rec := f.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, map[string]any{"operation": operation, "renderer_contract_version": "browser-wasm-v2", "model_routing": routing})
				if rec.Code != 400 || calls.Load() != before {
					t.Fatalf("user routing accepted: %d %s", rec.Code, rec.Body.String())
				}
			}
		}
		var jobs int
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM jobs WHERE aggregate_id=$1::uuid`, row.ID).Scan(&jobs); err != nil || jobs != 0 {
			t.Fatal("rejected routing created work", jobs, err)
		}
	})
	t.Run("recognition_pins_system_default_and_replays_original_model", func(t *testing.T) {
		for _, operation := range []string{"recognize", "prepare"} {
			preferred := "recognition-test-model"
			configured := host
			configured.RecognitionModels = func(context.Context) ([]string, string, error) {
				return []string{"other-model", "recognition-test-model"}, preferred, nil
			}
			api := chi.NewRouter()
			api.Use(identity.CSRF, identity.New(apiPool).Middleware)
			readhttp.Mount(api, configured)
			fixture := f
			fixture.t, fixture.handler = t, api
			row, _ := newRow()
			body := map[string]any{"operation": operation, "renderer_contract_version": "browser-wasm-v2", "command_id": "system-default-" + operation}
			first := listingMediaData[listingMediaPlan](t, fixture.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, body))
			var model string
			if err := f.pool.QueryRow(f.ctx, `SELECT payload #>> '{model_routing,primary_model}' FROM jobs WHERE aggregate_id=$1::uuid AND kind='ai.recognize'`, row.ID).Scan(&model); err != nil || model != preferred {
				t.Fatalf("system default not persisted: model=%q err=%v", model, err)
			}
			preferred = "other-model"
			again := listingMediaData[listingMediaPlan](t, fixture.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, body))
			if len(first.Jobs) == 0 || !reflect.DeepEqual(first.Jobs, again.Jobs) {
				t.Fatalf("default change replaced original jobs: %+v %+v", first, again)
			}
			next, _ := newRow()
			delete(body, "command_id")
			listingMediaData[listingMediaPlan](t, fixture.post("/api/listing/rows/"+next.ID+"/prepare", f.cookie, body))
			if err := f.pool.QueryRow(f.ctx, `SELECT payload #>> '{model_routing,primary_model}' FROM jobs WHERE aggregate_id=$1::uuid AND kind='ai.recognize'`, next.ID).Scan(&model); err != nil || model != preferred {
				t.Fatalf("new job missed current default: model=%q err=%v", model, err)
			}
		}
	})
	t.Run("recognition_invalid_theme_is_permanent_and_cannot_repurchase", func(t *testing.T) {
		mode.Store(3)
		defer mode.Store(0)
		row, _ := newRow()
		c, _ := claim(row.ID, "recognize")
		before := calls.Load()
		first := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"})
		if first.Code != 422 || !strings.Contains(first.Body.String(), "OCR_CONTRACT_VIOLATION") {
			t.Fatalf("fixed tag violation %d %s", first.Code, first.Body.String())
		}
		rec := get(t, router, "/api/listing/rows/"+row.ID+"?include=ocrRecovery&jobId="+c.Job.ID, f.cookie)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"result_usable":false`) {
			t.Fatalf("unusable recovery %d %s", rec.Code, rec.Body.String())
		}
		lookup := request("GET", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, nil)
		if lookup.Code != 422 {
			t.Fatalf("invalid receipt lookup %d %s", lookup.Code, lookup.Body.String())
		}
		mode.Store(0)
		retry := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key+":retry", map[string]any{"upload_ticket": "verified-test-ticket"})
		if retry.Code != 409 || calls.Load() != before+1 {
			t.Fatalf("unexpected contract repurchase %d %s", retry.Code, retry.Body.String())
		}
		third := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key+":retry:retry", map[string]any{"upload_ticket": "verified-test-ticket"})
		if third.Code != 409 || calls.Load() != before+1 {
			t.Fatal("unbounded paid retry", third.Code, third.Body.String())
		}
	})
	t.Run("recognition_command_replay_fences_template_and_operation", func(t *testing.T) {
		row, card := newRow()
		body := map[string]any{"operation": "prepare", "renderer_contract_version": "browser-wasm-v2", "command_id": "recognition-combo-command"}
		first := listingMediaData[listingMediaPlan](t, f.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, body))
		again := listingMediaData[listingMediaPlan](t, f.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, body))
		if len(first.Jobs) != 2 || len(again.Jobs) != 2 || first.Jobs[0].ID != again.Jobs[0].ID || first.Jobs[1].ID != again.Jobs[1].ID {
			t.Fatalf("command did not replay %+v %+v", first, again)
		}
		if _, err := f.pool.Exec(f.ctx, `UPDATE listing_cards SET payload=payload||jsonb_build_object('psdTemplateAssetId',$2::text,'psdTemplateSha256',$2::text) WHERE id=$1::uuid`, card, strings.Repeat("2", 64)); err != nil {
			t.Fatal(err)
		}
		changed := f.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, body)
		if changed.Code != 409 {
			t.Fatalf("template changed command %d %s", changed.Code, changed.Body.String())
		}
		body["operation"] = "recognize"
		changed = f.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, body)
		if changed.Code != 409 {
			t.Fatalf("operation changed command %d %s", changed.Code, changed.Body.String())
		}
	})
	t.Run("recognition_uncertain_rail_does_not_block_media", func(t *testing.T) {
		mode.Store(1)
		defer mode.Store(0)
		row, card := newRow()
		c, _ := claim(row.ID, "recognize")
		unknown := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"})
		if unknown.Code != 504 {
			t.Fatal(unknown.Code, unknown.Body.String())
		}
		nextPrompt := strings.ReplaceAll(prompt, "330 мл", "500 мл")
		digest := sha256.Sum256([]byte(nextPrompt))
		nextSHA := hex.EncodeToString(digest[:])
		if _, err := f.pool.Exec(f.ctx, `INSERT INTO category_prompts(prompt_id,description_category_id,type_id,name,file_name,content,created_at_ms,updated_at_ms,created_by_account_uuid,fixed_tags) VALUES('recognition-test-next',17027906,91976,'Next','next.txt',$1,1,1,'test','["#кружка"]')`, nextPrompt); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(f.ctx, `UPDATE listing_cards SET payload=payload||jsonb_build_object('aiPromptId','recognition-test-next','aiPromptSha256',$2::text) WHERE id=$1::uuid`, card, nextSHA); err != nil {
			t.Fatal(err)
		}
		planned := f.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, map[string]any{"operation": "prepare", "renderer_contract_version": "browser-wasm-v2"})
		plan := listingMediaData[listingMediaPlan](t, planned)
		if len(plan.Jobs) != 1 || plan.Jobs[0].Kind != "media.render" || !strings.Contains(planned.Body.String(), `"issues":[{"blockers":["ocr_recovery_required"]`) {
			t.Fatalf("AI blocked media %s", planned.Body.String())
		}
	})

	t.Run("recognition_revoked_session_fences_purchase", func(t *testing.T) {
		row, _ := newRow()
		c, _ := claim(row.ID, "recognize")
		before := calls.Load()
		var actor int64
		if err := f.pool.QueryRow(f.ctx, `SELECT owner_user_id FROM organizations WHERE id=$1`, f.org).Scan(&actor); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(f.ctx, `UPDATE account_sessions SET expires_at=clock_timestamp()-interval '1 minute' WHERE user_id=$1`, actor); err != nil {
			t.Fatal(err)
		}
		defer f.pool.Exec(f.ctx, `UPDATE account_sessions SET expires_at=clock_timestamp()+interval '1 day' WHERE user_id=$1`, actor)
		bought := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"})
		if (bought.Code != 401 && bought.Code != 403) || calls.Load() != before {
			t.Fatalf("revoked session bought recognition %d %s", bought.Code, bought.Body.String())
		}
	})

	t.Run("recognition_unknown_is_not_rebought", func(t *testing.T) {
		mode.Store(1)
		defer mode.Store(0)
		row, _ := newRow()
		c, _ := claim(row.ID, "recognize")
		before := calls.Load()
		first := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"})
		if first.Code != 504 {
			t.Fatalf("unknown %d %s", first.Code, first.Body.String())
		}
		again := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"})
		if again.Code != 409 || calls.Load() != before+1 {
			t.Fatalf("unknown repurchased %d %s", again.Code, again.Body.String())
		}
		recovery := get(t, router, "/api/listing/rows/"+row.ID+"?include=ocrRecovery&jobId="+c.Job.ID, f.cookie)
		if !strings.Contains(recovery.Body.String(), `"status":"unbilled_unknown"`) {
			t.Fatal(recovery.Body.String())
		}
		failed := f.post("/api/listing/rows/"+row.ID+"/ai/fail", f.cookie, map[string]any{"job_id": c.Job.ID, "lease": c.Lease})
		if failed.Code != 409 {
			t.Fatalf("unknown overwritten %d %s", failed.Code, failed.Body.String())
		}
	})
	t.Run("recognition_cancel_fences_new_purchase", func(t *testing.T) {
		row, _ := newRow()
		c, _ := claim(row.ID, "recognize")
		before := calls.Load()
		cancel := f.post("/api/listing/rows/"+row.ID+"/prepare/cancel", f.cookie, nil)
		if cancel.Code != 200 {
			t.Fatalf("cancel %d %s", cancel.Code, cancel.Body.String())
		}
		bought := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"})
		if bought.Code != 409 || calls.Load() != before {
			t.Fatalf("cancel purchased %d %s", bought.Code, bought.Body.String())
		}
	})
	t.Run("recognition_cancel_during_paid_call_keeps_writeback", func(t *testing.T) {
		mode.Store(4)
		defer mode.Store(0)
		row, _ := newRow()
		c, _ := claim(row.ID, "recognize")
		before := calls.Load()
		result := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			result <- request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"})
		}()
		select {
		case <-providerStarted:
		case <-time.After(5 * time.Second):
			t.Fatal("paid provider request did not start")
		}
		cancelled := f.post("/api/listing/rows/"+row.ID+"/prepare/cancel", f.cookie, nil)
		close(providerRelease)
		if cancelled.Code != 200 {
			t.Fatalf("cancel during payment %d %s", cancelled.Code, cancelled.Body.String())
		}
		select {
		case bought := <-result:
			if bought.Code != 200 || calls.Load() != before+1 || !strings.Contains(bought.Body.String(), `"listing_row":`) {
				t.Fatalf("accepted payment writeback lost %d %s", bought.Code, bought.Body.String())
			}
		case <-time.After(5 * time.Second):
			t.Fatal("paid provider result did not settle")
		}
		var status, state string
		if err := f.pool.QueryRow(f.ctx, `SELECT r.status,j.state FROM ai_requests r JOIN jobs j ON j.id=r.job_id WHERE r.org_id=$1 AND r.job_id=$2::uuid`, f.org, c.Job.ID).Scan(&status, &state); err != nil || status != "settled" || state != "succeeded" {
			t.Fatal("accepted payment lost", status, state, err)
		}
	})
	t.Run("supplier_current_profile_reaches_paid_ocr", func(t *testing.T) {
		mode.Store(5)
		defer mode.Store(0)
		row, card := newRow()
		compiled := strings.ReplaceAll(prompt, "330 мл", "500 мл")
		sum := sha256.Sum256([]byte(compiled))
		digest := hex.EncodeToString(sum[:])
		if _, err := f.pool.Exec(f.ctx, `INSERT INTO sc_sources(source_id,name,listed,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES('recognition-source','Recognition',true,1,1,'test'); INSERT INTO sc_products(product_id,source_id,title,published,description_category_id,type_id,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES('recognition-supplier','recognition-source','Cup',true,17027906,91976,1,1,'test'); INSERT INTO sc_skus(sku_id,product_id,platform_code,title,published,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES('recognition-sku','recognition-supplier','recognition-platform-code','Cup',true,1,1,'test'); INSERT INTO ozon_category_current(description_category_id,type_id,language,fields,content_digest,fetched_at_ms) VALUES(17027906,91976,'default','[]','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',(extract(epoch FROM clock_timestamp())*1000)::bigint) ON CONFLICT DO NOTHING;`); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(f.ctx, `INSERT INTO supplier_ozon_configs(product_id,description_category_id,type_id,language,prompt_text,fixed_tags,state,validated_catalog_digest,created_at_ms,updated_at_ms,created_by_account_uuid,updated_by_account_uuid) SELECT 'recognition-supplier',description_category_id,type_id,language,$1,'["#кружка"]','valid',content_digest,1,1,'test','test' FROM ozon_category_current WHERE description_category_id=17027906 AND type_id=91976 AND language='default'`, compiled); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(f.ctx, `UPDATE listing_cards SET payload=(payload-'aiPromptId'-'aiPromptSha256')||'{"supplierProductId":"recognition-supplier"}'::jsonb WHERE id=$1::uuid`, card); err != nil {
			t.Fatal(err)
		}
		plan := listingMediaData[listingMediaPlan](t, f.post("/api/listing/rows/"+row.ID+"/prepare", f.cookie, map[string]any{"operation": "recognize"}))
		var job string
		for _, j := range plan.Jobs {
			if j.Kind == "ai.recognize" {
				job = j.ID
			}
		}
		if job == "" {
			t.Fatalf("supplier prompt did not enqueue: %+v", plan)
		}
		claim := listingMediaData[recognitionClaim](t, f.post("/api/listing/jobs/"+job+"/claim", f.cookie, nil))
		if claim.Job.Payload.Prompt.Content != compiled || claim.Job.Payload.Prompt.SHA256 != digest || claim.Job.Payload.Prompt.ID != "supplier:recognition-supplier" {
			t.Fatalf("wrong published snapshot: %+v", claim.Job.Payload.Prompt)
		}
		before := calls.Load()
		paid := request("POST", "/api/ai/ocr/completions", f.cookie, claim, claim.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"})
		if paid.Code != 200 || calls.Load() != before+1 {
			t.Fatalf("supplier OCR %d %s", paid.Code, paid.Body.String())
		}
	})
	t.Run("recognition_filters_fixed_and_theme_tags_before_persistence", func(t *testing.T) {
		if _, err := f.pool.Exec(f.ctx, `INSERT INTO banned_tags(term,match_mode,note,created_by) VALUES('кружка','stem','','test')`); err != nil {
			t.Fatal(err)
		}
		defer f.pool.Exec(f.ctx, `DELETE FROM banned_tags WHERE term='кружка'`)
		row, _ := newRow()
		c, _ := claim(row.ID, "recognize")
		before := calls.Load()
		bought := request("POST", "/api/ai/ocr/completions", f.cookie, c, c.Job.Key, map[string]any{"upload_ticket": "verified-test-ticket"})
		if bought.Code != 200 || calls.Load() != before+1 {
			t.Fatalf("filtered recognition %d %s", bought.Code, bought.Body.String())
		}
		var raw []byte
		var content string
		if err := f.pool.QueryRow(f.ctx, `SELECT payload#>'{ai,summary,tags}',content_state FROM listing_rows WHERE org_id=$1 AND id=$2::uuid`, f.org, row.ID).Scan(&raw, &content); err != nil {
			t.Fatal(err)
		}
		var tags []string
		if err := json.Unmarshal(raw, &tags); err != nil || len(tags) != 0 || content != "ready" {
			t.Fatalf("restricted fixed or theme tag persisted: %s content=%s err=%v", raw, content, err)
		}
	})
	runSupplierOcrTestCases(t, f, runtime, &calls, &mode, resolver)

}
