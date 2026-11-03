package aihttp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

const imageModel = "qwen-image-2.1-pro"
const maxImageBytes = 20 << 20
const imageDeadline = 4 * time.Minute

var imagePreparation = make(chan struct{}, 2)

func takeImagePreparation() (func(), bool) {
	select {
	case imagePreparation <- struct{}{}:
		var once sync.Once
		return func() { once.Do(func() { <-imagePreparation }) }, true
	default:
		return nil, false
	}
}

// ImageGenerator performs exactly one n=1 call. It must never retry an unknown result.
type ImageGenerator interface {
	Generate(context.Context, []byte, string) ([]byte, error)
}
type ImageAsset struct {
	ObjectID string `json:"object_id"`
	URL      string `json:"url"`
	SHA256   string `json:"sha256"`
}

// ImageAssets confirms stored bytes and registers them before returning an object id.
type ImageAssets interface {
	Save(context.Context, int64, int64, []byte) (ImageAsset, error)
}
type ImageRuntime struct {
	Account func(context.Context) (string, error)
	Resolve func(context.Context, string, string) (ImageGenerator, ImageAssets, error)
	// PublicURL resolves an existing object independently of model availability.
	PublicURL func(bucketIdentity, key string) (string, error)
}
type imageInput struct {
	AccountID            string `json:"account_id"`
	Model                string `json:"model"`
	Source               string `json:"source_base64"`
	ExpectedUnitMicrofen int64  `json:"expected_unit_microfen"`
}
type ImageSetItem struct {
	Ordinal    int         `json:"ordinal"`
	Status     string      `json:"status"`
	RequestID  string      `json:"request_id"`
	ErrorClass *string     `json:"error_class,omitempty"`
	Asset      *ImageAsset `json:"asset,omitempty"`
	Charged    int64       `json:"charged_microfen"`
}
type ImageSetView struct {
	ID           string         `json:"id"`
	Model        string         `json:"requested_model"`
	Status       string         `json:"status"`
	SourceSHA256 string         `json:"source_sha256"`
	Items        []ImageSetItem `json:"items"`
}

var imagePrompts = [3]string{
	"保持参考图商品的轮廓比例、颜色、材质、图案、文字和全部现有结构一致，不增加任何设计、商标或配饰。仅替换为纯白无缝摄影背景，保留自然接触阴影，完整展示同一商品，真实电商主图，不要拼图。",
	"保持参考图中同一商品的轮廓比例、颜色、材质、图案、文字和现有结构一致，不增加设计、商标或配饰。商品完整放在浅灰绿色墙面和浅木桌面的极简场景，保持原视角，柔和自然窗光，没有其他物品，不要拼图。",
	"保持参考图中同一商品及其现有结构、颜色和材质。仅放大参考图中已存在的一个材质或工艺细节，保留原有图案和缝线，不虚构看不到的结构，没有文字标记，不要拼图。",
}

// jpegImage decodes pixels and removes metadata/transparency before storage or inference.
func jpegImage(raw []byte) ([]byte, error) {
	if len(raw) == 0 || len(raw) > maxImageBytes {
		return nil, errors.New("image size")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "jpeg" && format != "png") || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 4_000_000 {
		return nil, errors.New("image pixels")
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	dst := image.NewRGBA(image.Rect(0, 0, cfg.Width, cfg.Height))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), img, img.Bounds().Min, draw.Over)
	var out bytes.Buffer
	if err = jpeg.Encode(&out, dst, &jpeg.Options{Quality: 92}); err != nil {
		return nil, err
	}
	if out.Len() > maxImageBytes {
		return nil, errors.New("encoded image size")
	}
	return out.Bytes(), nil
}
func imageDigest(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }

