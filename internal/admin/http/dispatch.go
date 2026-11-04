package adminhttp

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/admin/service"
)

type family int

const (
	familyAdmin family = iota
	familyAI
	familyIntegration
)

func errorFamily(method, path string) family {
	switch method + " " + path {
	case "GET /api/admin/ai-requests", "GET /api/admin/ai-requests/summary",
		"GET /api/admin/ai/prices", "PUT /api/admin/ai/prices", "DELETE /api/admin/ai/prices",
		"POST /api/admin/integrations/ai/models", "POST /api/admin/integrations/ai/verify":
		return familyAI
	case "GET /api/admin/integrations/config", "PUT /api/admin/integrations/config":
		return familyIntegration
	default:
		return familyAdmin
	}
}

func implemented(method, path string) bool {
	switch method + " " + path {
	case "GET /api/admin/users", "POST /api/admin/users",
		"POST /api/admin/users/{uuid}/status", "POST /api/admin/users/{uuid}/admin",
		"POST /api/admin/users/{uuid}/password", "POST /api/admin/users/{uuid}/seats",
		"POST /api/admin/workspaces/{uuid}/dissolve",
		"GET /api/admin/support-grants", "POST /api/admin/support-grants", "POST /api/admin/support-grants/{id}/revoke",
		"GET /api/admin/writer-leases", "POST /api/admin/writer-leases", "POST /api/admin/writer-leases/revoke",
		"GET /api/admin/ai-requests", "GET /api/admin/ai-requests/summary",
		"GET /api/admin/ai/prices", "PUT /api/admin/ai/prices", "DELETE /api/admin/ai/prices",
		"POST /api/admin/integrations/ai/models", "POST /api/admin/integrations/ai/verify",
		"GET /api/admin/integrations/config", "PUT /api/admin/integrations/config":
		return true
	default:
		return false
	}
}

func writeAuthStatus(w http.ResponseWriter, fam family, status int, message string) {
	code := "AUTH_INVALID"
	if status == http.StatusForbidden {
		code = "FORBIDDEN"
	}
	switch fam {
	case familyAI:
		switch status {
		case http.StatusUnauthorized:
			code = "AUTH_REQUIRED"
		case http.StatusForbidden:
			code = "FORBIDDEN"
		default:
			status = http.StatusInternalServerError
			code = "INTERNAL"
		}
	case familyIntegration:
		if status != http.StatusUnauthorized && status != http.StatusForbidden {
			status = http.StatusInternalServerError
			code = "INTERNAL"
			message = "平台连接配置鉴权结果异常"
		}
	}
	writeErr(w, status, message, code)
}

