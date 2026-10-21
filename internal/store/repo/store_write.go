package storerepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// CreateInput is an already-normalized create request.
type CreateInput struct {
	Name                 string
	ClientID             *string
	AssigneeMembershipID *int64
}

// CreateStore inserts one store inside the caller's write transaction and
// returns its view plus the quota reconcile the insert triggered.
func CreateStore(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor, input CreateInput) (domain.Row, domain.QuotaChanges, error) {
	if api := lockWorkspaceRow(ctx, tx, orgID); api != nil {
		return domain.Row{}, domain.QuotaChanges{}, api
	}
	reloaded, api := reloadActorTx(ctx, tx, orgID, actor)
	if api != nil {
		return domain.Row{}, domain.QuotaChanges{}, api
	}
	actor = reloaded
	order, err := nextCreateOrder(ctx, tx, orgID)
	if err != nil {
		return domain.Row{}, domain.QuotaChanges{}, err
	}
	assignee, api := domain.AssigneeForCreate(actor, input.AssigneeMembershipID)
	if api != nil {
		return domain.Row{}, domain.QuotaChanges{}, api
	}
	if api := ensureClientIDAvailable(ctx, tx, orgID, input.ClientID, nil); api != nil {
		return domain.Row{}, domain.QuotaChanges{}, api
	}
	if api := ensureAssigneeInWorkspace(ctx, tx, orgID, assignee); api != nil {
		return domain.Row{}, domain.QuotaChanges{}, api
	}
	// A self-assigned create opens the grant so the creator can register the
	// first key. Unassigned stores and stores assigned to someone else stay
	// closed.
	grant := actor.IsAssigneeOf(assignee)
	var uuid string
	err = tx.QueryRow(ctx, `
		INSERT INTO public.organization_stores
		       (org_id, create_order, name, client_id, assignee_membership_id,
		        assignee_key_manage, assignee_key_read, assignee_key_write, assignee_key_edit)
		VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $6)
		RETURNING lower(uuid::text)`,
		orgID, order, input.Name, input.ClientID, assignee, grant).Scan(&uuid)
	if err != nil {
		if mapped := mapConflict(err); mapped != err {
			return domain.Row{}, domain.QuotaChanges{}, mapped
		}
		return domain.Row{}, domain.QuotaChanges{}, err
	}
	// Connecting a store can occupy a current vacant slot, never a future reservation.
	tag, err := tx.Exec(ctx, `UPDATE public.subscription_periods p SET keep_store_ids=
  ARRAY(SELECT s.uuid FROM public.organization_stores s WHERE s.org_id=$1 AND s.uuid=ANY(p.keep_store_ids) AND s.deleted_at_ms IS NULL) || $2::uuid
  WHERE p.org_id=$1 AND p.starts_at<=clock_timestamp() AND clock_timestamp()<p.ends_at AND p.keep_store_ids IS NOT NULL
   AND NOT($2::uuid=ANY(p.keep_store_ids))
   AND (SELECT count(*) FROM public.organization_stores s WHERE s.org_id=$1 AND s.uuid=ANY(p.keep_store_ids) AND s.deleted_at_ms IS NULL)<p.plan_stores+p.extra_stores`, orgID, uuid)
	if err != nil {
		return domain.Row{}, domain.QuotaChanges{}, err
	}
	if tag.RowsAffected() > 0 {
		if _, err = tx.Exec(ctx, `UPDATE subscriptions SET revision=revision+1,updated_at=clock_timestamp() WHERE org_id=$1`, orgID); err != nil {
			return domain.Row{}, domain.QuotaChanges{}, err
		}
	}

	changes, err := reconcileStoreQuota(ctx, tx, orgID)
	if err != nil {
		return domain.Row{}, domain.QuotaChanges{}, err
	}
	if err := bumpQuotaRevision(ctx, tx, orgID); err != nil {
		return domain.Row{}, domain.QuotaChanges{}, err
	}
	row, err := LoadMutationRowTx(ctx, tx, orgID, uuid)
	if err != nil {
		return domain.Row{}, domain.QuotaChanges{}, err
	}
	return row, changes, nil
}

// UpdateInput is an already-normalized patch. A nil pointer leaves the column;
// ClientIDSet distinguishes "absent" from "explicit null", which clears it.
type UpdateInput struct {
	Name        *string
	ClientID    *string
	ClientIDSet bool
	KeyManage   *bool
	TagUUIDs    *[]string
	GroupUUID   *string
	Revision    int64
}

