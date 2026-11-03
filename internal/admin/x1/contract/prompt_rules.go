package contract

import (
	"errors"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	"path"
	"strings"
	"unicode/utf8"
)

const (
	maxScalarName = 255
	maxFixedTags  = 30
	maxTagChars   = 30
)

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

// CanonicalProfile stores confirmed facts, never model instructions.
func CanonicalProfile(raw string) (string, error) { return ai.CanonicalProductProfile(raw) }

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
