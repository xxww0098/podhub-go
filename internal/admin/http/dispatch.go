package adminhttp

import (
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
	familyAuth
)

func errorFamily(method, path string) family {
	switch method + " " + path {
	case "GET /api/admin/ai-requests", "GET /api/admin/ai-requests/summary",
		"PUT /api/admin/ai/prices", "DELETE /api/admin/ai/prices",
		"POST /api/admin/integrations/ai/models", "POST /api/admin/integrations/ai/verify":
		return familyAI
	case "PUT /api/admin/integrations/config":
		return familyIntegration
	case "POST /api/admin/totp/enroll", "POST /api/admin/totp/confirm", "POST /api/admin/step-up":
		return familyAuth
	default:
		return familyAdmin
	}
}

func implemented(method, path string) bool {
	switch method + " " + path {
	case "GET /api/admin/users", "POST /api/admin/users",
		"POST /api/admin/users/{uuid}/status", "POST /api/admin/users/{uuid}/admin",
		"POST /api/admin/users/{uuid}/password", "POST /api/admin/users/{uuid}/seats",
		"POST /api/admin/users/{uuid}/member-seats/preview", "POST /api/admin/users/{uuid}/member-seats/apply",
		"POST /api/admin/workspaces/{uuid}/dissolve",
		"GET /api/admin/support-grants", "POST /api/admin/support-grants", "POST /api/admin/support-grants/{id}/revoke",
		"GET /api/admin/writer-leases", "POST /api/admin/writer-leases", "POST /api/admin/writer-leases/revoke",
		"GET /api/admin/ai-requests", "GET /api/admin/ai-requests/summary",
		"PUT /api/admin/ai/prices", "DELETE /api/admin/ai/prices",
		"POST /api/admin/integrations/ai/models", "POST /api/admin/integrations/ai/verify",
		"PUT /api/admin/integrations/config",
		"POST /api/admin/totp/enroll", "POST /api/admin/totp/confirm", "POST /api/admin/step-up":
		return true
	default:
		return false
	}
}

func wantsStepUp(method, path string) bool {
	switch method + " " + path {
	case "POST /api/admin/totp/enroll", "POST /api/admin/totp/confirm", "POST /api/admin/step-up":
		return false
	default:
		return implemented(method, path)
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

func writeAuthFault(w http.ResponseWriter, fam family, fault *contract.Fault) {
	if fault == nil {
		writeAuthStatus(w, fam, http.StatusInternalServerError, msgUnavailable)
		return
	}
	if fam == familyAdmin || fam == familyAuth || fault.Status == http.StatusForbidden || (fam == familyAI && fault.Status == http.StatusUnauthorized) {
		if fam == familyAI && fault.Status == http.StatusUnauthorized {
			fault = contract.Coded(http.StatusUnauthorized, "AUTH_REQUIRED", fault.Message)
		}
		writeFault(w, fault)
		return
	}
	writeAuthStatus(w, fam, fault.Status, fault.Message)
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
	case "POST /api/admin/users/{uuid}/member-seats/preview":
		body, fault = h.previewSeats(r, actor)
	case "POST /api/admin/users/{uuid}/member-seats/apply":
		body, fault = h.applySeats(r, actor)
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
		body, fault = h.API.SummarizeUsage(ctx, q.Get("q"), q.Get("status"), q.Get("api_format"), q.Get("operation"), q.Get("since"))
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
	case "POST /api/admin/totp/enroll":
		body, fault = h.API.Enroll(ctx, actor)
	case "POST /api/admin/totp/confirm":
		body, fault = h.totpCode(r, actor, true)
	case "POST /api/admin/step-up":
		body, fault = h.totpCode(r, actor, false)
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
	seats, fault := obj.i64("seats")
	if fault != nil {
		return nil, fault
	}
	return h.API.SetSeats(r.Context(), actor, chi.URLParam(r, "uuid"), seats)
}

func seatIntent(obj object) (domain.SeatIntent, *contract.Fault) {
	member, fault := obj.optI64("member_seats_override")
	if fault != nil {
		return domain.SeatIntent{}, fault
	}
	store, fault := obj.optI64("store_limit_override")
	if fault != nil {
		return domain.SeatIntent{}, fault
	}
	followMembers, fault := obj.boolean("follow_plan_member_seats", false)
	if fault != nil {
		return domain.SeatIntent{}, fault
	}
	followStores, fault := obj.boolean("follow_plan_store_limit", false)
	if fault != nil {
		return domain.SeatIntent{}, fault
	}
	return domain.SeatIntent{
		MemberOverride: member, FollowMembers: followMembers,
		StoreOverride: store, FollowStores: followStores,
	}, nil
}

func (h handler) previewSeats(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, nil, []string{
		"workspace_id", "member_seats_override", "follow_plan_member_seats",
		"store_limit_override", "follow_plan_store_limit",
	})
	if fault != nil {
		return nil, fault
	}
	intent, fault := seatIntent(obj)
	if fault != nil {
		return nil, fault
	}
	workspace, fault := obj.optI64("workspace_id")
	if fault != nil {
		return nil, fault
	}
	return h.API.PreviewSeats(r.Context(), actor, chi.URLParam(r, "uuid"), intent, workspace)
}

func (h handler) applySeats(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"expected_store_limit", "revision"}, []string{
		"workspace_id", "member_seats_override", "follow_plan_member_seats",
		"store_limit_override", "follow_plan_store_limit",
	})
	if fault != nil {
		return nil, fault
	}
	intent, fault := seatIntent(obj)
	if fault != nil {
		return nil, fault
	}
	workspace, fault := obj.optI64("workspace_id")
	if fault != nil {
		return nil, fault
	}
	stores, fault := obj.i64("expected_store_limit")
	if fault != nil {
		return nil, fault
	}
	revision, fault := obj.i64("revision")
	if fault != nil {
		return nil, fault
	}
	return h.API.ApplySeats(r.Context(), actor, chi.URLParam(r, "uuid"), intent, workspace, revision, stores)
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
	obj, fault := readObject(r, nil, []string{"accountId", "baseUrl", "apiKey", "apiFormat", "model"})
	if fault != nil {
		return nil, fault
	}
	in := service.ProbeIn{}
	if s, fault := obj.optStr("accountId"); fault != nil {
		return nil, fault
	} else if s != nil {
		in.AccountID = *s
	}
	if s, fault := obj.optStr("baseUrl"); fault != nil {
		return nil, fault
	} else if s != nil {
		in.BaseURL = *s
	}
	if s, fault := obj.optStr("apiKey"); fault != nil {
		return nil, fault
	} else if s != nil {
		in.APIKey = *s
	}
	if s, fault := obj.optStr("model"); fault != nil {
		return nil, fault
	} else if s != nil {
		in.Model = *s
	}
	if _, ok := obj["apiFormat"]; ok {
		format, present, fault := obj.rawString("apiFormat", true)
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

func (h handler) totpCode(r *http.Request, actor domain.Actor, confirm bool) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"code"}, nil)
	if fault != nil {
		return nil, fault
	}
	code, fault := obj.str("code")
	if fault != nil {
		return nil, fault
	}
	if confirm {
		return h.API.Confirm(r.Context(), actor, code)
	}
	return h.API.StepUp(r.Context(), actor, code)
}

