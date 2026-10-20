// Package service is the MCP JSON-RPC use-case layer.
package service

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/xxww0098/podhub-go/internal/mcp/domain"
)

const instructions = "Use search to obtain the current authorized catalogVersion and SDK declarations, then execute with code and separate input. Reuse executionId only for the same request; inspect durable receipts to recover partial work."

// Service answers one authenticated JSON-RPC request.
type Service struct {
	store domain.Store
	codes CodeAdmin
}

// New binds the repository. A nil store fails closed.
func New(store domain.Store) *Service { return &Service{store: store} }

// WithCodes attaches the admin activation-code and quota-card issuer.
// A nil issuer leaves those tools refusing with 服务暂不可用.
func (s *Service) WithCodes(admin CodeAdmin) *Service {
	if s == nil {
		return &Service{codes: admin}
	}
	s.codes = admin
	return s
}

// Handle runs one JSON-RPC body for a token that already passed the HTTP gate.
// The token hash is resolved again so a revoked grant becomes a session error.
func (s *Service) Handle(ctx context.Context, tokenHash string, body []byte) (int, []byte) {
	var req rpcRequest
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&req); err != nil || req.JSONRPC != "2.0" || len(req.ID) == 0 || req.Method == "" {
		return 200, rpcError(req.ID, -32600, "Invalid Request", nil)
	}
	grant, err := s.live(ctx, tokenHash)
	if err != nil || grant == nil {
		herr := domain.NewHost("not_authorized", "Authenticated request is required")
		if req.Method == "tools/call" {
			return 200, toolRefusal(req.ID, herr)
		}
		return 200, rpcError(req.ID, -32001, "Request is not authorized", map[string]any{"error": herr})
	}
	if shared, ok := rpcShared(req); ok {
		return 200, shared
	}
	if req.Method == "tools/call" {
		return 200, s.call(ctx, *grant, req.ID, req.Params)
	}
	return 200, rpcError(req.ID, -32601, "Method not found", nil)
}

// HandleSession runs one JSON-RPC body for a user session that already passed
// the HTTP gate. Automation tools stay on the grant path.
func (s *Service) HandleSession(ctx context.Context, caller domain.Caller, body []byte) (int, []byte) {
	var req rpcRequest
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&req); err != nil || req.JSONRPC != "2.0" || len(req.ID) == 0 || req.Method == "" {
		return 200, rpcError(req.ID, -32600, "Invalid Request", nil)
	}
	if shared, ok := rpcShared(req); ok {
		return 200, shared
	}
	if req.Method == "tools/call" {
		return 200, s.callSession(ctx, caller, req.ID, req.Params)
	}
	return 200, rpcError(req.ID, -32601, "Method not found", nil)
}

func rpcShared(req rpcRequest) ([]byte, bool) {
	switch req.Method {
	case "initialize":
		return rpcResult(req.ID, map[string]any{
			"protocolVersion": "2025-11-25",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "podhub-mcp", "version": "0.0.0"},
			"instructions":    instructions,
		}), true
	case "ping":
		return rpcResult(req.ID, map[string]any{}), true
	case "server/discover":
		return rpcResult(req.ID, map[string]any{
			"protocolVersions": []string{"2025-11-25"},
			"serverInfo":       map[string]any{"name": "podhub-mcp", "version": "0.0.0"},
			"instructions":     instructions,
		}), true
	case "tools/list":
		if cursorPresent(req.Params) {
			return rpcError(req.ID, -32602, "Tool list is not paginated", nil), true
		}
		return rpcResult(req.ID, map[string]any{"tools": toolDefinitions()}), true
	default:
		return nil, false
	}
}

// ResolveForGate is the authenticate step. A nil grant or an error is HTTP 401.
func (s *Service) ResolveForGate(ctx context.Context, tokenHash string) (*domain.Grant, error) {
	return s.live(ctx, tokenHash)
}