func (h httpHandler) imageSetPost(w http.ResponseWriter, r *http.Request) {
	principal, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	key, ok := Key(r.Header.Get("Idempotency-Key"))
	if !ok {
		writeResp(w, fail(400, "VALIDATION", "请求缺少有效的 Idempotency-Key 请求头"))
		return
	}
	releasePreparation, allowed := takeImagePreparation()
	if !allowed {
		writeResp(w, fail(429, "IMAGE_BUSY", "图片处理繁忙，请稍后重试"))
		return
	}
	defer releasePreparation()
	raw, err := readImageBody(w, r)
	if err != nil || len(raw) >= 29<<20 {
		writeResp(w, fail(400, "VALIDATION", "图片过大"))
		return
	}
	var in imageInput
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&in) != nil || dec.Decode(new(any)) != io.EOF || in.Model != imageModel || in.AccountID == "" || len(in.AccountID) > 128 || in.ExpectedUnitMicrofen <= 0 {
		writeResp(w, fail(400, "VALIDATION", "套图请求无效"))
		return
	}
	source, err := base64.StdEncoding.Strict().DecodeString(in.Source)
	if err != nil {
		writeResp(w, fail(400, "VALIDATION", "图片无效"))
		return
	}
	canonical, _ := json.Marshal([]string{"image-set-v1", in.AccountID, in.Model, imageDigest(source), strconv.FormatInt(in.ExpectedUnitMicrofen, 10)})
	inputHash := imageDigest(canonical)
	ctx, cancel := context.WithTimeout(withClientIP(r.Context(), remoteIP(r)), imageDeadline)
	defer cancel()
	if found, conflict, err := imageSetByKey(ctx, h.deps.Deps, principal.OrgID, key, inputHash); err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	} else if conflict {
		writeResp(w, fail(409, "IDEMPOTENCY_CONFLICT", "相同请求编号已用于其他图片或配置"))
		return
	} else if found != "" {
		h.writeImageSet(w, r, principal.OrgID, found)
		return
	}
	source, err = jpegImage(source)
	if err != nil {
		writeResp(w, fail(400, "VALIDATION", "图片无效"))
		return
	}
	// The heavy decode is finished. Release the small memory gate before any
	// network work, and discard the base64/request copies promptly.
	releasePreparation()
	raw = nil
	in.Source = ""
	if h.deps.Images == nil || h.deps.Images.Resolve == nil {
		writeResp(w, fail(503, "IMAGE_UNAVAILABLE", "套图模型或素材存储未配置"))
		return
	}
	generator, assets, err := h.deps.Images.Resolve(ctx, in.AccountID, in.Model)
	if err != nil || generator == nil || assets == nil {
		writeResp(w, fail(503, "IMAGE_UNAVAILABLE", "套图模型或素材存储未配置"))
		return
	}
	var price billing.Price
	var found bool
	if h.deps.Wallet.CurrentForModel == nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	err = imageTx(ctx, h.deps.Deps, principal.OrgID, func(tx pgx.Tx) error {
		var e error
		price, found, e = h.deps.Wallet.CurrentForModel(ctx, tx, in.Model)
		return e
	})
	if err != nil || !found {
		writeResp(w, fail(503, "IMAGE_PRICE_UNAVAILABLE", "套图按张价格未发布"))
		return
	}
	unit, err := imageUnitPrice(price)
	if err != nil {
		writeResp(w, fail(503, "IMAGE_PRICE_UNAVAILABLE", "套图按张价格未发布"))
		return
	}
	if unit != in.ExpectedUnitMicrofen {
		writeResp(w, fail(409, "IMAGE_PRICE_CHANGED", "套图价格已变化，请重新确认"))
		return
	}
	quote, _ := price.ChargeUsage(billing.Usage{})
	limits, resp := h.deps.limits(ctx)
	if resp.Status != 0 {
		writeResp(w, resp)
		return
	}
	if limits.LeaseTTL < imageDeadline+time.Minute {
		limits.LeaseTTL = imageDeadline + time.Minute
	}
	lease, status, message := Acquire(ctx, h.deps.Pool, limits, principal.UserID, in.AccountID, true)
	if status != 0 {
		writeResp(w, fail(status, "BUSY", message))
		return
	}
	defer lease.Release(context.Background())
	id, holds, resp := openImageSet(ctx, h.deps.Deps, principal.OrgID, principal.UserID, key, inputHash, imageDigest(source), in.Model, in.AccountID, price, unit)
	if resp.Status != 0 {
		writeResp(w, resp)
		return
	}
	// A concurrent creator won. Never repeat its external requests.
	if len(holds) == 0 {
		h.writeImageSet(w, r, principal.OrgID, id)
		return
	}
	stopAuthority := keepImageAuthority(ctx, h.deps.Deps, principal.OrgID, cancel)
	defer stopAuthority()
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		for _, opened := range holds {
			_ = releaseRequest(cleanup, h.deps.Deps, principal.OrgID, opened, "unbilled_unknown", "image_not_completed", nil)
		}
	}()
	original, err := assets.Save(ctx, principal.OrgID, principal.UserID, source)
	if err == nil {
		err = pinImageSource(ctx, h.deps.Deps, principal.OrgID, id, original.ObjectID)
	}
	if err != nil {
		for _, opened := range holds {
			_ = releaseRequest(ctx, h.deps.Deps, principal.OrgID, opened, "failed", "image_source_storage", nil)
		}
		h.writeImageSet(w, r, principal.OrgID, id)
		return
	}
	for ordinal, opened := range holds {
		if err = dispatchImage(ctx, h.deps.Deps, principal.OrgID, opened.ID); err != nil {
			break
		}
		pixels, callErr := generator.Generate(ctx, source, imagePrompts[ordinal])
		if callErr != nil {
			terminal, class := "unbilled_unknown", "image_upstream_unknown"
			var refusal *ImageProviderError
			if errors.As(callErr, &refusal) {
				class = refusal.Class
				if !refusal.Unknown {
					terminal = "failed"
				}
			}
			_ = releaseRequest(ctx, h.deps.Deps, principal.OrgID, opened, terminal, class, nil)
			break
		}
		normalized, normalErr := jpegImage(pixels)
		if normalErr != nil {
			_ = releaseRequest(ctx, h.deps.Deps, principal.OrgID, opened, "unbilled_unknown", "image_output_invalid", nil)
			break
		}
		asset, saveErr := assets.Save(ctx, principal.OrgID, principal.UserID, normalized)
		if saveErr != nil {
			_ = releaseRequest(ctx, h.deps.Deps, principal.OrgID, opened, "unbilled_unknown", "image_output_storage", nil)
			break
		}
		body, _ := json.Marshal(asset)
		_, err = settleRequestWith(ctx, h.deps.Deps, principal.OrgID, opened, billing.Usage{}, quote, "", body, func(tx pgx.Tx) error {
			tag, e := tx.Exec(ctx, `UPDATE ai_image_set_items SET object_id=$3::uuid WHERE set_id=$1::uuid AND ordinal=$2 AND org_id=$4 AND object_id IS NULL`, id, ordinal, asset.ObjectID, principal.OrgID)
			if e == nil && tag.RowsAffected() != 1 {
				return errors.New("image item changed")
			}
			return e
		})
		if err != nil {
			break
		}
	}
	// Undispatched holds are known not to have called the provider; a dispatched
	// request may be unknown. Both are released without a paid retry.
	cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
	for _, opened := range holds {
		var current string
		_ = imageTx(cleanup, h.deps.Deps, principal.OrgID, func(tx pgx.Tx) error {
			return tx.QueryRow(cleanup, `SELECT status FROM ai_requests WHERE id=$1 AND org_id=$2`, opened.ID, principal.OrgID).Scan(&current)
		})
		terminal, class := "unbilled_unknown", "image_not_completed"
		if current == "held" {
			terminal, class = "failed", "image_not_started"
		}
		_ = releaseRequest(cleanup, h.deps.Deps, principal.OrgID, opened, terminal, class, nil)
	}
	stop()
	h.writeImageSet(w, r, principal.OrgID, id)
}

func readImageBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	control := http.NewResponseController(w)
	_ = control.SetReadDeadline(time.Now().Add(15 * time.Second))
	defer control.SetReadDeadline(time.Time{})
	stop := context.AfterFunc(ctx, func() { _ = r.Body.Close() })
	defer stop()
	raw, err := io.ReadAll(io.LimitReader(r.Body, 29<<20))
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return raw, err
}

func (h httpHandler) imageSetGet(w http.ResponseWriter, r *http.Request) {
	p, ok := member(w, h.deps.Access, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeResp(w, fail(404, "NOT_FOUND", "套图不存在"))
		return
	}
	h.writeImageSet(w, r, p.OrgID, id.String())
}
func (h httpHandler) writeImageSet(w http.ResponseWriter, r *http.Request, org int64, id string) {
	// Recovery is tenant-scoped and runs only under the current billing writer.
	// It releases stale reservations; it never repeats inference or storage PUTs.
	_ = reconcileImageSet(r.Context(), h.deps.Deps, org, id)
	view, err := readImageSet(r.Context(), h.deps.Deps, org, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeResp(w, fail(404, "NOT_FOUND", "套图不存在"))
		return
	}
	if err != nil {
		writeResp(w, fail(500, "INTERNAL", "服务暂不可用"))
		return
	}
	status := 200
	if view.Status == "processing" {
		status = 202
	}
	jsonwire.Write(w, status, view)
}

func imageTx(ctx context.Context, deps Deps, org int64, fn func(pgx.Tx) error) error {
	if deps.Pool == nil {
		return errors.New("pool missing")
	}
	tx, err := tenantx.BeginApp(ctx, deps.Pool.Begin, org)
	if err != nil {
		return err
	}
	defer endTx(ctx, tx)
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
