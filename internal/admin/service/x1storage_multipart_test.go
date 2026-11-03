package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

type multipartOrigin func(context.Context, ObjectRequest) (ObjectResponse, error)

func (f multipartOrigin) Do(ctx context.Context, request ObjectRequest) (ObjectResponse, error) {
	return f(ctx, request)
}

func multipartService(origin multipartOrigin) (Service, sign.Account) {
	account := sign.Account{ID: "test-assets", Provider: sign.ProviderCloudflare, Endpoint: "http://127.0.0.1:9", Region: "auto", Bucket: "assets", ForcePathStyle: true, AccessKeyID: "test", SecretAccessKey: "test-secret"}
	return Service{
		Origin:   origin,
		Accounts: func(context.Context) (sign.Account, bool, error) { return account, true, nil },
		Now:      func() time.Time { return time.Date(2026, 10, 25, 8, 0, 0, 0, time.UTC) },
	}, account
}

func TestLargePSDCreatePreservesTypeAndPartHeaders(t *testing.T) {
	const contentType = "image/vnd.adobe.photoshop"
	service, account := multipartService(func(_ context.Context, request ObjectRequest) (ObjectResponse, error) {
		if request.Method != "POST" || request.Headers["Content-Type"] != contentType {
			t.Fatalf("multipart creation omitted the final object content type: method=%s type=%q", request.Method, request.Headers["Content-Type"])
		}
		return ObjectResponse{Status: 200, Body: []byte(`<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><UploadId>owned&amp;upload</UploadId></InitiateMultipartUploadResult>`)}, nil
	})
	in := domain.RowUpload{Extension: "psd", ContentType: contentType, SHA256: strings.Repeat("a", 64), Bytes: 75_000_040}
	result, err := service.issueLargePSD(context.Background(), contract.Actor{UserID: 7}, account, "", "src", in, service.clock())
	if err != nil || result.Multipart == nil || len(result.Multipart.Parts) != 5 {
		t.Fatalf("large PSD part plan: err=%v", err)
	}
	if result.Multipart.UploadID != "owned&upload" || result.Multipart.PartSize != partBytes {
		t.Fatal("creation XML or part size changed")
	}
	for i, part := range result.Multipart.Parts {
		parsed, err := url.Parse(part.URL)
		if err != nil {
			t.Fatal(err)
		}
		query := parsed.Query()
		if query.Get("uploadId") != "owned&upload" || query.Get("partNumber") != strconv.Itoa(i+1) {
			t.Fatal("part target changed")
		}
		headers := query.Get("X-Amz-SignedHeaders")
		if !strings.Contains(headers, "content-length") || !strings.Contains(headers, "content-type") || strings.Contains(headers, "if-none-match") {
			t.Fatalf("part signed headers: %q", headers)
		}
		want := partBytes
		if i == 4 {
			want = in.Bytes - 4*partBytes
		}
		if part.ByteLength != want {
			t.Fatalf("part %d bytes=%d want=%d", i+1, part.ByteLength, want)
		}
	}
}

func TestMultipartCompletionIsConditionalOrderedAndEscaped(t *testing.T) {
	service, account := multipartService(func(_ context.Context, request ObjectRequest) (ObjectResponse, error) {
		if request.Headers["if-none-match"] != "*" {
			t.Fatal("multipart completion could overwrite an existing object")
		}
		parsed, err := url.Parse(request.URL)
		if err != nil || !strings.Contains(parsed.Query().Get("X-Amz-SignedHeaders"), "if-none-match") {
			t.Fatal("completion condition is not signed")
		}
		var body struct {
			Parts []struct {
				Number int    `xml:"PartNumber"`
				ETag   string `xml:"ETag"`
			} `xml:"Part"`
		}
		if err := xml.Unmarshal(request.Body, &body); err != nil || len(body.Parts) != 2 {
			t.Fatalf("completion XML: %v", err)
		}
		if body.Parts[0].Number != 1 || body.Parts[1].Number != 2 || body.Parts[0].ETag != `"a&<tag>"` {
			t.Fatalf("completion part order or escaping changed: %+v", body.Parts)
		}
		return ObjectResponse{Status: 200, Body: []byte(`<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`)}, nil
	})
	mustAbort, err := service.completeMultipart(context.Background(), account, domain.UploadReceipt{Key: "supplier-dbs/src/file.psd", MultipartUploadID: "own"}, []domain.PartETag{{Number: 2, ETag: `"b"`}, {Number: 1, ETag: `"a&<tag>"`}})
	if err != nil || mustAbort {
		t.Fatalf("completion err=%v mustAbort=%v", err, mustAbort)
	}
}