// UpdateStore applies one roster patch. It returns the view and the
// before/after names the audit row reports.
type UpdateResult struct {
	Row        domain.Row
	TagNames   *TagNameChange
	GroupNames *GroupNameChange
}

// TagNameChange is the ordered tag names before and after a tag replacement.
type TagNameChange struct {
	From []string
	To   []string
}

// GroupNameChange is the group name before and after, either side optional.
type GroupNameChange struct {
	From *string
	To   *string
}

// UpdateStore applies the patch inside the caller's write transaction.
func UpdateStore(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor, uuid string, input UpdateInput) (UpdateResult, error) {
	if api := lockWorkspaceRow(ctx, tx, orgID); api != nil {
		return UpdateResult{}, api
	}
	reloaded, api := reloadActorTx(ctx, tx, orgID, actor)
	if api != nil {
		return UpdateResult{}, api
	}
	actor = reloaded
	current, err := LoadMutationRowTx(ctx, tx, orgID, uuid)
	if err != nil {
		return UpdateResult{}, err
	}
	if !actor.Visible(current.AssigneeMembershipID) {
		return UpdateResult{}, contract.NotFound(contract.MsgStoreMissing)
	}
	isOwner := actor.IsOwner()
	if input.ClientIDSet && !actor.MayManageKey(current.AssigneeKeyManage, current.AssigneeMembershipID) {
		return UpdateResult{}, contract.Forbidden(contract.MsgNoPatchKeyGrant)
	}
	if input.KeyManage != nil && !isOwner {
		return UpdateResult{}, contract.Forbidden(contract.MsgGrantOwnerOnly)
	}
	if input.KeyManage != nil && *input.KeyManage && current.AssigneeMembershipID == nil {
		return UpdateResult{}, contract.Validation(contract.MsgGrantNeedsAssignee)
	}
	if api := domain.EnsureRevision(current, input.Revision); api != nil {
		return UpdateResult{}, api
	}
	nextName := current.Name
	if input.Name != nil {
		name, api := domain.NormalizeStoreName(*input.Name)
		if api != nil {
			return UpdateResult{}, api
		}
		nextName = name
	}
	nextClientID := current.ClientID
	if input.ClientIDSet {
		normalized, api := domain.NormalizeClientID(input.ClientID)
		if api != nil {
			return UpdateResult{}, api
		}
		nextClientID = normalized
	}
	nextKeyManage := current.AssigneeKeyManage
	if input.KeyManage != nil {
		nextKeyManage = *input.KeyManage
	}
	var result UpdateResult
	if input.TagUUIDs != nil {
		names, err := replaceTags(ctx, tx, orgID, current, *input.TagUUIDs)
		if err != nil {
			return UpdateResult{}, err
		}
		result.TagNames = names
	}
	touchGroup := false
	var nextGroupID *int64
	if input.GroupUUID != nil {
		change, groupID, err := resolveGroup(ctx, tx, orgID, current, *input.GroupUUID)
		if err != nil {
			return UpdateResult{}, err
		}
		result.GroupNames = change
		touchGroup = true
		nextGroupID = groupID
	}
	if api := ensureClientIDAvailable(ctx, tx, orgID, nextClientID, &current.UUID); api != nil {
		return UpdateResult{}, api
	}
	credentialRotated := !sameStringPtr(current.ClientID, nextClientID)
	if credentialRotated {
		has, err := storeHasCredential(ctx, tx, current.ID)
		if err != nil {
			return UpdateResult{}, err
		}
		if has {
			return UpdateResult{}, contract.Conflict(contract.MsgKeyHeldClientID)
		}
	}
	rotated := 0
	if credentialRotated {
		rotated = 1
	}
	if _, err := tx.Exec(ctx, `
		UPDATE public.organization_stores
		   SET name = $1, client_id = $2,
		       assignee_key_manage = $6,
		       assignee_key_read = $6, assignee_key_write = $6, assignee_key_edit = $6,
		       credential_revision = credential_revision + $5,
		       revision = revision + 1,
		       updated_at = clock_timestamp(),
		       group_id = CASE WHEN $7 THEN $8 ELSE group_id END
		 WHERE id = $3 AND revision = $4 AND deleted_at_ms IS NULL`,
		nextName, nextClientID, current.ID, input.Revision,
		rotated, nextKeyManage, touchGroup, nextGroupID); err != nil {
		if mapped := mapConflict(err); mapped != err {
			return UpdateResult{}, mapped
		}
		return UpdateResult{}, err
	}
	if err := bumpQuotaRevision(ctx, tx, orgID); err != nil {
		return UpdateResult{}, err
	}
	updated, err := LoadMutationRowTx(ctx, tx, orgID, uuid)
	if err != nil {
		return UpdateResult{}, err
	}
	result.Row = updated
	return result, nil
}