func (s *Service) live(ctx context.Context, tokenHash string) (*domain.Grant, error) {
	if s == nil || s.store == nil {
		return nil, domain.NewHost("internal", "Service is temporarily unavailable")
	}
	return s.store.Resolve(ctx, tokenHash)
}

func (s *Service) call(ctx context.Context, grant domain.Grant, id json.RawMessage, params json.RawMessage) []byte {
	name, args, ok := decodeToolCall(params)
	if !ok {
		return rpcError(id, -32602, "Invalid tool arguments", nil)
	}
	if adminTool(name) {
		return s.adminTool(ctx, id, name, args, false, domain.Caller{})
	}
	switch name {
	case "search":
		return s.search(grant, id, args)
	case "execute":
		return s.execute(ctx, grant, id, args)
	default:
		return rpcError(id, -32602, "Unknown tool name", nil)
	}
}

func (s *Service) callSession(ctx context.Context, caller domain.Caller, id json.RawMessage, params json.RawMessage) []byte {
	name, args, ok := decodeToolCall(params)
	if !ok {
		return rpcError(id, -32602, "Invalid tool arguments", nil)
	}
	if adminTool(name) {
		return s.adminTool(ctx, id, name, args, true, caller)
	}
	switch name {
	case "search", "execute":
		return toolRefusal(id, domain.NewHost("not_authorized", "此工具需要自动化授权令牌"))
	default:
		return rpcError(id, -32602, "Unknown tool name", nil)
	}
}

func (s *Service) search(grant domain.Grant, id, args json.RawMessage) []byte {
	params, ok := decodeSearch(args)
	if !ok {
		return rpcError(id, -32602, "Invalid tool arguments", nil)
	}
	result, herr := domain.Search(grant, params)
	if herr != nil {
		return toolRefusal(id, herr)
	}
	raw, err := marshal(result)
	if err != nil {
		return toolRefusal(id, domain.NewHost("internal", "Service is temporarily unavailable"))
	}
	if len(raw) > 256*1024 {
		return toolRefusal(id, domain.NewHost("result_too_large", "Search result exceeds its limit; request fewer methods"))
	}
	return toolOK(id, raw, "Authorized method definitions returned", false)
}

func (s *Service) execute(ctx context.Context, grant domain.Grant, id, args json.RawMessage) []byte {
	params, ok := decodeExecute(args)
	if !ok {
		return rpcError(id, -32602, "Invalid tool arguments", nil)
	}
	parsed, err := uuid.Parse(params.ExecutionID)
	if err != nil {
		return rpcError(id, -32602, "executionId must be a UUID", nil)
	}
	params.ExecutionID = parsed.String()
	version, err := domain.Version(grant)
	if err != nil {
		return toolRefusal(id, domain.NewHost("internal", "Service is temporarily unavailable"))
	}
	if params.CatalogVersion != version {
		return toolOK(id, envelopeRaw(domain.Envelope{
			ExecutionID: params.ExecutionID,
			Status:      "failed",
			Calls:       0,
			Error:       domain.NewHost("catalog_changed", "Search the current authorized catalog before executing"),
			Receipts:    []domain.Receipt{},
		}), "Execution did not complete", true)
	}
	if len(params.Input) == 0 {
		params.Input = json.RawMessage("null")
	}
	digest, herr := domain.RequestDigest(params.Code, params.CatalogVersion, params.Input)
	if herr != nil {
		return toolRefusal(id, herr)
	}
	start, err := s.store.Begin(ctx, grant, params.ExecutionID, digest, version)
	if err != nil {
		if host, ok := err.(*domain.HostError); ok {
			return toolRefusal(id, host)
		}
		return toolRefusal(id, domain.NewHost("internal", "Service is temporarily unavailable"))
	}
	if start.Replay {
		start.Envelope.Value = nil
		failed := failedStatus(start.Envelope.Status)
		text := "Execution metadata returned"
		if failed {
			text = "Execution did not complete"
		}
		return toolOK(id, envelopeRaw(start.Envelope), text, failed)
	}
	status, value, hostErr, calls := s.run(ctx, grant, start.Claim, params.Code, params.Input)
	env, err := s.store.Finish(ctx, grant, start.Claim, status, hostErr, calls)
	if err != nil {
		if host, ok := err.(*domain.HostError); ok {
			return toolRefusal(id, host)
		}
		return toolRefusal(id, domain.NewHost("internal", "Service is temporarily unavailable"))
	}
	failed := failedStatus(env.Status)
	text := "Execution metadata returned"
	if failed {
		text = "Execution did not complete"
	}
	_ = value
	if env.Status == "completed" {
		env.Value = value
	}
	return toolOK(id, envelopeRaw(env), text, failed)
}