func (h handler) dispatchPlatform(w http.ResponseWriter, r *http.Request, rt Route, actor domain.Actor) {
	ctx := r.Context()
	var (
		status = http.StatusOK
		body   any
		fault  *contract.Fault
	)
	switch rt.Method + " " + rt.Path {
	case "GET /api/admin/users":
		body, fault = h.API.ListUsers(ctx, actor)
	case "POST /api/admin/users":
		status, body, fault = h.createUser(r, actor)
	case "POST /api/admin/users/{uuid}/status":
		body, fault = h.setStatus(r, actor)
	case "POST /api/admin/users/{uuid}/admin":
		body, fault = h.setRole(r, actor)
	case "POST /api/admin/users/{uuid}/password":
		body, fault = h.setPassword(r, actor)
	case "POST /api/admin/users/{uuid}/seats":
		body, fault = h.setSeats(r, actor)
	case "POST /api/admin/workspaces/{uuid}/dissolve":
		body, fault = h.dissolve(r, actor)
	case "GET /api/admin/support-grants":
		body, fault = h.listGrants(r, actor)
	case "POST /api/admin/support-grants":
		body, fault = h.issueGrant(r, actor)
	case "POST /api/admin/support-grants/{id}/revoke":
		body, fault = h.revokeGrant(r, actor)
	case "GET /api/admin/writer-leases":
		body, fault = h.API.LeaseStatus(ctx, actor)
	case "POST /api/admin/writer-leases":
		body, fault = h.grantLease(r, actor)
	case "POST /api/admin/writer-leases/revoke":
		body, fault = h.revokeLease(r, actor)
	case "GET /api/admin/ai-requests":
		q := r.URL.Query()
		body, fault = h.API.ListUsage(ctx, actor, q.Get("q"), q.Get("status"), q.Get("api_format"), q.Get("operation"), q.Get("since"), q.Get("page"), q.Get("page_size"))
	case "GET /api/admin/ai-requests/summary":
		q := r.URL.Query()
		body, fault = h.API.SummarizeUsage(ctx, actor, q.Get("q"), q.Get("status"), q.Get("api_format"), q.Get("operation"), q.Get("since"))
	case "GET /api/admin/ai/prices":
		body, fault = h.API.Prices(ctx)
	case "PUT /api/admin/ai/prices":
		body, fault = h.publishPrice(r, actor)
	case "DELETE /api/admin/ai/prices":
		body, fault = h.unpublishPrice(r, actor)
	case "POST /api/admin/integrations/ai/models":
		body, fault = h.probe(r, false)
	case "POST /api/admin/integrations/ai/verify":
		body, fault = h.probe(r, true)
	case "PUT /api/admin/integrations/config":
		body, fault = h.replaceConfig(r, actor)
	case "GET /api/admin/integrations/config":
		body, fault = h.API.GetConfig(ctx)
	default:
		writeErr(w, http.StatusNotImplemented, contract.ErrNotPorted.Error(), "not_ported")
		return
	}
	if fault != nil {
		writeFault(w, fault)
		return
	}
	writeAdminJSON(w, status, body)
}

func (h handler) createUser(r *http.Request, actor domain.Actor) (int, any, *contract.Fault) {
	obj, fault := readObject(r, []string{"email", "password"}, []string{"name", "role"})
	if fault != nil {
		return 0, nil, fault
	}
	email, fault := obj.str("email")
	if fault != nil {
		return 0, nil, fault
	}
	password, fault := obj.str("password")
	if fault != nil {
		return 0, nil, fault
	}
	name, fault := obj.optStr("name")
	if fault != nil {
		return 0, nil, fault
	}
	role, fault := obj.optStr("role")
	if fault != nil {
		return 0, nil, fault
	}
	nameS, roleS := "", ""
	if name != nil {
		nameS = *name
	}
	if role != nil {
		roleS = *role
	}
	return h.API.CreateUser(r.Context(), actor, email, password, nameS, roleS)
}

func (h handler) setStatus(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"enabled"}, nil)
	if fault != nil {
		return nil, fault
	}
	enabled, fault := obj.boolean("enabled", true)
	if fault != nil {
		return nil, fault
	}
	return h.API.SetStatus(r.Context(), actor, chi.URLParam(r, "uuid"), enabled)
}

func (h handler) setRole(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"role"}, nil)
	if fault != nil {
		return nil, fault
	}
	role, fault := obj.str("role")
	if fault != nil {
		return nil, fault
	}
	return h.API.SetRole(r.Context(), actor, chi.URLParam(r, "uuid"), role)
}

func (h handler) setPassword(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"password"}, nil)
	if fault != nil {
		return nil, fault
	}
	password, fault := obj.str("password")
	if fault != nil {
		return nil, fault
	}
	return h.API.SetPassword(r.Context(), actor, chi.URLParam(r, "uuid"), password)
}

func (h handler) setSeats(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"seats"}, nil)
	if fault != nil {
		return nil, fault
	}
	seats, fault := obj.nullableI64("seats")
	if fault != nil {
		return nil, fault
	}
	return h.API.SetSeats(r.Context(), actor, chi.URLParam(r, "uuid"), seats)
}

