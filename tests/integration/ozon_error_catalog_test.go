package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/ozonerr/domain"
	ozonerrrepo "github.com/xxww0098/podhub-go/internal/ozonerr/repo"
	ozonerrsvc "github.com/xxww0098/podhub-go/internal/ozonerr/service"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestOzonErrorCatalog(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	userA, orgA := insertWorkspace(t, ctx, pool, "e2-a-"+uuid.NewString()+"@example.com", "E2 A")
	userB, orgB := insertWorkspace(t, ctx, pool, "e2-b-"+uuid.NewString()+"@example.com", "E2 B")
	if _, err := pool.Exec(ctx, `UPDATE public.account_users SET role = 'super_admin' WHERE id = $1`, userA); err != nil {
		t.Fatal(err)
	}
	run := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	if _, err := pool.Exec(ctx, `DELETE FROM public.ozon_error_catalog WHERE source <> 'docs_seed'`); err != nil {
		t.Fatal(err)
	}
	svc := ozonerrsvc.New(ozonerrrepo.New(pool))
	repo := ozonerrrepo.New(pool)
	t.Cleanup(func() {
		cctx := context.Background()
		_, _ = pool.Exec(cctx, `DELETE FROM public.ozon_error_catalog WHERE source <> 'docs_seed'`)
		_, _ = pool.Exec(cctx, `DELETE FROM public.organizations WHERE id IN ($1, $2)`, orgA, orgB)
		_, _ = pool.Exec(cctx, `DELETE FROM public.account_credentials WHERE user_id IN ($1, $2)`, userA, userB)
		_, _ = pool.Exec(cctx, `DELETE FROM public.account_profiles WHERE user_id IN ($1, $2)`, userA, userB)
		_, _ = pool.Exec(cctx, `DELETE FROM public.account_users WHERE id IN ($1, $2)`, userA, userB)
	})

	t.Run("docs seed is present and has no tenant columns", func(t *testing.T) {
		var n int
		var density string
		var occurrences int64
		if err := pool.QueryRow(ctx, `
			SELECT count(*),
			       coalesce(max(sample_description) FILTER (WHERE code = 'Incorrect_density'), ''),
			       coalesce(max(occurrences), -1)
			  FROM public.ozon_error_catalog
			 WHERE source = 'docs_seed'`).Scan(&n, &density, &occurrences); err != nil {
			t.Fatal(err)
		}
		if n != len(domain.DocsSeed) || density != domain.DensitySample || occurrences != 0 {
			t.Fatalf("seed n=%d density=%q occ=%d", n, density, occurrences)
		}
		var cols int
		if err := pool.QueryRow(ctx, `
			SELECT count(*)
			  FROM information_schema.columns
			 WHERE table_schema = 'public'
			   AND table_name = 'ozon_error_catalog'
			   AND column_name IN ('org_id', 'offer_id', 'api_key')`).Scan(&cols); err != nil || cols != 0 {
			t.Fatalf("catalog columns %d %v", cols, err)
		}
	})

	t.Run("live row does not overwrite the seed", func(t *testing.T) {
		code := "SPU_already_exists"
		n, err := svc.RecordRows(ctx, orgA, []domain.Row{{
			Source: domain.SourceImportInfo, Code: code, TaskKey: "seed-" + run, OfferKey: "o",
			Sample: "live",
		}})
		if err != nil || n != 1 {
			t.Fatalf("record %d %v", n, err)
		}
		var seedOcc int64
		var seedSample, liveSample string
		var liveOcc int64
		if err := pool.QueryRow(ctx, `
			SELECT occurrences, sample_description
			  FROM public.ozon_error_catalog
			 WHERE source = 'docs_seed' AND code = $1`, code).Scan(&seedOcc, &seedSample); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `
			SELECT occurrences, sample_description
			  FROM public.ozon_error_catalog
			 WHERE source = 'ozon_import_info' AND code = $1`, code).Scan(&liveOcc, &liveSample); err != nil {
			t.Fatal(err)
		}
		if seedOcc != 0 || seedSample != "" || liveOcc != 1 || liveSample != "live" {
			t.Fatalf("seed %d %q live %d %q", seedOcc, seedSample, liveOcc, liveSample)
		}
	})

	t.Run("repeat task and offer does not double count", func(t *testing.T) {
		code := "E2" + run + "ID"
		row := domain.Row{Source: domain.SourceImportInfo, Code: code, TaskKey: "task-1", OfferKey: "offer-a", DescriptionCategoryID: 11}
		n, err := svc.RecordRows(ctx, orgA, []domain.Row{row})
		if err != nil || n != 1 {
			t.Fatal(n, err)
		}
		n, err = svc.RecordRows(ctx, orgA, []domain.Row{row})
		if err != nil || n != 0 {
			t.Fatal(n, err)
		}
		if got := catalogCount(t, ctx, pool, domain.SourceImportInfo, code); got != 1 {
			t.Fatal(got)
		}
		row.OfferKey = "offer-b"
		if n, err = svc.RecordRows(ctx, orgA, []domain.Row{row}); err != nil || n != 1 {
			t.Fatal(n, err)
		}
		row.OfferKey = "offer-a"
		row.TaskKey = "task-2"
		if n, err = svc.RecordRows(ctx, orgA, []domain.Row{row}); err != nil || n != 1 {
			t.Fatal(n, err)
		}
		if got := catalogCount(t, ctx, pool, domain.SourceImportInfo, code); got != 3 {
			t.Fatal(got)
		}
	})

	t.Run("concurrent upserts", func(t *testing.T) {
		before := deadlocks(t, ctx, pool)
		diffCode := "E2" + run + "DF"
		var wg sync.WaitGroup
		errCh := make(chan error, 32)
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				_, err := svc.RecordRows(ctx, orgA, []domain.Row{{
					Source: domain.SourceImportInfo, Code: diffCode,
					TaskKey: fmt.Sprintf("diff-%d", i), OfferKey: "same",
				}})
				if err != nil {
					errCh <- err
				}
			}(i)
		}
		sameCode := "E2" + run + "SM"
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := svc.RecordRows(ctx, orgA, []domain.Row{{
					Source: domain.SourceImportInfo, Code: sameCode, TaskKey: "one", OfferKey: "one",
				}})
				if err != nil {
					errCh <- err
				}
			}()
		}
		perms := [][]int{{0, 1, 2, 3}, {3, 2, 1, 0}, {1, 3, 0, 2}, {2, 0, 3, 1}, {0, 2, 1, 3}, {3, 1, 2, 0}}
		for g, perm := range perms {
			wg.Add(1)
			go func(g int, perm []int) {
				defer wg.Done()
				rows := make([]domain.Row, len(perm))
				for i, p := range perm {
					rows[i] = domain.Row{
						Source: domain.SourceImportInfo, Code: fmt.Sprintf("E2%sB%d", run, p),
						TaskKey: fmt.Sprintf("batch-%d", g), OfferKey: "batch",
					}
				}
				_, err := svc.RecordRows(ctx, orgA, rows)
				if err != nil {
					errCh <- err
				}
			}(g, perm)
		}
		wg.Wait()
		close(errCh)
		for err := range errCh {
			var pg *pgconn.PgError
			if errors.As(err, &pg) && pg.Code == "40P01" {
				t.Fatalf("40P01 %v", err)
			}
			t.Fatal(err)
		}
		if got := catalogCount(t, ctx, pool, domain.SourceImportInfo, diffCode); got != 8 {
			t.Fatalf("diff %d", got)
		}
		if got := catalogCount(t, ctx, pool, domain.SourceImportInfo, sameCode); got != 1 {
			t.Fatalf("same %d", got)
		}
		for i := 0; i < 4; i++ {
			if got := catalogCount(t, ctx, pool, domain.SourceImportInfo, fmt.Sprintf("E2%sB%d", run, i)); got != int64(len(perms)) {
				t.Fatalf("batch %d count %d", i, got)
			}
		}
		if after := deadlocks(t, ctx, pool); after != before {
			t.Fatalf("deadlocks %d -> %d", before, after)
		}
	})

	t.Run("pagination and filters", func(t *testing.T) {
		cat := int64(32017001)
		for i, n := range []int{3, 2, 1} {
			code := fmt.Sprintf("E2%sP%d", run, i)
			for k := 0; k < n; k++ {
				got, err := svc.RecordRows(ctx, orgA, []domain.Row{{
					Source: domain.SourceImportInfo, Code: code, DescriptionCategoryID: cat,
					TaskKey: fmt.Sprintf("page-%d-%d", i, k), OfferKey: "p",
				}})
				if err != nil || got != 1 {
					t.Fatal(got, err)
				}
			}
		}
		body, err := svc.List(ctx, userA, fmt.Sprintf("descriptionCategoryId=%d&limit=2", cat))
		page := listPage(t, body, err)
		if len(page.Items) != 2 || page.Items[0].Occurrences != 3 || page.Items[1].Occurrences != 2 || page.Next == "" {
			t.Fatalf("%+v", page)
		}
		body, err = svc.List(ctx, userA, fmt.Sprintf("descriptionCategoryId=%d&limit=2&cursor=%s", cat, page.Next))
		next := listPage(t, body, err)
		if len(next.Items) != 1 || next.Items[0].Occurrences != 1 || next.Next != "" {
			t.Fatalf("%+v", next)
		}
		body, err = svc.List(ctx, userA, "code="+fmt.Sprintf("E2%sP0", run))
		one := listPage(t, body, err)
		if len(one.Items) != 1 || one.Items[0].Code != fmt.Sprintf("E2%sP0", run) {
			t.Fatalf("%+v", one)
		}
		body, err = svc.ListOrg(ctx, orgA, "code="+fmt.Sprintf("E2%sP1", run))
		orgPage := listPage(t, body, err)
		if len(orgPage.Items) != 1 || orgPage.Items[0].Occurrences != 2 {
			t.Fatalf("%+v", orgPage)
		}
	})

	t.Run("tenant isolation", func(t *testing.T) {
		code := "E2" + run + "RL"
		if _, err := svc.RecordRows(ctx, orgA, []domain.Row{{
			Source: domain.SourceImportInfo, Code: code, TaskKey: "a", OfferKey: "a",
		}}); err != nil {
			t.Fatal(err)
		}
		txB, err := tenant.BeginApp(ctx, pool.Begin, orgB)
		if err != nil {
			t.Fatal(err)
		}
		var seen int
		if err := txB.QueryRow(ctx, `SELECT count(*) FROM public.ozon_error_observation WHERE code = $1`, code).Scan(&seen); err != nil || seen != 0 {
			t.Fatalf("org B sees %d %v", seen, err)
		}
		_, err = txB.Exec(ctx, `
			INSERT INTO public.ozon_error_observation (
				org_id, source, code, attribute_id, description_category_id, type_id, occurrences)
			VALUES ($1, 'ozon_import_info', $2, 0, 0, 0, 1)`, orgA, code)
		if err == nil {
			t.Fatal("org B inserted org A")
		}
		_ = txB.Rollback(ctx)

		bare, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := bare.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
			t.Fatal(err)
		}
		if err := bare.QueryRow(ctx, `SELECT count(*) FROM public.ozon_error_observation`).Scan(&seen); err != nil || seen != 0 {
			t.Fatalf("missing GUC sees %d %v", seen, err)
		}
		_, err = bare.Exec(ctx, `
			INSERT INTO public.ozon_error_observation (
				org_id, source, code, attribute_id, description_category_id, type_id, occurrences)
			VALUES ($1, 'ozon_import_info', 'E2missing', 0, 0, 0, 1)`, orgA)
		if err == nil {
			t.Fatal("missing GUC inserted")
		}
		_ = bare.Rollback(ctx)
		denied, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := denied.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
			t.Fatal(err)
		}
		_, err = denied.Exec(ctx, `
			INSERT INTO public.ozon_error_catalog (
				source, code, attribute_id, description_category_id, type_id, occurrences)
			VALUES ('ozon_import_info', 'E2app', 0, 0, 0, 1)`)
		if err == nil || !strings.Contains(err.Error(), "permission denied") {
			t.Fatalf("app insert catalog: %v", err)
		}
		_ = denied.Rollback(ctx)

		worker, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := worker.Exec(ctx, `SELECT set_config('role', 'podhub_worker', true)`); err != nil {
			t.Fatal(err)
		}
		err = worker.QueryRow(ctx, `SELECT count(*) FROM public.ozon_error_catalog`).Scan(&seen)
		if err == nil || !strings.Contains(err.Error(), "permission denied") {
			t.Fatalf("worker select: %v", err)
		}
		_ = worker.Rollback(ctx)

		other, err := svc.List(ctx, userB, "code="+code)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(other), code) {
			t.Fatalf("non-super %s", other)
		}
		admin, err := svc.List(ctx, userA, "code="+code)
		if err != nil || !strings.Contains(string(admin), code) {
			t.Fatalf("super %s %v", admin, err)
		}
		seeds, err := svc.List(ctx, userA, "code=Incorrect_density")
		if err != nil || !strings.Contains(string(seeds), domain.DensitySample) {
			t.Fatalf("seed list %s %v", seeds, err)
		}
	})

	t.Run("browser report and import-info leave listing state", func(t *testing.T) {
		kek := seal.DeriveKEK("browser-direct-fixture-kek")
		ring := seal.Ring{Primary: kek}
		shop := newOzonShop(t, ctx, pool, orgA, userA, ring, false, svc)
		row := shop.row(t, ctx)
		grant := parseGrant(t, shop.post(t, http.MethodPost, "/api/listing/browser/grant", shop.body("offer-e2", "op-e2", row)))
		if state := intentState(t, ctx, pool, grant.IntentID); state != "submitting" {
			t.Fatal(state)
		}
		beforeJobs := countJobs(t, ctx, pool, orgA)
		okReport := shop.post(t, http.MethodPost, "/api/listing/browser/report", `{"intentId":"`+grant.IntentID+`","taskId":9,"offerId":"client-offer"}`)
		if okReport.Code != http.StatusOK || !strings.Contains(okReport.Body.String(), `"state":"accepted"`) {
			t.Fatalf("report %d %s", okReport.Code, okReport.Body.String())
		}
		var intent, task, listing string
		if err := pool.QueryRow(ctx, `
			SELECT i.state, i.external_task_id, r.submission_state
			  FROM public.submission_intents i
			  JOIN public.listing_rows r ON r.id = i.listing_row_id
			 WHERE i.id = $1::uuid`, grant.IntentID).Scan(&intent, &task, &listing); err != nil {
			t.Fatal(err)
		}
		if intent != "accepted" || task != "9" || listing != "accepted" {
			t.Fatalf("%s %s %s", intent, task, listing)
		}
		var requests int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM public.ozon_error_sighting
			 WHERE org_id = $1 AND task_key = $2`, orgA, "intent:"+grant.IntentID).Scan(&requests); err != nil || requests != 0 {
			t.Fatalf("2xx recorded %d %v", requests, err)
		}
		if countJobs(t, ctx, pool, orgA) != beforeJobs || countUpstream(t, ctx, pool, orgA, grant.IntentID) != 0 {
			t.Fatal("report changed jobs or upstream writes")
		}

		rejected := newOzonShop(t, ctx, pool, orgA, userA, ring, false, svc)
		first := parseGrant(t, rejected.post(t, http.MethodPost, "/api/listing/browser/grant", rejected.body("offer-e2-4", "op-e2-4", rejected.row(t, ctx))))
		body := `{"intentId":"` + first.IntentID + `","httpStatus":400,"offerId":"not-the-offer","gateway":{"code":3,"message":"denied ` + fixtureAPIKey + `","details":[{"apiKey":"` + fixtureAPIKey + `"}]}}`
		rec := rejected.post(t, http.MethodPost, "/api/listing/browser/report", body)
		if rec.Code != http.StatusOK || strings.Count(rec.Body.String(), fixtureAPIKey) != 0 {
			t.Fatalf("4xx %d %s", rec.Code, rec.Body.String())
		}
		var code string
		var rowState string
		if err := pool.QueryRow(ctx, `
			SELECT i.state, COALESCE(i.last_error_code, ''), r.submission_state
			  FROM public.submission_intents i
			  JOIN public.listing_rows r ON r.id = i.listing_row_id
			 WHERE i.id = $1::uuid`, first.IntentID).Scan(&intent, &code, &rowState); err != nil {
			t.Fatal(err)
		}
		if intent != "rejected" || code != "OZON_ROW_REJECTED" || rowState != "rejected" {
			t.Fatalf("%s %s %s", intent, code, rowState)
		}
		var sample, offer string
		if err := pool.QueryRow(ctx, `
			SELECT c.sample_description, s.offer_key
			  FROM public.ozon_error_sighting s
			  JOIN public.ozon_error_catalog c
			    ON c.source = s.source AND c.code = s.code
			   AND c.attribute_id = s.attribute_id
			   AND c.description_category_id = s.description_category_id
			   AND c.type_id = s.type_id
			 WHERE s.org_id = $1 AND s.task_key = $2`, orgA, "intent:"+first.IntentID).Scan(&sample, &offer); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(sample, fixtureAPIKey) || !strings.Contains(sample, "[redacted]") || offer != "offer-e2-4" {
			t.Fatalf("sample %q offer %q", sample, offer)
		}
		if got := catalogCount(t, ctx, pool, domain.SourceRequest, "3"); got < 1 {
			t.Fatal(got)
		}
		// An identical classified receipt is an idempotent success.
		beforeReplay := receiptSnapshot(t, ctx, pool, first.IntentID)
		again := rejected.post(t, http.MethodPost, "/api/listing/browser/report", body)
		if again.Code != http.StatusOK {
			t.Fatalf("second %d %s", again.Code, again.Body.String())
		}
		if afterReplay := receiptSnapshot(t, ctx, pool, first.IntentID); afterReplay != beforeReplay {
			t.Fatal("replayed rejection changed the intent or listing row")
		}
		var sightings int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM public.ozon_error_sighting
			 WHERE org_id = $1 AND task_key = $2`, orgA, "intent:"+first.IntentID).Scan(&sightings); err != nil || sightings != 1 {
			t.Fatalf("sightings %d %v", sightings, err)
		}

		info := newOzonShop(t, ctx, pool, orgA, userA, ring, true, svc)
		live := newOzonShop(t, ctx, pool, orgA, userA, ring, false, svc)
		intentID := parseGrant(t, live.post(t, http.MethodPost, "/api/listing/browser/grant", live.body("offer-info", "op-info", live.row(t, ctx)))).IntentID
		payload := `{"taskId":88001,"apiKey":"` + fixtureAPIKey + `","items":[{"offerId":"offer-info","errors":[
			{"code":"E2` + run + `RD","description":"密度说明 ` + fixtureAPIKey + ` 仍在","attribute_id":0,"field":"name"},
			{"code":"E2` + run + `UK","description":"只有卖家文字","attribute_id":0,"apiKey":"` + fixtureAPIKey + `","optional_description_elements":["x"]}
		]}]}`
		infoRec := info.post(t, http.MethodPost, "/api/listing/browser/import-info", payload)
		if infoRec.Code != http.StatusOK || !strings.Contains(infoRec.Body.String(), `"accepted":2`) || strings.Count(infoRec.Body.String(), fixtureAPIKey) != 0 || strings.Contains(infoRec.Body.String(), "apiKey") {
			t.Fatalf("import %d %s", infoRec.Code, infoRec.Body.String())
		}
		if infoRec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(infoRec.Header().Get("Cache-Control"))
		}
		var stored string
		if err := pool.QueryRow(ctx, `
			SELECT coalesce(string_agg(sample_description || field || attribute_name || level || state, ''), '')
			  FROM public.ozon_error_catalog
			 WHERE code IN ($1, $2)`, "E2"+run+"RD", "E2"+run+"UK").Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(stored, fixtureAPIKey) || !strings.Contains(stored, "密度说明") || !strings.Contains(stored, "[redacted]") || !strings.Contains(stored, "只有卖家文字") {
			t.Fatal(stored)
		}
		if state := intentState(t, ctx, pool, intentID); state != "submitting" {
			t.Fatal(state)
		}
		reviewer := newOzonShop(t, ctx, pool, orgA, userA, ring, false, svc)
		reviewer.role = "reviewer"
		reviewer.h = reviewer.handler()
		denied := reviewer.post(t, http.MethodPost, "/api/listing/browser/import-info", payload)
		if denied.Code != http.StatusForbidden {
			t.Fatalf("reviewer %d %s", denied.Code, denied.Body.String())
		}
		seen := reviewer.post(t, http.MethodGet, "/api/listing/ozon-errors?code=E2"+run+"UK", "")
		if seen.Code != http.StatusOK || !strings.Contains(seen.Body.String(), "E2"+run+"UK") || strings.Contains(seen.Body.String(), fixtureAPIKey) {
			t.Fatalf("get %d %s", seen.Code, seen.Body.String())
		}
		other := newOzonShop(t, ctx, pool, orgB, userB, ring, false, svc)
		foreign := other.post(t, http.MethodGet, "/api/listing/ozon-errors?code=E2"+run+"UK", "")
		if foreign.Code != http.StatusOK || strings.Contains(foreign.Body.String(), "E2"+run+"UK") {
			t.Fatalf("foreign %d %s", foreign.Code, foreign.Body.String())
		}
	})

	t.Run("write failure does not move the listing", func(t *testing.T) {
		kek := seal.DeriveKEK("browser-direct-fixture-kek")
		ring := seal.Ring{Primary: kek}
		shop := newOzonShop(t, ctx, pool, orgA, userA, ring, false, failOzon{})
		first := parseGrant(t, shop.post(t, http.MethodPost, "/api/listing/browser/grant", shop.body("offer-fail", "op-fail", shop.row(t, ctx))))
		rec := shop.post(t, http.MethodPost, "/api/listing/browser/report", `{"intentId":"`+first.IntentID+`","httpStatus":400}`)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"state":"rejected"`) {
			t.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
		var listing string
		if err := pool.QueryRow(ctx, `
			SELECT r.submission_state
			  FROM public.submission_intents i
			  JOIN public.listing_rows r ON r.id = i.listing_row_id
			 WHERE i.id = $1::uuid`, first.IntentID).Scan(&listing); err != nil || listing != "rejected" {
			t.Fatalf("listing %s %v", listing, err)
		}

		held := newOzonShop(t, ctx, pool, orgA, userA, ring, false, svc)
		id := parseGrant(t, held.post(t, http.MethodPost, "/api/listing/browser/grant", held.body("offer-dirty", "op-dirty", held.row(t, ctx)))).IntentID
		_, err := repo.Insert(ctx, orgA, []domain.Row{{
			Source: domain.SourceImportInfo, Code: "E2" + run + "DIRTY", TaskKey: "dirty", OfferKey: "dirty",
			Sample: "before " + fixtureAPIKey + " after",
		}})
		if err == nil {
			t.Fatal("dirty sample stored")
		}
		if state := intentState(t, ctx, pool, id); state != "submitting" {
			t.Fatal(state)
		}
		if got := catalogCount(t, ctx, pool, domain.SourceImportInfo, "E2"+run+"DIRTY"); got != 0 {
			t.Fatal(got)
		}
	})

	t.Run("upstream observation", func(t *testing.T) {
		code := "E2" + run + "UP"
		req := []byte(`{"task_id":99001,"apiKey":"` + fixtureAPIKey + `"}`)
		resp := []byte(`{"result":{"items":[{"offer_id":"up","errors":[{"code":"` + code + `","description":"上游 ` + fixtureAPIKey + `"}]}]}}`)
		if err := svc.ObserveUpstream(ctx, orgA, 200, req, resp); err != nil {
			t.Fatal(err)
		}
		var sample string
		if err := pool.QueryRow(ctx, `
			SELECT sample_description FROM public.ozon_error_catalog
			 WHERE source = 'ozon_import_info' AND code = $1`, code).Scan(&sample); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(sample, fixtureAPIKey) || !strings.Contains(sample, "上游") {
			t.Fatal(sample)
		}
		if err := svc.ObserveUpstream(ctx, orgA, 403, []byte(`{"task_id":99002}`), []byte(`{"code":7,"message":"no","details":[{"body":"ignored"}]}`)); err != nil {
			t.Fatal(err)
		}
		if got := catalogCount(t, ctx, pool, domain.SourceRequest, "7"); got < 1 {
			t.Fatal(got)
		}
		before := catalogCount(t, ctx, pool, domain.SourceRequest, "3")
		if err := svc.ObserveUpstream(ctx, orgA, 422, []byte(`{"task_id":99003}`), []byte(`{"message":"no"}`)); err != nil {
			t.Fatal(err)
		}
		if err := svc.ObserveUpstream(ctx, orgA, 200, []byte(`{"offer":"x"}`), resp); err != nil {
			t.Fatal(err)
		}
		if got := catalogCount(t, ctx, pool, domain.SourceRequest, "3"); got != before {
			t.Fatalf("422 recorded %d -> %d", before, got)
		}
		if got := catalogCount(t, ctx, pool, domain.SourceImportInfo, code); got != 1 {
			t.Fatal(got)
		}
	})
}

func catalogCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, source, code string) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(ctx, `
		SELECT coalesce(sum(occurrences), 0)
		  FROM public.ozon_error_catalog
		 WHERE source = $1 AND code = $2`, source, code).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

type pageBody struct {
	Items []struct {
		Code        string `json:"code"`
		Occurrences int64  `json:"occurrences"`
	} `json:"items"`
	Next string `json:"next_cursor"`
}

func listPage(t *testing.T, body []byte, err error) pageBody {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	var wrap struct {
		Data pageBody `json:"data"`
	}
	if err := json.Unmarshal(body, &wrap); err != nil {
		t.Fatal(err)
	}
	return wrap.Data
}

type failOzon struct{}

func (failOzon) RecordRows(context.Context, int64, []domain.Row) (int, error) {
	return 0, errors.New("catalog down")
}
func (failOzon) RecordRequest(context.Context, int64, domain.RequestError) error {
	return errors.New("catalog down")
}
func (failOzon) ListOrg(context.Context, int64, string) ([]byte, error) {
	return nil, errors.New("catalog down")
}
func (failOzon) List(context.Context, int64, string) ([]byte, error) {
	return nil, errors.New("catalog down")
}
func (failOzon) ObserveUpstream(context.Context, int64, int, []byte, []byte) error {
	return errors.New("catalog down")
}

type ozonShop struct {
	t     *testing.T
	pool  *pgxpool.Pool
	org   int64
	user  int64
	store string
	role  string
	off   bool
	ozon  httpapi.OzonRecorder
	opens *atomic.Int32
	h     http.Handler
}

func newOzonShop(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64, ring seal.Ring, disabled bool, ozon httpapi.OzonRecorder) *ozonShop {
	t.Helper()
	storePK, storeID := insertNextStore(t, ctx, pool, org)
	insertSealedCredential(t, ctx, pool, org, user, storePK, ring, farExpiry())
	shop := &ozonShop{
		t: t, pool: pool, org: org, user: user, store: storeID, role: "owner",
		off: disabled, ozon: ozon, opens: &atomic.Int32{},
	}
	shop.h = shop.handler()
	return shop
}

func (s *ozonShop) handler() http.Handler {
	router := chi.NewRouter()
	opens := s.opens
	kek := seal.DeriveKEK("browser-direct-fixture-kek")
	ring := seal.Ring{Primary: kek}
	srv := &httpapi.Server{
		Pool: s.pool,
		Access: access.FixedResolver{Principal: &access.Principal{
			UserID: s.user, OrgID: s.org, WorkspaceRole: s.role,
		}},
		Now:            time.Now,
		WritesDisabled: s.off,
		Ozon:           s.ozon,
		OpenGrant: func(env seal.Store) (seal.Secret, error) {
			opens.Add(1)
			return ring.OpenStore(env)
		},
	}
	httpapi.RegisterBrowserDirect(router, srv)
	return router
}

func (s *ozonShop) row(t *testing.T, ctx context.Context) string {
	t.Helper()
	return insertFenceRow(t, ctx, s.pool, s.org, s.store)
}

func (s *ozonShop) body(offer, op, row string) string {
	raw, err := json.Marshal(map[string]any{
		"storeId": s.store, "listingRowId": row, "rowRevision": 1,
		"clientOperationId": op, "requestHash": "hash-" + offer, "offerId": offer,
	})
	if err != nil {
		s.t.Fatal(err)
	}
	return string(raw)
}

func (s *ozonShop) post(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return callJSON(s.h, method, path, body)
}
