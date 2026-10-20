package identity

import (
	"fmt"
	"strings"
	"unicode"
)

const (
	nameMaxChars     = 24
	renameCooldownMS = 24 * 60 * 60 * 1000
)

var bannedNameTerms = []string{
	"暴力", "血腥", "屠杀", "杀戮", "砍杀", "灭门", "恐怖袭击", "恐怖主义", "杀人", "强奸", "轮奸", "自杀",
	"色情", "淫秽", "涩情", "黄片", "裸聊", "裸体", "援交", "卖淫", "嫖娼", "约炮", "做爱", "性交易", "成人视频",
	"赌博", "博彩", "赌场", "赌球", "赌钱", "百家乐", "老虎机", "六合彩", "时时彩", "北京赛车", "网上赌",
	"毒品", "吸毒", "贩毒", "制毒", "冰毒", "大麻", "可卡因", "海洛因", "摇头丸", "鸦片", "吗啡", "氯胺酮",
	"porn", "hentai", "nsfw", "casino", "gambl", "bet365", "cocaine", "heroin", "marijuana", "methamphetamine", "opium", "prostitut",
}

func validateName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len([]rune(name)) > nameMaxChars {
		return "", fmt.Errorf("名字须为 1-%d 个字符", nameMaxChars)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", fmt.Errorf("名字不能包含控制字符")
		}
	}
	if hasBannedTerm(name) {
		return "", fmt.Errorf("名字包含违规内容，请更换后重试")
	}
	return name, nil
}

func hasBannedTerm(name string) bool {
	normalized := normalizeName(name)
	for _, term := range bannedNameTerms {
		if strings.Contains(normalized, term) {
			return true
		}
	}
	return false
}

func normalizeName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			continue
		}
		for _, lower := range strings.ToLower(string(r)) {
			b.WriteRune(lower)
		}
	}
	return b.String()
}

func cooldownMessage(remainingMS int64) string {
	if remainingMS >= 3_600_000 {
		hours := (remainingMS + 3_600_000 - 1) / 3_600_000
		return fmt.Sprintf("名字每 24 小时只能修改一次，约 %d 小时后可再改", hours)
	}
	minutes := (remainingMS + 60_000 - 1) / 60_000
	return fmt.Sprintf("名字每 24 小时只能修改一次，约 %d 分钟后可再改", minutes)
}
