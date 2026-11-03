package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	storage "github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

type supplierMediaFile struct {
	URL   string `json:"url"`
	Name  string `json:"name"`
	Bytes int64  `json:"bytes"`
}
type supplierMediaFiles struct {
	Source string
	PSD    []supplierMediaFile
	Videos []supplierMediaFile
}

func (s *Server) supplierMediaFiles(ctx context.Context, p access.Principal, product string) (supplierMediaFiles, error) {
	var out supplierMediaFiles
	if s.Pool == nil {
		return out, mediaUnavailable()
	}
	tx, err := tenantx.BeginApp(ctx, s.Pool.Begin, p.OrgID)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	var psd, videos []byte
	err = tx.QueryRow(ctx, `SELECT p.source_id,p.psd,p.product_videos FROM sc_products p
 JOIN sc_sources src ON src.source_id=p.source_id
 JOIN supplier_ozon_configs c ON c.product_id=p.product_id AND c.description_category_id=p.description_category_id AND c.type_id=p.type_id
 JOIN ozon_category_current cat ON cat.description_category_id=c.description_category_id AND cat.type_id=c.type_id AND cat.language=c.language
 WHERE p.product_id=$2 AND p.published AND NOT p.archived AND src.listed AND c.state='valid'
 AND c.validated_catalog_digest=cat.content_digest AND cat.fetched_at_ms >= (extract(epoch FROM clock_timestamp())*1000)::bigint-259200000
 AND EXISTS(SELECT 1 FROM sc_skus sku WHERE sku.product_id=p.product_id AND sku.published)
 AND EXISTS(SELECT 1 FROM listing_cards card WHERE card.org_id=$1 AND card.supplier_product_id=p.product_id)`, p.OrgID, product).Scan(&out.Source, &psd, &videos)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, &mediaFailure{404, "NOT_FOUND", "供应商商品不存在或当前不可用"}
	}
	if err != nil {
		return out, err
	}
	if json.Unmarshal(psd, &out.PSD) != nil || json.Unmarshal(videos, &out.Videos) != nil || len(out.PSD) > 20 || len(out.Videos) > 15 {
		return out, mediaConflict()
	}
	return out, nil
}

// Source uploads are content-addressed and admitted only after byte verification.
func supplierMediaKey(account sign.Account, source string, file supplierMediaFile, psd bool) (string, string, string, error) {
	u, err := url.Parse(file.URL)
	if err != nil || u.RawQuery != "" || u.Fragment != "" || file.Bytes <= 0 {
		return "", "", "", mediaConflict()
	}
	name := path.Base(u.Path)
	ext := path.Ext(name)
	digest := strings.TrimSuffix(name, ext)
	if len(digest) != 64 {
		return "", "", "", mediaConflict()
	}
	if _, err = hex.DecodeString(digest); err != nil {
		return "", "", "", mediaConflict()
	}
	mime := ""
	switch ext {
	case ".psd":
		if psd {
			mime = "image/vnd.adobe.photoshop"
		}
	case ".mp4":
		if !psd {
			mime = "video/mp4"
		}
	case ".mov":
		if !psd {
			mime = "video/quicktime"
		}
	}
	max := int64(200 << 20)
	if psd {
		max = 500 << 20
	}
	if mime == "" || file.Bytes > max {
		return "", "", "", mediaConflict()
	}
	key := strings.Trim(account.KeyPrefix, "/")
	if key != "" {
		key += "/"
	}
	key += "supplier-dbs/" + source + "/" + name
	if file.URL != sign.PublicURL(account, key) {
		return "", "", "", mediaConflict()
	}
	return key, digest, mime, nil
}

func verifySupplierFile(ctx context.Context, account sign.Account, source string, file supplierMediaFile, psd bool) error {
	key, digest, _, err := supplierMediaKey(account, source, file, psd)
	if err != nil {
		return err
	}
	u, _, err := sign.PresignURL(account, http.MethodGet, key, "", time.Now(), 2*time.Minute, nil, nil)
	if err != nil {
		return mediaUnavailable()
	}
	got, err := storage.ExchangeAccount(ctx, account, storage.Request{Method: http.MethodGet, URL: u, Timeout: 2 * time.Minute, StrictRead: true, NoCompress: true, MaxBytes: file.Bytes + 1})
	if err != nil || got.Status < 200 || got.Status >= 300 {
		return mediaUnavailable()
	}
	sum := sha256.Sum256(got.Body)
	if int64(len(got.Body)) != file.Bytes || hex.EncodeToString(sum[:]) != digest {
		return mediaConflict()
	}
	return nil
}

func (s *Server) VerifySupplierMedia(w http.ResponseWriter, r *http.Request, product string) {
	p, _, err := s.mediaActor(r, "")
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	files, err := s.supplierMediaFiles(r.Context(), p, product)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if s.SupplierMediaAccount == nil {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	account, err := s.SupplierMediaAccount(r.Context())
	if err != nil {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	digest, name := "", ""
	if len(files.PSD) > 0 {
		if err = verifySupplierFile(r.Context(), account, files.Source, files.PSD[0], true); err != nil {
			writeMediaFailure(w, err)
			return
		}
		_, digest, _, _ = supplierMediaKey(account, files.Source, files.PSD[0], true)
		name = files.PSD[0].Name
	}
	for _, video := range files.Videos {
		if err = verifySupplierFile(r.Context(), account, files.Source, video, false); err != nil {
			writeMediaFailure(w, err)
			return
		}
	}
	fresh, refusal, err := s.principal(r)
	if err != nil || refusal != nil || fresh.OrgID != p.OrgID || fresh.UserID != p.UserID {
		writeMediaFailure(w, &mediaFailure{403, "FORBIDDEN", "登录或工作空间已变化"})
		return
	}
	current, err := s.supplierMediaFiles(r.Context(), fresh, product)
	before, _ := json.Marshal(files)
	after, _ := json.Marshal(current)
	if err != nil || string(before) != string(after) {
		writeMediaFailure(w, mediaConflict())
		return
	}
	jsonwire.Write(w, http.StatusOK, map[string]any{"data": map[string]any{"product_id": product, "psd_sha256": digest, "psd_file_name": name, "video_count": len(files.Videos)}})
}

func (s *Server) DownloadSupplierTemplate(w http.ResponseWriter, r *http.Request, product, digest string) {
	p, _, err := s.mediaActor(r, "")
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	files, err := s.supplierMediaFiles(r.Context(), p, product)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if len(files.PSD) == 0 || s.SupplierMediaAccount == nil {
		writeMediaFailure(w, &mediaFailure{404, "NOT_FOUND", "供应商 PSD 不存在"})
		return
	}
	account, err := s.SupplierMediaAccount(r.Context())
	if err != nil {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	file := files.PSD[0]
	key, actual, mime, err := supplierMediaKey(account, files.Source, file, true)
	if err != nil || actual != digest {
		writeMediaFailure(w, &mediaFailure{404, "NOT_FOUND", "供应商 PSD 不存在"})
		return
	}
	now := time.Now()
	u, _, err := sign.PresignURL(account, http.MethodGet, key, "", now, 10*time.Minute, nil, nil)
	if err != nil {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	jsonwire.Write(w, http.StatusOK, map[string]any{"data": map[string]any{"url": u, "expires_at_ms": now.Add(10 * time.Minute).UnixMilli(), "bytes": file.Bytes, "file_name": file.Name, "content_type": mime, "sha256": actual}})
}
