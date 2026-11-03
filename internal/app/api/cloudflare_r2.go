package api

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/cloudflare"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

const (
	workspaceSlicePath    = "/api/workspace/slice-storage"
	cloudflarePath        = workspaceSlicePath + "/cloudflare"
	cloudflareStateCookie = "podhub_cf_state"
	cloudflareTokenCookie = "podhub_cf_token"
)

// Setup grants live only in encrypted HttpOnly cookies, bound to the PodHub
// login session. No Cloudflare bearer or refresh token is returned to JavaScript.
type cloudflareGrant struct {
	State     string `json:"state,omitempty"`
	Verifier  string `json:"verifier,omitempty"`
	Token     string `json:"token,omitempty"`
	ExpiresAt int64  `json:"expires_at"`
}

func (s *Server) cloudflareActor(r *http.Request) (access.Principal, error) {
	p, refusal, err := s.principal(r)
	if err != nil {
		return p, mediaUnavailable()
	}
	if refusal != nil {
		return p, &mediaFailure{refusal.Status, mediaCode(refusal), refusal.Message}
	}
	if status, message, ok := access.OrgMember(p); !ok {
		return p, &mediaFailure{status, "FORBIDDEN", message}
	}
	if p.WorkspaceRole != "owner" {
		return p, workspaceStorageOwnerRequired()
	}
	if p.UserID <= 0 || p.TokenHash == "" {
		return p, &mediaFailure{401, "UNAUTHENTICATED", "请重新登录"}
	}
	return p, nil
}

func (s *Server) cloudflareReady() bool {
	return s.Cloudflare != nil && s.CloudflareOAuth.Valid() && len(s.SliceStorageKey) == 32
}

func cloudflareAAD(p access.Principal, name string) string {
	return fmt.Sprintf("podhub:cloudflare:%s:%d:%d:%s", name, p.UserID, p.OrgID, p.TokenHash)
}

func (s *Server) cloudflareCookie(w http.ResponseWriter, name, value string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: value, Path: workspaceSlicePath, HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure:  strings.HasPrefix(s.CloudflareOAuth.RedirectURL, "https://"),
		Expires: expires, MaxAge: max(-1, int(expires.Sub(s.now()).Seconds())),
	})
}

func (s *Server) saveCloudflareGrant(w http.ResponseWriter, p access.Principal, name string, grant cloudflareGrant) error {
	raw, err := json.Marshal(grant)
	if err != nil {
		return err
	}
	nonce, ciphertext, err := seal.SealBlob(s.SliceStorageKey, cloudflareAAD(p, name), raw)
	if err != nil {
		return err
	}
	value := base64.RawURLEncoding.EncodeToString(append(nonce, ciphertext...))
	if len(value) > 3800 {
		return errors.New("Cloudflare credential exceeds cookie limit")
	}
	s.cloudflareCookie(w, name, value, time.Unix(grant.ExpiresAt, 0))
	return nil
}

func (s *Server) readCloudflareGrant(r *http.Request, p access.Principal, name string) (cloudflareGrant, error) {
	cookie, err := r.Cookie(name)
	if err != nil || len(cookie.Value) > 3800 {
		return cloudflareGrant{}, cloudflareConnectRequired()
	}
	raw, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil || len(raw) <= 12 {
		return cloudflareGrant{}, cloudflareConnectRequired()
	}
	plain, err := seal.OpenBlob(s.SliceStorageKey, cloudflareAAD(p, name), raw[:12], raw[12:])
	var grant cloudflareGrant
	if err != nil || json.Unmarshal(plain, &grant) != nil || grant.ExpiresAt <= s.now().Unix() {
		return cloudflareGrant{}, cloudflareConnectRequired()
	}
	return grant, nil
}

func cloudflareConnectRequired() error {
	return &mediaFailure{409, "CLOUDFLARE_CONNECT_REQUIRED", "请先授权连接 Cloudflare，授权超过 15 分钟后需重新连接"}
}

func (s *Server) cloudflareToken(r *http.Request) (string, error) {
	p, err := s.cloudflareActor(r)
	if err != nil {
		return "", err
	}
	if !s.cloudflareReady() {
		return "", &mediaFailure{503, "CLOUDFLARE_UNAVAILABLE", "Cloudflare OAuth 尚未配置"}
	}
	grant, err := s.readCloudflareGrant(r, p, cloudflareTokenCookie)
	if err != nil || grant.Token == "" {
		return "", cloudflareConnectRequired()
	}
	return grant.Token, nil
}

func (s *Server) getCloudflareConnection(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, err := s.cloudflareActor(r)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	grant, err := s.readCloudflareGrant(r, p, cloudflareTokenCookie)
	jsonwire.Write(w, 200, map[string]any{"available": s.cloudflareReady(), "connected": s.cloudflareReady() && err == nil && grant.Token != "", "expires_at": grant.ExpiresAt})
}

