package aihttp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

type ocrTestInput struct {
	SourceID  string            `json:"source_id"`
	ProductID string            `json:"product_id"`
	Profile   ai.ProductProfile `json:"profile"`
	Tags      []string          `json:"fixed_tags"`
	Model     string            `json:"model"`
	Image     ai.Image          `json:"image"`
}
type ocrTestBody struct {
	Input  ocrTestInput `json:"input"`
	Ticket string       `json:"upload_ticket,omitempty"`
}

func testKey(id string) string { return "ocr-test:v1:" + id }
func testFingerprint(in ocrTestInput) string {
	raw, _ := json.Marshal(in)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func testBinding(id string, in ocrTestInput) (ai.Claim, ai.Binding) {
	raw, _ := json.Marshal(in.Profile)
	sum := sha256.Sum256(raw)
	return ai.Claim{JobID: id, Lease: ai.Lease{Owner: "ocr-test", Epoch: 1}}, ai.Binding{Fingerprint: testFingerprint(in), Pin: ai.Pin{Contract: ai.RecognitionContract, Prompt: ai.Prompt{ID: "supplier:" + in.ProductID, Content: string(raw), SHA256: hex.EncodeToString(sum[:]), FixedTags: in.Tags, TemplateSHA256: ai.VisualPromptSHA256()}, Routing: ai.Routing{Primary: in.Model}}}
}
func (h httpHandler) testMember(w http.ResponseWriter, r *http.Request) (*access.Principal, string, bool) {
	p, ok := member(w, h.deps.Access, r)
	if !ok {
		return nil, "", false
	}
	if !access.IsPlatformStaff(p.PlatformRole) {
		writeResp(w, fail(403, "FORBIDDEN", "需要商品库管理权限"))
		return nil, "", false
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeResp(w, fail(400, "VALIDATION", "测试编号无效"))
		return nil, "", false
	}
	if h.deps.Pool == nil || h.deps.OCR == nil || h.deps.OCR.TestAuthorize == nil || h.deps.OCR.Validate == nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "识图测试尚未配置"))
		return nil, "", false
	}
	return p, id.String(), true
}
func (h httpHandler) testInput(w http.ResponseWriter, r *http.Request, p access.Principal) (ocrTestBody, bool) {
	var body ocrTestBody
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
	dec.DisallowUnknownFields()
	if dec.Decode(&body) != nil || dec.Decode(new(any)) != io.EOF {
		writeResp(w, fail(400, "VALIDATION", "测试输入无效"))
		return body, false
	}
	in := &body.Input
	if in.SourceID == "" || in.ProductID == "" || len(in.SourceID) > 128 || len(in.ProductID) > 128 || len(in.Tags) < 1 || len(in.Tags) > 30 || h.deps.OCR.TestAuthorize(r.Context(), p, in.SourceID, in.ProductID) != nil {
		writeResp(w, fail(404, "NOT_FOUND", "商品不存在或无权访问"))
		return body, false
	}
	raw, _ := json.Marshal(in.Profile)
	profile, err := ai.ParseProductProfile(string(raw))
	if err != nil {
		writeResp(w, fail(422, "VALIDATION", err.Error()))
		return body, false
	}
	in.Profile = profile
	if h.deps.OCR.Models == nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "识别模型不可用"))
		return body, false
	}
	models, preferred, err := h.deps.OCR.Models(r.Context())
	if err != nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "识别模型不可用"))
		return body, false
	}
	if in.Model == "" {
		in.Model = preferred
	}
	known := false
	for _, model := range models {
		known = known || model == in.Model
	}
	if !known {
		writeResp(w, fail(422, "VALIDATION", "识别模型不可用"))
		return body, false
	}
	_, binding := testBinding("", *in)
	if _, err := h.deps.OCR.Validate(r.Context(), binding.Pin, []byte(`{"choices":[{"message":{"content":"{\"state\":\"plain\",\"theme_ru\":\"\",\"description_ru\":\"\",\"tags\":[]}"}}]}`)); err != nil {
		var violation *ai.ContractError
		if errors.As(err, &violation) {
			writeResp(w, fail(422, "VALIDATION", violation.Message))
		} else {
			writeResp(w, fail(503, "RELAY_UNAVAILABLE", "识图输入校验暂不可用"))
		}
		return body, false
	}
	if in.Image.Bytes == 0 || in.Image.Bytes > 1400000 || len(in.Image.SHA256) != 64 || (in.Image.ContentType != "image/png" && in.Image.ContentType != "image/jpeg") {
		writeResp(w, fail(422, "VALIDATION", "图片信息无效"))
		return body, false
	}
	return body, true
}
func (h httpHandler) ocrTestUpload(w http.ResponseWriter, r *http.Request) {
	p, id, ok := h.testMember(w, r)
	if !ok {
		return
	}
	body, ok := h.testInput(w, r, *p)
	if !ok {
		return
	}
	c, b := testBinding(id, body.Input)
	if h.deps.OCR.Issue == nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "私有图片存储不可用"))
		return
	}
	target, err := h.deps.OCR.Issue(r.Context(), *p, c, b, body.Input.Image)
	if err != nil {
		writeResp(w, fail(422, "VALIDATION", "无法创建私有图片上传"))
		return
	}
	ocrData(w, map[string]any{"input": body.Input, "target": target})
}
func (h httpHandler) testPixels(ctx context.Context, p access.Principal, id string, body ocrTestBody) ([]byte, string, error) {
	if h.deps.OCR.Read == nil || body.Ticket == "" {
		return nil, "", errors.New("missing upload")
	}
	c, b := testBinding(id, body.Input)
	return h.deps.OCR.Read(ctx, p, c, b, body.Ticket)
}
func (h httpHandler) ocrTestConfirm(w http.ResponseWriter, r *http.Request) {
	p, id, ok := h.testMember(w, r)
	if !ok {
		return
	}
	body, ok := h.testInput(w, r, *p)
	if !ok {
		return
	}
	raw, _, err := h.testPixels(r.Context(), *p, id, body)
	if errors.Is(err, ai.ErrImageMissing) {
		writeResp(w, fail(404, "MEDIA_COMPLETE_MISSING", "图片尚未上传"))
		return
	}
	if err != nil {
		writeResp(w, fail(409, "CONFLICT", "图片字节校验未通过"))
		return
	}
	ocrData(w, map[string]any{"bytes": len(raw), "sha256": body.Input.Image.SHA256})
}
func (h httpHandler) ocrTestPost(w http.ResponseWriter, r *http.Request) {
	p, id, ok := h.testMember(w, r)
	if !ok {
		return
	}
	body, ok := h.testInput(w, r, *p)
	if !ok {
		return
	}
	if replay, found := h.lookupTest(r.Context(), *p, id, testFingerprint(body.Input)); found {
		writeResp(w, replay)
		return
	}
	pixels, mime, err := h.testPixels(r.Context(), *p, id, body)
	if errors.Is(err, ai.ErrImageMissing) {
		writeResp(w, fail(404, "MEDIA_COMPLETE_MISSING", "图片尚未上传"))
		return
	}
	if err != nil {
		writeResp(w, fail(409, "CONFLICT", "图片字节校验未通过"))
		return
	}
	if h.deps.OCR.Resolve == nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "识别模型不可用"))
		return
	}
	_, binding := testBinding(id, body.Input)
	provider, err := h.deps.OCR.Resolve(r.Context(), binding.Pin.Routing)
	if err != nil {
		writeResp(w, fail(503, "RELAY_UNAVAILABLE", "识别模型不可用"))
		return
	}
	request, err := ai.RecognitionRequest(provider.Model, binding.Pin.Prompt, "data:"+mime+";base64,"+base64.StdEncoding.EncodeToString(pixels))
	if err != nil {
		writeResp(w, fail(422, "VALIDATION", err.Error()))
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
	defer cancel()
	_, resp := h.completeOCR(ctx, *p, provider, request, func(price billing.Price, hold int64) (openedHold, Response) {
		fresh, refusal, authErr := h.deps.Access.Resolve(r.WithContext(ctx))
		if authErr != nil || refusal != nil || fresh == nil || fresh.UserID != p.UserID || fresh.OrgID != p.OrgID || fresh.PlatformRole != p.PlatformRole || fresh.TokenHash != p.TokenHash {
			return openedHold{}, fail(403, "FORBIDDEN", "登录或工作空间权限已变化，测试未受理")
		}
		return h.openTestHold(ctx, *fresh, id, body.Input, provider, price, hold)
	})
	if resp.Status != 0 {
		if replay, found := h.lookupTest(ctx, *p, id, testFingerprint(body.Input)); found {
			writeResp(w, replay)
			return
		}
		writeResp(w, resp)
		return
	}
	if replay, found := h.lookupTest(ctx, *p, id, testFingerprint(body.Input)); found {
		writeResp(w, replay)
		return
	}
	writeResp(w, fail(500, "INTERNAL", "测试回执等待恢复，请读取本次结果"))
}
func (h httpHandler) ocrTestGet(w http.ResponseWriter, r *http.Request) {
	p, id, ok := h.testMember(w, r)
	if !ok {
		return
	}
	if replay, found := h.lookupTest(r.Context(), *p, id, ""); found {
		writeResp(w, replay)
		return
	}
	writeResp(w, fail(404, "NOT_FOUND", "测试尚未记录，请使用相同测试编号重试或稍后读取"))
}
