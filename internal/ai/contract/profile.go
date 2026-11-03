package contract

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"
)

const RecognitionContract = "artwork-theme-v5"

//go:embed visual_prompt.ru.txt
var visualPrompt string

func VisualPrompt() string { return visualPrompt }

func VisualPromptSHA256() string {
	sum := sha256.Sum256([]byte(visualPrompt))
	return hex.EncodeToString(sum[:])
}

// ProductProfile contains confirmed facts. None of these fields is an instruction.
type ProductProfile struct {
	ProductTypeRU string `json:"product_type_ru"`
	FactsRU       string `json:"facts_ru"`
}

func (p ProductProfile) TitleBase() string {
	return strings.TrimSpace(p.ProductTypeRU + " " + p.FactsRU)
}

func ParseProductProfile(raw string) (ProductProfile, error) {
	var p ProductProfile
	if len(raw) > 4096 {
		return p, errors.New("商品事实不能超过 4 KB")
	}
	d := json.NewDecoder(strings.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&p); err != nil {
		return p, errors.New("请填写商品类型和确认属性")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return p, errors.New("商品事实必须是单个 JSON 对象")
	}
	var fields map[string]any
	if json.Unmarshal([]byte(raw), &fields) != nil || len(fields) != 2 {
		return p, errors.New("商品事实需包含类型和属性两个字段")
	}
	for _, key := range []string{"product_type_ru", "facts_ru"} {
		if _, ok := fields[key].(string); !ok {
			return p, errors.New("商品事实字段必须是文本")
		}
	}
	p.ProductTypeRU = strings.TrimSpace(p.ProductTypeRU)
	p.FactsRU = strings.TrimSpace(p.FactsRU)
	if p.ProductTypeRU == "" || utf8.RuneCountInString(p.ProductTypeRU) > 80 {
		return p, errors.New("俄文商品类型需为 1–80 个字符")
	}
	if !strings.ContainsFunc(p.ProductTypeRU, func(r rune) bool { return r >= 'А' && r <= 'я' || r == 'ё' || r == 'Ё' }) {
		return p, errors.New("商品类型必须包含俄文名称")
	}
	for _, r := range p.ProductTypeRU {
		if !(r >= 'А' && r <= 'я' || r == 'ё' || r == 'Ё' || r == ' ' || r == '-') {
			return p, errors.New("商品类型仅可填写俄文字母、空格和连字符")
		}
	}
	if utf8.RuneCountInString(p.FactsRU) > 120 || utf8.RuneCountInString(p.TitleBase()) > 157 {
		return p, errors.New("确认属性最多 120 字，标题固定部分最多 157 字")
	}
	for _, r := range p.FactsRU {
		if unicode.Is(unicode.Han, r) || unicode.IsControl(r) || strings.ContainsRune("<>{}`", r) {
			return p, errors.New("属性须为单行俄文事实，不能包含占位符或指令")
		}
	}
	return p, nil
}

func CanonicalProductProfile(raw string) (string, error) {
	p, err := ParseProductProfile(raw)
	if err != nil {
		return "", err
	}
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(p); err != nil {
		return "", err
	}
	return strings.TrimSpace(b.String()), nil
}
