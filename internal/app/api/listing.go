package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	listing "github.com/xxww0098/podhub-go/internal/listing/read/http"
	platform "github.com/xxww0098/podhub-go/internal/listing/rules"
	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

type dbRules struct {
	q *sqlc.Queries
}

func (d dbRules) EnabledBannedTags(ctx context.Context) ([]listing.Rule, error) {
	return platform.LoadEnabledBannedTags(ctx, d.q)
}

func (s *Server) loadRules(ctx context.Context) ([]listing.Rule, error) {
	if s != nil && s.Rules != nil {
		return s.Rules.EnabledBannedTags(ctx)
	}
	if s == nil || s.Pool == nil {
		return nil, errors.New("banned tag table is not available")
	}
	// banned_tags has no org_id and no tenant RLS, but its grants are on
	// podhub_app. A login role with INHERIT FALSE membership (the API uses
	// podhub_login_api) does not inherit them, so the read must enter the
	// role in the transaction.
	var out []listing.Rule
	err := s.platformRead(ctx, func(q *sqlc.Queries) error {
		rules, err := dbRules{q: q}.EnabledBannedTags(ctx)
		if err != nil {
			return err
		}
		out = rules
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Server) GetListingRules(w http.ResponseWriter, r *http.Request, params GetListingRulesParams) {
	rules, version, ok := s.currentRules(w, r)
	if !ok {
		return
	}
	etag := `"` + version + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-store")
	ifNoneMatch := ""
	if params.IfNoneMatch != nil {
		ifNoneMatch = *params.IfNoneMatch
	}
	if etagMatch(ifNoneMatch, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeListingJSON(w, http.StatusOK, rulesWire{
		RulesVersion: version,
		BannedTags:   listingBannedTagsWire{Rules: bannedTagWires(rules)},
	})
}

// bannedTagWires maps the wasm Rule (camelCase matchMode, the Rust boundary
// and the rulesVersion hash) onto the wire BannedTagRule (match_mode).
func bannedTagWires(rules []listing.Rule) []bannedTagRuleWire {
	out := make([]bannedTagRuleWire, 0, len(rules))
	for _, rule := range rules {
		out = append(out, bannedTagRuleWire{Term: rule.Term, MatchMode: rule.MatchMode})
	}
	return out
}

func (s *Server) PostListingValidate(w http.ResponseWriter, r *http.Request) {
	in, rules, version, ok := s.tagCheck(w, r)
	if !ok {
		return
	}
	verdict, err := listing.Validate(r.Context(), s.Engine, listing.Input{
		RulesVersion:   in.RulesVersion,
		CurrentVersion: version,
		Tags:           in.Tags,
		Text:           in.Text,
		Rules:          rules,
	})
	if err != nil {
		s.writeTagError(w, version, err)
		return
	}
	writeListingJSON(w, http.StatusOK, validateWire{
		RulesVersion: version,
		Save: saveWire{
			OK:       verdict.Save.OK,
			Rejected: orEmpty(verdict.Save.Rejected),
			Message:  verdict.Save.Message,
		},
		AI: stripWire{
			Kept:     orEmpty(verdict.AI.Kept),
			Rejected: orEmpty(verdict.AI.Rejected),
			Text:     verdict.AI.Text,
			Message:  verdict.AI.Message,
		},
		BeforeSend: stripWire{
			Kept:     []string{},
			Rejected: orEmpty(verdict.BeforeSend.Rejected),
			Text:     verdict.BeforeSend.Text,
			Message:  verdict.BeforeSend.Message,
		},
		Submit: submitWire{
			Rejected:             verdict.Submit.Rejected,
			Message:              verdict.Submit.Message,
			BehaviorChange:       verdict.Submit.BehaviorChange,
			RustFreezeChecksTags: verdict.Submit.RustFreezeChecksTags,
		},
	})
}

func (s *Server) PostListingSubmit(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		writeListingJSON(w, http.StatusBadRequest, listingError{Code: "bad_request", Message: "请求格式无效"})
		return
	}
	// The stored-row batch form (row_ids) routes before the Draft check.
	if submit.IsBatch(body) {
		s.postBatchSubmit(w, r, body)
		return
	}
	if submit.IsDraft(body) {
		s.postDraftSubmit(w, r, body)
		return
	}
	if len(body) > 1<<20 {
		writeListingJSON(w, http.StatusBadRequest, listingError{Code: "bad_request", Message: "请求格式无效"})
		return
	}
	in, rules, version, ok := s.tagCheckBytes(w, r, body)
	if !ok {
		return
	}
	verdict, err := listing.Validate(r.Context(), s.Engine, listing.Input{
		RulesVersion:   in.RulesVersion,
		CurrentVersion: version,
		Tags:           in.Tags,
		Text:           in.Text,
		Rules:          rules,
	})
	if err != nil {
		s.writeTagError(w, version, err)
		return
	}
	if verdict.Submit.Rejected {
		writeListingJSON(w, http.StatusBadRequest, listingError{
			Code:                 "banned_tag",
			Message:              verdict.Submit.Message,
			RulesVersion:         version,
			BehaviorChange:       verdict.Submit.BehaviorChange,
			RustFreezeChecksTags: boolPtr(false),
		})
		return
	}
	// The tag gate passed. A body without storeId/items is not a
	// SubmitListingDraftsRequest, so it is a 400. Nothing is written or enqueued.
	writeListingJSON(w, http.StatusBadRequest, listingError{
		Code:    "validation",
		Message: "请求格式无效",
	})
}

func (s *Server) currentRules(w http.ResponseWriter, r *http.Request) ([]listing.Rule, string, bool) {
	rules, err := s.loadRules(r.Context())
	if err != nil {
		slog.Error("banned tags read", "err", err)
		writeListingJSON(w, http.StatusServiceUnavailable, listingError{
			Code:    "rules_unavailable",
			Message: "规则表读取失败，已拒绝通过",
		})
		return nil, "", false
	}
	if rules == nil {
		rules = []listing.Rule{}
	}
	version, err := listing.RulesVersion(rules)
	if err != nil {
		slog.Error("banned tags version", "err", err)
		writeListingJSON(w, http.StatusServiceUnavailable, listingError{
			Code:    "rules_unavailable",
			Message: "规则表读取失败，已拒绝通过",
		})
		return nil, "", false
	}
	return rules, version, true
}

func (s *Server) tagCheck(w http.ResponseWriter, r *http.Request) (tagCheckRequest, []listing.Rule, string, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeListingJSON(w, http.StatusBadRequest, listingError{Code: "bad_request", Message: "请求格式无效"})
		return tagCheckRequest{}, nil, "", false
	}
	return s.tagCheckBytes(w, r, body)
}

func (s *Server) tagCheckBytes(w http.ResponseWriter, r *http.Request, body []byte) (tagCheckRequest, []listing.Rule, string, bool) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var in tagCheckRequest
	if err := dec.Decode(&in); err != nil {
		writeListingJSON(w, http.StatusBadRequest, listingError{Code: "bad_request", Message: "请求格式无效"})
		return tagCheckRequest{}, nil, "", false
	}
	if strings.TrimSpace(in.RulesVersion) == "" {
		writeListingJSON(w, http.StatusBadRequest, listingError{Code: "rules_version_required", Message: "需要规则版本"})
		return tagCheckRequest{}, nil, "", false
	}
	if in.Tags == nil {
		in.Tags = []string{}
	}
	rules, version, ok := s.currentRules(w, r)
	if !ok {
		return tagCheckRequest{}, nil, "", false
	}
	if in.RulesVersion != version {
		writeListingJSON(w, http.StatusConflict, listingError{
			Code:         "rules_stale",
			Message:      "规则版本已变化，请重新拉取",
			RulesVersion: version,
		})
		return tagCheckRequest{}, nil, "", false
	}
	if s.Engine == nil {
		writeListingJSON(w, http.StatusServiceUnavailable, listingError{
			Code:         "rules_unavailable",
			Message:      "规则未能执行，已拒绝通过",
			RulesVersion: version,
		})
		return tagCheckRequest{}, nil, "", false
	}
	return in, rules, version, true
}

