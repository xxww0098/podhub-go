package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/xxww0098/podhub-go/internal/identity"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	listing "github.com/xxww0098/podhub-go/internal/listing/read/http"
	"github.com/xxww0098/podhub-go/internal/listing/submit"
)

// The generated POST /api/listing/submit is the one send route: the body
// shape selects the stored-row batch branch (row_ids), the Draft branch
// (store_id or items), or the banned-tag check. A well-formed send freezes
// through listing-core and enqueues listing.submit.batch. It does not dial
// Ozon.
func (s *Server) postBatchSubmit(w http.ResponseWriter, r *http.Request, body []byte) {
	p, ok := s.submitActor(w, r)
	if !ok {
		return
	}
	parsed, err := submit.ParseBatch(body)
	if err != nil {
		writeListing(w, http.StatusBadRequest, err.Error(), "bad_request")
		return
	}
	data, err := submit.SendStored(r.Context(), s.Pool, p.OrgID, p.UserID, parsed, s.now())
	if writeSubmit(w, err) {
		return
	}
	writeListingJSON(w, http.StatusOK, struct {
		Data submit.BatchData `json:"data"`
	}{Data: data})
}

func (s *Server) postDraftSubmit(w http.ResponseWriter, r *http.Request, body []byte) {
	p, ok := s.submitActor(w, r)
	if !ok {
		return
	}
	peek, err := submit.PeekDraft(body)
	if err != nil {
		writeListing(w, http.StatusBadRequest, err.Error(), "bad_request")
		return
	}
	if strings.TrimSpace(peek.StoreID) == "" {
		writeListing(w, http.StatusBadRequest, submit.ErrStoreRequired.Error(), "bad_request")
		return
	}
	if _, err := uuid.Parse(strings.TrimSpace(peek.StoreID)); err != nil {
		writeListing(w, http.StatusBadRequest, submit.ErrStoreInvalid.Error(), "bad_request")
		return
	}
	if strings.TrimSpace(peek.CardID) == "" {
		writeListing(w, http.StatusBadRequest, submit.ErrCardRequired.Error(), "bad_request")
		return
	}
	if !peek.HasItems || peek.Items == 0 {
		writeListing(w, http.StatusBadRequest, submit.ErrRowsRequired.Error(), "bad_request")
		return
	}
	if peek.Items > submit.ImportV3MaxItems {
		writeListing(w, http.StatusBadRequest, submit.ErrBatchTooLarge.Error(), "bad_request")
		return
	}
	if peek.RulesVersion != "" || len(peek.Tags) > 0 || peek.Text != "" {
		if !s.draftTagGate(w, r, peek) {
			return
		}
	}
	data, err := submit.SendDrafts(r.Context(), s.Pool, p.OrgID, p.UserID, body, s.now())
	if writeSubmit(w, err) {
		return
	}
	writeListingJSON(w, http.StatusOK, struct {
		Data submit.DraftData `json:"data"`
	}{Data: data})
}

func (s *Server) draftTagGate(w http.ResponseWriter, r *http.Request, peek submit.DraftPeek) bool {
	if strings.TrimSpace(peek.RulesVersion) == "" {
		writeListingJSON(w, http.StatusBadRequest, listingError{Code: "rules_version_required", Message: "需要规则版本"})
		return false
	}
	rules, version, ok := s.currentRules(w, r)
	if !ok {
		return false
	}
	if peek.RulesVersion != version {
		writeListingJSON(w, http.StatusConflict, listingError{
			Code: "rules_stale", Message: "规则版本已变化，请重新拉取", RulesVersion: version,
		})
		return false
	}
	tags := peek.Tags
	if tags == nil {
		tags = []string{}
	}
	verdict, err := listing.Validate(r.Context(), s.Engine, listing.Input{
		RulesVersion: peek.RulesVersion, CurrentVersion: version,
		Tags: tags, Text: peek.Text, Rules: rules,
	})
	if err != nil {
		s.writeTagError(w, version, err)
		return false
	}
	if verdict.Submit.Rejected {
		writeListingJSON(w, http.StatusBadRequest, listingError{
			Code: "banned_tag", Message: verdict.Submit.Message, RulesVersion: version,
			BehaviorChange: verdict.Submit.BehaviorChange, RustFreezeChecksTags: boolPtr(false),
		})
		return false
	}
	return true
}

func writeSubmit(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	var st submit.Status
	if errors.As(err, &st) {
		writeListing(w, st.Code, st.Message, st.Kind)
		return true
	}
	writeListing(w, http.StatusInternalServerError, "服务暂不可用", "internal")
	return true
}

func (s *Server) submitActor(w http.ResponseWriter, r *http.Request) (access.Principal, bool) {
	p, refusal, err := s.principal(r)
	if err != nil {
		writeListing(w, http.StatusInternalServerError, access.MsgUnavailable, "internal")
		return access.Principal{}, false
	}
	if refusal != nil {
		writeListing(w, refusal.Status, refusal.Message, listingCode(refusal))
		return access.Principal{}, false
	}
	if p.OrgID <= 0 || strings.TrimSpace(p.WorkspaceRole) == "" {
		writeListing(w, http.StatusForbidden, access.MsgNoWorkspace, "forbidden")
		return access.Principal{}, false
	}
	role, ok := identity.ParseWorkspaceRole(p.WorkspaceRole)
	if !ok {
		writeListing(w, http.StatusForbidden, access.MsgBadWorkspaceRole, "forbidden")
		return access.Principal{}, false
	}
	if !role.Allows(identity.CapListingSubmit) {
		writeListing(w, http.StatusForbidden, access.MsgListingForbidden, "forbidden")
		return access.Principal{}, false
	}
	return p, true
}
