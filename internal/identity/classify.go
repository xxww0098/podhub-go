package identity

import "net/http"

// RouteClass is the admission bucket for one path.
type RouteClass int

const (
	ClassInteractiveRead RouteClass = iota
	ClassRegularWrite
	ClassMediaUpload
	ClassPsdUpload
	ClassMediaProbe
	ClassAI
	ClassOCR
	ClassControl
)

func (c RouteClass) String() string {
	switch c {
	case ClassInteractiveRead:
		return "interactive_read"
	case ClassRegularWrite:
		return "regular_write"
	case ClassMediaUpload:
		return "media_upload"
	case ClassPsdUpload:
		return "psd_upload"
	case ClassMediaProbe:
		return "media_probe"
	case ClassAI:
		return "ai"
	case ClassOCR:
		return "ocr"
	default:
		return "control"
	}
}

const (
	chatCompletionsPath = "/api/ai/chat/completions"
	ocrCompletionsPath  = "/api/ai/ocr/completions"
)

// Classify maps a path and method to a route class.
func Classify(path, method string) RouteClass {
	switch {
	case stringsHasPrefix(path, "/api/media/objects/"):
		switch {
		case stringsHasSuffix(path, "/probe"):
			return ClassMediaProbe
		case stringsHasSuffix(path, "/presign") || stringsHasSuffix(path, "/presign-batch"):
			return ClassControl
		default:
			return ClassMediaUpload
		}
	case isPSDUpload(path, method):
		return ClassPsdUpload
	case isOriginConfirmation(path, method):
		return ClassMediaUpload
	case path == ocrCompletionsPath:
		return ClassOCR
	case path == chatCompletionsPath:
		return ClassAI
	case isControlPlane(path):
		return ClassControl
	case isOpsRead(path):
		return ClassInteractiveRead
	case method == http.MethodGet || method == http.MethodHead:
		return ClassInteractiveRead
	default:
		return ClassRegularWrite
	}
}

func isControlPlane(path string) bool {
	return stringsHasSuffix(path, "/heartbeat") ||
		stringsHasSuffix(path, "/prepare/cancel") ||
		stringsHasSuffix(path, "/cancel") ||
		stringsHasSuffix(path, "/ai/settle") ||
		stringsHasSuffix(path, "/ai/fail") ||
		stringsHasSuffix(path, "/snapshot") ||
		stringsContains(path, "/media/images/") ||
		(stringsContains(path, "/listing/rows/") && stringsHasSuffix(path, "/media/images")) ||
		(stringsContains(path, "/listing/rows/") && stringsHasSuffix(path, "/media"))
}

func isPSDUpload(path, method string) bool {
	if method != http.MethodPost {
		return false
	}
	if path == "/api/listing/templates" {
		return true
	}
	if stringsHasPrefix(path, "/api/listing/templates/") && (stringsHasSuffix(path, "/confirm") || stringsContains(path, "/multipart/")) {
		return true
	}
	return stringsHasPrefix(path, "/api/admin/supplier-dbs/") &&
		(stringsHasSuffix(path, "/uploads") || stringsHasSuffix(path, "/uploads/confirm") || stringsHasSuffix(path, "/uploads/abort"))
}

func isOriginConfirmation(path, method string) bool {
	if method == http.MethodPost {
		switch path {
		case "/api/seller/delegate/assets",
			"/api/admin/media/uploads/confirm",
			"/api/ai/ocr/uploads/confirm":
			return true
		}
		return false
	}
	return method == http.MethodPut && (path == "/api/avatars/me" || stringsHasPrefix(path, "/api/avatars/workspaces/"))
}

func isOpsRead(path string) bool {
	return stringsHasPrefix(path, "/api/ops/") && !stringsHasSuffix(path, "/mutate") && !stringsHasSuffix(path, "/send")
}

func stringsHasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
func stringsHasSuffix(s, suffix string) bool {
	return len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix
}
func stringsContains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
