package slicepurge

import (
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
	"github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

var errInvalid = errors.New("invalid slice storage request")

// Origin implements the daily clear over only the saved account's slice keys.
// Before prevents a delayed clear from deleting a new day's uploads.
type AccountOrigin struct {
	Account      sign.Account
	Before       time.Time
	SettlesAfter time.Time
	SelectKeys   func(context.Context, []string) ([]string, error)
}

func (o AccountOrigin) prefix() (string, error) {
	prefix, err := contract.SlicePrefix(o.Account.ID)
	if err != nil || o.Account.KeyPrefix != prefix || o.Before.IsZero() {
		return "", errInvalid
	}
	return prefix + "uploads/", nil
}

func (o AccountOrigin) call(ctx context.Context, method, key string, query [][2]string, headers map[string]string, body []byte) (r2.Response, error) {
	var signed [][2]string
	for name, value := range headers {
		signed = append(signed, [2]string{name, value})
	}
	raw, _, err := sign.PresignURL(o.Account, method, key, "", time.Now(), 5*time.Minute, query, signed)
	if err != nil {
		return r2.Response{}, errInvalid
	}
	response, err := r2.ExchangeAccount(ctx, o.Account, r2.Request{Method: method, URL: raw, Headers: headers, Body: body, Timeout: 30 * time.Second, StrictRead: true, MaxBytes: 2 << 20})
	if err != nil || response.Status != http.StatusOK {
		return r2.Response{}, errors.New("R2 request failed")
	}
	return response, nil
}

// List walks all pages until it has 1,000 eligible, canonical slice keys.
func (o AccountOrigin) List(ctx context.Context) ([]string, error) {
	prefix, err := o.prefix()
	if err != nil {
		return nil, err
	}
	var keys []string
	token := ""
	for {
		query := [][2]string{{"list-type", "2"}, {"max-keys", "1000"}, {"prefix", prefix}}
		if token != "" {
			query = append(query, [2]string{"continuation-token", token})
		}
		response, err := o.call(ctx, http.MethodGet, "", query, nil, nil)
		if err != nil {
			return nil, err
		}
		var page struct {
			XMLName xml.Name `xml:"ListBucketResult"`
			Keys    []struct {
				Key string `xml:"Key"`
			} `xml:"Contents"`
			Truncated bool   `xml:"IsTruncated"`
			Next      string `xml:"NextContinuationToken"`
		}
		if xml.Unmarshal(response.Body, &page) != nil || len(page.Keys) > 1000 {
			return nil, errInvalid
		}
		var candidates []string
		for _, item := range page.Keys {
			parsed, ok := objectkey.ParseUploadKey(item.Key)
			if !strings.HasPrefix(item.Key, prefix) {
				return nil, errInvalid
			}
			if ok && time.UnixMilli(parsed.BatchMS).Before(o.Before) {
				candidates = append(candidates, item.Key)
			}
		}
		if o.SelectKeys != nil && len(candidates) > 0 {
			candidates, err = o.SelectKeys(ctx, candidates)
			if err != nil {
				return nil, err
			}
		}
		keys = append(keys, candidates...)
		if len(keys) >= 1000 {
			return keys[:1000], nil
		}
		if !page.Truncated {
			if len(keys) == 0 && time.Now().Before(o.SettlesAfter) {
				return nil, &CallError{Code: "slice_wait_uploads", Retryable: false}
			}
			return keys, nil
		}
		if page.Next == "" || page.Next == token {
			return nil, errInvalid
		}
		token = page.Next
	}
}

// Delete refuses keys outside the account prefix or after the clear boundary.
func (o AccountOrigin) Delete(ctx context.Context, keys []string) (DeleteResult, error) {
	prefix, err := o.prefix()
	if err != nil || len(keys) == 0 || len(keys) > 1000 {
		return DeleteResult{}, errInvalid
	}
	request := struct {
		XMLName xml.Name `xml:"Delete"`
		Objects []struct {
			Key string `xml:"Key"`
		} `xml:"Object"`
	}{}
	want := make(map[string]bool, len(keys))
	for _, key := range keys {
		parsed, ok := objectkey.ParseUploadKey(key)
		if !ok || !strings.HasPrefix(key, prefix) || !time.UnixMilli(parsed.BatchMS).Before(o.Before) || want[key] {
			return DeleteResult{}, errInvalid
		}
		want[key] = true
		request.Objects = append(request.Objects, struct {
			Key string `xml:"Key"`
		}{key})
	}
	body, err := xml.Marshal(request)
	if err != nil {
		return DeleteResult{}, errInvalid
	}
	sum := md5.Sum(body)
	headers := map[string]string{"content-md5": base64.StdEncoding.EncodeToString(sum[:])}
	response, err := o.call(ctx, http.MethodPost, "", [][2]string{{"delete", ""}}, headers, body)
	if err != nil {
		return DeleteResult{}, err
	}
	var receipt struct {
		XMLName xml.Name `xml:"DeleteResult"`
		Deleted []struct {
			Key string `xml:"Key"`
		} `xml:"Deleted"`
		Errors []struct {
			Key string `xml:"Key"`
		} `xml:"Error"`
	}
	if xml.Unmarshal(response.Body, &receipt) != nil {
		return DeleteResult{}, errInvalid
	}
	result := DeleteResult{Retryable: true}
	for _, item := range receipt.Deleted {
		if !want[item.Key] {
			return DeleteResult{}, errInvalid
		}
		delete(want, item.Key)
		result.Deleted++
	}
	for _, item := range receipt.Errors {
		if !want[item.Key] {
			return DeleteResult{}, errInvalid
		}
		delete(want, item.Key)
		result.FailedKeys = append(result.FailedKeys, item.Key)
		result.FailedCodes = append(result.FailedCodes, "s3_delete_rejected")
	}
	if len(want) != 0 {
		return DeleteResult{}, errInvalid
	}
	return result, nil
}
