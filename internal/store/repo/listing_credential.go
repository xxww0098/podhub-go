package storerepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

// OpenListingCredentialTx binds every intent to its durable tenant/store before
// opening the current generation with the canonical org/store/revision AAD.
// New sends recheck the actor and subscription. Read-only convergence of existing
// work survives an expired subscription or departed actor, but never a deleted
// store or an unusable/expired credential.
func OpenListingCredentialTx(ctx context.Context, tx pgx.Tx, ring seal.Ring, keyID string, scope sellercontract.StoreBinding, now time.Time) (domain.OpenedCredential, error) {
	refused := errors.New("listing store credential unavailable")
	if scope.OrgID <= 0 || len(scope.IntentIDs) == 0 || (!scope.ReadOnly && scope.UserID <= 0) {
		return domain.OpenedCredential{}, refused
	}
	unique := make(map[string]struct{}, len(scope.IntentIDs))
	for _, id := range scope.IntentIDs {
		if id == "" {
			return domain.OpenedCredential{}, refused
		}
		unique[id] = struct{}{}
	}
	if len(unique) != len(scope.IntentIDs) {
		return domain.OpenedCredential{}, refused
	}
	var state domain.SyncSnapshot
	var disabled, allowed bool
	var found int
	err := tx.QueryRow(ctx, `
		SELECT s.id, s.uuid::text, s.org_id, s.credential_revision,
		       s.manual_disabled,
		       public.subscription_store_allowed(s.org_id,s.uuid,$6),
		       (SELECT count(*) FROM public.submission_intents i
		         WHERE i.org_id=s.org_id AND i.store_id=s.uuid AND i.id=ANY($4::uuid[])
		           AND (($5 AND i.state IN ('unknown','accepted'))
		             OR (NOT $5 AND i.state IN ('queued','submitting'))))
		  FROM public.organization_stores s
		  JOIN public.organizations o ON o.id=s.org_id AND o.dissolved_at IS NULL
		 WHERE s.org_id=$1 AND ($2='' OR s.uuid=NULLIF($2,'')::uuid) AND ($3::bigint=0 OR s.id=$3)
		   AND s.deleted_at_ms IS NULL
		   AND EXISTS (SELECT 1 FROM public.submission_intents i
		                WHERE i.org_id=s.org_id AND i.store_id=s.uuid AND i.id=$7::uuid)
		 FOR SHARE OF s`, scope.OrgID, scope.StoreUUID, scope.StorePK, scope.IntentIDs, scope.ReadOnly, now, scope.IntentIDs[0]).Scan(
		&state.StorePK, &state.StoreUUID, &state.OrgID, &state.CredentialRevision, &disabled, &allowed, &found)
	if err != nil || found != len(scope.IntentIDs) {
		return domain.OpenedCredential{}, refused
	}
	if !scope.ReadOnly {
		if disabled || !allowed {
			return domain.OpenedCredential{}, refused
		}
		var actorAllowed bool
		err := tx.QueryRow(ctx, `
			SELECT EXISTS (
			 SELECT 1 FROM public.organization_members m
			 JOIN public.organization_stores s ON s.org_id=m.org_id
			 WHERE m.org_id=$1 AND m.user_id=$2 AND s.id=$3
			   AND m.status='active' AND NOT m.manual_disabled
			   AND m.role IN ('owner','manager','admin','member')
			   AND public.subscription_member_allowed(m.org_id,m.id,$4)
			   AND (m.role IN ('owner','manager','admin') OR s.assignee_membership_id=m.id)
			)`, scope.OrgID, scope.UserID, state.StorePK, now).Scan(&actorAllowed)
		if err != nil || !actorAllowed {
			return domain.OpenedCredential{}, refused
		}
	}
	opened, err := OpenCredentialTx(ctx, tx, ring, keyID, state, now.UnixMilli())
	if err != nil || opened.ClientID == "" || opened.APIKey == "" {
		return domain.OpenedCredential{}, refused
	}
	return opened, nil
}