func multipartConfirmation(t *testing.T, service Service, account sign.Account, payload []byte) []byte {
	t.Helper()
	sum := sha256.Sum256(payload)
	key := "supplier-dbs/src/file.psd"
	issued, err := domain.IssueMultipart(account, domain.PurposeForKey(key), 7, key, "image/vnd.adobe.photoshop", hex.EncodeToString(sum[:]), "only-own-upload", uint64(len(payload)), partBytes, service.clock())
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{"upload_ticket": issued.Ticket, "parts": []map[string]any{{"part_number": 1, "etag": "abc"}}})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestMultipartExistingObjectRecoveryRequiresExactProof(t *testing.T) {
	for _, mismatch := range []string{"", "digest", "length", "mime", "missing mime"} {
		name := mismatch
		if name == "" {
			name = "matching interrupted upload"
		}
		t.Run(name, func(t *testing.T) {
			payload := []byte("8BPScontent")
			aborts, reads, proofs := 0, 0, 0
			service, account := multipartService(func(_ context.Context, request ObjectRequest) (ObjectResponse, error) {
				switch request.Method {
				case "POST":
					if request.Headers["if-none-match"] != "*" {
						t.Fatal("recovery removed the no-overwrite condition")
					}
					return ObjectResponse{Status: 412}, nil
				case "GET":
					reads++
					body := bytes.Clone(payload)
					headers := map[string]string{"content-type": "image/vnd.adobe.photoshop", "content-length": strconv.Itoa(len(body)), "etag": `"0123456789abcdef-1"`}
					switch mismatch {
					case "digest":
						body[len(body)-1] ^= 1
					case "length":
						body = append(body, 'x')
						headers["content-length"] = strconv.Itoa(len(body))
					case "mime":
						headers["content-type"] = "application/octet-stream"
					case "missing mime":
						delete(headers, "content-type")
					}
					return ObjectResponse{Status: 200, Body: body, Headers: headers}, nil
				case "DELETE":
					parsed, _ := url.Parse(request.URL)
					if parsed.Query().Get("uploadId") != "only-own-upload" || !strings.HasSuffix(parsed.Path, "/supplier-dbs/src/file.psd") {
						t.Fatal("cleanup touched a different upload or the committed object")
					}
					aborts++
					return ObjectResponse{Status: 204}, nil
				case "PUT":
					parsed, _ := url.Parse(request.URL)
					if !strings.HasSuffix(parsed.Path, ".verified") || aborts != 1 || reads != 1 {
						t.Fatal("recovery wrote the object or published before proving and aborting its upload")
					}
					proofs++
					return ObjectResponse{Status: 200}, nil
				default:
					t.Fatalf("unexpected origin method %s", request.Method)
					return ObjectResponse{}, nil
				}
			})
			_, err := service.ConfirmRowUpload(context.Background(), contract.Actor{UserID: 7}, "src", multipartConfirmation(t, service, account, payload))
			if reads != 1 || aborts != 1 {
				t.Fatalf("reads=%d aborts=%d", reads, aborts)
			}
			if mismatch == "" {
				if err != nil || proofs != 1 {
					t.Fatalf("matching object recovery err=%v proofs=%d", err, proofs)
				}
			} else {
				failure, ok := contract.AsFail(err)
				if !ok || failure.Kind != contract.KindConflict || proofs != 0 {
					t.Fatalf("mismatch accepted: err=%v proofs=%d", err, proofs)
				}
			}
		})
	}
}

