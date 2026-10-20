package supplierrepo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/draw"
	"image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/supplier/contract"
	"github.com/xxww0098/podhub-go/internal/supplier/domain"
)

func (r Repo) DownloadAsset(ctx context.Context, userID int64, dispatchID, assetID string, wantJSON bool, nowMs int64) (contract.AssetBytes, error) {
	meta, err := r.findAsset(ctx, userID, dispatchID, assetID)
	if err != nil {
		return contract.AssetBytes{}, err
	}
	if r.assets == nil {
		return contract.AssetBytes{}, fail(503, "storage_unavailable", "委托原图存储未配置，请联系平台管理员")
	}
	mime := meta.mime
	if !domain.SafeInline(mime) {
		mime = "application/octet-stream"
	}
	if wantJSON {
		extra := [][2]string{
			{"response-content-disposition", "attachment; filename*=UTF-8''" + url.PathEscape(meta.name)},
			{"response-content-type", mime},
		}
		raw, err := presign(*r.assets, meta.key, 120*time.Second, extra)
		if err != nil {
			return contract.AssetBytes{}, fail(503, "storage_unavailable", "对象存储暂不可用")
		}
		return contract.AssetBytes{Grant: &contract.DownloadGrant{
			URL: raw, ExpiresAtMs: nowMs + 120*1000, Bytes: meta.bytes, FileName: meta.name, ContentType: mime, SHA256: meta.sha,
		}}, nil
	}
	body, err := fetchLoopback(ctx, *r.assets, meta.key, 600*time.Second, 65*60*time.Second)
	if err != nil {
		return contract.AssetBytes{}, err
	}
	return contract.AssetBytes{Body: body, ContentType: mime, FileName: meta.name, Inline: domain.SafeInline(meta.mime)}, nil
}

type assetMeta struct {
	key, name, mime, sha string
	bytes                int64
}

func (r Repo) findAsset(ctx context.Context, userID int64, dispatchID, assetID string) (assetMeta, error) {
	var meta assetMeta
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		if _, err := r.loadMembers(ctx, tx, userID); err != nil {
			return err
		}
		var payload []byte
		err := tx.QueryRow(ctx, `SELECT payload FROM delegate_dispatches WHERE dispatch_id = $1::uuid LIMIT 1`, dispatchID).Scan(&payload)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "not_found", "派发包不存在")
		}
		if err != nil {
			return mapDB(err)
		}
		detail := contract.DispatchDetail{}
		fillDetail(&detail, dispatchID, payload, nil)
		for _, line := range detail.Lines {
			for _, asset := range line.Assets {
				if asset.AssetID == assetID {
					meta.bytes = asset.Bytes
					meta.name = asset.FileName
					meta.mime = asset.Mime
					meta.sha = asset.SHA256
				}
			}
		}
		return nil
	})
	if err != nil {
		return meta, err
	}
	var key string
	key, err = r.assetKey(ctx, userID, dispatchID, assetID)
	if err != nil {
		return meta, err
	}
	if strings.TrimSpace(key) == "" {
		return meta, fail(404, "not_found", "素材不存在")
	}
	meta.key = key
	return meta, nil
}

func (r Repo) assetKey(ctx context.Context, userID int64, dispatchID, assetID string) (string, error) {
	var key string
	err := r.withTx(ctx, 0, userID, func(tx pgx.Tx) error {
		var payload []byte
		if err := tx.QueryRow(ctx, `SELECT payload FROM delegate_dispatches WHERE dispatch_id = $1::uuid`, dispatchID).Scan(&payload); err != nil {
			return mapDB(err)
		}
		detail := map[string]any{}
		_ = json.Unmarshal(payload, &detail)
		lines, _ := detail["lines"].([]any)
		for _, line := range lines {
			obj, _ := line.(map[string]any)
			assets, _ := obj["assets"].([]any)
			for _, asset := range assets {
				item, _ := asset.(map[string]any)
				if asString(item["asset_id"]) == assetID {
					key = asString(item["object_key"])
					return nil
				}
			}
		}
		return fail(404, "not_found", "素材不存在")
	})
	return key, err
}

