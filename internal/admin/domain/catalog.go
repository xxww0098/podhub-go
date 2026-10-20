package domain

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"unicode/utf8"

	catcontract "github.com/xxww0098/podhub-go/internal/admin/catalog/contract"
)

const (
	maxTextChars = 255
	maxShort     = 64
	maxDesc      = 4000
	maxMedia     = 20
	maxSpecs     = 30
	maxURLChars  = 2048

	msgBadCatalogJSON = "请求格式无效"
	msgRevision       = "expectedRevision 无效"
	msgUnmanaged      = "该行由平台货源管理，请在平台货源中操作"
	msgMissing        = "记录不存在或未上架"
	msgConflict       = "记录已被更新，请刷新后重试"
	msgCodeTaken      = "平台编码已存在"
	msgUnknownProduct = "平台商品不存在"
	msgPickProduct    = "请选择平台商品"
	msgPrice          = "平台价必须大于 0"
	msgMediaFull      = "图片数量已达上限"
	msgMediaURL       = "图片须先通过图片上传接口写入媒体存储"
	msgWritesCatalog  = "平台目录写入未启用"
	msgNoMediaConfig  = "平台尚未配置媒体存储"
)

// Product and SKU are the platform catalog rows. Shipping fields are omitted when nil.
type (
	Product      = catcontract.Product
	SKU          = catcontract.SKU
	ProductInput = catcontract.ProductInput
	SKUInput     = catcontract.SKUInput
	ImageTarget  = catcontract.ImageTarget
)

// CatalogList is the admin list envelope.
type CatalogList struct {
	Data struct {
		Products []Product `json:"products"`
		SKUs     []SKU     `json:"skus"`
	} `json:"data"`
}

// ProductMutation wraps one product.
type ProductMutation struct {
	Data struct {
		Product Product `json:"product"`
	} `json:"data"`
}

// SKUMutation wraps one SKU.
type SKUMutation struct {
	Data struct {
		SKU SKU `json:"sku"`
	} `json:"data"`
}

// DecodeJSON rejects unknown fields, a second value, and an empty body.
func DecodeJSON(raw []byte, dest any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dest); err != nil {
		return Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	return nil
}

type productBody struct {
	Title            *string           `json:"title"`
	Description      string            `json:"description"`
	Media            []string          `json:"media"`
	Specs            map[string]string `json:"specs"`
	ExpectedRevision *int64            `json:"expectedRevision"`
}

type skuCreateBody struct {
	ProductID    *string           `json:"productId"`
	PlatformCode *string           `json:"platformCode"`
	Title        *string           `json:"title"`
	Media        []string          `json:"media"`
	Specs        map[string]string `json:"specs"`
	LeadTime     string            `json:"leadTime"`
}

type skuUpdateBody struct {
	ExpectedRevision *int64            `json:"expectedRevision"`
	Title            *string           `json:"title"`
	Media            []string          `json:"media"`
	Specs            map[string]string `json:"specs"`
	LeadTime         string            `json:"leadTime"`
}

type casBody struct {
	ExpectedRevision *int64 `json:"expectedRevision"`
}

type priceBody struct {
	ExpectedRevision *int64 `json:"expectedRevision"`
	PriceCents       *int64 `json:"priceCents"`
}