// SetStoreStatus flips the manager switch and reconciles the quota.
func SetStoreStatus(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor, uuid string, manualDisabled bool, expectedRevision int64) (domain.Row, domain.QuotaChanges, domain.Row, error) {
	if api := lockWorkspaceRow(ctx, tx, orgID); api != nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Row{}, api
	}
	reloaded, api := reloadActorTx(ctx, tx, orgID, actor)
	if api != nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Row{}, api
	}
	actor = reloaded
	if !actor.CanManageAll() {
		return domain.Row{}, domain.QuotaChanges{}, domain.Row{}, contract.Forbidden(contract.MsgManagerOnly)
	}
	current, err := LoadMutationRowTx(ctx, tx, orgID, uuid)
	if err != nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Row{}, err
	}
	if api := domain.EnsureRevision(current, expectedRevision); api != nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Row{}, api
	}
	if _, err := tx.Exec(ctx, `
		UPDATE public.organization_stores
		   SET manual_disabled = $1, revision = revision + 1, updated_at = clock_timestamp()
		 WHERE id = $2 AND revision = $3 AND deleted_at_ms IS NULL`,
		manualDisabled, current.ID, expectedRevision); err != nil {
		if mapped := mapConflict(err); mapped != err {
			return domain.Row{}, domain.QuotaChanges{}, domain.Row{}, mapped
		}
		return domain.Row{}, domain.QuotaChanges{}, domain.Row{}, err
	}
	changes, err := reconcileStoreQuota(ctx, tx, orgID)
	if err != nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Row{}, err
	}
	if err := bumpQuotaRevision(ctx, tx, orgID); err != nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Row{}, err
	}
	updated, err := LoadMutationRowTx(ctx, tx, orgID, uuid)
	if err != nil {
		return domain.Row{}, domain.QuotaChanges{}, domain.Row{}, err
	}
	return updated, changes, current, nil
}