func (r Repo) CatalogImage(ctx context.Context, sourceID, file string, edge uint32) (contract.ImageBody, error) {
	if r.catalogStore == nil {
		return contract.ImageBody{}, fail(503, "STORAGE_NOT_CONFIGURED", "先配置平台货源存储桶")
	}
	prefix, err := domain.NormalizeKeyPrefix(r.catalogStore.KeyPrefix)
	if err != nil {
		return contract.ImageBody{}, fail(500, "INTERNAL", "服务暂不可用")
	}
	id, ext, err := domain.ParseImageFile(file)
	if err != nil {
		return contract.ImageBody{}, err
	}
	key := prefix + "supplier-dbs/" + sourceID + "/" + id + "." + ext
	publicURL := strings.TrimRight(strings.TrimSpace(r.catalogStore.PublicBaseURL), "/") + "/" + encodeObjectPath(key)
	ok, err := r.imageVisible(ctx, sourceID, publicURL)
	if err != nil {
		return contract.ImageBody{}, err
	}
	if !ok {
		return contract.ImageBody{}, fail(404, "NOT_FOUND", "记录不存在或已删除")
	}
	body, err := fetchLoopback(ctx, *r.catalogStore, key, 300*time.Second, 20*time.Second)
	if err != nil {
		if strings.Contains(err.Error(), "404") {
			return contract.ImageBody{}, fail(404, "NOT_FOUND", "对象不存在")
		}
		return contract.ImageBody{}, fail(502, "STORAGE_UNAVAILABLE", "对象存储暂不可用")
	}
	fitted, ctype := fitImage(body, edge, ext)
	return contract.ImageBody{Bytes: fitted, ContentType: ctype}, nil
}

