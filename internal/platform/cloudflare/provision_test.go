package cloudflare

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestProvisionConfiguresOnlyTheReservedBucket(t *testing.T) {
	var calls []string
	c := New(transportFunc(func(r *http.Request) (*http.Response, error) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer setup-token" || r.URL.Host != "api.cloudflare.com" {
			t.Fatal("wrong management authorization")
		}
		base := "/client/v4/accounts/" + testAccount
		body, _ := io.ReadAll(r.Body)
		switch r.URL.Path {
		case base + "/r2/buckets/podhub-test/cors":
			var policy struct {
				Rules []struct {
					Allowed struct{ Origins, Methods, Headers []string }
					Expose  []string `json:"exposeHeaders"`
				}
			}
			if json.Unmarshal(body, &policy) != nil || len(policy.Rules) != 1 || strings.Join(policy.Rules[0].Allowed.Origins, ",") != "https://podhub.example" || strings.Join(policy.Rules[0].Allowed.Methods, ",") != "GET,PUT,HEAD" {
				t.Fatal("CORS did not stay limited to this app")
			}
			return response(200, `{"success":true,"result":{}}`), nil
		case base + "/r2/buckets/podhub-test/domains/managed":
			if string(body) != `{"enabled":true}` {
				t.Fatal("public consent was not applied")
			}
			return response(200, `{"success":true,"result":{"enabled":true,"domain":"pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev"}}`), nil
		case base + "/tokens/permission_groups":
			return response(200, `{"success":true,"result":[{"id":"cccccccccccccccccccccccccccccccc","name":"Workers R2 Storage Bucket Item Write"}]}`), nil
		case base + "/tokens":
			var policy struct {
				Policies []struct {
					Resources map[string]string
					Groups    []struct{ ID string } `json:"permission_groups"`
				}
			}
			resource := "com.cloudflare.edge.r2.bucket." + testAccount + "_default_podhub-test"
			if json.Unmarshal(body, &policy) != nil || len(policy.Policies) != 1 || len(policy.Policies[0].Resources) != 1 || policy.Policies[0].Resources[resource] != "*" || len(policy.Policies[0].Groups) != 1 || policy.Policies[0].Groups[0].ID != strings.Repeat("c", 32) {
				t.Fatal("S3 credential was not restricted to this bucket")
			}
			return response(200, `{"success":true,"result":{"id":"dddddddddddddddddddddddddddddddd","value":"private-s3-token"}}`), nil
		default:
			t.Fatalf("unexpected management request %s", r.URL.Path)
			return nil, nil
		}
	}))
	public, err := c.ConfigureBucket(context.Background(), "setup-token", testAccount, "podhub-test", "https://podhub.example")
	if err != nil || public != "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev" {
		t.Fatalf("configure %s %v", public, err)
	}
	credential, err := c.CreateBucketCredential(context.Background(), "setup-token", testAccount, "podhub-test")
	sum := sha256.Sum256([]byte("private-s3-token"))
	if err != nil || credential.ID != strings.Repeat("d", 32) || credential.Secret != hex.EncodeToString(sum[:]) || len(calls) != 4 {
		t.Fatal("S3 credential derivation or request sequence failed")
	}
	if _, err := c.ConfigureBucket(context.Background(), "setup-token", testAccount, "podhub-test", "https://podhub.example/path"); err == nil || len(calls) != 4 {
		t.Fatal("invalid origin reached Cloudflare")
	}
}
