package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/receipt"
	"github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"strings"
	"time"
)

func ocrUploadPurpose(c ai.Claim, b ai.Binding) string {
	return fmt.Sprintf("workflow-ocr:%s:%s:%d:%s", c.JobID, c.Lease.Owner, c.Lease.Epoch, b.Fingerprint)
}
func ocrUploadTarget(account sign.Account, p access.Principal, c ai.Claim, b ai.Binding, in ai.Image, now time.Time) (any, error) {
	if in.Bytes == 0 || in.Bytes > 1_400_000 || (in.ContentType != "image/jpeg" && in.ContentType != "image/png") {
		return nil, errors.New("recognition image invalid")
	}
	key := strings.TrimRight(account.KeyPrefix, "/") + fmt.Sprintf("/ocr/%d/%s/%d/%s", p.OrgID, c.JobID, c.Lease.Epoch, in.SHA256)
	key = strings.TrimLeft(key, "/")
	target, err := receipt.Issue(account, receipt.Subject{Purpose: ocrUploadPurpose(c, b), ActorID: p.UserID, WorkspaceID: &p.OrgID}, receipt.Object{Key: key, ContentType: in.ContentType, ByteLength: in.Bytes, SHA256: in.SHA256}, now, true, nil)
	if err != nil {
		return nil, err
	}
	headers := map[string]any{"content_type": target.Grant.ContentType, "if_none_match": target.Grant.IfNoneMatch}
	if target.Grant.ChecksumSHA256 != "" {
		headers["checksum_sha256"] = target.Grant.ChecksumSHA256
	}
	return map[string]any{"upload_ticket": target.Ticket, "upload": map[string]any{"url": target.Grant.URL, "headers": headers, "expires_at_ms": target.Grant.ExpiresAt.UnixMilli()}}, nil
}
func readOCRUpload(ctx context.Context, account sign.Account, p access.Principal, c ai.Claim, b ai.Binding, ticket string, now time.Time) ([]byte, string, error) {
	proof, err := receipt.Verify(account, ticket, receipt.Subject{Purpose: ocrUploadPurpose(c, b), ActorID: p.UserID, WorkspaceID: &p.OrgID}, now)
	if err != nil {
		return nil, "", err
	}
	if proof.ByteLength > 1_400_000 || (proof.ContentType != "image/png" && proof.ContentType != "image/jpeg") {
		return nil, "", errors.New("recognition image invalid")
	}
	signed, _, err := sign.PresignURL(account, "GET", proof.Key, "", now, time.Minute, nil, nil)
	if err != nil {
		return nil, "", err
	}
	got, err := r2.ExchangeAccount(ctx, account, r2.Request{Method: "GET", URL: signed, Timeout: 20 * time.Second, StrictRead: true, NoCompress: true, MaxBytes: int64(proof.ByteLength) + 1})
	if err == nil && got.Status == 404 {
		return nil, "", ai.ErrImageMissing
	}
	if err != nil || got.Status != 200 || uint64(len(got.Body)) != proof.ByteLength {
		return nil, "", errors.New("recognition image unreadable")
	}
	sum := sha256.Sum256(got.Body)
	cfg, format, err := image.DecodeConfig(bytes.NewReader(got.Body))
	expected := "image/" + format
	if format == "jpeg" {
		expected = "image/jpeg"
	}
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || int64(cfg.Width)*int64(cfg.Height) > 4_000_000 || hex.EncodeToString(sum[:]) != proof.SHA256 || expected != proof.ContentType {
		return nil, "", errors.New("recognition image mismatch")
	}
	if _, _, err = image.Decode(bytes.NewReader(got.Body)); err != nil {
		return nil, "", errors.New("recognition image corrupt")
	}
	return got.Body, proof.ContentType, nil
}