func (r Repo) imageVisible(ctx context.Context, sourceID, publicURL string) (bool, error) {
	if r.pool == nil || r.begin == nil {
		return false, contract.ErrUnavailable
	}
	tx, err := r.begin(ctx, r.pool.Begin, 0)
	if err != nil {
		return false, mapDB(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var present bool
	err = tx.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM sc_products p
		  JOIN sc_sources src ON src.source_id = p.source_id
		  JOIN sc_skus s ON s.product_id = p.product_id
		  WHERE p.source_id = $1 AND p.published AND s.published AND NOT p.archived AND src.listed
		    AND (
		      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.gallery)='array' THEN p.gallery ELSE '[]'::jsonb END) g WHERE g->>'url' = $2)
		      OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.product_videos)='array' THEN p.product_videos ELSE '[]'::jsonb END) v WHERE v->>'coverUrl' = $2)
		    )
		)`, sourceID, publicURL).Scan(&present)
	if err != nil {
		return false, mapDB(err)
	}
	return present, tx.Commit(ctx)
}

func presign(account sign.Account, key string, ttl time.Duration, extra [][2]string) (string, error) {
	raw, _, err := sign.PresignURL(account, http.MethodGet, key, "", time.Now().UTC(), ttl, extra, nil)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if !loopbackHost(u.Hostname()) {
		return "", errors.New("remote")
	}
	return raw, nil
}

func fetchLoopback(ctx context.Context, account sign.Account, key string, ttl, timeout time.Duration) ([]byte, error) {
	raw, err := presign(account, key, ttl, nil)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{CheckRedirect: httpx.UseLast, Transport: httpx.Loopback(false)}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, errors.New("404")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, errors.New("bad status")
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 20*1024*1024+1))
	if err != nil || len(body) == 0 || len(body) > 20*1024*1024 {
		return nil, errors.New("bad body")
	}
	return body, nil
}

func loopbackHost(host string) bool {
	return host == "127.0.0.1" || host == "localhost"
}

func encodeObjectPath(key string) string {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

func fitImage(body []byte, edge uint32, ext string) ([]byte, string) {
	img, _, err := image.Decode(bytes.NewReader(body))
	if err != nil {
		return body, domain.ContentTypeForExt(ext)
	}
	b := img.Bounds()
	longest := b.Dx()
	if b.Dy() > longest {
		longest = b.Dy()
	}
	dst := img
	if longest > int(edge) && edge > 0 {
		scale := float64(edge) / float64(longest)
		w := int(float64(b.Dx()) * scale)
		h := int(float64(b.Dy()) * scale)
		if w < 1 {
			w = 1
		}
		if h < 1 {
			h = 1
		}
		canvas := image.NewRGBA(image.Rect(0, 0, w, h))
		scaleNearest(canvas, img)
		dst = canvas
	}
	white := image.NewRGBA(dst.Bounds())
	draw.Draw(white, white.Bounds(), image.White, image.Point{}, draw.Src)
	draw.Draw(white, white.Bounds(), dst, dst.Bounds().Min, draw.Over)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, white, &jpeg.Options{Quality: 75}); err != nil {
		return body, domain.ContentTypeForExt(ext)
	}
	if longest <= int(edge) && len(body) <= buf.Len() {
		return body, domain.ContentTypeForExt(ext)
	}
	return buf.Bytes(), "image/jpeg"
}

// scaleNearest writes a nearest-neighbor sample into canvas. The sample
// coordinate is b.Min + i*b.Dx()/w, the same integer division as before.
// YCbCr, RGBA, and NRGBA write Pix directly. The stored bytes are what
// image.RGBA.Set would store via color.RGBAModel: RGBA copies its Pix,
// every other color is RGBA() shifted right by 8.
func scaleNearest(canvas *image.RGBA, img image.Image) {
	b := img.Bounds()
	w := canvas.Bounds().Dx()
	h := canvas.Bounds().Dy()
	switch src := img.(type) {
	case *image.YCbCr:
		scaleYCbCr(canvas, src, b, w, h)
	case *image.RGBA:
		scaleRGBA(canvas, src, b, w, h)
	case *image.NRGBA:
		scaleNRGBA(canvas, src, b, w, h)
	default:
		for y := 0; y < h; y++ {
			sy := b.Min.Y + y*b.Dy()/h
			for x := 0; x < w; x++ {
				sx := b.Min.X + x*b.Dx()/w
				canvas.Set(x, y, img.At(sx, sy))
			}
		}
	}
}

func scaleYCbCr(dst *image.RGBA, src *image.YCbCr, b image.Rectangle, w, h int) {
	for y := 0; y < h; y++ {
		sy := b.Min.Y + y*b.Dy()/h
		di := dst.PixOffset(0, y)
		for x := 0; x < w; x++ {
			sx := b.Min.X + x*b.Dx()/w
			r, g, bl, a := src.YCbCrAt(sx, sy).RGBA()
			dst.Pix[di] = uint8(r >> 8)
			dst.Pix[di+1] = uint8(g >> 8)
			dst.Pix[di+2] = uint8(bl >> 8)
			dst.Pix[di+3] = uint8(a >> 8)
			di += 4
		}
	}
}

func scaleRGBA(dst *image.RGBA, src *image.RGBA, b image.Rectangle, w, h int) {
	for y := 0; y < h; y++ {
		sy := b.Min.Y + y*b.Dy()/h
		di := dst.PixOffset(0, y)
		for x := 0; x < w; x++ {
			sx := b.Min.X + x*b.Dx()/w
			if !image.Pt(sx, sy).In(src.Rect) {
				dst.Pix[di], dst.Pix[di+1], dst.Pix[di+2], dst.Pix[di+3] = 0, 0, 0, 0
			} else {
				si := src.PixOffset(sx, sy)
				copy(dst.Pix[di:di+4], src.Pix[si:si+4])
			}
			di += 4
		}
	}
}

func scaleNRGBA(dst *image.RGBA, src *image.NRGBA, b image.Rectangle, w, h int) {
	for y := 0; y < h; y++ {
		sy := b.Min.Y + y*b.Dy()/h
		di := dst.PixOffset(0, y)
		for x := 0; x < w; x++ {
			sx := b.Min.X + x*b.Dx()/w
			if !image.Pt(sx, sy).In(src.Rect) {
				dst.Pix[di], dst.Pix[di+1], dst.Pix[di+2], dst.Pix[di+3] = 0, 0, 0, 0
			} else {
				si := src.PixOffset(sx, sy)
				r, g, bl, a := nrgbaPremul(src.Pix[si], src.Pix[si+1], src.Pix[si+2], src.Pix[si+3])
				dst.Pix[di] = r
				dst.Pix[di+1] = g
				dst.Pix[di+2] = bl
				dst.Pix[di+3] = a
			}
			di += 4
		}
	}
}

// nrgbaPremul is color.NRGBA.RGBA then the RGBAModel shift (>> 8).
func nrgbaPremul(r, g, b, a uint8) (uint8, uint8, uint8, uint8) {
	if a == 0xff {
		return r, g, b, a
	}
	if a == 0 {
		return 0, 0, 0, 0
	}
	rr := uint32(r) | uint32(r)<<8
	gg := uint32(g) | uint32(g)<<8
	bb := uint32(b) | uint32(b)<<8
	aa := uint32(a) | uint32(a)<<8
	rr = rr * aa / 0xffff
	gg = gg * aa / 0xffff
	bb = bb * aa / 0xffff
	return uint8(rr >> 8), uint8(gg >> 8), uint8(bb >> 8), uint8(aa >> 8)
}
