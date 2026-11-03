package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	"github.com/xxww0098/podhub-go/internal/media/domain/receipt"
	mediagen "github.com/xxww0098/podhub-go/internal/media/http/gen"
	"github.com/xxww0098/podhub-go/internal/media/service/transit"
	"github.com/xxww0098/podhub-go/internal/media/service/upload"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

const transitBatchLimit = 32
const transitObjectLimit = 20 << 20

type transitLease struct {
	workspace, batch, digest, extension, key string
	bytes, revision                          int64
	expires                                  time.Time
	reused                                   bool
}

func (s *Server) IssueUploadBatch(w http.ResponseWriter, r *http.Request) {
	var in mediagen.MediaUploadBatchRequest
	if decodeMedia(r, &in) != nil || in.WorkspaceUuid == "" {
		writeMediaFailure(w, mediaInvalid())
		return
	}
	p, _, err := s.mediaActor(r, in.WorkspaceUuid)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if _, ok := s.mediaAccount(r.Context(), p); !ok {
		writeMediaFailure(w, sliceAccountUnavailable())
		return
	}
	now := s.now()
	jsonwire.Write(w, http.StatusOK, mediagen.MediaUploadBatchData{UploadBatch: newTransitBatch(now), ExpiresAt: now.Add(4 * time.Hour).UTC().Format(time.RFC3339Nano)})
}

func newTransitBatch(now time.Time) string {
	return strconv.FormatInt(now.UnixMilli(), 10) + "." + uuid.NewString()
}

func (s *Server) PresignBatch(w http.ResponseWriter, r *http.Request) {
	var in mediagen.MediaObjectBatchPresignRequest
	if decodeMedia(r, &in) != nil || in.WorkspaceUuid == "" || (in.StoreChecksum != nil && *in.StoreChecksum != "sha256") {
		writeMediaFailure(w, mediaInvalid())
		return
	}
	p, workspace, err := s.mediaActor(r, in.WorkspaceUuid)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	objects, err := s.presignMedia(r.Context(), p, workspace, in.UploadBatch, in.Objects)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	jsonwire.Write(w, http.StatusOK, mediagen.MediaObjectBatchPresignData{Objects: objects})
}

func (s *Server) presignMedia(ctx context.Context, actor access.Principal, workspace string, requestedBatch *string, objects []mediagen.MediaObjectBatchPresignItem) ([]mediagen.MediaObjectPresignData, error) {
	if len(objects) == 0 || len(objects) > transitBatchLimit {
		return nil, mediaInvalid()
	}
	account, ok := s.mediaAccount(ctx, actor)
	if !ok {
		return nil, sliceAccountUnavailable()
	}
	now := s.now()
	batch := newTransitBatch(now)
	if requestedBatch != nil {
		batch = *requestedBatch
	}
	grantFor := func(lease transitLease) (mediagen.MediaObjectPresignData, error) {
		putExpires := now.Add(15 * time.Minute)
		if lease.expires.Before(putExpires) {
			putExpires = lease.expires
		}
		actualBatch := strings.Replace(lease.batch, "-", ".", 1)
		grant, err := upload.Presign(upload.Request{Account: account, Prefix: account.KeyPrefix,
			Workspace: workspace, Digest: lease.digest, Ext: lease.extension, Batch: actualBatch,
			ByteLength: uint64(lease.bytes), Now: now, Purpose: "workflow-media", ActorID: actor.UserID,
			WorkspaceID: &actor.OrgID, ExpiresAt: &putExpires})
		if err != nil || grant.ChecksumSHA256 == "" {
			return mediagen.MediaObjectPresignData{}, mediaUnavailable()
		}
		return mediagen.MediaObjectPresignData{AccountId: account.ID, ObjectKey: lease.key,
			PublicUrl: grant.PublicURL, WorkspaceUuid: workspace, StorageRevision: lease.revision, Transport: mediagen.Direct,
			UploadBatch: &actualBatch, UploadTicket: &grant.UploadTicket, Upload: &mediagen.DirectUploadGrant{
				Url: grant.URL, ExpiresAtMs: grant.ExpiresAtMS, Headers: mediagen.DirectUploadHeaders{
					ContentType: grant.ContentType, IfNoneMatch: grant.IfNoneMatch, ChecksumSha256: &grant.ChecksumSHA256}}}, nil
	}
	rows := make([]mediagen.MediaObjectPresignData, 0, len(objects))
	leases := make([]transitLease, 0, len(objects))
	for _, object := range objects {
		lease, err := makeTransitLease(account, workspace, batch, object.Digest, object.Extension, object.ByteLength, now)
		if err != nil {
			return nil, err
		}
		grant, err := grantFor(lease)
		if err != nil {
			return nil, err
		}
		rows = append(rows, grant)
		leases = append(leases, lease)
	}
	leases, err := s.reserveTransit(ctx, actor, account, leases)
	if err != nil {
		return nil, err
	}
	for index, lease := range leases {
		if lease.reused {
			rows[index] = mediagen.MediaObjectPresignData{AccountId: account.ID, ObjectKey: lease.key,
				PublicUrl: sign.PublicURL(account, lease.key), WorkspaceUuid: workspace,
				StorageRevision: lease.revision, Transport: mediagen.Ready}
		} else if lease.key != rows[index].ObjectKey {
			rows[index], err = grantFor(lease)
			if err != nil {
				return nil, err
			}
		}
	}
	return rows, nil
}

