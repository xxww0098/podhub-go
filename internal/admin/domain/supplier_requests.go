package domain

import (
	"encoding/json"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

const partSize = uint64(16 * 1024 * 1024)

// StorageUpload is the tree or row presign body.
type StorageUpload struct {
	Path        string
	ContentType string
	Bytes       uint64
	SHA256      string
}

// DecodeStorageUpload requires path, contentType, bytes and sha256.
func DecodeStorageUpload(body []byte) (StorageUpload, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"path", "contentType", "bytes", "sha256"}) ||
		!requireKeys(raw, []string{"path", "contentType", "bytes", "sha256"}) {
		return StorageUpload{}, invalid()
	}
	var in StorageUpload
	var bytes json.Number
	if !unmarshal(raw["path"], &in.Path) || !unmarshal(raw["contentType"], &in.ContentType) ||
		!unmarshal(raw["bytes"], &bytes) || !unmarshal(raw["sha256"], &in.SHA256) {
		return StorageUpload{}, invalid()
	}
	n, err := strconv.ParseUint(bytes.String(), 10, 64)
	if err != nil {
		return StorageUpload{}, invalid()
	}
	in.Bytes = n
	if err := ContentType(in.ContentType); err != nil {
		return StorageUpload{}, fail(contract.KindValidation, "contentType 无效")
	}
	if in.Bytes < 1 || in.Bytes > sign.MaxObjectBytes {
		return StorageUpload{}, fail(contract.KindValidation, "文件大小需在 1–2GiB 字节之间")
	}
	if !hex64(in.SHA256) {
		return StorageUpload{}, fail(contract.KindValidation, "sha256 无效")
	}
	in.SHA256 = strings.ToLower(in.SHA256)
	return in, nil
}

func hex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

// DecodeDirectory reads {"path"}.
func DecodeDirectory(body []byte) (string, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"path"}) || !requireKeys(raw, []string{"path"}) {
		return "", invalid()
	}
	var p string
	if !unmarshal(raw["path"], &p) {
		return "", invalid()
	}
	return SupplierPath(p, false)
}

// DeleteRequest is path plus file or directory.
type DeleteRequest struct {
	Path string
	Kind string
}

// DecodeDelete reads {"path","kind"}.
func DecodeDelete(body []byte) (DeleteRequest, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"path", "kind"}) || !requireKeys(raw, []string{"path", "kind"}) {
		return DeleteRequest{}, invalid()
	}
	var in DeleteRequest
	if !unmarshal(raw["path"], &in.Path) || !unmarshal(raw["kind"], &in.Kind) {
		return DeleteRequest{}, invalid()
	}
	if in.Kind != "file" && in.Kind != "directory" {
		return DeleteRequest{}, invalid()
	}
	p, err := SupplierPath(in.Path, false)
	if err != nil {
		return DeleteRequest{}, err
	}
	in.Path = p
	return in, nil
}

// MoveRequest is a file move. Directories are rejected by the service.
type MoveRequest struct {
	Source      string
	Destination string
	Kind        string
}

// DecodeMove reads sourcePath, destinationPath and kind.
func DecodeMove(body []byte) (MoveRequest, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"sourcePath", "destinationPath", "kind"}) ||
		!requireKeys(raw, []string{"sourcePath", "destinationPath", "kind"}) {
		return MoveRequest{}, invalid()
	}
	var in MoveRequest
	if !unmarshal(raw["sourcePath"], &in.Source) || !unmarshal(raw["destinationPath"], &in.Destination) || !unmarshal(raw["kind"], &in.Kind) {
		return MoveRequest{}, invalid()
	}
	if in.Kind != "file" && in.Kind != "directory" {
		return MoveRequest{}, invalid()
	}
	if in.Kind == "directory" {
		return MoveRequest{}, fail(contract.KindValidation, "暂不支持移动目录；请逐个移动文件，避免非原子递归操作")
	}
	src, err := SupplierPath(in.Source, false)
	if err != nil {
		return MoveRequest{}, err
	}
	dst, err := SupplierPath(in.Destination, false)
	if err != nil {
		return MoveRequest{}, err
	}
	if src == dst {
		return MoveRequest{}, fail(contract.KindValidation, "源路径与目标路径不能相同")
	}
	in.Source, in.Destination = src, dst
	return in, nil
}

// ConfirmTree reads path and uploadTicket.
type ConfirmTree struct {
	Path   string
	Ticket string
}

// DecodeConfirmTree rejects unknown fields.
func DecodeConfirmTree(body []byte) (ConfirmTree, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"path", "uploadTicket"}) || !requireKeys(raw, []string{"path", "uploadTicket"}) {
		return ConfirmTree{}, invalid()
	}
	var in ConfirmTree
	if !unmarshal(raw["path"], &in.Path) || !unmarshal(raw["uploadTicket"], &in.Ticket) {
		return ConfirmTree{}, invalid()
	}
	p, err := SupplierPath(in.Path, false)
	if err != nil {
		return ConfirmTree{}, err
	}
	in.Path = p
	return in, nil
}

// PartETag is one completed part.
type PartETag struct {
	Number int
	ETag   string
}

// ConfirmRow reads uploadTicket and an optional parts list.
type ConfirmRow struct {
	Ticket string
	Parts  []PartETag
}

