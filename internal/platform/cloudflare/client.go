// Package cloudflare calls the fixed-host Cloudflare management API.
package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
)

const apiURL = "https://api.cloudflare.com/client/v4"

var (
	accountIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
	bucketPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)
	ErrInput         = errors.New("invalid Cloudflare request")
)

type Client struct{ http *http.Client }

// New accepts a transport for tests; request destinations are never configurable.
func New(transport http.RoundTripper) *Client {
	if transport == nil {
		tr := httpx.Plain().Clone()
		tr.Proxy = nil
		transport = tr
	}
	return &Client{http: &http.Client{Transport: transport, Timeout: 20 * time.Second, CheckRedirect: httpx.UseLast}}
}

// Error excludes upstream messages and bodies, which may contain credentials.
type Error struct {
	Status      int
	Code        int
	Unconfirmed bool
	Created     bool
}

func (e *Error) Error() string {
	return fmt.Sprintf("Cloudflare request failed (status=%d code=%d unconfirmed=%t created=%t)", e.Status, e.Code, e.Unconfirmed, e.Created)
}

type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Bucket struct {
	Name         string `json:"name"`
	CreationDate string `json:"creation_date,omitempty"`
}

type envelope struct {
	Success bool            `json:"success"`
	Result  json.RawMessage `json:"result"`
	Errors  []struct {
		Code int `json:"code"`
	} `json:"errors"`
	Info struct {
		TotalPages int `json:"total_pages"`
	} `json:"result_info"`
}

func validToken(token string) bool {
	return token != "" && len(token) <= 8192 && !strings.ContainsAny(token, " \t\r\n")
}

func ValidBucket(accountID, name string) bool {
	return accountIDPattern.MatchString(accountID) && bucketPattern.MatchString(name)
}

func (c *Client) request(ctx context.Context, token, method, path string, body any, out any) (envelope, error) {
	if !validToken(token) {
		return envelope{}, ErrInput
	}
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			return envelope{}, ErrInput
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, apiURL+path, bytes.NewReader(payload))
	if err != nil {
		return envelope{}, ErrInput
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return envelope{}, &Error{Unconfirmed: method != http.MethodGet}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	var result envelope
	if err != nil || len(raw) > 1<<20 || json.Unmarshal(raw, &result) != nil {
		return envelope{}, &Error{Status: resp.StatusCode, Unconfirmed: method != http.MethodGet}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !result.Success || len(result.Errors) != 0 {
		uncertain := resp.StatusCode < 400 || resp.StatusCode >= 500
		failure := &Error{Status: resp.StatusCode, Unconfirmed: method != http.MethodGet && uncertain}
		if len(result.Errors) > 0 {
			failure.Code = result.Errors[0].Code
		}
		return envelope{}, failure
	}
	if out != nil && (len(result.Result) == 0 || string(result.Result) == "null" || json.Unmarshal(result.Result, out) != nil) {
		return envelope{}, &Error{Status: resp.StatusCode, Unconfirmed: method != http.MethodGet}
	}
	return result, nil
}

// Accounts returns only accounts visible to this grant. A truncated list is an error.
func (c *Client) Accounts(ctx context.Context, token string) ([]Account, error) {
	accounts := []Account{}
	for page := 1; page <= 50; page++ {
		var rows []Account
		result, err := c.request(ctx, token, http.MethodGet, fmt.Sprintf("/accounts?per_page=50&page=%d", page), nil, &rows)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if !accountIDPattern.MatchString(row.ID) {
				return nil, &Error{}
			}
		}
		accounts = append(accounts, rows...)
		if result.Info.TotalPages <= page {
			return accounts, nil
		}
	}
	return nil, &Error{}
}

func (c *Client) Bucket(ctx context.Context, token, accountID, name string) (Bucket, error) {
	if !ValidBucket(accountID, name) {
		return Bucket{}, ErrInput
	}
	var bucket Bucket
	_, err := c.request(ctx, token, http.MethodGet, "/accounts/"+accountID+"/r2/buckets/"+name, nil, &bucket)
	if err == nil && bucket.Name != name {
		err = &Error{}
	}
	return bucket, err
}

// CreateBucket sends one POST, then reads the bucket back. It never retries a write.
// Existing buckets are not adopted: a conflict is returned to the caller.
func (c *Client) CreateBucket(ctx context.Context, token, accountID, name string) (Bucket, error) {
	if !ValidBucket(accountID, name) {
		return Bucket{}, ErrInput
	}
	var created Bucket
	_, err := c.request(ctx, token, http.MethodPost, "/accounts/"+accountID+"/r2/buckets", map[string]string{"name": name}, &created)
	if err != nil {
		return Bucket{}, err
	}
	if created.Name != name {
		return Bucket{}, &Error{Unconfirmed: true}
	}
	readback, err := c.Bucket(ctx, token, accountID, name)
	if err != nil {
		return Bucket{}, &Error{Created: true, Unconfirmed: true}
	}
	return readback, nil
}
