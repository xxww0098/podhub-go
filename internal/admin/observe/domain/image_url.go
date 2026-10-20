package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// ImageClass is how a stored primary_image is shown.
type ImageClass int

const (
	ImageDrop ImageClass = iota
	ImageDirect
	ImageProxy
)

// ClassifyImage ports classify_stored_image from the thumbnail fixture.
func ClassifyImage(raw string) (ImageClass, string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ImageDrop, ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return ImageDrop, ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ImageDrop, ""
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return ImageDrop, ""
	}
	if ozonCDN(host) {
		if parsed.Port() != "" && parsed.Port() != "80" && parsed.Port() != "443" {
			return ImageDrop, ""
		}
		parsed.Scheme = "https"
		parsed.Host = host
		return ImageProxy, parsed.String()
	}
	if parsed.Scheme != "https" {
		return ImageDrop, ""
	}
	return ImageDirect, parsed.String()
}

func ozonCDN(host string) bool {
	host = strings.ToLower(host)
	if net.ParseIP(host) != nil {
		return false
	}
	for _, r := range host {
		if r > 127 {
			return false
		}
	}
	return host == "ozone.ru" || host == "ozon.ru" || strings.HasSuffix(host, ".ozone.ru") || strings.HasSuffix(host, ".ozon.ru")
}

// AdminImageURL is the list URL. Proxy URLs become the admin thumbnail path.
// v is the first 8 bytes of SHA-256 over the canonical proxy URL, hex encoded.
func AdminImageURL(storeID string, productID int64, raw string) (string, bool) {
	class, canonical := ClassifyImage(raw)
	switch class {
	case ImageDrop:
		return "", false
	case ImageDirect:
		return canonical, true
	default:
		sum := sha256.Sum256([]byte(canonical))
		v := hex.EncodeToString(sum[:8])
		return "/api/admin/stores/" + storeID + "/products/" + strconv.FormatInt(productID, 10) + "/thumbnail?v=" + v, true
	}
}

// NextHop resolves one thumbnail redirect and keeps it on an Ozon CDN.
func NextHop(current, location string) (string, bool) {
	base, err := url.Parse(current)
	if err != nil {
		return "", false
	}
	next, err := base.Parse(location)
	if err != nil || next.User != nil {
		return "", false
	}
	if next.Scheme != "https" || next.Port() != "" || !ozonCDN(next.Hostname()) {
		return "", false
	}
	return next.String(), true
}

// SniffImage returns a raster content type, or blank when the bytes are not one.
func SniffImage(body []byte) string {
	if len(body) >= 3 && body[0] == 0xFF && body[1] == 0xD8 && body[2] == 0xFF {
		return "image/jpeg"
	}
	if len(body) >= 8 && body[0] == 0x89 && body[1] == 'P' && body[2] == 'N' && body[3] == 'G' && body[4] == '\r' && body[5] == '\n' && body[6] == 0x1A && body[7] == '\n' {
		return "image/png"
	}
	if len(body) >= 6 && (string(body[:6]) == "GIF87a" || string(body[:6]) == "GIF89a") {
		return "image/gif"
	}
	if len(body) >= 12 && string(body[:4]) == "RIFF" && string(body[8:12]) == "WEBP" {
		return "image/webp"
	}
	return ""
}