func (h handler) dissolve(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"name"}, nil)
	if fault != nil {
		return nil, fault
	}
	name, fault := obj.str("name")
	if fault != nil {
		return nil, fault
	}
	return h.API.Dissolve(r.Context(), actor, chi.URLParam(r, "uuid"), name)
}

func (h handler) listGrants(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	raw := r.URL.Query().Get("org_id")
	if _, present := r.URL.Query()["org_id"]; present {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return nil, invalidBody()
		}
		if n <= 0 {
			return nil, contract.Validation("org_id 无效")
		}
		return h.API.ListGrants(r.Context(), actor, &n)
	}
	return h.API.ListGrants(r.Context(), actor, nil)
}

func (h handler) issueGrant(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"org_id", "reason"}, []string{"staff_user_id", "ttl_minutes"})
	if fault != nil {
		return nil, fault
	}
	orgID, fault := obj.i64("org_id")
	if fault != nil {
		return nil, fault
	}
	reason, fault := obj.str("reason")
	if fault != nil {
		return nil, fault
	}
	staff, fault := obj.optI64("staff_user_id")
	if fault != nil {
		return nil, fault
	}
	ttl, fault := obj.optI64("ttl_minutes")
	if fault != nil {
		return nil, fault
	}
	var staffID int64
	if staff != nil {
		staffID = *staff
	}
	return h.API.IssueGrant(r.Context(), actor, orgID, staffID, reason, ttl)
}

func (h handler) revokeGrant(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		return nil, invalidBody()
	}
	return h.API.RevokeGrant(r.Context(), actor, id)
}

func (h handler) grantLease(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"domain", "holder", "holderInstance", "reason"}, []string{"expectedFence"})
	if fault != nil {
		return nil, fault
	}
	name, fault := obj.str("domain")
	if fault != nil {
		return nil, fault
	}
	holder, fault := obj.str("holder")
	if fault != nil {
		return nil, fault
	}
	instance, fault := obj.str("holderInstance")
	if fault != nil {
		return nil, fault
	}
	reason, fault := obj.str("reason")
	if fault != nil {
		return nil, fault
	}
	expected, fault := obj.optI64("expectedFence")
	if fault != nil {
		return nil, fault
	}
	return h.API.GrantLease(r.Context(), actor, name, holder, instance, reason, expected)
}

func (h handler) revokeLease(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"domain", "reason"}, []string{"expectedFence"})
	if fault != nil {
		return nil, fault
	}
	name, fault := obj.str("domain")
	if fault != nil {
		return nil, fault
	}
	reason, fault := obj.str("reason")
	if fault != nil {
		return nil, fault
	}
	expected, fault := obj.optI64("expectedFence")
	if fault != nil {
		return nil, fault
	}
	return h.API.RevokeLease(r.Context(), actor, name, reason, expected)
}

func (h handler) publishPrice(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{
		"model", "input_microfen_per_million", "cached_input_microfen_per_million",
		"output_microfen_per_million", "reasoning_microfen_per_million", "max_request_microfen",
	}, []string{"billing_mode", "per_request_microfen"})
	if fault != nil {
		return nil, fault
	}
	model, fault := obj.str("model")
	if fault != nil {
		return nil, fault
	}
	mode := "token"
	if _, ok := obj["billing_mode"]; ok {
		parsed, present, fault := obj.rawString("billing_mode", true)
		if fault != nil {
			return nil, fault
		}
		if present {
			mode = parsed
		}
	}
	in, fault := obj.i64("input_microfen_per_million")
	if fault != nil {
		return nil, fault
	}
	cached, fault := obj.i64("cached_input_microfen_per_million")
	if fault != nil {
		return nil, fault
	}
	out, fault := obj.i64("output_microfen_per_million")
	if fault != nil {
		return nil, fault
	}
	reasoning, fault := obj.i64("reasoning_microfen_per_million")
	if fault != nil {
		return nil, fault
	}
	per := int64(0)
	if _, ok := obj["per_request_microfen"]; ok {
		per, fault = obj.i64("per_request_microfen")
		if fault != nil {
			return nil, fault
		}
	}
	max, fault := obj.i64("max_request_microfen")
	if fault != nil {
		return nil, fault
	}
	return h.API.PublishPrice(r.Context(), actor, model, mode, in, cached, out, reasoning, per, max)
}

