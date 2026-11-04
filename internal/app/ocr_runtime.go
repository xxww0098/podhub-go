package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	configdoc "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	adminactor "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	x1repo "github.com/xxww0098/podhub-go/internal/admin/x1/repo"
	"github.com/xxww0098/podhub-go/internal/ai"
	aicontract "github.com/xxww0098/podhub-go/internal/ai/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	readhttp "github.com/xxww0098/podhub-go/internal/listing/read/http"
	"github.com/xxww0098/podhub-go/internal/listing/rules"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func ocrEndpoint(raw string) (string, string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.Port() != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", "", errors.New("recognition endpoint unavailable")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/chat/completions"
	u.RawPath = ""
	return u.String(), u.Hostname(), nil
}
func newOCRRuntime(pool *pgxpool.Pool, cfg config.Config) *ai.OCRRuntime {
	host := readhttp.Host{Pool: pool, Now: time.Now, Engine: sharedEngine()}
	host.LoadRules = func(ctx context.Context) ([]readhttp.Rule, error) {
		if pool == nil {
			return nil, errors.New("全局受限标签规则不可用")
		}
		return rules.EnabledBannedTags(ctx, func(ctx context.Context) ([]readhttp.Rule, error) {
			var out []readhttp.Rule
			err := db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
				var err error
				out, err = rules.LoadEnabledBannedTags(ctx, sqlc.New(tx))
				return err
			})
			return out, err
		})
	}
	load := func(ctx context.Context) (configdoc.Snapshot, error) {
		return requireAISnapshot(ctx, pool, cfg)
	}
	runtime := &ai.OCRRuntime{Authorize: host.AuthorizeOCR, Settle: host.SettleOCR, Validate: host.ValidateOCR}

	rows := x1repo.NewX1(pool, tenantx.BeginApp)
	rows.ValidateConfig = validateSupplierConfig
	runtime.TestAuthorize = func(ctx context.Context, p access.Principal, source, product string) error {
		return rows.AuthorizeOCRTest(ctx, adminactor.Actor{UserID: p.UserID, OrgID: p.OrgID, Role: p.PlatformRole}, source, product)
	}
	runtime.Models = func(ctx context.Context) ([]string, string, error) {
		snapshot, err := load(ctx)
		if err != nil {
			return nil, "", err
		}
		seen := map[string]bool{}
		models := []string{}
		for _, account := range snapshot.AIAccounts {
			if _, _, err := ocrEndpoint(account.BaseURL); err == nil && account.Active && account.APIKey != "" && account.APIFormat == "chat_completions" && account.Purpose == configdoc.PurposeOCR && !seen[account.Model] {
				seen[account.Model] = true
				models = append(models, account.Model)
			}
		}
		sort.Strings(models)
		preferred := snapshot.AIDefaultModel
		if !seen[preferred] {
			preferred = ""
			if len(models) == 1 {
				preferred = models[0]
			}
		}
		return models, preferred, nil
	}
	runtime.Resolve = func(ctx context.Context, routing aicontract.Routing) (ai.OCRProvider, error) {
		snapshot, err := load(ctx)
		if err != nil {
			return ai.OCRProvider{}, err
		}
		model := routing.Primary
		if model == "" {
			return ai.OCRProvider{}, errors.New("recognition model was not pinned")
		}
		var chosen *configdoc.StoredAI
		for i := range snapshot.AIAccounts {
			account := &snapshot.AIAccounts[i]
			if account.Active && account.Model == model && account.APIKey != "" && account.APIFormat == "chat_completions" && account.Purpose == configdoc.PurposeOCR {
				if chosen == nil || account.Priority < chosen.Priority {
					chosen = account
				}
			}
		}
		if chosen == nil {
			return ai.OCRProvider{}, errors.New("recognition model unavailable")
		}
		endpoint, host, err := ocrEndpoint(chosen.BaseURL)
		if err != nil {
			return ai.OCRProvider{}, err
		}
		client := ai.NewImageClient(host)
		account := *chosen
		return ai.OCRProvider{AccountID: account.ID, Model: account.Model, Complete: func(ctx context.Context, body []byte) (int, []byte, error) {
			body, err := ocrThinkingBody(body, account.Thinking, account.ThinkingFormat)
			if err != nil {
				return 0, nil, errors.New("recognition request invalid")
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
			if err != nil {
				return 0, nil, errors.New("recognition request invalid")
			}
			req.Header.Set("Authorization", "Bearer "+account.APIKey)
			req.Header.Set("Content-Type", "application/json")
			resp, err := client.Do(req)
			if err != nil {
				return 0, nil, errors.New("recognition transport unknown")
			}
			defer resp.Body.Close()
			raw, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
			if err != nil || len(raw) > 2<<20 {
				return resp.StatusCode, nil, errors.New("recognition response invalid")
			}
			return resp.StatusCode, raw, nil
		}}, nil
	}
	runtime.Issue = func(ctx context.Context, p access.Principal, c aicontract.Claim, b aicontract.Binding, in aicontract.Image) (any, error) {
		account, _, err := configuredR2Account(ctx, pool, cfg, media.RolePrivate)
		if err != nil {
			return nil, err
		}
		return ocrUploadTarget(account, p, c, b, in, time.Now())
	}
	runtime.Read = func(ctx context.Context, p access.Principal, c aicontract.Claim, b aicontract.Binding, ticket string) ([]byte, string, error) {
		account, _, err := configuredR2Account(ctx, pool, cfg, media.RolePrivate)
		if err != nil {
			return nil, "", err
		}
		return readOCRUpload(ctx, account, p, c, b, ticket, time.Now())
	}

	return runtime
}

func ocrThinkingBody(body []byte, thinking, format string) ([]byte, error) {
	if format != "enable_thinking" || thinking == "" || thinking == "provider_default" {
		return body, nil
	}
	var request map[string]json.RawMessage
	if err := json.Unmarshal(body, &request); err != nil {
		return nil, err
	}
	if request == nil {
		return nil, errors.New("recognition request must be an object")
	}
	request["enable_thinking"] = json.RawMessage("true")
	if thinking == "disabled" {
		request["enable_thinking"] = json.RawMessage("false")
	}
	return json.Marshal(request)
}
