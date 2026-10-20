package contract

import (
	"errors"
	"path"
	"strings"
	"unicode/utf8"
)

const (
	maxScalarName = 255
	maxBriefBytes = 4096
	maxFixedTags  = 30
	maxTagChars   = 30
)

var briefLabels = []string{
	"Товар:",
	"Тема:",
	"Заголовок:",
	"Не пиши:",
	"Описание:",
	"Не выдумывай:",
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// PromptName trims and requires 1–255 Unicode scalars.
func PromptName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || utf8.RuneCountInString(name) > maxScalarName {
		return "", errors.New("提示词名称需为 1–255 个字符")
	}
	return name, nil
}

// PromptFile requires Path::extension to be the case-sensitive string md or txt.
func PromptFile(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	ext := path.Ext(name)
	stem := strings.TrimSuffix(path.Base(name), ext)
	if stem == "" || stem == "." || (ext != ".md" && ext != ".txt") {
		return "", errors.New("提示词文件名必须是 .md 或 .txt")
	}
	return name, nil
}

// CanonicalBrief stores six trimmed lines joined by LF.
// The byte cap is measured after BOM removal and trim, before the join.
func CanonicalBrief(raw string) (string, error) {
	text := strings.TrimPrefix(raw, "\uFEFF")
	text = strings.TrimSpace(text)
	if len(text) > maxBriefBytes {
		return "", errors.New("提示词正文超过 4 KB（" + itoa(len(text)) + " 字节）")
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		lines = append(lines, line)
	}
	if len(lines) != 6 {
		return "", errors.New("提示词正文应为 6 行商品说明（Товар / Тема / Заголовок / Не пиши / Описание / Не выдумывай），现在是 " + itoa(len(lines)) + " 行")
	}
	for i, line := range lines {
		label := briefLabels[i]
		if !strings.HasPrefix(line, label) {
			return "", errors.New("第 " + itoa(i+1) + " 行应以「" + label + "」开头")
		}
		rest := strings.TrimSpace(strings.TrimPrefix(line, label))
		if rest == "" {
			return "", errors.New("「" + label + "」后面没有内容")
		}
		if containsHan(line) {
			return "", errors.New("「" + label + "」这一行含汉字，只能写俄文")
		}
		if label == "Заголовок:" && !titleFormula(rest) {
			return "", errors.New("「Заголовок:」要用反引号包住标题公式，公式里要有 \"<тема>\"")
		}
	}
	return strings.Join(lines, "\n"), nil
}

func titleFormula(rest string) bool {
	start := strings.IndexByte(rest, '`')
	if start < 0 {
		return false
	}
	end := strings.IndexByte(rest[start+1:], '`')
	if end < 0 {
		return false
	}
	return strings.Contains(rest[start+1:start+1+end], `"<тема>"`)
}

func containsHan(s string) bool {
	for _, r := range s {
		if r >= 0x3400 && r <= 0x4DBF || r >= 0x4E00 && r <= 0x9FFF || r >= 0xF900 && r <= 0xFAFF || r >= 0x20000 && r <= 0x323AF {
			return true
		}
	}
	return false
}

// FixedTags checks the 1–30 Russian hashtag list.
func FixedTags(tags []string) error {
	if len(tags) == 0 || len(tags) > maxFixedTags {
		return errors.New("固定标签必须 1–30 个")
	}
	seen := map[string]struct{}{}
	for _, tag := range tags {
		n := utf8.RuneCountInString(tag)
		if n < 2 || n > maxTagChars {
			return errors.New("固定标签长度必须为 2–30 个字符")
		}
		if !strings.HasPrefix(tag, "#") || !tagBody(tag[1:]) {
			return errors.New("固定标签必须是以 # 开头的俄语标签")
		}
		key := strings.ToLower(tag)
		if _, ok := seen[key]; ok {
			return errors.New("固定标签不能重复")
		}
		seen[key] = struct{}{}
	}
	return nil
}

func tagBody(body string) bool {
	if body == "" {
		return false
	}
	parts := strings.Split(body, "_")
	for _, part := range parts {
		if part == "" {
			return false
		}
		cyr := false
		for _, r := range part {
			if isCyr(r) {
				cyr = true
				continue
			}
			if r < '0' || r > '9' {
				return false
			}
		}
		if !cyr {
			return false
		}
	}
	return true
}

func isCyr(r rune) bool {
	switch {
	case r >= 'а' && r <= 'я', r >= 'А' && r <= 'Я', r == 'ё', r == 'Ё':
		return true
	default:
		return false
	}
}