func TestMultipartRetryRequiresFullDigest(t *testing.T) {
	for _, correct := range []bool{true, false} {
		t.Run(strconv.FormatBool(correct), func(t *testing.T) {
			payload := []byte("8BPScontent")
			readbacks, sidecars := 0, 0
			service, account := multipartService(func(_ context.Context, request ObjectRequest) (ObjectResponse, error) {
				switch request.Method {
				case "POST":
					return ObjectResponse{Status: 404}, nil
				case "GET":
					readbacks++
					body := append([]byte(nil), payload...)
					if !correct {
						body[len(body)-1] ^= 1
					}
					return ObjectResponse{Status: 200, Body: body, Headers: map[string]string{"content-type": "image/vnd.adobe.photoshop", "content-length": strconv.Itoa(len(body)), "etag": `"0123456789abcdef-1"`}}, nil
				case "PUT":
					sidecars++
					return ObjectResponse{Status: 200}, nil
				case "DELETE":
					return ObjectResponse{Status: 404}, nil
				default:
					t.Fatalf("unexpected method %s", request.Method)
					return ObjectResponse{}, nil
				}
			})
			_, err := service.ConfirmRowUpload(context.Background(), contract.Actor{UserID: 7}, "src", multipartConfirmation(t, service, account, payload))
			if correct {
				if err != nil || readbacks != 1 || sidecars != 1 {
					t.Fatalf("retry err=%v reads=%d sidecars=%d", err, readbacks, sidecars)
				}
			} else if err == nil || sidecars != 0 {
				t.Fatal("multipart ETag accepted as full SHA proof")
			}
		})
	}
}

func TestVerifyLargeObjectUsesAuthorizedReadBound(t *testing.T) {
	payload := make([]byte, 33<<20)
	copy(payload, "8BPS")
	sum := sha256.Sum256(payload)
	service, account := multipartService(func(_ context.Context, request ObjectRequest) (ObjectResponse, error) {
		if request.MaxBytes != int64(len(payload)) {
			t.Fatalf("read limit=%d want=%d", request.MaxBytes, len(payload))
		}
		return ObjectResponse{Status: 200, Body: payload, Headers: map[string]string{"content-type": "image/vnd.adobe.photoshop", "content-length": strconv.Itoa(len(payload))}}, nil
	})
	got, err := service.verifyObject(context.Background(), account, domain.UploadReceipt{Key: "supplier-dbs/src/large.psd", ContentType: "image/vnd.adobe.photoshop", ByteLength: uint64(len(payload)), SHA256: hex.EncodeToString(sum[:])})
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("large readback: %v", err)
	}
}

func TestSmallMissingObjectKeepsMissingCode(t *testing.T) {
	service, account := multipartService(func(_ context.Context, request ObjectRequest) (ObjectResponse, error) {
		if request.MaxBytes != 1<<20 {
			t.Fatalf("error response bound=%d", request.MaxBytes)
		}
		return ObjectResponse{Status: 404, Body: []byte(`<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`)}, nil
	})
	_, err := service.verifyObject(context.Background(), account, domain.UploadReceipt{Key: "supplier-dbs/src/tiny.psd", ByteLength: 40})
	failure, ok := contract.AsFail(err)
	if !ok || failure.Code != "UPLOAD_OBJECT_MISSING" {
		t.Fatalf("missing-object retry code: %v", err)
	}
}

func TestMultipartAbortChecksSourceAndAcceptsMissingUpload(t *testing.T) {
	calls := 0
	service, account := multipartService(func(_ context.Context, request ObjectRequest) (ObjectResponse, error) {
		calls++
		parsed, _ := url.Parse(request.URL)
		if request.Method != "DELETE" || parsed.Query().Get("uploadId") != "own" {
			t.Fatal("wrong abort target")
		}
		return ObjectResponse{Status: 404}, nil
	})
	key := "supplier-dbs/src/file.psd"
	issued, err := domain.IssueMultipart(account, domain.PurposeForKey(key), 7, key, "image/vnd.adobe.photoshop", strings.Repeat("a", 64), "own", partBytes+1, partBytes, service.clock())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"upload_ticket": issued.Ticket})
	if err := service.AbortRowUpload(context.Background(), contract.Actor{UserID: 7}, "other", body); err == nil || calls != 0 {
		t.Fatal("abort accepted a ticket for another source")
	}
	if err := service.AbortRowUpload(context.Background(), contract.Actor{UserID: 7}, "src", body); err != nil || calls != 1 {
		t.Fatalf("idempotent abort: %v calls=%d", err, calls)
	}
}
