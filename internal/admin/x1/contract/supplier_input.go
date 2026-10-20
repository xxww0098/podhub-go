package contract

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf8"

	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
)

// RowInput is a normalized create or update body.
type RowInput struct {
	Title                 string
	PlatformCode          string
	VariantGroup          string
	DescriptionCategoryID *int64
	TypeID                *int64
	SuggestedRetail       *int64
	SuggestedOld          *int64
	CostCents             *int64
	ShippingCents         *int64
	LeadTime              string
	Size                  string
	Material              string
	Craft                 string
	GrossWeightG          *int64
	Brand                 string
	PackWidthMM           *int64
	PackHeightMM          *int64
	PackDepthMM           *int64
	PackWeightG           *int64
	Contents              string
	Gallery               json.RawMessage
	PSD                   json.RawMessage
	Videos                json.RawMessage
	PromptName            string
	PromptFileName        string
	PromptContent         string
	FixedTags             []string
	Description           string
	InternalNote          string
	Props                 json.RawMessage
	ExpectedRevision      *int64
	Archived              bool
	HasExpected           bool
}

type rowWire struct {
	Title                 string          `json:"title"`
	PlatformCode          string          `json:"platformCode"`
	VariantGroup          string          `json:"variantGroup"`
	DescriptionCategoryID *int64          `json:"descriptionCategoryId"`
	TypeID                *int64          `json:"typeId"`
	SuggestedRetail       *int64          `json:"suggestedRetailCents"`
	SuggestedOld          *int64          `json:"suggestedOldPriceCents"`
	CostCents             *int64          `json:"costCents"`
	ShippingCents         *int64          `json:"shippingCostCents"`
	LeadTime              string          `json:"leadTime"`
	Size                  string          `json:"size"`
	Material              string          `json:"material"`
	Craft                 string          `json:"craft"`
	GrossWeightG          *int64          `json:"grossWeightG"`
	Brand                 string          `json:"brand"`
	PackWidthMM           *int64          `json:"packWidthMm"`
	PackHeightMM          *int64          `json:"packHeightMm"`
	PackDepthMM           *int64          `json:"packDepthMm"`
	PackWeightG           *int64          `json:"packWeightG"`
	Contents              string          `json:"contents"`
	Gallery               json.RawMessage `json:"gallery"`
	PSD                   json.RawMessage `json:"psd"`
	Videos                json.RawMessage `json:"productVideos"`
	PromptName            string          `json:"promptName"`
	PromptFileName        string          `json:"promptFileName"`
	PromptContent         string          `json:"promptContent"`
	FixedTags             []string        `json:"fixedTags"`
	Description           string          `json:"description"`
	InternalNote          string          `json:"internalNote"`
	Props                 json.RawMessage `json:"props"`
	ExpectedRevision      *int64          `json:"expectedRevision"`
	Archived              bool            `json:"archived"`
}

// DecodeRow rejects unknown fields. Update requires expectedRevision.
func DecodeRow(body []byte, update bool) (RowInput, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var wire rowWire
	if err := dec.Decode(&wire); err != nil || dec.More() {
		return RowInput{}, invalid()
	}
	if update && wire.ExpectedRevision == nil {
		return RowInput{}, fail(contract.KindValidation, "expectedRevision 必填")
	}
	if !update && wire.Archived {
		return RowInput{}, fail(contract.KindValidation, "新建行不能是归档态")
	}
	title := strings.TrimSpace(wire.Title)
	if title == "" {
		title = "未命名"
	}
	if utf8.RuneCountInString(title) > MaxNameChars {
		return RowInput{}, fail(contract.KindValidation, "名称需为 1–80 个字符")
	}
	for _, n := range []*int64{wire.CostCents, wire.ShippingCents, wire.GrossWeightG, wire.PackWidthMM, wire.PackHeightMM, wire.PackDepthMM, wire.PackWeightG, wire.SuggestedRetail, wire.SuggestedOld} {
		if n != nil && *n <= 0 {
			return RowInput{}, fail(contract.KindValidation, "数值必须大于 0")
		}
	}
	gallery, err := canonGallery(wire.Gallery)
	if err != nil {
		return RowInput{}, err
	}
	psd, err := canonFiles(wire.PSD)
	if err != nil {
		return RowInput{}, err
	}
	videos, err := canonVideos(wire.Videos)
	if err != nil {
		return RowInput{}, err
	}
	props := bytes.TrimSpace(wire.Props)
	if len(props) == 0 {
		props = []byte(`{}`)
	}
	if !json.Valid(props) || props[0] != '{' {
		return RowInput{}, invalid()
	}
	tags, err := NormalizeTags(wire.FixedTags, false)
	if err != nil {
		return RowInput{}, err
	}
	content := strings.TrimSpace(wire.PromptContent)
	if content != "" {
		content, err = CanonicalBrief(wire.PromptContent)
		if err != nil {
			return RowInput{}, fail(contract.KindValidation, err.Error())
		}
	}
	return RowInput{
		Title: title, PlatformCode: strings.TrimSpace(wire.PlatformCode), VariantGroup: wire.VariantGroup,
		DescriptionCategoryID: wire.DescriptionCategoryID, TypeID: wire.TypeID,
		SuggestedRetail: wire.SuggestedRetail, SuggestedOld: wire.SuggestedOld,
		CostCents: wire.CostCents, ShippingCents: wire.ShippingCents,
		LeadTime: strings.TrimSpace(wire.LeadTime), Size: strings.TrimSpace(wire.Size),
		Material: strings.TrimSpace(wire.Material), Craft: strings.TrimSpace(wire.Craft),
		GrossWeightG: wire.GrossWeightG, Brand: strings.TrimSpace(wire.Brand),
		PackWidthMM: wire.PackWidthMM, PackHeightMM: wire.PackHeightMM, PackDepthMM: wire.PackDepthMM, PackWeightG: wire.PackWeightG,
		Contents: strings.TrimSpace(wire.Contents), Gallery: gallery, PSD: psd, Videos: videos,
		PromptName: strings.TrimSpace(wire.PromptName), PromptFileName: strings.TrimSpace(wire.PromptFileName),
		PromptContent: content, FixedTags: tags, Description: strings.TrimSpace(wire.Description),
		InternalNote: strings.TrimSpace(wire.InternalNote), Props: props,
		ExpectedRevision: wire.ExpectedRevision, Archived: wire.Archived, HasExpected: wire.ExpectedRevision != nil,
	}, nil
}

