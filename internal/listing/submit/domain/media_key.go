package domain

import (
	"strconv"
	"strings"
	"time"
	"unicode"
)

// SubmitMaxAgeDays is media-core SUBMIT_MAX_AGE_DAYS (RETENTION_DAYS - 2).
const SubmitMaxAgeDays = 28

// UploadKey is the structural read of a batched image key.
// Source: crates/media-core/src/object_key/parse.rs in xxww0098/podhub;
// media-core has no crate in this repository's rust/crates/.
type UploadKey struct {
	WorkspaceUUID string
	BatchMS       int64
	Digest        string
}

// ParseUploadKey reads a canonical batch image key out of a key or a URL.
// Anything else is false. The rules are transcribed from parse_upload_key
// at a03d735; media-core is not linked into this module.
func ParseUploadKey(key string) (UploadKey, bool) {
	for _, segment := range strings.Split(key, "/") {
		if segment == "." || segment == ".." {
			return UploadKey{}, false
		}
	}
	tail := key
	if rest, ok := strings.CutPrefix(key, "uploads/"); ok {
		tail = rest
	} else if _, rest, ok := strings.Cut(key, "/uploads/"); ok {
		tail = rest
	} else {
		return UploadKey{}, false
	}
	parts := strings.Split(tail, "/")
	if len(parts) != 7 {
		return UploadKey{}, false
	}
	date, batch, class, teams, workspace, shaSeg, file := parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
	if class != "images" || teams != "teams" || shaSeg != "sha256" || !isUUIDv4(workspace) {
		return UploadKey{}, false
	}
	digest, ext, ok := strings.Cut(file, ".")
	if !ok || (ext != "jpg" && ext != "png") || !isDigest(digest) {
		return UploadKey{}, false
	}
	timestamp, batchUUID, ok := strings.Cut(batch, "-")
	if !ok || len(timestamp) < 13 || !digits(timestamp) || !uuidAny(batchUUID) {
		return UploadKey{}, false
	}
	batchMS, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return UploadKey{}, false
	}
	when := time.UnixMilli(batchMS).UTC()
	if when.Format("2006-01-02") != date {
		return UploadKey{}, false
	}
	return UploadKey{WorkspaceUUID: workspace, BatchMS: batchMS, Digest: digest}, true
}

// MediaSkip is a draft image the server will not send.
type MediaSkip string

const (
	MediaForeign MediaSkip = "media_foreign"
	MediaExpired MediaSkip = "media_expired"
)

// ImageIssue is media_key_issue for one draft's images. Videos are not
// judged here: the supplier and pool checks live in submit_drafts_media.rs
// and are not called.
func ImageIssue(images []string, workspace string, nowMS int64) (MediaSkip, bool) {
	maxAge := int64(SubmitMaxAgeDays) * 24 * 60 * 60 * 1000
	for _, raw := range images {
		url := strings.TrimSpace(raw)
		if url == "" {
			continue
		}
		key, ok := ParseUploadKey(url)
		if !ok || !strings.EqualFold(key.WorkspaceUUID, workspace) {
			return MediaForeign, true
		}
		if nowMS-key.BatchMS > maxAge {
			return MediaExpired, true
		}
	}
	return "", false
}

func isDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, r := range value {
		if !unicode.Is(unicode.ASCII_Hex_Digit, r) {
			return false
		}
	}
	return true
}

func digits(value string) bool {
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return value != ""
}

func isUUIDv4(value string) bool {
	if len(value) != 36 || value[14] != '4' {
		return false
	}
	for i := 0; i < len(value); i++ {
		switch i {
		case 8, 13, 18, 23:
			if value[i] != '-' {
				return false
			}
		default:
			if !isHexByte(value[i]) {
				return false
			}
		}
	}
	return true
}

func uuidAny(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i := 0; i < len(value); i++ {
		switch i {
		case 8, 13, 18, 23:
			if value[i] != '-' {
				return false
			}
		default:
			if !isHexByte(value[i]) {
				return false
			}
		}
	}
	return true
}

func isHexByte(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}
