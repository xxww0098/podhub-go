package contract

import (
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
	if purpose.Bucket == RolePrivate && ext == ExtPSD {
		return "", ErrExtension
	}
	digest = strings.ToLower(strings.TrimSpace(digest))
	if !isDigest(digest) {
		return "", ErrKey
	}
	switch purpose.Kind {
	case PurposeListingImage:
		if ext != ExtJPG {
			return "", ErrExtension
		}
		return normalized + "orgs/" + purpose.ID + "/images/" + digest + ".jpg", nil
	case PurposeOrgFile:
		return normalized + "orgs/" + purpose.ID + "/files/" + digest + "." + string(ext), nil
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
