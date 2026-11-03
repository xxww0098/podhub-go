package cloudflare

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

const testAccount = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func TestCreateBucketReadsBackWithoutChangingExistingConfiguration(t *testing.T) {
	var methods []string
	c := New(transportFunc(func(r *http.Request) (*http.Response, error) {
		methods = append(methods, r.Method)
		if r.URL.Host != "api.cloudflare.com" || r.Header.Get("Authorization") != "Bearer private-token" {
			t.Fatalf("unexpected host/auth: %s", r.URL.Host)
		}
		if r.Method == "POST" {
			body, _ := io.ReadAll(r.Body)
			if r.URL.Path != "/client/v4/accounts/"+testAccount+"/r2/buckets" || string(body) != `{"name":"my-slices"}` {
				t.Fatalf("unexpected create: %s %s", r.URL.Path, body)
			}
		} else if r.Method != "GET" || r.URL.Path != "/client/v4/accounts/"+testAccount+"/r2/buckets/my-slices" {
			t.Fatalf("unexpected read: %s %s", r.Method, r.URL.Path)
		}
		return response(200, `{"success":true,"errors":[],"result":{"name":"my-slices","creation_date":"2026-11-02T00:00:00Z"}}`), nil
	}))
	bucket, err := c.CreateBucket(context.Background(), "private-token", testAccount, "my-slices")
	if err != nil || bucket.Name != "my-slices" || bucket.CreationDate == "" || strings.Join(methods, ",") != "POST,GET" {
		t.Fatalf("create/readback: %+v %v %v", bucket, err, methods)
	}
}

func TestCreateBucketRefusesBadInputWithoutSending(t *testing.T) {
	c := New(transportFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid input left the process")
		return nil, nil
	}))
	for _, in := range []struct{ account, bucket, token string }{
		{testAccount + "/other", "my-slices", "token"}, {testAccount, "ab", "token"},
		{testAccount, "My-Slices", "token"}, {testAccount, "-my-slices", "token"},
		{testAccount, "my-slices-", "token"}, {testAccount, "../my-slices", "token"},
		{testAccount, strings.Repeat("a", 64), "token"}, {testAccount, "my-slices", "bad\r\ntoken"},
	} {
		if _, err := c.CreateBucket(context.Background(), in.token, in.account, in.bucket); !errors.Is(err, ErrInput) {
			t.Errorf("input was accepted: %+v %v", in, err)
		}
	}
}

func TestCreateFailureNeverRetriesOrLeaksUpstreamText(t *testing.T) {
	for _, tc := range []struct {
		name        string
		status      int
		body        string
		transport   bool
		unconfirmed bool
	}{
		{"permission", 403, `{"success":false,"errors":[{"code":10000,"message":"private-token"}]}`, false, false},
		{"conflict", 409, `{"success":false,"errors":[{"code":10004}]}`, false, false},
		{"rate limited", 429, `{"success":false,"errors":[]}`, false, false},
		{"server error", 503, `{"success":false,"errors":[]}`, false, true},
		{"invalid json", 200, `private-token`, false, true},
		{"empty result", 200, `{"success":true,"result":null}`, false, true},
		{"wrong bucket", 200, `{"success":true,"result":{"name":"another"}}`, false, true},
		{"contradictory result", 200, `{"success":true,"errors":[{"code":1}],"result":{"name":"my-slices"}}`, false, true},
		{"failed 200", 200, `{"success":false,"errors":[{"code":1}]}`, false, true},
		{"timeout", 0, "", true, true},
		{"oversized", 200, strings.Repeat("x", (1<<20)+1), false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			c := New(transportFunc(func(*http.Request) (*http.Response, error) {
				calls++
				if tc.transport {
					return nil, errors.New("private-token")
				}
				return response(tc.status, tc.body), nil
			}))
			_, err := c.CreateBucket(context.Background(), "private-token", testAccount, "my-slices")
			var failure *Error
			if !errors.As(err, &failure) || failure.Unconfirmed != tc.unconfirmed || calls != 1 || strings.Contains(err.Error(), "private-token") {
				t.Fatalf("failure: %v calls=%d", err, calls)
			}
		})
	}
}

func TestReadbackFailurePreservesCreationAcknowledgement(t *testing.T) {
	calls := 0
	c := New(transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Method == "POST" {
			return response(200, `{"success":true,"result":{"name":"my-slices"}}`), nil
		}
		return response(503, `{"success":false}`), nil
	}))
	_, err := c.CreateBucket(context.Background(), "token", testAccount, "my-slices")
	var failure *Error
	if !errors.As(err, &failure) || !failure.Created || !failure.Unconfirmed || calls != 2 {
		t.Fatalf("lost partial result: %v calls=%d", err, calls)
	}
}

func TestAccountsPaginates(t *testing.T) {
	calls := 0
	c := New(transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Query().Get("page") != string(rune('0'+calls)) {
			t.Fatal("wrong page")
		}
		return response(200, `{"success":true,"result":[{"id":"`+testAccount+`","name":"Test"}],"result_info":{"total_pages":2}}`), nil
	}))
	accounts, err := c.Accounts(context.Background(), "token")
	if err != nil || len(accounts) != 2 || calls != 2 {
		t.Fatalf("pagination: %v %v", accounts, err)
	}
}

func TestClientRefusesRedirects(t *testing.T) {
	calls := 0
	c := New(transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls > 1 {
			t.Fatal("followed a redirect carrying credentials")
		}
		resp := response(302, `{"success":false}`)
		resp.Header.Set("Location", "https://another.example/")
		return resp, nil
	}))
	_, err := c.CreateBucket(context.Background(), "token", testAccount, "my-slices")
	if err == nil || calls != 1 {
		t.Fatalf("redirect: %v calls=%d", err, calls)
	}
}