func (h handler) unpublishPrice(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"model"}, nil)
	if fault != nil {
		return nil, fault
	}
	model, fault := obj.str("model")
	if fault != nil {
		return nil, fault
	}
	return h.API.UnpublishPrice(r.Context(), actor, model)
}

func (h handler) probe(r *http.Request, verify bool) (any, *contract.Fault) {
	obj, fault := readObject(r, nil, []string{"account_id", "base_url", "api_key", "api_format", "model"})
	if fault != nil {
		return nil, fault
	}
	in := service.ProbeIn{}
	if s, fault := obj.optStr("account_id"); fault != nil {
		return nil, fault
	} else if s != nil {
		in.AccountID = *s
	}
	if s, fault := obj.optStr("base_url"); fault != nil {
		return nil, fault
	} else if s != nil {
		in.BaseURL = *s
	}
	if s, fault := obj.optStr("api_key"); fault != nil {
		return nil, fault
	} else if s != nil {
		in.APIKey = *s
	}
	if s, fault := obj.optStr("model"); fault != nil {
		return nil, fault
	} else if s != nil {
		in.Model = *s
	}
	if _, ok := obj["api_format"]; ok {
		format, present, fault := obj.rawString("api_format", true)
		if fault != nil {
			return nil, fault
		}
		if present {
			switch format {
			case "chat_completions", "anthropic_messages", "responses":
			default:
				return nil, invalidBody()
			}
			in.APIFormat = format
			in.HasFormat = true
		}
	}
	if verify {
		return h.API.VerifyModel(r.Context(), in)
	}
	return h.API.ListModels(r.Context(), in)
}

func (h handler) replaceConfig(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"expected_revision", "ai_accounts"}, []string{
		"ai_default_model", "ai_runtime", "system_storage",
	})
	if fault != nil {
		return nil, fault
	}
	expected, fault := obj.i64("expected_revision")
	if fault != nil {
		return nil, fault
	}
	aiDefault, fault := obj.optStr("ai_default_model")
	if fault != nil {
		return nil, fault
	}
	ais, fault := obj.objects("ai_accounts")
	if fault != nil {
		return nil, fault
	}
	in := service.ConfigIn{AIDefault: aiDefault, Expected: expected}
	in.AI, fault = decodeAIs(ais)
	if fault != nil {
		return nil, fault
	}
	if raw, ok := obj["ai_runtime"]; ok {
		if in.Runtime, fault = decodeRuntime(raw); fault != nil {
			return nil, fault
		}
	}
	if _, ok := obj["system_storage"]; ok {
		rows, fault := obj.objects("system_storage")
		if fault != nil {
			return nil, fault
		}
		storage := make([]service.StorageIn, 0, len(rows))
		for _, row := range rows {
			if fault := onlyKeys(row, []string{"role", "endpoint", "bucket", "public_base_url", "access_key_id", "secret_access_key"}, nil); fault != nil {
				return nil, fault
			}
			var item service.StorageIn
			for key, target := range map[string]*string{
				"role": &item.Role, "endpoint": &item.Endpoint, "bucket": &item.Bucket,
				"public_base_url": &item.PublicBaseURL,
				"access_key_id":   &item.AccessKeyID, "secret_access_key": &item.SecretAccessKey,
			} {
				*target, fault = row.str(key)
				if fault != nil {
					return nil, fault
				}
			}
			storage = append(storage, item)
		}
		in.Storage = &storage
	}
	return h.API.ReplaceConfig(r.Context(), actor, in)
}

