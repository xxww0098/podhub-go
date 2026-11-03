package scans

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

type acceptedReader struct {
	task, info, pictures string
	calls                []string
	err                  error
}

func (r *acceptedReader) WritesDisabled() bool        { return true }
func (r *acceptedReader) Ready(context.Context) error { return submit.ErrNotSent }
func (r *acceptedReader) Write(context.Context, string, []byte) (int, string, error) {
	return 0, "", submit.ErrNotSent
}
func (r *acceptedReader) Read(_ context.Context, path string, _ []byte) (int, string, error) {
	r.calls = append(r.calls, path)
	if r.err != nil {
		return 0, "", r.err
	}
	if path == "/v1/product/import/info" {
		return 200, r.task, nil
	}
	if path == "/v3/product/info/list" {
		return 200, r.info, nil
	}
	if path == "/v2/product/pictures/info" {
		return 200, r.pictures, nil
	}
	return 0, "", submit.ErrNotSent
}

func TestAcceptedTaskReadbackNeverTreatsTaskIDAsProductConfirmation(t *testing.T) {
	for _, tc := range []struct {
		status           string
		errors           string
		calls            int
		terminal, failed bool
	}{
		{"pending", `[]`, 1, false, false}, {"failed", `[{"level":"error","code":"bad-field"}]`, 1, true, true},
		{"imported", `[{"level":"error","code":"SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT"}]`, 1, true, true},
		{"imported", `[{"level":"warning","message":"informational"}]`, 2, true, false}, {"skipped", `[]`, 2, true, false},
	} {
		t.Run(tc.status, func(t *testing.T) {
			r := &acceptedReader{task: `{"result":{"items":[{"offer_id":"a","product_id":7,"status":"` + tc.status + `","errors":` + tc.errors + `}]}}`, info: `{"items":[{"id":7,"offer_id":"a","sources":[{"sku":8}]}]}`}
			hit := observeAccepted(context.Background(), r, []acceptedRow{{ID: "intent", OfferID: "a", TaskID: "71"}})["intent"]
			if len(r.calls) != tc.calls || hit.terminal != tc.terminal || hit.failed != tc.failed || hit.task == nil || hit.task.Status != tc.status {
				t.Fatalf("calls=%v hit=%+v", r.calls, hit)
			}
			if tc.calls == 2 && (hit.sight != submit.SightFound || hit.found.ProductID != 7) {
				t.Fatal("product readback was not confirmed")
			}
		})
	}
	for _, body := range []string{`{}`, `{"result":{"items":null}}`, `{"result":{"items":[{"offer_id":"a","status":"unknown"}]}}`, `{"result":{"items":[{"offer_id":"a","status":"imported","errors":[{"level":"unknown"}]}]}}`} {
		r := &acceptedReader{task: body}
		hit := observeAccepted(context.Background(), r, []acceptedRow{{ID: "intent", OfferID: "a", TaskID: "71"}})["intent"]
		if hit.sight != submit.SightUnreadable || hit.terminal || len(r.calls) != 1 {
			t.Fatal("invalid task readback confirmed a product")
		}
	}
}

func TestAcceptedReadRequiresAnExplicitReadableItemsArray(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `{"items":null}`, `{"items":[{"id":0,"offer_id":"a"}]}`, `{"items":[{"id":1,"offer_id":""}]}`, `{"items":[{"id":1,"offer_id":"a"},{"id":2,"offer_id":"a"}]}`} {
		if _, ok := parseAccepted(200, []byte(body), nil); ok {
			t.Fatalf("malformed response counted as readable: %s", body)
		}
	}
	if _, ok := parseAccepted(503, []byte(`{"items":[]}`), nil); ok {
		t.Fatal("upstream failure became absence")
	}
	if _, ok := parseAccepted(200, []byte(`{"items":[]}`), errors.New("response unavailable")); ok {
		t.Fatal("transport failure became absence")
	}
	if found, ok := parseAccepted(200, []byte(`{"items":[]}`), nil); !ok || len(found) != 0 {
		t.Fatal("explicit empty result rejected")
	}
	found, ok := parseAccepted(200, []byte(`{"items":[{"id":7,"offer_id":"a","sources":[{"sku":8}]}]}`), nil)
	if !ok || found["a"].ProductID != 7 || found["a"].SKU != 8 {
		t.Fatal("valid readback lost identity")
	}
}