// DeleteStore soft-deletes one store, drops its ciphertext and tag links, and
// reconciles the quota. It returns the deleted row so the handler can report
// what it was.
func DeleteStore(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor, uuid string, expectedRevision int64, nowMS int64) (domain.Row, int64, domain.QuotaChanges, error) {
	if api := lockWorkspaceRow(ctx, tx, orgID); api != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, api
	}
	reloaded, api := reloadActorTx(ctx, tx, orgID, actor)
	if api != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, api
	}
	actor = reloaded
	current, err := LoadMutationRowTx(ctx, tx, orgID, uuid)
	if err != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, err
	}
	has, err := storeHasCredential(ctx, tx, current.ID)
	if err != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, err
	}
	view := current
	view.CredentialAnyConfigured = view.CredentialAnyConfigured || has
	if api := domain.MayDeleteStore(actor, view); api != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, api
	}
	if api := domain.EnsureRevision(current, expectedRevision); api != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, api
	}
	if _, err := tx.Exec(ctx, `
		UPDATE public.organization_stores
		   SET deleted_at_ms = $1, revision = revision + 1, updated_at = clock_timestamp()
		 WHERE id = $2 AND revision = $3 AND deleted_at_ms IS NULL`,
		nowMS, current.ID, expectedRevision); err != nil {
		if mapped := mapConflict(err); mapped != err {
			return domain.Row{}, 0, domain.QuotaChanges{}, mapped
		}
		return domain.Row{}, 0, domain.QuotaChanges{}, err
	}
	// The ciphertext lives and dies with the quota slot. Deletion is a soft
	// delete, so the row's ON DELETE CASCADE never fires; leaving the ciphertext
	// behind a tombstone would retain openable secret material for a store the
	// Workspace already gave up.
	if _, err := tx.Exec(ctx, `DELETE FROM public.store_seller_credentials WHERE store_id = $1`,
		current.ID); err != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM public.store_tag_links WHERE store_id = $1`,
		current.ID); err != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, err
	}
	changes, err := reconcileStoreQuota(ctx, tx, orgID)
	if err != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, err
	}
	if err := bumpQuotaRevision(ctx, tx, orgID); err != nil {
		return domain.Row{}, 0, domain.QuotaChanges{}, err
	}
	return current, expectedRevision + 1, changes, nil
}

// SetAssignee reassigns one store. A change closes every key grant and bumps
// the quota revision; an unchanged value writes nothing but still commits the
// audit row.
func SetAssignee(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor, uuid string, assignee *int64, expectedRevision int64) (domain.Row, domain.Row, bool, error) {
	if api := lockWorkspaceRow(ctx, tx, orgID); api != nil {
		return domain.Row{}, domain.Row{}, false, api
	}
	reloaded, api := reloadActorTx(ctx, tx, orgID, actor)
	if api != nil {
		return domain.Row{}, domain.Row{}, false, api
	}
	actor = reloaded
	if !actor.CanManageAll() {
		return domain.Row{}, domain.Row{}, false, contract.Forbidden(contract.MsgReassignManager)
	}
	current, err := LoadMutationRowTx(ctx, tx, orgID, uuid)
	if err != nil {
		return domain.Row{}, domain.Row{}, false, err
	}
	if api := domain.EnsureRevision(current, expectedRevision); api != nil {
		return domain.Row{}, domain.Row{}, false, api
	}
	if api := ensureAssigneeInWorkspace(ctx, tx, orgID, assignee); api != nil {
		return domain.Row{}, domain.Row{}, false, api
	}
	changed := !sameInt64Ptr(current.AssigneeMembershipID, assignee)
	if changed {
		if _, err := tx.Exec(ctx, `
			UPDATE public.organization_stores
			   SET assignee_membership_id = $1,
			       assignee_key_manage = false,
			       assignee_key_read = false, assignee_key_write = false,
			       assignee_key_edit = false, revision = revision + 1,
			       updated_at = clock_timestamp()
			 WHERE id = $2 AND revision = $3 AND deleted_at_ms IS NULL`,
			assignee, current.ID, expectedRevision); err != nil {
			return domain.Row{}, domain.Row{}, false, err
		}
		if err := bumpQuotaRevision(ctx, tx, orgID); err != nil {
			return domain.Row{}, domain.Row{}, false, err
		}
	}
	updated, err := LoadMutationRowTx(ctx, tx, orgID, uuid)
	if err != nil {
		return domain.Row{}, domain.Row{}, false, err
	}
	return updated, current, changed, nil
}

// LoadMutationRowTx is the exported view of load_store_mutation_row for the
// service layer's post-write read.
func LoadMutationRowTx(ctx context.Context, tx pgx.Tx, orgID int64, uuid string) (domain.Row, error) {
	row, err := scanProjection(tx.QueryRow(ctx, `
		SELECT `+projectionColumns+`
		  FROM public.organization_stores s
		 WHERE s.org_id = $1 AND s.uuid = $2::uuid
		 LIMIT 1
		 FOR UPDATE`, orgID, uuid))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Row{}, contract.NotFound(contract.MsgStoreMissing)
	}
	if err != nil {
		return domain.Row{}, err
	}
	if row.DeletedAtMS != nil {
		return domain.Row{}, contract.NotFound(contract.MsgStoreDeleted)
	}
	return row, nil
}

func reloadActorTx(ctx context.Context, tx pgx.Tx, orgID int64, actor domain.Actor) (domain.Actor, *contract.APIError) {
	var role string
	err := tx.QueryRow(ctx, `
		SELECT role FROM public.organization_members
		 WHERE id = $1 AND org_id = $2
		   AND status = 'active' AND NOT manual_disabled AND NOT quota_suspended`,
		actor.MembershipID, orgID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Actor{}, contract.Forbidden(contract.MsgMemberUnusable)
	}
	if err != nil {
		return domain.Actor{}, contract.Internal()
	}
	actor.Role = role
	return actor, nil
}

func nextCreateOrder(ctx context.Context, tx pgx.Tx, orgID int64) (int64, error) {
	var order int64
	// Soft-deleted rows keep their create_order: the number is immutable, and
	// reusing a released one would let a new store inherit an old audit trail.
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(create_order), 0) + 1 FROM public.organization_stores
		 WHERE org_id = $1`, orgID).Scan(&order)
	return order, err
}

// ensureClientIDAvailable refuses a Client ID another live store already holds.
// Tombstoned rows do not hold one: deleting a store releases its slot and drops
// it from the roster, so refusing the same Client ID afterwards would leave a
// slot that reads as free and cannot be refilled.
func ensureClientIDAvailable(ctx context.Context, tx pgx.Tx, orgID int64, clientID *string, currentUUID *string) *contract.APIError {
	if clientID == nil {
		return nil
	}
	var existing string
	err := tx.QueryRow(ctx, `
		SELECT lower(uuid::text) FROM public.organization_stores
		 WHERE org_id = $1 AND client_id = $2 AND deleted_at_ms IS NULL
		 LIMIT 1`, orgID, *clientID).Scan(&existing)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return contract.Internal()
	}
	if currentUUID != nil && *currentUUID == existing {
		return nil
	}
	return contract.Conflict(contract.MsgClientIDDuplicate)
}