func (h handler) replaceConfig(r *http.Request, actor domain.Actor) (any, *contract.Fault) {
	obj, fault := readObject(r, []string{"expectedRevision", "aiAccounts", "storageBuckets"}, []string{
		"aiDefaultModel",
	})
	if fault != nil {
		return nil, fault
	}
	expected, fault := obj.i64("expectedRevision")
	if fault != nil {
		return nil, fault
	}
	aiDefault, fault := obj.optStr("aiDefaultModel")
	if fault != nil {
		return nil, fault
	}
	ais, fault := obj.objects("aiAccounts")
	if fault != nil {
		return nil, fault
	}
	buckets, fault := obj.objects("storageBuckets")
	if fault != nil {
		return nil, fault
	}
	in := service.ConfigIn{AIDefault: aiDefault, Expected: expected}
	in.AI, fault = decodeAIs(ais)
	if fault != nil {
		return nil, fault
	}
	in.Buckets, fault = decodeBuckets(buckets)
	if fault != nil {
		return nil, fault
	}
	return h.API.ReplaceConfig(r.Context(), actor, in)
}

func decodeAIs(rows []object) ([]service.AIIn, *contract.Fault) {
	out := make([]service.AIIn, 0, len(rows))
	for _, row := range rows {
		if fault := onlyKeys(row, []string{"id", "label", "baseUrl", "apiFormat", "model", "apiKey", "active"}, []string{"thinking", "thinkingFormat", "priority"}); fault != nil {
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
		if item.BaseURL, fault = row.str("baseUrl"); fault != nil {
			return nil, fault
		}
		if item.APIFormat, fault = row.str("apiFormat"); fault != nil {
			return nil, fault
		}
		if item.Model, fault = row.str("model"); fault != nil {
			return nil, fault
		}
		if item.APIKey, fault = row.str("apiKey"); fault != nil {
			return nil, fault
		}
		if item.Active, fault = row.boolean("active", true); fault != nil {
			return nil, fault
		}
		if _, ok := row["thinking"]; ok {
			if item.Thinking, fault = row.str("thinking"); fault != nil {
				return nil, fault
			}
		}
		if _, ok := row["thinkingFormat"]; ok {
			if item.ThinkingFormat, fault = row.str("thinkingFormat"); fault != nil {
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

func decodeBuckets(rows []object) ([]domain.BucketIn, *contract.Fault) {
	out := make([]domain.BucketIn, 0, len(rows))
	for _, row := range rows {
		item, fault := decodeBucket(row)
		if fault != nil {
			return nil, fault
		}
		out = append(out, item)
	}
	return out, nil
}

func decodeBucket(row object) (domain.BucketIn, *contract.Fault) {
	if fault := onlyKeys(row, []string{
		"id", "label", "role", "provider", "endpoint", "region", "bucket", "keyPrefix",
		"publicBaseUrl", "forcePathStyle", "accessKeyId", "secretAccessKey", "sessionToken", "active",
	}, nil); fault != nil {
		return domain.BucketIn{}, fault
	}
	var item domain.BucketIn
	var fault *contract.Fault
	if item.ID, fault = row.str("id"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.Label, fault = row.str("label"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.Role, fault = row.str("role"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.Provider, fault = row.str("provider"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.Endpoint, fault = row.str("endpoint"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.Region, fault = row.str("region"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.Bucket, fault = row.str("bucket"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.KeyPrefix, fault = row.str("keyPrefix"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.PublicBase, fault = row.str("publicBaseUrl"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.ForcePath, fault = row.boolean("forcePathStyle", true); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.AccessKey, fault = row.str("accessKeyId"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.SecretKey, fault = row.str("secretAccessKey"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.Session, fault = row.str("sessionToken"); fault != nil {
		return domain.BucketIn{}, fault
	}
	if item.Active, fault = row.boolean("active", true); fault != nil {
		return domain.BucketIn{}, fault
	}
	return item, nil
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
