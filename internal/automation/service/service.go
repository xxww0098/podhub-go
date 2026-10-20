package service

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/xxww0098/podhub-go/internal/automation/contract"
	"github.com/xxww0098/podhub-go/internal/automation/domain"
)

// Service validates a call and then asks the store. It does not dial.
type Service struct {
	store  Store
	now    func() time.Time
	random io.Reader
}

// New uses time.Now and crypto/rand when a clock or reader is nil.
func New(store Store, now func() time.Time, random io.Reader) *Service {
	if now == nil {
		now = time.Now
	}
	if random == nil {
		random = rand.Reader
	}
	return &Service{store: store, now: now, random: random}
}

func (s *Service) fail(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, contract.ErrAuthority) {
		return contract.Forbidden(contract.MsgAuthority)
	}
	var fault *contract.Fault
	if errors.As(err, &fault) {
		return err
	}
	return contract.Unavailable()
}

// ListAssetSets returns the caller's sets. An empty list is a 200.
func (s *Service) ListAssetSets(ctx context.Context, orgID, userID int64) ([]domain.AssetSet, error) {
	sets, err := s.store.ListAssetSets(ctx, orgID, userID)
	if err != nil {
		return nil, s.fail(err)
	}
	if sets == nil {
		sets = []domain.AssetSet{}
	}
	return sets, nil
}

// CreateAssetSet inserts one set and its items in request order.
func (s *Service) CreateAssetSet(ctx context.Context, orgID, userID int64, name string, items []domain.ItemInput) (domain.AssetSet, error) {
	name, fault := domain.CleanName(name)
	if fault != nil {
		return domain.AssetSet{}, fault
	}
	items, fault = domain.CleanItems(items)
	if fault != nil {
		return domain.AssetSet{}, fault
	}
	set, err := s.store.CreateAssetSet(ctx, orgID, userID, name, items)
	if err != nil {
		return domain.AssetSet{}, s.fail(err)
	}
	if set.Items == nil {
		set.Items = []domain.AssetItem{}
	}
	return set, nil
}

// Claim pulls up to the clamped limit and always reports the 90s lease.
func (s *Service) Claim(ctx context.Context, orgID, userID int64, runtimeID string, limit *int64) ([]domain.Claimed, int64, error) {
	id, ok := domain.ParseID(runtimeID)
	if !ok {
		return nil, 0, contract.NotFound(contract.MsgRuntimeMissing)
	}
	cmds, err := s.store.Claim(ctx, orgID, userID, id, domain.ClampLimit(limit))
	if err != nil {
		return nil, 0, s.fail(err)
	}
	if cmds == nil {
		cmds = []domain.Claimed{}
	}
	return cmds, domain.ClaimLeaseSeconds, nil
}

// RenewClaim is one lease the caller still believes it holds.
type RenewClaim struct {
	OperationID string
	Epoch       int64
}

// Lease is one renew verdict, in request order.
type Lease struct {
	OperationID  string
	Control      string
	LeaseSeconds int64
}

// Renew extends each still-held lease. A miss is lost and does not write.
func (s *Service) Renew(ctx context.Context, orgID, userID int64, runtimeID string, claims []RenewClaim) ([]Lease, error) {
	id, ok := domain.ParseID(runtimeID)
	if !ok {
		return nil, contract.NotFound(contract.MsgRuntimeMissing)
	}
	ids := make([]string, len(claims))
	epochs := make([]int64, len(claims))
	for i, claim := range claims {
		op, ok := domain.ParseID(claim.OperationID)
		if !ok || claim.Epoch < 0 {
			return nil, contract.Validation(contract.MsgBadClaim)
		}
		ids[i] = op
		epochs[i] = claim.Epoch
	}
	hits, err := s.store.Renew(ctx, orgID, userID, id, ids, epochs)
	if err != nil {
		return nil, s.fail(err)
	}
	if len(hits) != len(claims) {
		return nil, contract.Unavailable()
	}
	out := make([]Lease, len(claims))
	for i, hit := range hits {
		out[i] = Lease{OperationID: ids[i], Control: domain.ControlLost, LeaseSeconds: 0}
		if hit.Matched {
			out[i].Control = domain.ControlContinue
			out[i].LeaseSeconds = domain.ClaimLeaseSeconds
			if hit.Cancel {
				out[i].Control = domain.ControlCancel
			}
		}
	}
	return out, nil
}

// Progress overwrites progress while the lease is held.
func (s *Service) Progress(ctx context.Context, orgID, userID int64, id string, epoch int64, progress json.RawMessage) (domain.WriteResult, error) {
	parsed, ok := domain.ParseID(id)
	if !ok {
		return domain.WriteResult{}, contract.NotFound(contract.MsgOperationMissing)
	}
	res, err := s.store.Progress(ctx, orgID, userID, parsed, epoch, progress)
	return s.writeBack(res, err)
}

// Settle moves a held command to a terminal status.
func (s *Service) Settle(ctx context.Context, orgID, userID int64, id string, epoch int64, status string, result, errJSON *json.RawMessage) (domain.WriteResult, error) {
	status, fault := domain.CleanStatus(status)
	if fault != nil {
		return domain.WriteResult{}, fault
	}
	parsed, ok := domain.ParseID(id)
	if !ok {
		return domain.WriteResult{}, contract.NotFound(contract.MsgOperationMissing)
	}
	res, err := s.store.Settle(ctx, orgID, userID, parsed, epoch, status, result, errJSON)
	return s.writeBack(res, err)
}