func makeTransitLease(account sign.Account, workspace, batch, digest, extension string, size int64, now time.Time) (transitLease, error) {
	if size <= 0 || size > transitObjectLimit {
		return transitLease{}, mediaInvalid()
	}
	parts := strings.Split(batch, ".")
	if len(parts) != 2 {
		return transitLease{}, &mediaFailure{400, "MEDIA_UPLOAD_BATCH_INVALID", "上传批次无效或已过期"}
	}
	key, err := transit.UploadKey(account.KeyPrefix, workspace, digest, extension, batch)
	parsed, valid := objectkey.ParseUploadKey(key)
	if err != nil || !valid {
		return transitLease{}, mediaInvalid()
	}
	if objectkey.IsHealthcheckDigest(parsed.Digest) {
		return transitLease{}, mediaInvalid()
	}
	issued := time.UnixMilli(parsed.BatchMS)
	expires := issued.Add(4 * time.Hour)
	if issued.After(now.Add(5*time.Second)) || !expires.After(now) {
		return transitLease{}, &mediaFailure{400, "MEDIA_UPLOAD_BATCH_INVALID", "上传批次无效或已过期"}
	}
	return transitLease{workspace: workspace, batch: objectkey.BatchIdentity(key), digest: parsed.Digest,
		extension: parsed.Ext, key: key, bytes: size, revision: transitStorageRevision(account), expires: expires}, nil
}

// The browser carries a JSON number. Derive a stable, JS-safe revision from
// the complete receipt identity so an environment switch invalidates old grants.
func transitStorageRevision(account sign.Account) int64 {
	value, _ := strconv.ParseUint(receipt.StorageIdentity(account)[:13], 16, 64)
	return int64(value)
}

func (s *Server) MediaObjectComplete(w http.ResponseWriter, r *http.Request, digest, extension string) {
	var in mediagen.MediaObjectCompleteRequest
	if decodeMedia(r, &in) != nil || in.WorkspaceUuid == "" {
		writeMediaFailure(w, mediaInvalid())
		return
	}
	p, workspace, err := s.mediaActor(r, in.WorkspaceUuid)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	data, err := s.completeTransit(r, p, workspace, digest, extension, in)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	jsonwire.Write(w, http.StatusOK, data)
}

func (s *Server) CompleteBatch(w http.ResponseWriter, r *http.Request) {
	var in mediagen.MediaObjectBatchCompleteRequest
	if decodeMedia(r, &in) != nil || in.WorkspaceUuid == "" || len(in.Objects) == 0 || len(in.Objects) > transitBatchLimit {
		writeMediaFailure(w, mediaInvalid())
		return
	}
	p, workspace, err := s.mediaActor(r, in.WorkspaceUuid)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	out := mediagen.MediaObjectBatchCompleteData{Objects: make([]mediagen.MediaObjectBatchCompleteOutcome, 0, len(in.Objects))}
	for _, item := range in.Objects {
		data, err := s.completeTransit(r, p, workspace, item.Digest, item.Extension, mediagen.MediaObjectCompleteRequest{
			WorkspaceUuid: workspace, AccountId: item.AccountId, ObjectKey: item.ObjectKey, StorageRevision: item.StorageRevision,
			ByteLength: item.ByteLength, UploadTicket: item.UploadTicket, UploadBatch: in.UploadBatch})
		if err != nil {
			failure := mediaFailureDetails(err)
			out.Objects = append(out.Objects, mediagen.MediaObjectBatchCompleteOutcome{Error: &mediagen.MediaObjectBatchItemError{
				Status: int32(failure.status), Code: mediagen.IntegrationConfigErrorCode(failure.code), Error: failure.text}})
		} else {
			out.Objects = append(out.Objects, mediagen.MediaObjectBatchCompleteOutcome{Object: &data})
		}
	}
	jsonwire.Write(w, http.StatusOK, out)
}

