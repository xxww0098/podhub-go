package supplierhttp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

type assetActions struct {
	spy
	url string
}

func (s *assetActions) DownloadAsset(context.Context, int64, string, string, bool, int64) (contract.DownloadGrant, error) {
	return contract.DownloadGrant{URL: s.url}, nil
}

func TestSupplierAssetRangeRedirect(t *testing.T) {
	const size = int64(500 << 20)
	file, err := os.Create(filepath.Join(t.TempDir(), "large.psd"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err = file.Truncate(size); err != nil {
		t.Fatal(err)
	}
	for offset, body := range map[int64]string{64<<20 - 4: "boundary", size - 4: "tail"} {
		if _, err = file.WriteAt([]byte(body), offset); err != nil {
			t.Fatal(err)
		}
	}
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"v1"`)
		http.ServeContent(w, r, "large.psd", time.Time{}, file)
	}))
	defer origin.Close()
	router := chi.NewRouter()
	Mount(router, Deps{Session: fixedSession{userID: 7}, Actions: &assetActions{url: origin.URL + "/large.psd"}})
	api := httptest.NewServer(router)
	defer api.Close()
	path := api.URL + "/api/supplier/dispatches/11111111-1111-4111-8111-111111111111/assets/22222222-2222-4222-8222-222222222222"
	for _, tc := range []struct {
		rangeHeader string
		ifRange     string
		status      int
		body        string
	}{
		{fmt.Sprintf("bytes=%d-%d", 64<<20-4, 64<<20+3), `"v1"`, http.StatusPartialContent, "boundary"},
		{"bytes=-4", "", http.StatusPartialContent, "tail"},
		{fmt.Sprintf("bytes=%d-", size-4), "", http.StatusPartialContent, "tail"},
		{"bytes=0-3", `"v0"`, http.StatusOK, ""},
		{fmt.Sprintf("bytes=%d-", size), "", http.StatusRequestedRangeNotSatisfiable, ""},
	} {
		t.Run(tc.rangeHeader, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, path, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Range", tc.rangeHeader)
			req.Header.Set("If-Range", tc.ifRange)
			resp, err := api.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, err := io.ReadAll(io.LimitReader(resp.Body, 1024))
			if err != nil || resp.StatusCode != tc.status {
				t.Fatalf("status=%d body=%q err=%v", resp.StatusCode, body, err)
			}
			if tc.body != "" && (string(body) != tc.body || resp.ContentLength != int64(len(tc.body))) {
				t.Fatalf("length=%d body=%q", resp.ContentLength, body)
			}
			if tc.status != http.StatusOK && resp.Header.Get("Content-Range") == "" {
				t.Fatal("missing Content-Range")
			}
			if tc.status == http.StatusOK && (resp.ContentLength != size || resp.Header.Get("Content-Range") != "") {
				t.Fatal("changed If-Range did not select the whole representation")
			}
		})
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTemporaryRedirect || resp.Header.Get("Cache-Control") != "private, no-store" || resp.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("redirect status=%d headers=%v", resp.StatusCode, resp.Header)
	}
}