func (s *Service) writeBack(res domain.WriteResult, err error) (domain.WriteResult, error) {
	if err != nil {
		return domain.WriteResult{}, s.fail(err)
	}
	if res.Gone {
		return domain.WriteResult{}, contract.NotFound(contract.MsgOperationMissing)
	}
	if !res.Applied {
		res.CancelRequested = true
	}
	return res, nil
}

// ListGrants returns every workspace grant for this user, including revoked rows
// that were not deleted. This route deletes on revoke, so those rows are absent.
func (s *Service) ListGrants(ctx context.Context, userID, orgID int64) ([]domain.GrantView, error) {
	grants, err := s.store.ListGrants(ctx, userID, orgID)
	if err != nil {
		return nil, s.fail(err)
	}
	if grants == nil {
		grants = []domain.GrantView{}
	}
	return grants, nil
}

// CreateGrant mints a token, locks the live role, and inserts one row.
// The token is returned only when the insert commits.
func (s *Service) CreateGrant(ctx context.Context, userID, orgID int64, role, name string, actions []string, expires *int64) (domain.GrantView, string, error) {
	name, fault := domain.CleanName(name)
	if fault != nil {
		return domain.GrantView{}, "", fault
	}
	kept, fault := domain.Delegate(role, actions)
	if fault != nil {
		return domain.GrantView{}, "", fault
	}
	if fault = domain.CleanExpiry(expires); fault != nil {
		return domain.GrantView{}, "", fault
	}
	token, prefix, hash, err := domain.MintToken(s.random)
	if err != nil {
		return domain.GrantView{}, "", contract.Unavailable()
	}
	view, err := s.store.CreateGrant(ctx, userID, orgID, name, hash, prefix, kept, expires)
	if err != nil {
		return domain.GrantView{}, "", s.fail(err)
	}
	if view.Actions == nil {
		view.Actions = []string{}
	}
	return view, token, nil
}

// RevokeGrant deletes the grant and the rows that point at it.
func (s *Service) RevokeGrant(ctx context.Context, userID, orgID int64, id string) (string, error) {
	parsed, ok := domain.ParseID(id)
	if !ok {
		return "", contract.NotFound(contract.MsgGrantMissing)
	}
	got, err := s.store.RevokeGrant(ctx, userID, orgID, parsed)
	if errors.Is(err, contract.ErrMissing) {
		return "", contract.NotFound(contract.MsgGrantMissing)
	}
	if err != nil {
		return "", s.fail(err)
	}
	return got, nil
}

// Runtime is the wire view including the process-clock live bit.
type Runtime struct {
	domain.RuntimeRow
	Live bool
}

func (s *Service) present(row domain.RuntimeRow) Runtime {
	return Runtime{RuntimeRow: row, Live: domain.RuntimeLive(s.now().UnixMilli(), row.HeartbeatAtMS)}
}

// ListRuntimes returns the caller's registered runtimes.
func (s *Service) ListRuntimes(ctx context.Context, orgID, userID int64) ([]Runtime, error) {
	rows, err := s.store.ListRuntimes(ctx, orgID, userID)
	if err != nil {
		return nil, s.fail(err)
	}
	out := make([]Runtime, 0, len(rows))
	for _, row := range rows {
		out = append(out, s.present(row))
	}
	return out, nil
}

// RegisterRuntime inserts a runtime for a live workspace grant.
func (s *Service) RegisterRuntime(ctx context.Context, orgID, userID int64, grantID, label, renderer string) (Runtime, int64, error) {
	label, fault := domain.CleanName(label)
	if fault != nil {
		return Runtime{}, 0, fault
	}
	renderer, fault = domain.CleanRenderer(renderer)
	if fault != nil {
		return Runtime{}, 0, fault
	}
	id, ok := domain.ParseID(grantID)
	if !ok {
		return Runtime{}, 0, contract.NotFound(contract.MsgGrantMissing)
	}
	row, err := s.store.RegisterRuntime(ctx, orgID, userID, id, label, renderer)
	if errors.Is(err, contract.ErrMissing) {
		return Runtime{}, 0, contract.NotFound(contract.MsgGrantInactive)
	}
	if err != nil {
		return Runtime{}, 0, s.fail(err)
	}
	return s.present(row), domain.ClaimLeaseSeconds, nil
}

// DeregisterRuntime marks the runtime and returns its claimed commands to the queue.
func (s *Service) DeregisterRuntime(ctx context.Context, orgID, userID int64, id string) (Runtime, error) {
	return s.touchRuntime(ctx, orgID, userID, id, s.store.DeregisterRuntime)
}

// HeartbeatRuntime refreshes heartbeat_at and does not touch commands.
func (s *Service) HeartbeatRuntime(ctx context.Context, orgID, userID int64, id string) (Runtime, error) {
	return s.touchRuntime(ctx, orgID, userID, id, s.store.HeartbeatRuntime)
}

func (s *Service) touchRuntime(ctx context.Context, orgID, userID int64, id string, fn func(context.Context, int64, int64, string) (domain.RuntimeRow, error)) (Runtime, error) {
	parsed, ok := domain.ParseID(id)
	if !ok {
		return Runtime{}, contract.NotFound(contract.MsgRuntimeMissing)
	}
	row, err := fn(ctx, orgID, userID, parsed)
	if errors.Is(err, contract.ErrMissing) {
		return Runtime{}, contract.NotFound(contract.MsgRuntimeGone)
	}
	if err != nil {
		return Runtime{}, s.fail(err)
	}
	return s.present(row), nil
}