func canonGallery(raw json.RawMessage) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return []byte(`[]`), nil
	}
	var items []GalleryItem
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, invalid()
	}
	if items == nil {
		items = []GalleryItem{}
	}
	out, err := json.Marshal(items)
	if err != nil {
		return nil, invalid()
	}
	return out, nil
}

func canonFiles(raw json.RawMessage) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return []byte(`[]`), nil
	}
	var items []FileItem
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, invalid()
	}
	if items == nil {
		items = []FileItem{}
	}
	out, _ := json.Marshal(items)
	return out, nil
}

func canonVideos(raw json.RawMessage) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return []byte(`[]`), nil
	}
	var items []VideoItem
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, invalid()
	}
	if items == nil {
		items = []VideoItem{}
	}
	out, _ := json.Marshal(items)
	return out, nil
}

// RowPriceInput is the adjust-price body. Note stays out of the response.
type RowPriceInput struct {
	Cents int64
	Note  string
}

// DecodePrice requires priceCents > 0.
func DecodePrice(body []byte) (RowPriceInput, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"priceCents", "note"}) || !requireKeys(raw, []string{"priceCents", "note"}) {
		return RowPriceInput{}, invalid()
	}
	var cents int64
	var note string
	if !unmarshal(raw["priceCents"], &cents) || !unmarshal(raw["note"], &note) {
		return RowPriceInput{}, invalid()
	}
	if cents <= 0 {
		return RowPriceInput{}, fail(contract.KindValidation, "平台价必须大于 0")
	}
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > MaxNoteChars {
		return RowPriceInput{}, fail(contract.KindValidation, "内部备注不能超过 2000 个字符")
	}
	return RowPriceInput{Cents: cents, Note: note}, nil
}

// PreviewInput is the free preview body.
type PreviewInput struct {
	Brief string
	Tags  []string
}

// DecodePreview rejects unknown fields.
func DecodePreview(body []byte) (PreviewInput, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"brief", "fixedTags"}) || !requireKeys(raw, []string{"brief", "fixedTags"}) {
		return PreviewInput{}, invalid()
	}
	var brief string
	var tags []string
	if !unmarshal(raw["brief"], &brief) || !unmarshal(raw["fixedTags"], &tags) {
		return PreviewInput{}, invalid()
	}
	return PreviewInput{Brief: brief, Tags: tags}, nil
}

// PromptPatchInput is the supplier prompt PATCH body.
type PromptPatchInput struct {
	Name     string
	FileName string
	Content  string
	Tags     []string
	Expected int64
}

// DecodePromptPatch canonicalizes the brief and tags.
func DecodePromptPatch(body []byte) (PromptPatchInput, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"promptName", "promptFileName", "promptContent", "fixedTags", "expectedRevision"}) ||
		!requireKeys(raw, []string{"promptName", "promptFileName", "promptContent", "fixedTags", "expectedRevision"}) {
		return PromptPatchInput{}, invalid()
	}
	var in PromptPatchInput
	if !unmarshal(raw["promptName"], &in.Name) || !unmarshal(raw["promptFileName"], &in.FileName) ||
		!unmarshal(raw["promptContent"], &in.Content) || !unmarshal(raw["fixedTags"], &in.Tags) ||
		!unmarshal(raw["expectedRevision"], &in.Expected) {
		return PromptPatchInput{}, invalid()
	}
	name, err := PromptName(in.Name)
	if err != nil {
		return PromptPatchInput{}, fail(contract.KindValidation, err.Error())
	}
	file, err := PromptFile(in.FileName)
	if err != nil {
		return PromptPatchInput{}, fail(contract.KindValidation, err.Error())
	}
	content, err := CanonicalBrief(in.Content)
	if err != nil {
		return PromptPatchInput{}, fail(contract.KindValidation, err.Error())
	}
	tags, err := NormalizeTags(in.Tags, true)
	if err != nil {
		return PromptPatchInput{}, err
	}
	return PromptPatchInput{Name: name, FileName: file, Content: content, Tags: tags, Expected: in.Expected}, nil
}

// DecodeRevision reads {"revision": n} and rejects n <= 0.
func DecodeRevision(body []byte) (int32, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"revision"}) || !requireKeys(raw, []string{"revision"}) {
		return 0, invalid()
	}
	var n int32
	if !unmarshal(raw["revision"], &n) {
		return 0, invalid()
	}
	if n <= 0 {
		return 0, fail(contract.KindValidation, "版本号必须为正整数")
	}
	return n, nil
}
