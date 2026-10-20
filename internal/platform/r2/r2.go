// Package storage is the only R2 client.
//
// CLOUD_MEDIA_GC_DELETE is parsed in internal/config. DeleteObjects is sent
// only when that parse is enabled AND the endpoint host is 127.0.0.1 (the
// fake bucket). Any other R2_* host is treated as a real bucket: the client
// is not given delete permission, and no request is sent.
//
// aws-sdk-go-v2 performs List, Put, Head, and Delete against that fake
// endpoint. Browser PUT URLs are signed in internal/media/sign so the
// canonical request stays the one Rust builds.
package r2

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// ErrDeleteDisabled means CLOUD_MEDIA_GC_DELETE parsed as off
// (0/false/off/no, or any unrecognized value).
var ErrDeleteDisabled = errors.New("CLOUD_MEDIA_GC_DELETE is off; object deletes are closed")

// ErrDeleteNotPorted means the purge is enabled, no bucket settings are
// present, and this process still refused to call R2.
var ErrDeleteNotPorted = errors.New("object delete is not ported; no request was sent")

// ErrRewriteBucketRefuse means the purge is enabled and a real (non-loopback)
// R2 setting is present. The client is not built and no delete is sent.
var ErrRewriteBucketRefuse = errors.New("refusing CLOUD_MEDIA_GC_DELETE while R2 settings are configured; the rewrite must not purge a real bucket")

// ErrRemoteRefused means a call would leave this machine for a host other
// than 127.0.0.1. Upload, list, head, and delete all stop here.
var ErrRemoteRefused = errors.New("refusing object storage host; only 127.0.0.1 is dialed during the rewrite")

// Client talks to one S3-compatible endpoint. api is nil when there is nothing to dial.
type Client struct {
	cfg    config.Config
	bucket string
	api    *s3.Client
}

// New builds a client.
//
// An enabled purge plus any R2 setting whose host is not 127.0.0.1 returns
// ErrRewriteBucketRefuse and does not construct a credentialed client.
// A complete 127.0.0.1 endpoint is the fake bucket and may be deleted when
// the purge is enabled. A complete endpoint with the purge off is constructed
// but DeleteObject still returns ErrDeleteDisabled before any API call, and
// every dial refuses a non-loopback host.
func New(cfg config.Config) (*Client, error) {
	if cfg.MediaDeleteEnabled() && cfg.R2Configured() && !fakeReady(cfg) {
		return nil, ErrRewriteBucketRefuse
	}
	c := &Client{cfg: cfg, bucket: cfg.R2Bucket}
	if !cfg.R2Configured() {
		return c, nil
	}
	if cfg.R2Endpoint == "" || cfg.R2Bucket == "" || cfg.R2AccessKey == "" || cfg.R2Secret == "" {
		return nil, fmt.Errorf("R2 settings must be all set or all empty")
	}
	c.api = s3.New(s3.Options{
		Region:       "auto",
		BaseEndpoint: aws.String(cfg.R2Endpoint),
		Credentials:  credentials.NewStaticCredentialsProvider(cfg.R2AccessKey, cfg.R2Secret, ""),
		UsePathStyle: true,
		// Browser grants are signed in internal/media/sign. This client only
		// lists, puts, and deletes on the fake bucket, and it must not add a
		// checksum header the fake server does not understand.
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	})
	return c, nil
}

// DeleteObject removes one key. It does not call the AWS client unless the
// purge is enabled and the endpoint is the 127.0.0.1 fake bucket.
func (c *Client) DeleteObject(ctx context.Context, key string) error {
	if err := c.deleteAllowed(); err != nil {
		return err
	}
	if key == "" {
		return fmt.Errorf("empty object key")
	}
	_, err := c.api.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	return err
}

// DeleteKeys removes up to one DeleteObjects batch on the fake bucket.
// deleted is the number of keys the fake acknowledged. failed lists the rest.
func (c *Client) DeleteKeys(ctx context.Context, bucket string, keys []string) (int, []string, error) {
	if err := c.deleteAllowed(); err != nil {
		return 0, nil, err
	}
	if bucket == "" {
		return 0, nil, fmt.Errorf("empty bucket")
	}
	objects := make([]types.ObjectIdentifier, 0, len(keys))
	for _, key := range keys {
		if key == "" {
			return 0, nil, fmt.Errorf("empty object key")
		}
		objects = append(objects, types.ObjectIdentifier{Key: aws.String(key)})
	}
	if len(objects) == 0 {
		return 0, nil, nil
	}
	out, err := c.api.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String(bucket),
		Delete: &types.Delete{Objects: objects, Quiet: aws.Bool(false)},
	})
	if err != nil {
		return 0, nil, err
	}
	failed := make([]string, 0, len(out.Errors))
	for _, item := range out.Errors {
		if item.Key != nil {
			failed = append(failed, *item.Key)
		}
	}
	return len(out.Deleted), failed, nil
}