// DecodeConfirmRow allows a missing parts key.
func DecodeConfirmRow(body []byte) (ConfirmRow, error) {
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"uploadTicket", "parts"}) || !requireKeys(raw, []string{"uploadTicket"}) {
		return ConfirmRow{}, invalid()
	}
	var ticket string
	if !unmarshal(raw["uploadTicket"], &ticket) {
		return ConfirmRow{}, invalid()
	}
	var parts []PartETag
	if rawParts, ok := raw["parts"]; ok {
		var rows []struct {
			Number int    `json:"partNumber"`
			ETag   string `json:"etag"`
		}
		if err := json.Unmarshal(rawParts, &rows); err != nil {
			return ConfirmRow{}, invalid()
		}
		for _, row := range rows {
			parts = append(parts, PartETag{Number: row.Number, ETag: row.ETag})
		}
	}
	return ConfirmRow{Ticket: ticket, Parts: parts}, nil
}

// DecodeAbort reads an optional uploadTicket. An empty object is a no-op abort.
func DecodeAbort(body []byte) (string, error) {
	if len(strings.TrimSpace(string(body))) == 0 {
		return "", nil
	}
	raw, err := strictObject(body)
	if err != nil || !hasOnly(raw, []string{"uploadTicket"}) {
		return "", invalid()
	}
	if _, ok := raw["uploadTicket"]; !ok {
		return "", nil
	}
	var ticket string
	if !unmarshal(raw["uploadTicket"], &ticket) {
		return "", invalid()
	}
	return ticket, nil
}

// FileExt is the lower-case extension without the dot. Empty is rejected.
func FileExt(name string) (string, error) {
	base := path.Base(strings.TrimSpace(name))
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(base), "."))
	if ext == "" || strings.Contains(ext, "/") || utf8.RuneCountInString(ext) > 16 {
		return "", fail(contract.KindValidation, "文件扩展名无效")
	}
	return ext, nil
}

// LargePSD is an extension of psd whose byte length exceeds one part.
func LargePSD(ext string, bytes uint64) bool {
	return ext == "psd" && bytes > partSize
}

// PartPlan splits bytes into 16 MiB parts. The count must be 1..10000.
func PartPlan(bytes uint64) ([]uint64, error) {
	if bytes == 0 {
		return nil, fail(contract.KindValidation, "分片上传的文件是空的")
	}
	n := (bytes + partSize - 1) / partSize
	if n < 1 || n > 10000 {
		return nil, fail(contract.KindValidation, "分片数量超出对象存储上限")
	}
	out := make([]uint64, n)
	var left = bytes
	for i := range out {
		if left > partSize {
			out[i] = partSize
			left -= partSize
		} else {
			out[i] = left
		}
	}
	return out, nil
}

// CheckParts rejects holes, duplicates, empty lists and bad etags.
func CheckParts(parts []PartETag, want int) error {
	if len(parts) == 0 || len(parts) > 10000 {
		return fail(contract.KindValidation, "分片上传尚未完成")
	}
	if len(parts) != want {
		return fail(contract.KindValidation, "分片序号不连续")
	}
	seen := map[int]bool{}
	for _, part := range parts {
		if part.Number < 1 || part.Number > want || seen[part.Number] {
			return fail(contract.KindValidation, "分片序号不连续")
		}
		seen[part.Number] = true
		if !etagOK(part.ETag) {
			return fail(contract.KindValidation, "分片 ETag 无效")
		}
	}
	return nil
}

func etagOK(raw string) bool {
	s := strings.TrimSpace(raw)
	if s == "" || strings.ContainsAny(s, "\r\n") {
		return false
	}
	if !strings.HasPrefix(s, `"`) {
		s = `"` + s + `"`
	}
	return len(s) >= 2 && strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`)
}

// QuoteETag returns the etag with surrounding quotes.
func QuoteETag(raw string) string {
	s := strings.TrimSpace(raw)
	if strings.HasPrefix(s, `"`) {
		return s
	}
	return `"` + s + `"`
}

// MagicOK checks a few well-known signatures. Unknown types pass.
// The mismatch sentence is not in the spec export and is listed for the user.
func MagicOK(contentType string, body []byte) error {
	ct := contentType
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	var ok bool
	switch ct {
	case "image/png":
		ok = len(body) >= 8 && string(body[:8]) == "\x89PNG\r\n\x1a\n"
	case "image/jpeg":
		ok = len(body) >= 3 && body[0] == 0xff && body[1] == 0xd8 && body[2] == 0xff
	case "image/gif":
		ok = len(body) >= 4 && string(body[:4]) == "GIF8"
	case "image/webp":
		ok = len(body) >= 12 && string(body[:4]) == "RIFF" && string(body[8:12]) == "WEBP"
	case "image/vnd.adobe.photoshop", "application/x-photoshop", "image/psd":
		ok = len(body) >= 4 && string(body[:4]) == "8BPS"
	case "application/pdf":
		ok = len(body) >= 4 && string(body[:4]) == "%PDF"
	case "video/mp4":
		ok = len(body) >= 8 && string(body[4:8]) == "ftyp"
	default:
		return nil
	}
	if !ok {
		return fail(contract.KindConflict, "上传对象内容与声明的文件类型不一致")
	}
	return nil
}

// UploadIDOK rejects an empty, over-long, or control-bearing multipart id.
func UploadIDOK(id string) error {
	if id == "" || len(id) > 1024 {
		return fail(contract.KindValidation, "分片上传编号无效")
	}
	for i := 0; i < len(id); i++ {
		if id[i] < 32 {
			return fail(contract.KindValidation, "分片上传编号无效")
		}
	}
	return nil
}

// PlatformCode mints P- plus 12 uppercase hex digits when the request is blank.
func PlatformCode(raw, publicID string) string {
	raw = strings.TrimSpace(raw)
	if raw != "" {
		return raw
	}
	hexDigits := strings.ReplaceAll(publicID, "-", "")
	if len(hexDigits) > 12 {
		hexDigits = hexDigits[:12]
	}
	return "P-" + strings.ToUpper(hexDigits)
}