func decodeAIs(rows []object) ([]service.AIIn, *contract.Fault) {
	out := make([]service.AIIn, 0, len(rows))
	for _, row := range rows {
		if fault := onlyKeys(row, []string{"id", "label", "base_url", "api_format", "model", "api_key", "active", "purpose"}, []string{"thinking", "thinking_format", "priority"}); fault != nil {
			return nil, fault
		}
		item := service.AIIn{Thinking: "provider_default", ThinkingFormat: "none"}
		var fault *contract.Fault
		if item.ID, fault = row.str("id"); fault != nil {
			return nil, fault
		}
		if item.Label, fault = row.str("label"); fault != nil {
			return nil, fault
		}
		if item.BaseURL, fault = row.str("base_url"); fault != nil {
			return nil, fault
		}
		if item.APIFormat, fault = row.str("api_format"); fault != nil {
			return nil, fault
		}
		if item.Model, fault = row.str("model"); fault != nil {
			return nil, fault
		}
		if item.APIKey, fault = row.str("api_key"); fault != nil {
			return nil, fault
		}
		if item.Active, fault = row.boolean("active", true); fault != nil {
			return nil, fault
		}
		if item.Purpose, fault = row.str("purpose"); fault != nil {
			return nil, fault
		}
		if _, ok := row["thinking"]; ok {
			if item.Thinking, fault = row.str("thinking"); fault != nil {
				return nil, fault
			}
		}
		if _, ok := row["thinking_format"]; ok {
			if item.ThinkingFormat, fault = row.str("thinking_format"); fault != nil {
				return nil, fault
			}
		}
		if _, ok := row["priority"]; ok {
			if item.Priority, fault = row.i64("priority"); fault != nil {
				return nil, fault
			}
		}
		out = append(out, item)
	}
	return out, nil
}

// decodeRuntime reads the ai_runtime object: every key is required and must
// be an integer (a boolean for allow_public_egress). Range checks live in the
// service.
func decodeRuntime(raw json.RawMessage) (*domain.AIRuntime, *contract.Fault) {
	obj, fault := decodeObject(raw)
	if fault != nil {
		return nil, fault
	}
	if fault := onlyKeys(obj, []string{
		"max_concurrency_global", "max_concurrency_user", "max_concurrency_account",
		"user_rate_per_minute", "lease_ttl_seconds", "allow_public_egress",
	}, nil); fault != nil {
		return nil, fault
	}
	var out domain.AIRuntime
	for _, field := range []struct {
		key  string
		into *int
	}{
		{"max_concurrency_global", &out.MaxConcurrencyGlobal},
		{"max_concurrency_user", &out.MaxConcurrencyUser},
		{"max_concurrency_account", &out.MaxConcurrencyAccount},
		{"user_rate_per_minute", &out.UserRatePerMinute},
		{"lease_ttl_seconds", &out.LeaseTTLSeconds},
	} {
		n, fault := obj.i64(field.key)
		if fault != nil {
			return nil, fault
		}
		if n < math.MinInt32 || n > math.MaxInt32 {
			return nil, invalidBody()
		}
		*field.into = int(n)
	}
	var fault2 *contract.Fault
	if out.AllowPublicEgress, fault2 = obj.boolean("allow_public_egress", true); fault2 != nil {
		return nil, fault2
	}
	return &out, nil
}

func onlyKeys(obj object, required, optional []string) *contract.Fault {
	allow := map[string]struct{}{}
	for _, key := range required {
		allow[key] = struct{}{}
		if _, ok := obj[key]; !ok {
			return invalidBody()
		}
	}
	for _, key := range optional {
		allow[key] = struct{}{}
	}
	for key := range obj {
		if _, ok := allow[key]; !ok {
			return invalidBody()
		}
	}
	return nil
}