// ParseCreateProduct requires title. Description, media, and specs default empty.
func ParseCreateProduct(raw []byte, bases []string) (ProductInput, error) {
	var body productBody
	if err := DecodeJSON(raw, &body); err != nil {
		return ProductInput{}, err
	}
	if body.Title == nil {
		return ProductInput{}, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	in := ProductInput{Title: *body.Title, Description: body.Description, Media: body.Media, Specs: body.Specs}
	if err := normalizeProduct(&in, bases, false); err != nil {
		return ProductInput{}, err
	}
	return in, nil
}

// ParseUpdateProduct requires expectedRevision and title.
func ParseUpdateProduct(raw []byte, bases []string) (ProductInput, error) {
	var body productBody
	if err := DecodeJSON(raw, &body); err != nil {
		return ProductInput{}, err
	}
	if body.Title == nil || body.ExpectedRevision == nil {
		return ProductInput{}, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	in := ProductInput{Title: *body.Title, Description: body.Description, Media: body.Media, Specs: body.Specs, Revision: *body.ExpectedRevision, HasRevision: true}
	if err := requireRevision(in.Revision); err != nil {
		return ProductInput{}, err
	}
	if err := normalizeProduct(&in, bases, false); err != nil {
		return ProductInput{}, err
	}
	return in, nil
}

// ParseCAS reads expectedRevision.
func ParseCAS(raw []byte) (int64, error) {
	var body casBody
	if err := DecodeJSON(raw, &body); err != nil {
		return 0, err
	}
	if body.ExpectedRevision == nil {
		return 0, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	if err := requireRevision(*body.ExpectedRevision); err != nil {
		return 0, err
	}
	return *body.ExpectedRevision, nil
}

// ParseCreateSKU requires productId, platformCode, and title.
func ParseCreateSKU(raw []byte, bases []string) (SKUInput, error) {
	var body skuCreateBody
	if err := DecodeJSON(raw, &body); err != nil {
		return SKUInput{}, err
	}
	if body.ProductID == nil || body.PlatformCode == nil || body.Title == nil {
		return SKUInput{}, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	in := SKUInput{ProductID: strings.TrimSpace(*body.ProductID), PlatformCode: *body.PlatformCode, Title: *body.Title, Media: body.Media, Specs: body.Specs, LeadTime: body.LeadTime}
	if in.ProductID == "" {
		return SKUInput{}, Fail(400, "VALIDATION", msgPickProduct)
	}
	if err := catalogText("平台编码", in.PlatformCode); err != nil {
		return SKUInput{}, err
	}
	if utf8.RuneCountInString(strings.TrimSpace(in.PlatformCode)) > maxShort {
		return SKUInput{}, Fail(400, "VALIDATION", "平台编码不能超过 64 个字符")
	}
	in.PlatformCode = strings.TrimSpace(in.PlatformCode)
	if err := catalogText("SKU 名称", in.Title); err != nil {
		return SKUInput{}, err
	}
	in.Title = strings.TrimSpace(in.Title)
	if err := optionalBound("交期", &in.LeadTime, maxShort); err != nil {
		return SKUInput{}, err
	}
	if err := normalizeMediaSpecs(&in.Media, &in.Specs, bases); err != nil {
		return SKUInput{}, err
	}
	return in, nil
}

// ParseUpdateSKU requires expectedRevision and title. It does not change the platform code.
func ParseUpdateSKU(raw []byte, bases []string) (SKUInput, error) {
	var body skuUpdateBody
	if err := DecodeJSON(raw, &body); err != nil {
		return SKUInput{}, err
	}
	if body.Title == nil || body.ExpectedRevision == nil {
		return SKUInput{}, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	if err := requireRevision(*body.ExpectedRevision); err != nil {
		return SKUInput{}, err
	}
	in := SKUInput{Title: *body.Title, Media: body.Media, Specs: body.Specs, LeadTime: body.LeadTime, Revision: *body.ExpectedRevision, HasRevision: true}
	if err := catalogText("SKU 名称", in.Title); err != nil {
		return SKUInput{}, err
	}
	in.Title = strings.TrimSpace(in.Title)
	if err := optionalBound("交期", &in.LeadTime, maxShort); err != nil {
		return SKUInput{}, err
	}
	if err := normalizeMediaSpecs(&in.Media, &in.Specs, bases); err != nil {
		return SKUInput{}, err
	}
	return in, nil
}

// ParsePrice requires expectedRevision and priceCents.
func ParsePrice(raw []byte) (rev, cents int64, err error) {
	var body priceBody
	if err = DecodeJSON(raw, &body); err != nil {
		return 0, 0, err
	}
	if body.ExpectedRevision == nil || body.PriceCents == nil {
		return 0, 0, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	if err = requireRevision(*body.ExpectedRevision); err != nil {
		return 0, 0, err
	}
	if *body.PriceCents <= 0 {
		return 0, 0, Fail(400, "VALIDATION", msgPrice)
	}
	return *body.ExpectedRevision, *body.PriceCents, nil
}

func normalizeProduct(in *ProductInput, bases []string, _ bool) error {
	if err := catalogText("商品名称", in.Title); err != nil {
		return err
	}
	in.Title = strings.TrimSpace(in.Title)
	if err := optionalBound("描述", &in.Description, maxDesc); err != nil {
		return err
	}
	return normalizeMediaSpecs(&in.Media, &in.Specs, bases)
}

func requireRevision(n int64) error {
	if n < 1 {
		return Fail(400, "VALIDATION", msgRevision)
	}
	return nil
}

func catalogText(label, value string) error {
	n := utf8.RuneCountInString(strings.TrimSpace(value))
	if n < 1 || n > maxTextChars {
		return Fail(400, "VALIDATION", label+"需为 1–"+itoa(maxTextChars)+" 个字符")
	}
	return nil
}

func optionalBound(label string, value *string, max int) error {
	trimmed := strings.TrimSpace(*value)
	if utf8.RuneCountInString(trimmed) > max {
		return Fail(400, "VALIDATION", label+"不能超过 "+itoa(max)+" 个字符")
	}
	*value = trimmed
	return nil
}

func normalizeMediaSpecs(media *[]string, specs *map[string]string, bases []string) error {
	if *media == nil {
		*media = []string{}
	}
	if len(*media) > maxMedia {
		return Fail(400, "VALIDATION", "媒体最多 20 项")
	}
	cleanBases := make([]string, 0, len(bases))
	for _, b := range bases {
		if b != "" {
			cleanBases = append(cleanBases, b)
		}
	}
	for i, raw := range *media {
		item := strings.TrimSpace(raw)
		n := utf8.RuneCountInString(item)
		if n < 1 || n > maxURLChars {
			return Fail(400, "VALIDATION", "每条媒体地址需为 1–2048 个字符")
		}
		ok := false
		for _, b := range cleanBases {
			if strings.HasPrefix(item, b) {
				ok = true
				break
			}
		}
		if !ok {
			return Fail(400, "VALIDATION", msgMediaURL)
		}
		(*media)[i] = item
	}
	if *specs == nil {
		*specs = map[string]string{}
	}
	if len(*specs) > maxSpecs {
		return Fail(400, "VALIDATION", "规格最多 30 项")
	}
	next := make(map[string]string, len(*specs))
	for k, v := range *specs {
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if utf8.RuneCountInString(k) < 1 || utf8.RuneCountInString(k) > maxShort || utf8.RuneCountInString(v) > maxTextChars {
			return Fail(400, "VALIDATION", "规格键需为 1–64 个字符，值不超过 255 个字符")
		}
		next[k] = v
	}
	*specs = next
	return nil
}

// FillProduct guarantees JSON arrays and objects, not null.
func FillProduct(p Product) Product { return catcontract.FillProduct(p) }

// FillSKU guarantees JSON arrays and objects, not null.
func FillSKU(s SKU) SKU { return catcontract.FillSKU(s) }

// ProductAudit is the success message for a product write.
func ProductAudit(title string, published bool, revision int64) string {
	return catcontract.ProductAudit(title, published, revision)
}

// SKUAudit is the success message for a SKU write.
func SKUAudit(title, code string, published bool, revision int64, price *int64) string {
	return catcontract.SKUAudit(title, code, published, revision, price)
}

// ImageFile is DirectUploadSpec.
type ImageFile struct {
	Bytes       uint64
	SHA256      string
	ContentType string
}

// InitImage is the presign body after strict JSON.
type InitImage struct {
	Revision int64
	File     ImageFile
}

// ConfirmImage is the object-confirmation body.
type ConfirmImage struct {
	Revision int64
	Ticket   string
}

type initImageBody struct {
	ExpectedRevision *int64 `json:"expectedRevision"`
	File             *struct {
		Bytes       *uint64 `json:"bytes"`
		SHA256      *string `json:"sha256"`
		ContentType *string `json:"contentType"`
	} `json:"file"`
}

type confirmImageBody struct {
	ExpectedRevision *int64  `json:"expectedRevision"`
	UploadTicket     *string `json:"uploadTicket"`
}

// ParseInitImage rejects unknown fields and a missing file object.
func ParseInitImage(raw []byte) (InitImage, error) {
	var body initImageBody
	if err := DecodeJSON(raw, &body); err != nil {
		return InitImage{}, err
	}
	if body.ExpectedRevision == nil || body.File == nil || body.File.Bytes == nil || body.File.SHA256 == nil || body.File.ContentType == nil {
		return InitImage{}, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	if err := requireRevision(*body.ExpectedRevision); err != nil {
		return InitImage{}, err
	}
	file := ImageFile{Bytes: *body.File.Bytes, SHA256: strings.TrimSpace(*body.File.SHA256), ContentType: *body.File.ContentType}
	if file.Bytes == 0 || file.Bytes > MaxCatalogImageBytes || file.ContentType != "image/jpeg" {
		return InitImage{}, Fail(400, "VALIDATION", "只支持不超过 512 KiB 的 JPEG 图片")
	}
	if !hexSHA256(file.SHA256) {
		return InitImage{}, Fail(400, "VALIDATION", "上传凭据无效或已过期，请重新选择文件")
	}
	return InitImage{Revision: *body.ExpectedRevision, File: file}, nil
}

// ParseConfirmImage rejects the legacy base64 field.
func ParseConfirmImage(raw []byte) (ConfirmImage, error) {
	var body confirmImageBody
	if err := DecodeJSON(raw, &body); err != nil {
		return ConfirmImage{}, err
	}
	if body.ExpectedRevision == nil || body.UploadTicket == nil {
		return ConfirmImage{}, Fail(400, "VALIDATION", msgBadCatalogJSON)
	}
	if err := requireRevision(*body.ExpectedRevision); err != nil {
		return ConfirmImage{}, err
	}
	return ConfirmImage{Revision: *body.ExpectedRevision, Ticket: *body.UploadTicket}, nil
}

// MaxCatalogImageBytes is 512 KiB.
const MaxCatalogImageBytes = 512 * 1024

func hexSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// ReplaceMedia folds owned URLs into newURL and appends when none match.
// A result longer than 20 is MediaFull.
func ReplaceMedia(current []string, replacements []string, newURL string) ([]string, error) {
	owned := map[string]bool{newURL: true}
	for _, u := range replacements {
		owned[u] = true
	}
	out := make([]string, 0, len(current)+1)
	hit := false
	for _, item := range current {
		if owned[item] {
			if !hit {
				out = append(out, newURL)
				hit = true
			}
			continue
		}
		out = append(out, item)
	}
	if !hit {
		out = append(out, newURL)
	}
	if len(out) > maxMedia {
		return nil, Fail(400, "VALIDATION", msgMediaFull)
	}
	return out, nil
}