func (s *Server) completeTransit(r *http.Request, actor access.Principal, workspace, digest, extension string, in mediagen.MediaObjectCompleteRequest) (mediagen.MediaObjectCompleteData, error) {
	var zero mediagen.MediaObjectCompleteData
	account, ok := s.mediaAccount(r.Context(), actor)
	if !ok {
		return zero, sliceAccountUnavailable()
	}
	batch := strings.Replace(objectkey.BatchIdentity(in.ObjectKey), "-", ".", 1)
	if in.UploadBatch != nil && *in.UploadBatch != batch {
		return zero, mediaConflict()
	}
	lease, err := makeTransitLease(account, workspace, batch, digest, extension, in.ByteLength, s.now())
	if err != nil {
		return zero, err
	}
	if in.AccountId != account.ID {
		return zero, &mediaFailure{400, "MEDIA_UPLOAD_BATCH_INVALID", "切片 R2 已更换，请重新准备图片"}
	}
	if in.StorageRevision != lease.revision || in.ObjectKey != lease.key {
		return zero, mediaConflict()
	}
	if err := s.checkTransit(r.Context(), actor, account, lease); err != nil {
		return zero, err
	}
	proof, err := receipt.Verify(account, in.UploadTicket, receipt.Subject{Purpose: "workflow-media", ActorID: actor.UserID, WorkspaceID: &actor.OrgID}, s.now())
	kind, _ := objectkey.ContentType(lease.extension)
	if err != nil || proof.Key != lease.key || proof.SHA256 != lease.digest || proof.ByteLength != uint64(lease.bytes) || proof.ContentType != kind || !proof.ChecksumEnforced {
		return zero, mediaInvalid()
	}
	width, height, err := verifyTransitBytes(r.Context(), account, lease, s.now())
	if err != nil {
		return zero, err
	}
	// No object proof can restore a revoked session, membership or writer lease.
	current, _, err := s.mediaActor(r, workspace)
	if err != nil {
		return zero, err
	}
	if current.UserID != actor.UserID || current.OrgID != actor.OrgID {
		return zero, mediaConflict()
	}
	if _, err := receipt.Verify(account, in.UploadTicket, receipt.Subject{Purpose: "workflow-media", ActorID: actor.UserID, WorkspaceID: &actor.OrgID}, s.now()); err != nil {
		return zero, mediaInvalid()
	}
	deduplicated, err := s.commitTransit(r.Context(), actor, account, lease, width, height)
	if err != nil {
		return zero, err
	}
	return mediagen.MediaObjectCompleteData{AccountId: account.ID, ObjectKey: lease.key, PublicUrl: sign.PublicURL(account, lease.key),
		WorkspaceUuid: workspace, StorageRevision: lease.revision, ByteLength: lease.bytes, Transport: mediagen.Ready, Deduplicated: deduplicated}, nil
}

func verifyTransitBytes(ctx context.Context, account sign.Account, lease transitLease, now time.Time) (int, int, error) {
	privateURL, _, err := sign.PresignURL(account, http.MethodGet, lease.key, "", now, 5*time.Minute, nil, nil)
	if err != nil {
		return 0, 0, mediaUnavailable()
	}
	contentType, _ := objectkey.ContentType(lease.extension)
	var width, height int
	for _, rawURL := range []string{privateURL, sign.PublicURL(account, lease.key)} {
		w, h, err := verifyTransitObject(ctx, account, lease, rawURL, contentType, width == 0)
		if err != nil {
			return 0, 0, err
		}
		if width == 0 {
			width, height = w, h
		}
	}
	return width, height, nil
}

// verifyTransitObject fetches one URL and checks the bytes against the lease.
// Dimensions are decoded (and returned) only when decode is true.
func verifyTransitObject(ctx context.Context, account sign.Account, lease transitLease, rawURL, contentType string, decode bool) (int, int, error) {
	response, err := r2.ExchangeAccount(ctx, account, r2.Request{Method: http.MethodGet, URL: rawURL,
		Timeout: 45 * time.Second, NoCompress: true, StrictRead: true, MaxBytes: lease.bytes})
	if response.Status == http.StatusNotFound {
		return 0, 0, &mediaFailure{404, "MEDIA_COMPLETE_MISSING", "上传对象尚不存在"}
	}
	if err != nil || response.Status != http.StatusOK {
		return 0, 0, mediaUnavailable()
	}
	kind, _, typeErr := mime.ParseMediaType(http.Header(response.Header).Get("Content-Type"))
	sum := sha256.Sum256(response.Body)
	if typeErr != nil || kind != contentType || int64(len(response.Body)) != lease.bytes || hex.EncodeToString(sum[:]) != lease.digest {
		return 0, 0, mediaConflict()
	}
	if !decode {
		return 0, 0, nil
	}
	cfg, format, decodeErr := image.DecodeConfig(bytes.NewReader(response.Body))
	if decodeErr != nil || (format != "png" && format != "jpeg") || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 64_000_000 {
		return 0, 0, mediaInvalid()
	}
	return cfg.Width, cfg.Height, nil
}

func (s *Server) MediaObjectProbe(w http.ResponseWriter, r *http.Request, digest, extension string) {
	p, workspace, err := s.mediaActor(r, "")
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	account, ok := s.mediaAccount(r.Context(), p)
	if !ok {
		writeMediaFailure(w, sliceAccountUnavailable())
		return
	}
	lease, found, err := s.findTransit(r.Context(), p, account, workspace, digest, extension)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	data := mediagen.MediaObjectProbeData{AccountId: account.ID}
	if found {
		if _, _, err = verifyTransitBytes(r.Context(), account, lease, s.now()); err != nil {
			if mediaFailureDetails(err).code != "MEDIA_COMPLETE_MISSING" {
				writeMediaFailure(w, err)
				return
			}
		} else {
			data.Exists = true
			data.ObjectKey = lease.key
			data.PublicUrl = sign.PublicURL(account, lease.key)
		}
	}
	jsonwire.Write(w, http.StatusOK, data)
}