var sdkCall = regexp.MustCompile(`^return await (?:sdk\.)?([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)+)\(input\);\s*$`)

// run accepts only `return await sdk.<method>(input);`. Anything else needs
// the QuickJS sandbox, which this process does not spawn.
func (s *Service) run(ctx context.Context, grant domain.Grant, claim domain.Claim, code string, input json.RawMessage) (string, json.RawMessage, *domain.HostError, int) {
	m := sdkCall.FindStringSubmatch(strings.TrimSpace(code))
	if m == nil {
		return "failed", nil, domain.NewHost("sandbox_unavailable", "An operating system sandbox is required"), 0
	}
	name := m[1] + m[2]
	if !domain.Known(grant, name) {
		return "failed", nil, domain.NewHost("method_not_allowed", "Method is not available"), 0
	}
	switch name {
	case "workspace.getContext":
		orgName, err := s.store.WorkspaceName(ctx, grant, claim)
		if err != nil {
			return "failed", nil, asHost(err), 1
		}
		raw, merr := marshal(map[string]any{
			"workspaceId":    itoa(grant.OrgID),
			"workspaceName":  orgName,
			"role":           grant.WorkspaceRole,
			"grantId":        grant.ID,
			"grantedActions": grant.PermittedActions(),
		})
		if merr != nil {
			return "failed", nil, domain.NewHost("internal", "Service is temporarily unavailable"), 1
		}
		return "completed", raw, nil, 1
	case "automation.executions.get":
		var body struct {
			ExecutionID string `json:"executionId"`
		}
		if json.Unmarshal(input, &body) != nil {
			return "failed", nil, domain.NewHost("invalid_arguments", "Invalid SDK arguments"), 0
		}
		env, err := s.store.ExecutionView(ctx, grant, claim, body.ExecutionID)
		if err != nil {
			return "failed", nil, asHost(err), 1
		}
		return "completed", envelopeRaw(env), nil, 1
	default:
		return "failed", nil, domain.NewHost("method_not_found", "SDK method is not available"), 0
	}
}

func asHost(err error) *domain.HostError {
	if err == nil {
		return nil
	}
	if host, ok := err.(*domain.HostError); ok {
		return host
	}
	slog.Error("mcp host", "err", err)
	return domain.NewHost("internal", "Service is temporarily unavailable")
}