// ensureAssigneeInWorkspace makes a foreign membership id the caller's 400
// instead of the foreign key's 500.
func ensureAssigneeInWorkspace(ctx context.Context, tx pgx.Tx, orgID int64, membershipID *int64) *contract.APIError {
	if membershipID == nil {
		return nil
	}
	var present int
	err := tx.QueryRow(ctx, `
		SELECT 1 FROM public.organization_members WHERE id = $1 AND org_id = $2`,
		*membershipID, orgID).Scan(&present)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.Validation(contract.MsgAssigneeForeign)
	}
	if err != nil {
		return contract.Internal()
	}
	return nil
}

func storeHasCredential(ctx context.Context, tx pgx.Tx, storeID int64) (bool, error) {
	var present int
	err := tx.QueryRow(ctx,
		`SELECT 1 FROM public.store_seller_credentials WHERE store_id = $1`, storeID).Scan(&present)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// replaceTags sets the store's tag set to exactly uuids and reports the names
// before and after. Every UUID must exist in this org; duplicate UUIDs collapse.
func replaceTags(ctx context.Context, tx pgx.Tx, orgID int64, current domain.Row, uuids []string) (*TagNameChange, error) {
	parsed := make([]string, 0, len(uuids))
	seen := map[string]bool{}
	for _, raw := range uuids {
		normalized, ok := domain.NormalizeStoreUUID(raw)
		if !ok {
			return nil, contract.Validation(contract.MsgTagMissing)
		}
		if seen[normalized] {
			continue
		}
		seen[normalized] = true
		parsed = append(parsed, normalized)
	}
	before, err := tagNames(ctx, tx, current.ID)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id, name FROM public.organization_store_tags
		 WHERE org_id = $1 AND uuid = ANY($2::uuid[])`, orgID, parsed)
	if err != nil {
		return nil, err
	}
	var ids []int64
	after := make([]string, 0, len(parsed))
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
		after = append(after, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) != len(parsed) {
		return nil, contract.Validation(contract.MsgTagMissing)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM public.store_tag_links WHERE store_id = $1 AND NOT (tag_id = ANY($2::bigint[]))`,
		current.ID, ids); err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO public.store_tag_links (org_id, store_id, tag_id)
			SELECT $1, $2, t.id FROM public.organization_store_tags t
			 WHERE t.org_id = $1 AND t.id = ANY($3::bigint[])
			ON CONFLICT DO NOTHING`, orgID, current.ID, ids); err != nil {
			return nil, err
		}
	}
	return &TagNameChange{From: before, To: after}, nil
}

func tagNames(ctx context.Context, tx pgx.Tx, storeID int64) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT t.name FROM public.store_tag_links l
		  JOIN public.organization_store_tags t ON t.id = l.tag_id
		 WHERE l.store_id = $1
		 ORDER BY lower(t.name), t.id`, storeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// resolveGroup maps a requested group UUID (empty clears) to a group id and
// reports the name change. The UUID is trimmed before parsing, unlike tags.
func resolveGroup(ctx context.Context, tx pgx.Tx, orgID int64, current domain.Row, raw string) (*GroupNameChange, *int64, error) {
	from := ""
	if current.Group != nil {
		from = current.Group.Name
	}
	var fromPtr *string
	if current.Group != nil {
		fromPtr = &from
	}
	trimmed := trimSpace(raw)
	if trimmed == "" {
		return &GroupNameChange{From: fromPtr, To: nil}, nil, nil
	}
	uuid, ok := domain.NormalizeStoreUUID(trimmed)
	if !ok {
		return nil, nil, contract.Validation(contract.MsgGroupMissing)
	}
	var id int64
	var name string
	err := tx.QueryRow(ctx, `
		SELECT id, name FROM public.organization_store_groups
		 WHERE org_id = $1 AND uuid = $2::uuid`, orgID, uuid).Scan(&id, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, contract.Validation(contract.MsgGroupMissing)
	}
	if err != nil {
		return nil, nil, err
	}
	return &GroupNameChange{From: fromPtr, To: &name}, &id, nil
}

func sameStringPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sameInt64Ptr(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func trimSpace(value string) string {
	start, end := 0, len(value)
	for start < end && isSpace(value[start]) {
		start++
	}
	for end > start && isSpace(value[end-1]) {
		end--
	}
	return value[start:end]
}

func isSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\v' || b == '\f'
}
