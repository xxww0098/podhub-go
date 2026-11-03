package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDecodeRowUploadKindRules(t *testing.T) {
	for _, tc := range []struct {
		kind, filename, contentType string
		limit                       uint64
	}{
		{"gallery", "商品展示.JPEG", "image/jpeg", 20 << 20},
		{"gallery", "图.png", "image/png", 20 << 20},
		{"gallery", "图.webp", "image/webp", 20 << 20},
		{"psd", "印花 01.psd", "image/vnd.adobe.photoshop", 500 << 20},
		{"video", "演示.mp4", "video/mp4", 200 << 20},
		{"video", "演示.mov", "video/quicktime", 200 << 20},
	} {
		t.Run(tc.filename, func(t *testing.T) {
			body := map[string]any{"kind": tc.kind, "filename": tc.filename, "content_type": tc.contentType, "bytes": tc.limit, "sha256": strings.Repeat("AB", 32)}
			encode := func() []byte { raw, _ := json.Marshal(body); return raw }
			got, err := DecodeRowUpload(encode())
			if err != nil || got.Kind != tc.kind || got.Filename != tc.filename || got.Bytes != tc.limit || got.SHA256 != strings.Repeat("ab", 32) {
				t.Fatalf("allowed file: %+v %v", got, err)
			}
			body["bytes"] = tc.limit + 1
			if _, err := DecodeRowUpload(encode()); err == nil {
				t.Fatal("accepted an oversized file")
			}
		})
	}
}

func TestDecodeRowUploadRejectsInvalidCapabilityRequests(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		value       any
	}{
		{"arbitrary path", "path", "supplier-dbs/other/object.png"},
		{"unknown kind", "kind", "document"},
		{"kind extension mismatch", "kind", "psd"},
		{"MIME mismatch", "content_type", "image/jpeg"},
		{"retired camelCase MIME", "contentType", "image/png"},
		{"header injection", "content_type", "image/png\r\nx-extra:1"},
		{"absolute filename", "filename", "/tmp/picture.png"},
		{"parent path", "filename", "../picture.png"},
		{"nested path", "filename", "other/picture.png"},
		{"windows path", "filename", `C:\picture.png`},
		{"control filename", "filename", "pic\x00ture.png"},
		{"padded filename", "filename", " picture.png"},
		{"long filename", "filename", strings.Repeat("图", 252) + ".png"},
		{"unknown extension", "filename", "picture.svg"},
		{"zero size", "bytes", 0},
		{"fractional size", "bytes", 1.5},
		{"negative size", "bytes", -1},
		{"wrong digest", "sha256", strings.Repeat("z", 64)},
		{"unsupported resume", "resume_ticket", "old-ticket"},
		{"empty resume", "resume_ticket", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{"kind": "gallery", "filename": "picture.png", "content_type": "image/png", "bytes": 12, "sha256": strings.Repeat("a", 64)}
			body[tc.field] = tc.value
			raw, _ := json.Marshal(body)
			if _, err := DecodeRowUpload(raw); err == nil {
				t.Fatalf("accepted %s", raw)
			}
		})
	}
	for _, field := range []string{"kind", "filename", "content_type", "bytes", "sha256"} {
		t.Run("missing "+field, func(t *testing.T) {
			body := map[string]any{"kind": "gallery", "filename": "picture.png", "content_type": "image/png", "bytes": 12, "sha256": strings.Repeat("a", 64)}
			delete(body, field)
			raw, _ := json.Marshal(body)
			if _, err := DecodeRowUpload(raw); err == nil {
				t.Fatalf("accepted missing %s", field)
			}
		})
	}
}

func TestDecodeRowUploadConfirmationWire(t *testing.T) {
	in, err := DecodeConfirmRow([]byte(`{"upload_ticket":"ticket","parts":[{"part_number":2,"etag":"part"}]}`))
	if err != nil || in.Ticket != "ticket" || len(in.Parts) != 1 || in.Parts[0].Number != 2 || in.Parts[0].ETag != "part" {
		t.Fatalf("confirmation: %+v, %v", in, err)
	}
	if _, err := DecodeConfirmRow([]byte(`{"uploadTicket":"ticket"}`)); err == nil {
		t.Fatal("accepted retired camelCase confirmation")
	}
	if ticket, err := DecodeAbort([]byte(`{"upload_ticket":"ticket"}`)); err != nil || ticket != "ticket" {
		t.Fatalf("abort: %q, %v", ticket, err)
	}
	if _, err := DecodeAbort([]byte(`{"uploadTicket":"ticket"}`)); err == nil {
		t.Fatal("accepted retired camelCase abort")
	}
}

func TestDecodeStorageConfirmationWire(t *testing.T) {
	got, err := DecodeConfirmTree([]byte(`{"path":"gallery/test.png","upload_ticket":"ticket"}`))
	if err != nil || got.Path != "gallery/test.png" || got.Ticket != "ticket" {
		t.Fatalf("storage confirmation %+v: %v", got, err)
	}
	for _, body := range []string{`{"path":"gallery/test.png","uploadTicket":"ticket"}`, `{"path":"../test.png","upload_ticket":"ticket"}`, `{"path":".direct-uploads/test","upload_ticket":"ticket"}`} {
		if _, err := DecodeConfirmTree([]byte(body)); err == nil {
			t.Fatalf("accepted invalid storage confirmation: %s", body)
		}
	}
}