// ListKeys returns up to 1000 keys. It dials only 127.0.0.1.
func (c *Client) ListKeys(ctx context.Context, bucket string) ([]string, error) {
	if err := c.dial(); err != nil {
		return nil, err
	}
	out, err := c.api.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket:  aws.String(bucket),
		MaxKeys: aws.Int32(1000),
	})
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(out.Contents))
	for _, item := range out.Contents {
		if item.Key != nil {
			keys = append(keys, *item.Key)
		}
	}
	return keys, nil
}

// PutBytes writes one object on the fake bucket. It does not delete.
func (c *Client) PutBytes(ctx context.Context, bucket, key, contentType string, body []byte) error {
	if err := c.dial(); err != nil {
		return err
	}
	_, err := c.api.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(body),
		ContentType: aws.String(contentType),
	})
	return err
}

// Head is the metadata a checksum verdict can see.
type Head struct {
	ByteLength  *uint64
	ContentType string
	HasType     bool
	SHA256Hex   string
	HasSHA256   bool
	ETag        string
}

// HeadObject reads metadata from the fake bucket.
func (c *Client) HeadObject(ctx context.Context, bucket, key string) (Head, error) {
	if err := c.dial(); err != nil {
		return Head{}, err
	}
	out, err := c.api.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return Head{}, err
	}
	head := Head{ETag: aws.ToString(out.ETag)}
	if out.ContentLength != nil {
		n := uint64(*out.ContentLength)
		head.ByteLength = &n
	}
	if out.ContentType != nil {
		head.HasType = true
		head.ContentType = strings.TrimSpace(strings.Split(*out.ContentType, ";")[0])
	}
	if out.ChecksumSHA256 != nil {
		head.HasSHA256 = true
		head.SHA256Hex = *out.ChecksumSHA256
	}
	return head, nil
}

// GetBytes reads one object from the fake bucket. Callers bound the size.
func (c *Client) GetBytes(ctx context.Context, bucket, key string, max int64) ([]byte, error) {
	if err := c.dial(); err != nil {
		return nil, err
	}
	out, err := c.api.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, err
	}
	defer out.Body.Close()
	return io.ReadAll(io.LimitReader(out.Body, max+1))
}

// CreateBucket creates a bucket on the fake endpoint.
func (c *Client) CreateBucket(ctx context.Context, bucket string) error {
	if err := c.dial(); err != nil {
		return err
	}
	_, err := c.api.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)})
	return err
}

// Configured reports whether an in-memory client exists. It does not probe R2.
func (c *Client) Configured() bool { return c != nil && c.api != nil }

// LoopbackDelete reports that deletes are enabled and the endpoint is 127.0.0.1.
func (c *Client) LoopbackDelete() bool {
	return c != nil && c.api != nil && c.cfg.MediaDeleteEnabled() && fakeReady(c.cfg)
}

// LoopbackHost reports a complete http(s) URL whose host is exactly 127.0.0.1.
// localhost and ::1 are not this host. Userinfo is refused.
func LoopbackHost(raw string) bool { return loopback(raw) }

// LoopbackAccount is the browser signer for the fake bucket. A real host,
// or a partial R2 setting, returns false and no account. Callers must not
// sign a URL for any other endpoint.
func LoopbackAccount(cfg config.Config) (sign.Account, bool) {
	if !fakeReady(cfg) {
		return sign.Account{}, false
	}
	return sign.Account{
		ID:              "r2-loopback",
		Provider:        sign.ProviderGeneric,
		Endpoint:        cfg.R2Endpoint,
		Region:          "auto",
		Bucket:          cfg.R2Bucket,
		ForcePathStyle:  true,
		AccessKeyID:     cfg.R2AccessKey,
		SecretAccessKey: cfg.R2Secret,
		PublicBaseURL:   strings.TrimRight(cfg.R2Endpoint, "/") + "/" + cfg.R2Bucket,
	}, true
}

func (c *Client) deleteAllowed() error {
	if c == nil || !c.cfg.MediaDeleteEnabled() {
		return ErrDeleteDisabled
	}
	if !fakeReady(c.cfg) || c.api == nil {
		if c.cfg.R2Configured() || (c != nil && c.api != nil) {
			return ErrRewriteBucketRefuse
		}
		return ErrDeleteNotPorted
	}
	if !loopback(c.cfg.R2Endpoint) {
		return ErrRewriteBucketRefuse
	}
	return nil
}

func (c *Client) dial() error {
	if c == nil || c.api == nil || !loopback(c.cfg.R2Endpoint) {
		return ErrRemoteRefused
	}
	return nil
}

func fakeReady(cfg config.Config) bool {
	return cfg.R2Endpoint != "" && cfg.R2Bucket != "" && cfg.R2AccessKey != "" && cfg.R2Secret != "" && loopback(cfg.R2Endpoint)
}

func loopback(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	return parsed.Hostname() == "127.0.0.1"
}