type acceptedBatchReader struct {
	tasks      map[int64]string
	info       string
	calls      []string
	infoBodies []string
}

func (r *acceptedBatchReader) WritesDisabled() bool        { return true }
func (r *acceptedBatchReader) Ready(context.Context) error { return submit.ErrNotSent }
func (r *acceptedBatchReader) Write(context.Context, string, []byte) (int, string, error) {
	return 0, "", submit.ErrNotSent
}
func (r *acceptedBatchReader) Read(_ context.Context, path string, body []byte) (int, string, error) {
	r.calls = append(r.calls, path)
	switch path {
	case "/v1/product/import/info":
		var request struct {
			TaskID int64 `json:"task_id"`
		}
		_ = json.Unmarshal(body, &request)
		return 200, r.tasks[request.TaskID], nil
	case "/v3/product/info/list":
		r.infoBodies = append(r.infoBodies, string(body))
		return 200, r.info, nil
	default:
		return 0, "", submit.ErrNotSent
	}
}

func TestAcceptedProductReadsAreSharedAcrossTasksAndChunked(t *testing.T) {
	reader := &acceptedBatchReader{
		tasks: map[int64]string{
			71: `{"result":{"items":[{"offer_id":"a","product_id":1,"status":"imported","errors":[]},{"offer_id":"b","product_id":2,"status":"imported","errors":[]}]}}`,
			72: `{"result":{"items":[{"offer_id":"c","product_id":3,"status":"imported","errors":[]}]}}`,
		},
		info: `{"items":[]}`,
	}
	rows := []acceptedRow{
		{ID: "a", OfferID: "a", TaskID: "71"},
		{ID: "b", OfferID: "b", TaskID: "71"},
		{ID: "c", OfferID: "c", TaskID: "72"},
	}
	sights := observeAccepted(context.Background(), reader, rows)
	if reader.calls[len(reader.calls)-1] != "/v3/product/info/list" || len(reader.infoBodies) != 1 {
		t.Fatalf("calls=%v info=%v", reader.calls, reader.infoBodies)
	}
	for _, row := range rows {
		if sights[row.ID].sight != submit.SightAbsent {
			t.Fatalf("%s not absent: %+v", row.ID, sights[row.ID])
		}
	}
	for _, offer := range []string{"a", "b", "c"} {
		if !strings.Contains(reader.infoBodies[0], `"`+offer+`"`) {
			t.Fatalf("offer %s missing from %s", offer, reader.infoBodies[0])
		}
	}
}

func TestAcceptedProductReadsSplitAtTheRequestLimit(t *testing.T) {
	rows := make([]acceptedRow, submit.InfoListBatch+1)
	items := make([]string, len(rows))
	for i := range rows {
		offer := fmt.Sprintf("o%d", i)
		rows[i] = acceptedRow{ID: offer, OfferID: offer, TaskID: "71"}
		items[i] = `{"offer_id":"` + offer + `","product_id":1,"status":"imported","errors":[]}`
	}
	reader := &acceptedBatchReader{
		tasks: map[int64]string{71: `{"result":{"items":[` + strings.Join(items, ",") + `]}}`},
		info:  `{"items":[]}`,
	}
	sights := observeAccepted(context.Background(), reader, rows)
	if len(reader.infoBodies) != 2 {
		t.Fatalf("product reads = %d", len(reader.infoBodies))
	}
	for _, row := range rows {
		if sights[row.ID].sight != submit.SightAbsent {
			t.Fatalf("%s not absent", row.ID)
		}
	}
}

func TestAcceptedCredentialFailureIsUnreadable(t *testing.T) {
	sights := readAccepted(context.Background(), nil, nil, seal.Ring{}, seal.DefaultSellerKeyID, 7, "550e8400-e29b-41d4-a716-446655440000", []acceptedRow{{ID: "intent", OrgID: 7, OfferID: "a"}})
	if sights["intent"].sight != submit.SightUnreadable {
		t.Fatal("failed credential binding became absence")
	}
}
