package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
)

const searchLimitMessage = "Provide query or up to 20 method names; limit must be 1–20"

// Descriptor is one authorized SDK method.
type Descriptor struct {
	Name         string          `json:"name"`
	Summary      string          `json:"summary"`
	Keywords     []string        `json:"keywords"`
	InputSchema  json.RawMessage `json:"inputSchema"`
	OutputSchema json.RawMessage `json:"outputSchema"`
	Declaration  string          `json:"declaration"`
	Effect       string          `json:"effect"`
	Example      json.RawMessage `json:"example"`
	action       string
}

// Visible methods are the workspace methods this grant permits, plus recovery.
// Business schemars schemas were not exported, so those 37 methods are absent.
func Visible(g Grant) []Descriptor {
	var out []Descriptor
	for _, m := range workspaceMethods() {
		if m.action != "" && !g.Permits(m.action) {
			continue
		}
		out = append(out, m)
	}
	out = append(out, recoveryMethod())
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Version is the catalog hash mixed with the authorization digest.
// It is stable for this process. It is not claimed byte-identical to Rust:
// the business method list and schemars documents were not exported.
func Version(g Grant) (string, error) {
	methods := Visible(g)
	raw, err := json.Marshal(methods)
	if err != nil {
		return "", err
	}
	canon, err := Canonical(raw)
	if err != nil {
		return "", err
	}
	auth, err := authorizationDigest(g)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	h.Write(canon)
	h.Write([]byte("\x00authorization\x00"))
	h.Write([]byte(auth))
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Permits is GrantContext::permits for one stored action name.
func (g Grant) Permits(action string) bool {
	if !contains(g.Actions, action) {
		return false
	}
	switch g.ScopeKind {
	case "workspace":
		return workspaceAllows(g.WorkspaceRole, action)
	case "catalog":
		return action == "catalog:read"
	case "supplier_catalog":
		return staff(g.PlatformRole) && supplierAction(action)
	default:
		return false
	}
}

// PermittedActions keeps grant order and drops actions the scope refuses.
func (g Grant) PermittedActions() []string {
	var out []string
	for _, action := range g.Actions {
		if g.Permits(action) {
			out = append(out, action)
		}
	}
	if out == nil {
		out = []string{}
	}
	return out
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func workspaceAllows(role, action string) bool {
	switch action {
	case "read", "catalog:read":
		return role != ""
	case "prepare", "cards:write":
		return role != "" && role != "viewer"
	case "submit":
		return role == "owner" || role == "manager" || role == "member"
	default:
		return false
	}
}

func staff(role string) bool {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "admin", "super_admin":
		return true
	default:
		return false
	}
}

func supplierAction(action string) bool {
	switch action {
	case "supplier:read", "supplier:write", "supplier:delete", "supplier:publish", "supplier:price":
		return true
	default:
		return false
	}
}

func platformDebug(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "admin":
		return "Admin"
	case "super_admin":
		return "SuperAdmin"
	default:
		return "User"
	}
}

func authorizationDigest(g Grant) (string, error) {
	scope := map[string]any{"kind": g.ScopeKind}
	switch g.ScopeKind {
	case "workspace":
		scope["id"] = itoa(g.OrgID)
		scope["role"] = g.WorkspaceRole
	case "supplier_catalog":
		if g.SourceAll {
			scope["sourceIds"] = nil
		} else {
			ids := append([]string{}, g.SourceIDs...)
			sort.Strings(ids)
			scope["sourceIds"] = ids
		}
	}
	body := map[string]any{
		"grantId":      g.ID,
		"userId":       itoa(g.UserID),
		"platformRole": platformDebug(g.PlatformRole),
		"scope":        scope,
		"actions":      g.PermittedActions(),
	}
	raw, err := marshalSorted(body)
	if err != nil {
		return "", err
	}
	return SHA256Hex(raw), nil
}

// SearchResult is the search tool payload.
type SearchResult struct {
	CatalogVersion string       `json:"catalogVersion"`
	Methods        []Descriptor `json:"methods"`
	NextCursor     *string      `json:"nextCursor"`
}

// SearchParams is the search tool input.
type SearchParams struct {
	Query  *string
	Names  []string
	Cursor *string
	Limit  *int
}

// Search filters the authorized catalog.
func Search(g Grant, p SearchParams) (SearchResult, *HostError) {
	limit := 8
	if p.Limit != nil {
		limit = *p.Limit
	}
	if limit < 1 || limit > 20 {
		return SearchResult{}, NewHost("invalid_arguments", searchLimitMessage)
	}
	var query *string
	if p.Query != nil {
		if len([]rune(*p.Query)) > 200 || strings.TrimSpace(*p.Query) == "" {
			return SearchResult{}, NewHost("invalid_arguments", searchLimitMessage)
		}
		folded := strings.ToLower(strings.Join(strings.Fields(*p.Query), " "))
		query = &folded
	}
	var names []string
	if p.Names != nil {
		if len(p.Names) == 0 || len(p.Names) > 20 {
			return SearchResult{}, NewHost("invalid_arguments", searchLimitMessage)
		}
		names = append([]string{}, p.Names...)
		sort.Strings(names)
		names = unique(names)
	}
	if query == nil && names == nil {
		return SearchResult{}, NewHost("invalid_arguments", searchLimitMessage)
	}
	version, err := Version(g)
	if err != nil {
		return SearchResult{}, NewHost("internal", "Service is temporarily unavailable")
	}
	all := Visible(g)
	if names != nil {
		have := map[string]bool{}
		for _, m := range all {
			have[m.Name] = true
		}
		for _, name := range p.Names {
			if !have[name] {
				return SearchResult{}, NewHost("not_found", "Method is unavailable")
			}
		}
	}
	var matched []Descriptor
	for _, m := range all {
		if names != nil && !contains(names, m.Name) {
			continue
		}
		if query != nil && !matches(m, *query) {
			continue
		}
		matched = append(matched, m)
	}
	if matched == nil {
		matched = []Descriptor{}
	}
	fp, err := searchFingerprint(version, query, names, limit)
	if err != nil {
		return SearchResult{}, NewHost("internal", "Service is temporarily unavailable")
	}
	offset := 0
	if p.Cursor != nil {
		if len(*p.Cursor) != 67 || !strings.HasPrefix(*p.Cursor, "s1:") {
			return SearchResult{}, NewHost("invalid_cursor", "Search cursor is invalid or expired; start a new search")
		}
		found := false
		for off := limit; off < len(matched); off += limit {
			if *p.Cursor == cursorFor(fp, off) {
				offset = off
				found = true
				break
			}
		}
		if !found {
			return SearchResult{}, NewHost("invalid_cursor", "Search cursor is invalid or expired; start a new search")
		}
	}
	end := offset + limit
	if end > len(matched) {
		end = len(matched)
	}
	var next *string
	if end < len(matched) {
		c := cursorFor(fp, end)
		next = &c
	}
	page := matched[offset:end]
	if page == nil {
		page = []Descriptor{}
	}
	return SearchResult{CatalogVersion: version, Methods: page, NextCursor: next}, nil
}

func matches(m Descriptor, query string) bool {
	name := strings.ToLower(m.Name)
	summary := strings.ToLower(m.Summary)
	for _, term := range strings.Fields(query) {
		ok := strings.Contains(name, term) || strings.Contains(summary, term)
		if !ok {
			for _, kw := range m.Keywords {
				if strings.Contains(strings.ToLower(kw), term) {
					ok = true
					break
				}
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

func searchFingerprint(version string, query *string, names []string, limit int) (string, error) {
	body := map[string]any{
		"version": version,
		"query":   nil,
		"names":   nil,
		"limit":   limit,
		"sort":    "methodNameAscending",
	}
	if query != nil {
		body["query"] = *query
	}
	if names != nil {
		body["names"] = names
	}
	raw, err := marshalSorted(body)
	if err != nil {
		return "", err
	}
	return SHA256Hex(raw), nil
}

func cursorFor(fingerprint string, offset int) string {
	return "s1:" + SHA256Hex([]byte(fingerprint+":"+itoa(int64(offset))))
}

func unique(in []string) []string {
	if len(in) == 0 {
		return in
	}
	out := []string{in[0]}
	for _, item := range in[1:] {
		if item != out[len(out)-1] {
			out = append(out, item)
		}
	}
	return out
}

func workspaceMethods() []Descriptor {
	empty := json.RawMessage(`{"additionalProperties":false,"properties":{},"required":[],"type":"object"}`)
	out := json.RawMessage(`{"type":"object"}`)
	example := json.RawMessage(`{}`)
	kw := []string{"workspace", "工作空间", "listing"}
	decl := func(ns, fn string) string {
		return "declare namespace sdk." + ns + " { function " + fn + "(args: Record<string, unknown>): Promise<Record<string, unknown>>; }"
	}
	return []Descriptor{
		{Name: "workspace.getContext", Summary: "Read the grant's workspace and live role", Keywords: kw, InputSchema: empty, OutputSchema: out, Declaration: decl("workspace", "getContext"), Effect: "read", Example: example, action: "read"},
		{Name: "workspace.stores.list", Summary: "List stores visible to this grant owner, without credentials", Keywords: kw, InputSchema: empty, OutputSchema: out, Declaration: decl("workspace.stores", "list"), Effect: "read", Example: example, action: "read"},
		{Name: "workspace.cards.list", Summary: "Page cards after applying the caller's store visibility", Keywords: kw, InputSchema: json.RawMessage(`{"additionalProperties":false,"properties":{"cursor":{"maxLength":1024,"minLength":1,"type":"string"},"limit":{"maximum":100,"minimum":1,"type":"integer"},"storeId":{"maxLength":256,"minLength":1,"type":"string"}},"required":[],"type":"object"}`), OutputSchema: out, Declaration: decl("workspace.cards", "list"), Effect: "read", Example: example, action: "read"},
		{Name: "workspace.assets.list", Summary: "List authorized asset metadata; no paths or file bytes", Keywords: kw, InputSchema: empty, OutputSchema: out, Declaration: decl("workspace.assets", "list"), Effect: "read", Example: example, action: "read"},
		{Name: "workspace.listingIntents.list", Summary: "Page visible listing intents; exact ID filters require storeId and empty arrays select nothing", Keywords: kw, InputSchema: json.RawMessage(`{"additionalProperties":false,"properties":{"cardId":{"maxLength":256,"minLength":1,"type":"string"},"cursor":{"maxLength":1024,"minLength":1,"type":"string"},"intentIds":{"items":{"format":"uuid","type":"string"},"maxItems":100,"type":"array"},"latestPerRow":{"type":"boolean"},"limit":{"maximum":100,"minimum":1,"type":"integer"},"listingRowId":{"maxLength":256,"minLength":1,"type":"string"},"listingRowIds":{"items":{"format":"uuid","type":"string"},"maxItems":100,"type":"array"},"stableOrder":{"type":"boolean"},"storeId":{"maxLength":256,"minLength":1,"type":"string"}},"required":[],"type":"object"}`), OutputSchema: out, Declaration: decl("workspace.listingIntents", "list"), Effect: "read", Example: example, action: "read"},
		{Name: "workspace.cards.createDraftFromCatalogProduct", Summary: "Create or return the existing supplier product draft; never replace an existing store or title", Keywords: kw, InputSchema: json.RawMessage(`{"additionalProperties":false,"properties":{"callId":{"maxLength":128,"minLength":1,"type":"string"},"expectedProductRevision":{"pattern":"^[1-9][0-9]{0,18}$","type":"string"},"productId":{"maxLength":256,"minLength":1,"type":"string"},"storeId":{"maxLength":256,"minLength":1,"type":"string"},"title":{"maxLength":200,"type":"string"}},"required":["productId","callId"],"type":"object"}`), OutputSchema: out, Declaration: decl("workspace.cards", "createDraftFromCatalogProduct"), Effect: "write", Example: example, action: "cards:write"},
	}
}

func recoveryMethod() Descriptor {
	return Descriptor{
		Name:         "automation.executions.get",
		Summary:      "Recover this grant's execution status and currently authorized finite mutation receipts; stored script values are never replayed",
		Keywords:     []string{"execution", "recovery", "回执"},
		InputSchema:  json.RawMessage(`{"additionalProperties":false,"properties":{"executionId":{"format":"uuid","type":"string"}},"required":["executionId"],"type":"object"}`),
		OutputSchema: json.RawMessage(`{"type":"object"}`),
		Declaration:  "declare namespace sdk.automation.executions { function get(args: {executionId:string}): Promise<{executionId:string;status:string;calls:number;receipts:unknown[]}>; }",
		Effect:       "read",
		Example:      json.RawMessage(`{"executionId":"00000000-0000-4000-8000-000000000001"}`),
	}
}

// Known reports whether name is in the authorized catalog.
func Known(g Grant, name string) bool {
	for _, m := range Visible(g) {
		if m.Name == name {
			return true
		}
	}
	return false
}
