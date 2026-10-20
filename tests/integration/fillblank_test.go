package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

const (
	fillCard  = "c4a11111-1111-4111-8111-111111111111"
	fillGone  = "f4a00000-0000-4000-8000-0000000000ff"
	storeA    = "b4b00000-0000-4000-8000-000000000001"
	storeB    = "b4b00000-0000-4000-8000-000000000002"
	storeMiss = "b4b00000-0000-4000-8000-000000000099"
)

func TestFillBlankPatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	owner, org := insertWorkspace(t, ctx, pool, "fill-owner@pod.example", "Fill")
	other, orgB := insertWorkspace(t, ctx, pool, "fill-other@pod.example", "Other")
	stranger, _ := insertWorkspace(t, ctx, pool, "fill-stranger@pod.example", "Stranger")
	insertMember(t, ctx, pool, org, owner, "owner", 1)
	insertMember(t, ctx, pool, org, other, "member", 2)
	insertCard(t, ctx, pool, fillCard, org, "fill", "2026-08-21T17:30:00Z", `{"descriptionCategoryId":9,"typeId":8}`)
	insertSchema(t, ctx, pool)
	insertStoreN(t, ctx, pool, org, storeA, 1)
	insertStoreN(t, ctx, pool, org, storeB, 2)

	const (
		kernel    = "a4a00000-0000-4000-8000-000000000010"
		brand     = "a4a00000-0000-4000-8000-000000000011"
		category  = "a4a00000-0000-4000-8000-000000000012"
		keepSrc   = "a4a00000-0000-4000-8000-000000000013"
		decode    = "a4a00000-0000-4000-8000-000000000014"
		source    = "a4a00000-0000-4000-8000-000000000015"
		edited    = "a4a00000-0000-4000-8000-000000000016"
		noEditor  = "a4a00000-0000-4000-8000-000000000017"
		protect   = "a4a00000-0000-4000-8000-000000000018"
		draftKey  = "a4a00000-0000-4000-8000-000000000019"
		media     = "a4a00000-0000-4000-8000-00000000001a"
		empty     = "a4a00000-0000-4000-8000-00000000001b"
		withDraft = "a4a00000-0000-4000-8000-00000000001c"
		opRow     = "a4a00000-0000-4000-8000-00000000001d"
		revRow    = "a4a00000-0000-4000-8000-00000000001e"
		cross     = "a4a00000-0000-4000-8000-00000000001f"
		csrfRow   = "a4a00000-0000-4000-8000-000000000020"
		sameRow   = "a4a00000-0000-4000-8000-000000000021"
		moveRow   = "a4a00000-0000-4000-8000-000000000022"
		unbind    = "a4a00000-0000-4000-8000-000000000023"
		opStore   = "a4a00000-0000-4000-8000-000000000024"
		noMember  = "a4a00000-0000-4000-8000-000000000025"
		badStore  = "a4a00000-0000-4000-8000-000000000026"
		missStore = "a4a00000-0000-4000-8000-000000000027"
		mixRow    = "a4a00000-0000-4000-8000-000000000028"
	)
	insertFillRow(t, ctx, pool, kernel, org, `{"title":"keep","description":"","gap":" ","n":0,"f":false,"a":[],"o":{},"z":null}`, "draft", "pending", "stale", "none", "built", 0, "")
	insertFillRow(t, ctx, pool, brand, org, `{"brand":"kept"}`, "ready", "ready", "passed", "queued", "built", 0, "")
	insertFillRow(t, ctx, pool, category, org, `{"title":"t"}`, "ready", "ready", "passed", "queued", "built", 0, "")
	insertFillRow(t, ctx, pool, keepSrc, org, `{"source":{"sha256":"abc"},"title":"t"}`, "ready", "ready", "passed", "queued", "built", 0, "")
	insertFillRow(t, ctx, pool, decode, org, `{"title":"keep"}`, "draft", "pending", "stale", "none", "built", 0, "")
	insertFillRow(t, ctx, pool, source, org, sourcePayload, "ready", "ready", "passed", "queued", "built", 0, "")
	insertFillRow(t, ctx, pool, edited, org, `{"title":"keep"}`, "draft", "pending", "stale", "none", "stale", owner, "")
	insertFillRow(t, ctx, pool, noEditor, org, `{"title":"keep"}`, "draft", "pending", "stale", "none", "stale", 0, "")
	insertFillRow(t, ctx, pool, protect, org, `{"ai":{"x":1},"title":"keep"}`, "draft", "pending", "stale", "none", "stale", 0, "")
	insertFillRow(t, ctx, pool, draftKey, org, `{"title":"t"}`, "draft", "pending", "stale", "none", "stale", 0, "")
	insertFillRow(t, ctx, pool, media, org, `{"media":{"images":[]}}`, "draft", "pending", "stale", "none", "stale", 0, "")
	insertFillRow(t, ctx, pool, empty, org, `{"title":"keep"}`, "ready", "ready", "passed", "queued", "built", 0, "")
	insertFillRow(t, ctx, pool, withDraft, org, `{"title":"x"}`, "draft", "pending", "stale", "none", "built", 0, "")
	insertFillRow(t, ctx, pool, opRow, org, `{"title":"op"}`, "draft", "pending", "stale", "none", "built", 0, "")
	insertFillRow(t, ctx, pool, revRow, org, `{"title":"rev"}`, "draft", "pending", "stale", "none", "built", 0, "")
	insertFillRow(t, ctx, pool, cross, org, `{"title":"cross"}`, "draft", "pending", "stale", "none", "built", 0, "")
	insertFillRow(t, ctx, pool, csrfRow, org, `{"title":"csrf"}`, "draft", "pending", "stale", "none", "built", 0, "")
	insertFillRow(t, ctx, pool, sameRow, org, `{"title":"same"}`, "ready", "ready", "passed", "queued", "built", 0, storeA)
	insertFillRow(t, ctx, pool, moveRow, org, `{"title":"move"}`, "ready", "ready", "passed", "queued", "built", 0, storeA)
	insertFillRow(t, ctx, pool, unbind, org, `{"title":"unbind"}`, "ready", "ready", "passed", "queued", "built", 0, storeA)
	insertFillRow(t, ctx, pool, opStore, org, `{"title":"opstore"}`, "draft", "pending", "stale", "none", "built", 0, "")
	insertFillRow(t, ctx, pool, noMember, org, `{"title":"nomem"}`, "draft", "pending", "stale", "none", "built", 0, "")
	insertFillRow(t, ctx, pool, badStore, org, `{"title":"bad"}`, "draft", "pending", "stale", "none", "built", 0, "")
	insertFillRow(t, ctx, pool, missStore, org, `{"title":"miss"}`, "draft", "pending", "stale", "none", "built", 0, "")
	insertFillRow(t, ctx, pool, mixRow, org, `{"title":"mix"}`, "draft", "pending", "stale", "none", "built", 0, "")

	now := time.Now
	ownerH := surfaceHandler(pool, nil, fillPrincipal(owner, org, "owner"), now)
	opH := surfaceHandler(pool, nil, fillPrincipal(other, org, "member"), now)
	revH := surfaceHandler(pool, nil, fillPrincipal(owner, org, "reviewer"), now)
	viewH := surfaceHandler(pool, nil, fillPrincipal(owner, org, "viewer"), now)
	noneH := surfaceHandler(pool, nil, fillPrincipal(owner, 0, ""), now)
	badH := surfaceHandler(pool, nil, fillPrincipal(owner, org, "nope"), now)
	outH := loggedOutListing(pool)
	crossH := surfaceHandler(pool, nil, fillPrincipal(other, orgB, "owner"), now)
	strangerH := surfaceHandler(pool, nil, fillPrincipal(stranger, org, "owner"), now)

	rec := callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+kernel, `{"baseRevision":1,"fillBlank":true,"changes":{"title":"ai-title","description":"ai-desc","gap":"x","n":1,"f":true,"a":[1],"o":{"k":1},"z":"filled","brand":null,"schemaSnapshot":{"no":1},"schemaRevision":"9"}}`)
	assertFillOK(t, rec, 2, 2)
	assertSQL(t, ctx, pool, `
		SELECT payload->>'title' = 'keep'
		   AND payload->>'description' = 'ai-desc'
		   AND payload->>'gap' = ' '
		   AND payload->'n' = '0'::jsonb
		   AND payload->'f' = 'false'::jsonb
		   AND payload->'a' = '[]'::jsonb
		   AND payload->'o' = '{}'::jsonb
		   AND payload->'z' = '"filled"'::jsonb
		   AND payload->'brand' = 'null'::jsonb
		   AND NOT (payload ? 'schemaSnapshot')
		   AND NOT (payload ? 'schemaRevision')
		   AND build_state = 'stale' AND revision = 2 AND view_revision = 2
		FROM listing_rows WHERE id = $1::uuid`, kernel)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+brand, `{"baseRevision":1,"fillBlank":true,"changes":{"brand":"new"}}`)
	assertFillOK(t, rec, 2, 2)
	assertSQL(t, ctx, pool, `
		SELECT payload->>'brand' = 'kept'
		   AND content_state = 'ready' AND media_state = 'ready'
		   AND validation_state = 'passed' AND submission_state = 'queued'
		   AND revision = 2 AND view_revision = 2
		FROM listing_rows WHERE id = $1::uuid`, brand)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+category, `{"baseRevision":1,"fillBlank":true,"changes":{"descriptionCategoryId":9}}`)
	assertFillOK(t, rec, 2, 3)
	assertSQL(t, ctx, pool, `
		SELECT payload->'descriptionCategoryId' = '9'::jsonb
		   AND content_state = 'draft' AND media_state = 'pending'
		   AND validation_state = 'stale' AND submission_state = 'none'
		   AND revision = 2 AND view_revision = 3
		FROM listing_rows WHERE id = $1::uuid`, category)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+keepSrc, `{"baseRevision":1,"fillBlank":true,"changes":{"source":{"sha256":"zzz"}}}`)
	assertFillOK(t, rec, 2, 2)
	assertSQL(t, ctx, pool, `
		SELECT payload#>>'{source,sha256}' = 'abc'
		   AND validation_state = 'passed' AND media_state = 'ready'
		   AND view_revision = 2
		FROM listing_rows WHERE id = $1::uuid`, keepSrc)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+decode, `{"baseRevision":1,"fillBlank":true,"changes":{"source":{"sha256":"abc"}}}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "商品行载荷不是可校验的上架文档：") || !strings.Contains(rec.Body.String(), "listing row payload decode:") || !strings.Contains(rec.Body.String(), `"code":"validation"`) {
		t.Fatalf("decode %d %s", rec.Code, rec.Body.String())
	}
	assertSQL(t, ctx, pool, `
		SELECT revision = 1 AND view_revision = 1 AND payload->>'title' = 'keep' AND NOT (payload ? 'source')
		FROM listing_rows WHERE id = $1::uuid`, decode)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+source, `{"baseRevision":1,"fillBlank":true,"changes":{"source":{"sha256":"newsha"}}}`)
	assertFillOK(t, rec, 2, 4)
	if strings.Contains(rec.Body.String(), "schemaSnapshot") {
		t.Fatalf("response kept schemaSnapshot %s", rec.Body.String())
	}
	assertSQL(t, ctx, pool, `
		SELECT NOT (payload #> '{draft,values}' ? 'brand')
		   AND payload #>> '{draft,values,name,value}' = 'kept'
		   AND payload #>> '{ai,requestId}' = ''
		   AND jsonb_array_length(payload #> '{ai,candidates}') = 0
		   AND jsonb_array_length(payload->'fieldOrigins') = 0
		   AND payload #>> '{source,sha256}' = 'newsha'
		   AND payload ? 'schemaSnapshot'
		   AND content_state = 'draft' AND media_state = 'pending'
		   AND validation_state = 'stale' AND submission_state = 'queued'
		   AND revision = 2 AND view_revision = 4
		FROM listing_rows WHERE id = $1::uuid`, source)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+edited, `{"baseRevision":9,"fillBlank":true,"changes":{"brand":"n","title":"m"}}`)
	assertConflict(t, rec, 1, 9, owner, `{"brand":"n","title":"m"}`, []byte(`{"title":"keep"}`))
	assertSQL(t, ctx, pool, `SELECT revision = 1 FROM listing_rows WHERE id = $1::uuid`, edited)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+noEditor, `{"baseRevision":9,"fillBlank":true,"changes":{"brand":"q"}}`)
	if rec.Code != http.StatusConflict || strings.Contains(rec.Body.String(), "lastEditorId") || !strings.HasPrefix(rec.Body.String(), `{"error":"商品行已被他人更新，请刷新后重试","code":"conflict","conflict":`) {
		t.Fatalf("null editor %d %s", rec.Code, rec.Body.String())
	}
	assertSQL(t, ctx, pool, `SELECT revision = 1 AND updated_by IS NULL FROM listing_rows WHERE id = $1::uuid`, noEditor)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+protect, `{"baseRevision":9,"fillBlank":true,"changes":{"ai":{"x":2}}}`)
	wantBody(t, rec, http.StatusBadRequest, `{"error":"识别证据与字段来源由服务端维护，请使用候选确认或草稿编辑","code":"validation"}`)
	assertSQL(t, ctx, pool, `SELECT revision = 1 FROM listing_rows WHERE id = $1::uuid`, protect)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+draftKey, `{"baseRevision":9,"fillBlank":true,"changes":{"draft":{"values":{}}}}`)
	wantBody(t, rec, http.StatusBadRequest, `{"error":"草稿值请通过 draft 编辑字段提交","code":"validation"}`)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+media, `{"baseRevision":1,"fillBlank":true,"changes":{"media":{"images":[1]}}}`)
	wantBody(t, rec, http.StatusBadRequest, `{"error":"切片清单和图片回执只能由媒体作业写入","code":"validation"}`)
	assertSQL(t, ctx, pool, `SELECT revision = 1 FROM listing_rows WHERE id = $1::uuid`, media)

	wantBody(t, callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+fillGone, `{"baseRevision":1,"fillBlank":true}`), http.StatusNotFound, `{"error":"商品行不存在","code":"not_found"}`)
	wantBody(t, callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+fillGone, `{"baseRevision":1,"fillBlank":true,"candidateDecisions":[]}`), http.StatusBadRequest, `{"error":"候选确认不能与其他字段写入一起提交","code":"validation"}`)
	wantBody(t, callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+mixRow, `{"baseRevision":1,"fillBlank":true,"changes":[]}`), http.StatusBadRequest, `{"error":"changes/payload 必须是对象","code":"validation"}`)
	wantBody(t, callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+mixRow, `{"baseRevision":1,"fillBlank":1}`), http.StatusBadRequest, `{"error":"请求格式无效","code":"validation"}`)
	wantBody(t, callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+mixRow, `{"baseRevision":1,"fillBlank":true,"candidateDecisions":[],"clearGeneratedContent":true}`), http.StatusBadRequest, `{"error":"候选确认不能与其他字段写入一起提交","code":"validation"}`)
	wantBody(t, callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+mixRow, `{"baseRevision":1,"fillBlank":true,"clearGeneratedContent":true}`), http.StatusBadRequest, `{"error":"清空生成内容不能与其他字段写入一起提交","code":"validation"}`)
	wantBody(t, callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+mixRow, `{"baseRevision":1,"fillBlank":true,"candidateDecisions":[],"storeId":null}`), http.StatusBadRequest, `{"error":"候选确认不能与其他字段写入一起提交","code":"validation"}`)
	assertSQL(t, ctx, pool, `SELECT revision = 1 FROM listing_rows WHERE id = $1::uuid`, mixRow)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+empty, `{"baseRevision":1,"fillBlank":true}`)
	assertFillOK(t, rec, 2, 2)
	assertSQL(t, ctx, pool, `
		SELECT payload->>'title' = 'keep'
		   AND content_state = 'ready' AND media_state = 'ready'
		   AND validation_state = 'passed' AND submission_state = 'queued'
		   AND build_state = 'stale'
		FROM listing_rows WHERE id = $1::uuid`, empty)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+withDraft, `{"baseRevision":1,"fillBlank":true,"draft":{"values":{},"complex_values":[]}}`)
	wantBody(t, rec, http.StatusBadRequest, "{\"error\":\"商品行载荷不是可校验的上架文档：missing field `categoryKey`\",\"code\":\"validation\"}")
	assertSQL(t, ctx, pool, `SELECT revision = 1 AND build_state = 'built' FROM listing_rows WHERE id = $1::uuid`, withDraft)

	wantBody(t, callJSON(viewH, http.MethodPatch, "/api/listing/rows/"+kernel, `{"baseRevision":2,"fillBlank":true}`), http.StatusForbidden, `{"error":"当前角色无权执行此操作","code":"forbidden"}`)
	wantBody(t, callJSON(noneH, http.MethodPatch, "/api/listing/rows/"+kernel, `{"baseRevision":2,"fillBlank":true}`), http.StatusForbidden, `{"error":"当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受","code":"forbidden"}`)
	wantBody(t, callJSON(badH, http.MethodPatch, "/api/listing/rows/"+kernel, `{"baseRevision":2,"fillBlank":true}`), http.StatusForbidden, `{"error":"工作空间角色无效","code":"forbidden"}`)
	wantBody(t, callJSON(outH, http.MethodPatch, "/api/listing/rows/"+kernel, `{"baseRevision":2,"fillBlank":true}`), http.StatusUnauthorized, `{"error":"未登录","code":"auth_invalid"}`)

	rec = callJSON(opH, http.MethodPatch, "/api/listing/rows/"+opRow, `{"baseRevision":1,"fillBlank":true}`)
	assertFillOK(t, rec, 2, 2)
	rec = callJSON(revH, http.MethodPatch, "/api/listing/rows/"+revRow, `{"baseRevision":1,"fillBlank":true}`)
	assertFillOK(t, rec, 2, 2)

	wantBody(t, callJSON(crossH, http.MethodPatch, "/api/listing/rows/"+cross, `{"baseRevision":1,"fillBlank":true}`), http.StatusNotFound, `{"error":"商品行不存在","code":"not_found"}`)
	wantBody(t, callJSON(crossH, http.MethodGet, "/api/listing/rows/"+cross, ""), http.StatusNotFound, `{"error":"商品行不存在","code":"not_found"}`)
	assertSQL(t, ctx, pool, `SELECT revision = 1 FROM listing_rows WHERE id = $1::uuid`, cross)

	csrf := callHdr(ownerH, http.MethodPatch, "/api/listing/rows/"+csrfRow, `{"baseRevision":1,"fillBlank":true}`, http.Header{"Cookie": []string{"sid=abc"}, "Origin": []string{"http://evil.example"}})
	wantBody(t, csrf, http.StatusForbidden, `{"code":"csrf_rejected","message":"跨站请求已被拒绝"}`)
	assertSQL(t, ctx, pool, `SELECT revision = 1 FROM listing_rows WHERE id = $1::uuid`, csrfRow)
	same := callHdr(ownerH, http.MethodPatch, "/api/listing/rows/"+csrfRow, `{"baseRevision":1,"fillBlank":true}`, http.Header{"Cookie": []string{"sid=abc"}, "Sec-Fetch-Site": []string{"same-origin"}, "Origin": []string{"http://evil.example"}})
	assertFillOK(t, same, 2, 2)
	req := httptest.NewRequest(http.MethodGet, "/api/listing/rows/"+csrfRow, nil)
	req.Header.Set("Cookie", "sid=abc")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	getRec := httptest.NewRecorder()
	ownerH.ServeHTTP(getRec, req)
	if getRec.Code != http.StatusOK || strings.Contains(getRec.Body.String(), "csrf_rejected") {
		t.Fatalf("get csrf %d %s", getRec.Code, getRec.Body.String())
	}

	wantBody(t, callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+badStore, `{"baseRevision":1,"fillBlank":true,"storeId":"nope"}`), http.StatusBadRequest, `{"error":"storeId 不是有效的店铺标识","code":"validation"}`)
	assertSQL(t, ctx, pool, `SELECT revision = 1 FROM listing_rows WHERE id = $1::uuid`, badStore)
	wantBody(t, callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+missStore, `{"baseRevision":1,"fillBlank":true,"storeId":"`+storeMiss+`"}`), http.StatusNotFound, `{"error":"Store 不存在","code":"not_found"}`)
	assertSQL(t, ctx, pool, `SELECT revision = 1 AND build_state = 'built' FROM listing_rows WHERE id = $1::uuid`, missStore)
	wantBody(t, callJSON(strangerH, http.MethodPatch, "/api/listing/rows/"+noMember, `{"baseRevision":1,"fillBlank":true,"storeId":"`+storeA+`"}`), http.StatusForbidden, `{"error":"工作空间成员当前不可用","code":"forbidden"}`)
	assertSQL(t, ctx, pool, `SELECT revision = 1 FROM listing_rows WHERE id = $1::uuid`, noMember)
	wantBody(t, callJSON(opH, http.MethodPatch, "/api/listing/rows/"+opStore, `{"baseRevision":1,"fillBlank":true,"storeId":"`+storeB+`"}`), http.StatusNotFound, `{"error":"Store 不存在","code":"not_found"}`)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+sameRow, `{"baseRevision":1,"fillBlank":true,"storeId":"`+storeA+`"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"state":"built"`) || strings.Contains(rec.Body.String(), `"plan"`) {
		t.Fatalf("same store %d %s", rec.Code, rec.Body.String())
	}
	assertSQL(t, ctx, pool, `
		SELECT revision = 2 AND view_revision = 2 AND build_state = 'built'
		   AND content_state = 'ready' AND store_id = $2::uuid AND updated_by = $3
		FROM listing_rows WHERE id = $1::uuid`, sameRow, storeA, owner)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+moveRow, `{"baseRevision":1,"fillBlank":true,"storeId":"`+storeB+`","changes":{"brand":"x"}}`)
	assertFillOK(t, rec, 3, 4)
	assertSQL(t, ctx, pool, `
		SELECT store_id = $2::uuid AND content_state = 'draft' AND media_state = 'pending'
		   AND submission_state = 'none' AND validation_state = 'stale' AND build_state = 'stale'
		FROM listing_rows WHERE id = $1::uuid`, moveRow, storeB)

	rec = callJSON(ownerH, http.MethodPatch, "/api/listing/rows/"+unbind, `{"baseRevision":1,"fillBlank":true,"storeId":null}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"state":"built"`) {
		t.Fatalf("unbind %d %s", rec.Code, rec.Body.String())
	}
	assertSQL(t, ctx, pool, `
		SELECT revision = 2 AND view_revision = 3 AND store_id IS NULL
		   AND content_state = 'draft' AND build_state = 'built'
		FROM listing_rows WHERE id = $1::uuid`, unbind)

	bare, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Release()
	tx, err := bare.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	var n int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM listing_rows`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing GUC sees %d %v", n, err)
	}
	tag, err := tx.Exec(ctx, `UPDATE listing_rows SET build_state = build_state`)
	if err != nil || tag.RowsAffected() != 0 {
		t.Fatalf("missing GUC update %d %v", tag.RowsAffected(), err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO listing_rows (id, org_id, card_id) VALUES ('f4a00000-0000-4000-8000-0000000000fe'::uuid, $1, $2::uuid)`, org, fillCard); err == nil {
		t.Fatal("missing GUC inserted a row")
	}
}

const sourcePayload = `{
	"categoryKey":"k","descriptionCategoryId":9,"typeId":8,"schemaRevision":"rev",
	"schemaSnapshot":{
		"category_key":"k","label":"L","description_category_id":9,"type_id":8,
		"schema_revision":"rev","recipe_id":1,"recipe_revision":1,"catalog_schema_version":1,
		"fields":[
			{"key":"name","label":"N","group":"g","editor":"text","required":false,"attribute_id":null},
			{"key":"brand","label":"B","group":"g","editor":"text","required":false,"attribute_id":null}
		]
	},
	"draft":{"values":{"name":{"kind":"text","value":"kept"},"brand":{"kind":"text","value":"ai"}},"complex_values":[]},
	"handEditedKeys":[],
	"fieldOrigins":[{"address":{"kind":"plain","field_key":"brand"},"kind":"ai_confirmed","source_ref":null,"updated_at_ms":1}],
	"ai":{"requestId":"r","candidates":[],"promptSha256":"p","modelVersion":"m"}
}`

func loggedOutListing(pool *pgxpool.Pool) http.Handler {
	router := chi.NewRouter()
	srv := &httpapi.Server{Pool: pool, Access: access.FixedResolver{}}
	httpapi.HandlerFromMux(srv, router)
	httpapi.MountDomains(router, srv)
	return specChecked(router)
}

func fillPrincipal(user, org int64, role string) access.Principal {
	return access.Principal{UserID: user, OrgID: org, WorkspaceRole: role, PlatformRole: "user", PublicID: "fill@pod.example"}
}

func insertFillRow(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string, org int64, payload, content, media, validation, submission, build string, editor int64, store string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO listing_rows (
			id, org_id, card_id, payload, content_state, media_state, validation_state,
			submission_state, build_state, updated_by, store_id
		) VALUES (
			$1::uuid, $2, $3::uuid, $4::jsonb, $5, $6, $7, $8, $9, NULLIF($10, 0), NULLIF($11, '')::uuid
		)`, id, org, fillCard, payload, content, media, validation, submission, build, editor, store)
	if err != nil {
		t.Fatal(err)
	}
}

func assertSQL(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) {
	t.Helper()
	var ok bool
	if err := pool.QueryRow(ctx, query, args...).Scan(&ok); err != nil || !ok {
		t.Fatalf("sql %v args %v", err, args)
	}
}

func assertFillOK(t *testing.T, rec *httptest.ResponseRecorder, revision, view int64) {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(rec.Body.Bytes(), &top) != nil {
		t.Fatal(rec.Body.String())
	}
	if _, ok := top["plan"]; ok {
		t.Fatalf("plan %s", rec.Body.String())
	}
	var data struct {
		Revision         int64           `json:"revision"`
		ViewRevision     int64           `json:"viewRevision"`
		UpdatedAtMs      int64           `json:"updatedAtMs"`
		ValidationIssues json.RawMessage `json:"validationIssues"`
		Build            struct {
			State string `json:"state"`
		} `json:"build"`
	}
	if json.Unmarshal(top["data"], &data) != nil {
		t.Fatal(rec.Body.String())
	}
	if data.Revision != revision || data.ViewRevision != view || data.Build.State != "stale" || data.UpdatedAtMs <= 0 {
		t.Fatalf("%+v %s", data, rec.Body.String())
	}
	if !bytes.Equal(bytes.TrimSpace(top["issues"]), bytes.TrimSpace(data.ValidationIssues)) {
		t.Fatalf("issues %s vs %s", top["issues"], data.ValidationIssues)
	}
}

func assertConflict(t *testing.T, rec *httptest.ResponseRecorder, serverRev, base, editor int64, changes string, payload []byte) {
	t.Helper()
	if rec.Code != http.StatusConflict || !strings.HasPrefix(rec.Body.String(), `{"error":"商品行已被他人更新，请刷新后重试","code":"conflict","conflict":`) {
		t.Fatalf("conflict %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Conflict struct {
			ServerRevision     int64           `json:"serverRevision"`
			ServerPayload      json.RawMessage `json:"serverPayload"`
			ClientBaseRevision int64           `json:"clientBaseRevision"`
			ClientChanges      json.RawMessage `json:"clientChanges"`
			LastEditorID       *int64          `json:"lastEditorId"`
		} `json:"conflict"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &body) != nil {
		t.Fatal(rec.Body.String())
	}
	if body.Conflict.ServerRevision != serverRev || body.Conflict.ClientBaseRevision != base || body.Conflict.LastEditorID == nil || *body.Conflict.LastEditorID != editor {
		t.Fatalf("%+v", body.Conflict)
	}
	if string(body.Conflict.ClientChanges) != changes {
		t.Fatalf("clientChanges %s", body.Conflict.ClientChanges)
	}
	semanticJSON(t, body.Conflict.ServerPayload, payload)
}

func semanticJSON(t *testing.T, a, b []byte) {
	t.Helper()
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		t.Fatalf("%s vs %s", a, b)
	}
	lb, _ := json.Marshal(left)
	rb, _ := json.Marshal(right)
	if !bytes.Equal(lb, rb) {
		t.Fatalf("%s vs %s", lb, rb)
	}
}

func wantBody(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status || rec.Body.String() != body {
		t.Fatalf("want %d %s\ngot  %d %s", status, body, rec.Code, rec.Body.String())
	}
}

func callHdr(h http.Handler, method, path, body string, hdr http.Header) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for key, values := range hdr {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	h.ServeHTTP(rec, req)
	return rec
}