func failedStatus(status string) bool {
	return status == "failed" || status == "cancelled" || status == "interrupted"
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func cursorPresent(params json.RawMessage) bool {
	if len(params) == 0 {
		return false
	}
	var body struct {
		Cursor json.RawMessage `json:"cursor"`
	}
	if json.Unmarshal(params, &body) != nil {
		return false
	}
	return len(body.Cursor) > 0 && string(body.Cursor) != "null"
}

func decodeSearch(raw json.RawMessage) (domain.SearchParams, bool) {
	if len(raw) == 0 {
		raw = []byte(`{}`)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var body struct {
		Query  *string  `json:"query"`
		Names  []string `json:"names"`
		Cursor *string  `json:"cursor"`
		Limit  *int     `json:"limit"`
	}
	if err := dec.Decode(&body); err != nil {
		return domain.SearchParams{}, false
	}
	return domain.SearchParams{Query: body.Query, Names: body.Names, Cursor: body.Cursor, Limit: body.Limit}, true
}

func decodeExecute(raw json.RawMessage) (execParams, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var body execParams
	if err := dec.Decode(&body); err != nil {
		return execParams{}, false
	}
	if body.ExecutionID == "" || body.CatalogVersion == "" || body.Code == "" {
		return execParams{}, false
	}
	return body, true
}

type execParams struct {
	ExecutionID    string          `json:"executionId"`
	CatalogVersion string          `json:"catalogVersion"`
	Code           string          `json:"code"`
	Input          json.RawMessage `json:"input"`
}

func toolDefinitions() []map[string]any {
	return append([]map[string]any{
		{
			"name":         "search",
			"description":  "Discover authorized SDK methods by keywords or exact names.",
			"inputSchema":  json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"},"names":{"type":"array","items":{"type":"string"}},"cursor":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":20}},"additionalProperties":false}`),
			"outputSchema": json.RawMessage(`{"type":"object"}`),
			"annotations":  map[string]any{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
		},
		{
			"name":         "execute",
			"description":  "Run an async JavaScript function body using the discovered SDK and input. Execution ownership and receipts are managed by the application.",
			"inputSchema":  json.RawMessage(`{"type":"object","properties":{"executionId":{"type":"string"},"catalogVersion":{"type":"string"},"code":{"type":"string"},"input":{}},"required":["executionId","catalogVersion","code"],"additionalProperties":false}`),
			"outputSchema": json.RawMessage(`{"type":"object"}`),
			"annotations":  map[string]any{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": false},
		},
	}, adminToolDefinitions()...)
}

func toolOK(id json.RawMessage, structured json.RawMessage, text string, isError bool) []byte {
	return rpcResult(id, map[string]any{
		"content":           []map[string]string{{"type": "text", "text": text}},
		"structuredContent": json.RawMessage(structured),
		"isError":           isError,
	})
}

func toolRefusal(id json.RawMessage, herr *domain.HostError) []byte {
	raw, _ := marshal(map[string]any{"error": herr})
	text, _ := marshal(herr)
	return rpcResult(id, map[string]any{
		"content":           []map[string]string{{"type": "text", "text": string(text)}},
		"structuredContent": json.RawMessage(raw),
		"isError":           true,
	})
}

func envelopeRaw(env domain.Envelope) json.RawMessage {
	body := map[string]any{
		"executionId": env.ExecutionID,
		"status":      env.Status,
		"calls":       env.Calls,
		"receipts":    receiptsOrEmpty(env.Receipts),
	}
	if len(env.Value) > 0 {
		body["value"] = json.RawMessage(env.Value)
	}
	if env.Error != nil {
		body["error"] = env.Error
	}
	raw, err := marshal(body)
	if err != nil {
		return []byte(`{}`)
	}
	return raw
}

func receiptsOrEmpty(in []domain.Receipt) []map[string]any {
	out := make([]map[string]any, 0, len(in))
	for _, rec := range in {
		meta := rec.Metadata
		if len(meta) == 0 {
			meta = []byte(`{}`)
		}
		out = append(out, map[string]any{
			"callId": rec.CallID, "method": rec.Method, "outcome": rec.Outcome, "metadata": json.RawMessage(meta),
		})
	}
	return out
}

func rpcResult(id json.RawMessage, result any) []byte {
	if len(id) == 0 {
		id = []byte(`null`)
	}
	raw, err := marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "result": result})
	if err != nil {
		return []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error"}}`)
	}
	return raw
}

func rpcError(id json.RawMessage, code int, message string, data any) []byte {
	if len(id) == 0 {
		id = []byte(`null`)
	}
	errBody := map[string]any{"code": code, "message": message}
	if data != nil {
		errBody["data"] = data
	}
	raw, err := marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "error": errBody})
	if err != nil {
		return []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error"}}`)
	}
	return raw
}

func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
