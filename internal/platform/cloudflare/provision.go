package cloudflare

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
)

// ConfigureBucket changes only the newly provisioned bucket. The caller has
// already obtained the owner's explicit consent to publish slice images.
func (c *Client) ConfigureBucket(ctx context.Context, token, accountID, name, origin string) (string, error) {
	u, err := url.Parse(origin)
	if !ValidBucket(accountID, name) || err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) {
		return "", ErrInput
	}
	path := "/accounts/" + accountID + "/r2/buckets/" + name
	policy := map[string]any{"rules": []any{map[string]any{
		"allowed":       map[string]any{"origins": []string{origin}, "methods": []string{"GET", "PUT", "HEAD"}, "headers": []string{"Content-Type", "If-None-Match", "X-Amz-Checksum-Sha256"}},
		"exposeHeaders": []string{"ETag", "Retry-After"}, "maxAgeSeconds": 3600,
	}}}
	if _, err := c.request(ctx, token, http.MethodPut, path+"/cors", policy, nil); err != nil {
		return "", err
	}
	var managed struct {
		Domain  string `json:"domain"`
		Enabled bool   `json:"enabled"`
	}
	if _, err := c.request(ctx, token, http.MethodPut, path+"/domains/managed", map[string]bool{"enabled": true}, &managed); err != nil {
		return "", err
	}
	host := strings.TrimSuffix(strings.TrimPrefix(managed.Domain, "pub-"), ".r2.dev")
	if !managed.Enabled || managed.Domain != "pub-"+host+".r2.dev" || !accountIDPattern.MatchString(host) {
		return "", &Error{}
	}
	return "https://" + managed.Domain, nil
}

type S3Credential struct{ ID, Secret string }

func (c *Client) CreateBucketCredential(ctx context.Context, token, accountID, name string) (S3Credential, error) {
	if !ValidBucket(accountID, name) {
		return S3Credential{}, ErrInput
	}
	var groups []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if _, err := c.request(ctx, token, http.MethodGet, "/accounts/"+accountID+"/tokens/permission_groups", nil, &groups); err != nil {
		return S3Credential{}, err
	}
	groupID := ""
	for _, group := range groups {
		if group.Name == "Workers R2 Storage Bucket Item Write" && accountIDPattern.MatchString(group.ID) {
			groupID = group.ID
			break
		}
	}
	if groupID == "" {
		return S3Credential{}, &Error{Status: 403}
	}
	policy := map[string]any{"name": "PodHub " + name, "policies": []any{map[string]any{
		"effect": "allow", "resources": map[string]string{"com.cloudflare.edge.r2.bucket." + accountID + "_default_" + name: "*"},
		"permission_groups": []any{map[string]string{"id": groupID}},
	}}}
	var created struct {
		ID    string `json:"id"`
		Value string `json:"value"`
	}
	if _, err := c.request(ctx, token, http.MethodPost, "/accounts/"+accountID+"/tokens", policy, &created); err != nil {
		return S3Credential{}, err
	}
	if !accountIDPattern.MatchString(created.ID) || !validToken(created.Value) {
		return S3Credential{}, &Error{Unconfirmed: true}
	}
	sum := sha256.Sum256([]byte(created.Value))
	return S3Credential{ID: created.ID, Secret: hex.EncodeToString(sum[:])}, nil
}

func (c *Client) DeleteCredential(ctx context.Context, token, accountID, id string) error {
	if !accountIDPattern.MatchString(accountID) || !accountIDPattern.MatchString(id) {
		return ErrInput
	}
	_, err := c.request(ctx, token, http.MethodDelete, "/accounts/"+accountID+"/tokens/"+id, nil, nil)
	return err
}
