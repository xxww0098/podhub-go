package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Extension is one stored extension. The type is bound to it: one extension
// never maps to two MIME types.
type Extension string

const (
	ExtJPG  Extension = "jpg"
	ExtPNG  Extension = "png"
	ExtWEBP Extension = "webp"
	ExtPSD  Extension = "psd"
	ExtMP4  Extension = "mp4"
	ExtMOV  Extension = "mov"
)

// allExtensions is the public bucket allowlist. svg, html and every other
// executable type stay out.
var allExtensions = map[Extension]bool{
	ExtJPG: true, ExtPNG: true, ExtWEBP: true, ExtPSD: true, ExtMP4: true, ExtMOV: true,
}

// NormalizeExtension folds jpeg onto jpg and refuses everything else.
func NormalizeExtension(raw string) (Extension, error) {
	switch Extension(strings.ToLower(strings.TrimSpace(raw))) {
	case "jpg", "jpeg":
		return ExtJPG, nil
	case "png":
		return ExtPNG, nil
	case "webp":
		return ExtWEBP, nil
	case "psd":
		return ExtPSD, nil
	case "mp4":
		return ExtMP4, nil
	case "mov":
		return ExtMOV, nil
	default:
		return "", ErrExtension
	}
}

// ContentType is the fixed MIME type for an extension.
func ContentType(ext Extension) (string, error) {
	switch ext {
	case ExtJPG:
		return "image/jpeg", nil
	case ExtPNG:
		return "image/png", nil
	case ExtWEBP:
		return "image/webp", nil
	case ExtPSD:
		return "image/vnd.adobe.photoshop", nil
	case ExtMP4:
		return "video/mp4", nil
	case ExtMOV:
		return "video/quicktime", nil
	default:
		return "", ErrExtension
	}
}

// ObjectKey is the server-side key composition. The client never supplies a
// path: purpose, scope and digest decide every segment.
func ObjectKey(prefix string, purpose Purpose, digest string, ext Extension) (string, error) {
	normalized, err := NormalizePrefix(prefix)
	if err != nil {
		return "", err
	}
	if !allExtensions[ext] {
		return "", ErrExtension
	}
	digest = strings.ToLower(strings.TrimSpace(digest))
	if !isDigest(digest) {
		return "", ErrKey
	}
	switch purpose.Kind {
	case PurposeOrgFile:
		return normalized + "orgs/" + purpose.ID + "/files/" + digest + "." + string(ext), nil
	case PurposeOrgTemplate:
		if ext != ExtPSD {
			return "", ErrExtension
		}
		return normalized + "orgs/" + purpose.ID + "/templates/" + digest + "." + string(ext), nil
	case PurposeDelegateBinding:
		return normalized + "orgs/" + itoa(purpose.OrgID) + "/originals/" + purpose.ID + "/" + digest + "." + string(ext), nil
	case PurposeSource:
		return normalized + "sources/" + purpose.ID + "/" + digest + "." + string(ext), nil
	case PurposeCatalog:
		if ext != ExtJPG {
			return "", ErrExtension
		}
		return normalized + "catalog/" + digest + "." + string(ext), nil
	default:
		return "", ErrPurpose
	}
}

// IsKey reports whether a key matches the role's path shape. It is the check
// a proxy or a management screen runs before touching an object.
func IsKey(role Role, key string) bool {
	parts := strings.Split(key, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	switch role {
	case RoleAssets:
		return hasDigestTail(parts) && (findSegment(parts, "sources") >= 0 || findSegment(parts, "catalog") >= 0)
	case RolePrivate:
		return hasDigestTail(parts) && findSegment(parts, "orgs") >= 0
	case RoleTransit:
		return hasBatchShape(parts)
	default:
		return false
	}
}

// hasDigestTail reports a final segment that is "{64 hex}.{ext}".
func hasDigestTail(parts []string) bool {
	if len(parts) == 0 {
		return false
	}
	last := parts[len(parts)-1]
	dot := strings.LastIndexByte(last, '.')
	if dot < 0 {
		return false
	}
	if !isDigest(last[:dot]) {
		return false
	}
	_, err := NormalizeExtension(last[dot+1:])
	return err == nil
}

// hasBatchShape is the transit key shape: uploads/{date}/{batch}/images/...
func hasBatchShape(parts []string) bool {
	at := findSegment(parts, "uploads")
	return at >= 0 && at+3 < len(parts) && findSegment(parts[at:], "images") >= 0
}

func findSegment(parts []string, want string) int {
	for i, part := range parts {
		if part == want {
			return i
		}
	}
	return -1
}

func isDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	if err != nil {
		return false
	}
	return strings.ToLower(value) == value
}

// SHA256Hex validates a lowercase hex digest from a request.
func SHA256Hex(raw string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if !isDigest(value) {
		return "", ErrScope
	}
	return value, nil
}

// DigestBytes turns a validated hex digest into the registry bytea value.
func DigestBytes(value string) []byte {
	raw, err := hex.DecodeString(value)
	if err != nil {
		return nil
	}
	return raw
}

// DigestHex is the inverse of DigestBytes and the value a HEAD compares to.
func DigestHex(raw []byte) string {
	if len(raw) != sha256.Size {
		return ""
	}
	return hex.EncodeToString(raw)
}