func (s *Server) writeTagError(w http.ResponseWriter, version string, err error) {
	if errors.Is(err, listing.ErrRulesStale) {
		writeListingJSON(w, http.StatusConflict, listingError{
			Code:         "rules_stale",
			Message:      "规则版本已变化，请重新拉取",
			RulesVersion: version,
		})
		return
	}
	slog.Error("listing tag check", "err", err)
	writeListingJSON(w, http.StatusServiceUnavailable, listingError{
		Code:         "rules_unavailable",
		Message:      "规则未能执行，已拒绝通过",
		RulesVersion: version,
	})
}

func etagMatch(header, etag string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.TrimSpace(part) == etag {
			return true
		}
	}
	return false
}

func orEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func boolPtr(v bool) *bool { return &v }

type tagCheckRequest struct {
	RulesVersion string   `json:"rules_version"`
	Tags         []string `json:"tags"`
	Text         string   `json:"text"`
}

type rulesWire struct {
	RulesVersion string                `json:"rules_version"`
	BannedTags   listingBannedTagsWire `json:"banned_tags"`
}

type listingBannedTagsWire struct {
	Rules []bannedTagRuleWire `json:"rules"`
}

type bannedTagRuleWire struct {
	Term      string `json:"term"`
	MatchMode string `json:"match_mode"`
}

type validateWire struct {
	RulesVersion string     `json:"rules_version"`
	Save         saveWire   `json:"save"`
	AI           stripWire  `json:"ai"`
	BeforeSend   stripWire  `json:"before_send"`
	Submit       submitWire `json:"submit"`
}

type saveWire struct {
	OK       bool     `json:"ok"`
	Rejected []string `json:"rejected"`
	Message  string   `json:"message"`
}

type stripWire struct {
	Kept     []string `json:"kept"`
	Rejected []string `json:"rejected"`
	Text     string   `json:"text"`
	Message  string   `json:"message"`
}

type submitWire struct {
	Rejected             bool   `json:"rejected"`
	Message              string `json:"message"`
	BehaviorChange       string `json:"behavior_change"`
	RustFreezeChecksTags bool   `json:"rust_freeze_checks_tags"`
}

type listingError struct {
	Code                 string `json:"code"`
	Message              string `json:"message"`
	RulesVersion         string `json:"rules_version,omitempty"`
	BehaviorChange       string `json:"behavior_change,omitempty"`
	RustFreezeChecksTags *bool  `json:"rust_freeze_checks_tags,omitempty"`
}

func writeListingJSON(w http.ResponseWriter, status int, body any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(body); err != nil {
		slog.Error("json encode", "err", err)
		http.Error(w, "encode", http.StatusInternalServerError)
		return
	}
	raw := bytes.TrimRight(buf.Bytes(), "\n")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if _, err := w.Write(raw); err != nil {
		slog.Error("json write", "err", err)
	}
}