func (s *Server) authorizeCloudflare(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, err := s.cloudflareActor(r)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if !s.cloudflareReady() {
		writeMediaFailure(w, &mediaFailure{503, "CLOUDFLARE_UNAVAILABLE", "Cloudflare OAuth 尚未配置"})
		return
	}
	var random [64]byte
	if _, err := rand.Read(random[:]); err != nil {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	grant := cloudflareGrant{
		State: base64.RawURLEncoding.EncodeToString(random[:32]), Verifier: base64.RawURLEncoding.EncodeToString(random[32:]),
		ExpiresAt: s.now().Add(10 * time.Minute).Unix(),
	}
	if err := s.saveCloudflareGrant(w, p, cloudflareStateCookie, grant); err != nil {
		writeMediaFailure(w, mediaUnavailable())
		return
	}
	challenge := sha256.Sum256([]byte(grant.Verifier))
	jsonwire.Write(w, 200, map[string]string{"authorization_url": s.CloudflareOAuth.AuthorizeURL(grant.State, base64.RawURLEncoding.EncodeToString(challenge[:]))})
}

func (s *Server) callbackCloudflare(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	p, err := s.cloudflareActor(r)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if !s.cloudflareReady() {
		writeMediaFailure(w, &mediaFailure{503, "CLOUDFLARE_UNAVAILABLE", "Cloudflare OAuth 尚未配置"})
		return
	}
	redirect := func(result string) {
		destination, _ := url.Parse(s.CloudflareOAuth.RedirectURL)
		destination.Path = "/"
		if access.IsPlatformStaff(p.PlatformRole) {
			destination.Path = "/admin"
		}
		destination.RawQuery = "settings=workspace-storage"
		if result != "" {
			destination.Fragment = "cloudflare_error=" + result
		}
		http.Redirect(w, r, destination.String(), http.StatusSeeOther)
	}
	grant, err := s.readCloudflareGrant(r, p, cloudflareStateCookie)
	s.cloudflareCookie(w, cloudflareStateCookie, "", time.Unix(1, 0))
	q := r.URL.Query()
	if err != nil || len(q["state"]) != 1 || subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(grant.State)) != 1 || grant.Verifier == "" {
		redirect("invalid_state")
		return
	}
	if q.Get("error") != "" {
		redirect("denied")
		return
	}
	if len(q["code"]) != 1 || q.Get("code") == "" {
		redirect("failed")
		return
	}
	token, err := s.Cloudflare.Exchange(r.Context(), s.CloudflareOAuth, q.Get("code"), grant.Verifier)
	if err != nil {
		redirect("failed")
		return
	}
	grant = cloudflareGrant{Token: token.AccessToken, ExpiresAt: s.now().Add(time.Duration(min(token.ExpiresIn, 900)) * time.Second).Unix()}
	if err := s.saveCloudflareGrant(w, p, cloudflareTokenCookie, grant); err != nil {
		_ = s.Cloudflare.Revoke(r.Context(), s.CloudflareOAuth, token.AccessToken)
		redirect("failed")
		return
	}
	redirect("")
}

func (s *Server) disconnectCloudflare(w http.ResponseWriter, r *http.Request) {
	p, err := s.cloudflareActor(r)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	if !s.cloudflareReady() {
		writeMediaFailure(w, &mediaFailure{503, "CLOUDFLARE_UNAVAILABLE", "Cloudflare OAuth 尚未配置"})
		return
	}
	grant, err := s.readCloudflareGrant(r, p, cloudflareTokenCookie)
	if err == nil && grant.Token != "" {
		if err := s.Cloudflare.Revoke(r.Context(), s.CloudflareOAuth, grant.Token); err != nil {
			writeMediaFailure(w, &mediaFailure{502, "CLOUDFLARE_REVOKE_FAILED", "无法确认 Cloudflare 授权已撤销，请重试或在 Cloudflare 控制台撤销"})
			return
		}
	}
	s.cloudflareCookie(w, cloudflareTokenCookie, "", time.Unix(1, 0))
	s.cloudflareCookie(w, cloudflareStateCookie, "", time.Unix(1, 0))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listCloudflareAccounts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	token, err := s.cloudflareToken(r)
	if err != nil {
		writeMediaFailure(w, err)
		return
	}
	accounts, err := s.Cloudflare.Accounts(r.Context(), token)
	if err != nil {
		writeCloudflareFailure(w, err)
		return
	}
	jsonwire.Write(w, 200, map[string]any{"accounts": accounts})
}

func writeCloudflareFailure(w http.ResponseWriter, err error) {
	status, code, message := 502, "CLOUDFLARE_API_FAILED", "Cloudflare 请求失败，请稍后重试"
	var upstream *cloudflare.Error
	if errors.Is(err, cloudflare.ErrInput) {
		status, code, message = 400, "VALIDATION", "账户 ID 需为 32 位小写十六进制；桶名需为 3–63 位小写字母、数字或连字符，首尾不能为连字符"
	} else if errors.As(err, &upstream) {
		switch {
		case upstream.Unconfirmed:
			code, message = "CLOUDFLARE_CREATE_UNCONFIRMED", "建桶结果未确认，请先查询同名桶，不要重复创建"
		case upstream.Status == 401 || upstream.Status == 403:
			status, code, message = 403, "CLOUDFLARE_PERMISSION_DENIED", "Cloudflare 授权无效或权限不足，请重新授权并确认 R2 管理权限"
		case upstream.Status == 404:
			status, code, message = 404, "CLOUDFLARE_NOT_FOUND", "未找到 Cloudflare 账户或存储桶"
		case upstream.Status == 409:
			status, code, message = 409, "CLOUDFLARE_BUCKET_EXISTS", "存储桶名称已存在，请更换名称或查询现有桶"
		case upstream.Status == 429:
			status, code, message = 429, "CLOUDFLARE_RATE_LIMITED", "Cloudflare 请求过于频繁，请稍后重试"
		case upstream.Status == 400:
			status, code, message = 400, "CLOUDFLARE_REJECTED", "Cloudflare 拒绝创建，请检查桶名、账户权限及 R2 是否已开通"
		}
		if upstream.Created {
			message = "Cloudflare 已确认建桶，但回读失败；请查询同名桶，不要重复创建"
		}
	}
	writeMediaFailure(w, &mediaFailure{status, code, message})
}
