package storerepo

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// BreakerState is which Seller-pressure breakers are open.
type BreakerState struct {
	WorkspaceOpen  bool
	DeploymentOpen bool
	EgressBlocked  bool
}

// breakerRules are plan.rs's constants. The floors keep a tiny fleet from
// tripping on one bad neighbour; the ratios carry the signal at scale.
const (
	breakerWindowMS           = 15 * 60 * 1000
	breakerDeploymentRatio    = 0.02
	breakerDeploymentMinStore = 20
	breakerWorkspaceRatio     = 0.20
	breakerWorkspaceMinStore  = 3
	egressBlockMinStores      = 5
	originEgressBlocked       = "egress_blocked"
)

// readBreakers answers which breakers are open right now, from the shared
// incident ledger. Reads inside a tenant transaction; the deployment arm sees
// every tenant, exactly as the incident scan does.
func readBreakers(ctx context.Context, tx pgx.Tx, orgID, nowMS int64) (BreakerState, error) {
	since := nowMS - breakerWindowMS
	var workspaceRefused, workspaceActive, deploymentRefused, deploymentActive, egressBlocked int64
	err := tx.QueryRow(ctx, `
		WITH active AS (
		    SELECT s.id, s.org_id, s.uuid
		      FROM public.organization_stores s
		     WHERE s.deleted_at_ms IS NULL
		       AND NOT s.manual_disabled
		       AND NOT s.quota_suspended
		       AND EXISTS (SELECT 1 FROM public.store_seller_credentials c
		                    WHERE c.store_id = s.id
		                      AND (c.key_expires_at_ms IS NULL OR c.key_expires_at_ms > $2))
		)
		SELECT
		    (SELECT count(DISTINCT i.store_id) FROM public.seller_read_incidents i
		      JOIN active a ON a.uuid = i.store_id AND a.org_id = $1
		     WHERE i.status = 429 AND i.at_ms > $2),
		    (SELECT count(*) FROM active WHERE org_id = $1),
		    (SELECT count(DISTINCT i.store_id) FROM public.seller_read_incidents i
		      JOIN active a ON a.uuid = i.store_id
		     WHERE i.status = 429 AND i.at_ms > $2),
		    (SELECT count(*) FROM active),
		    (SELECT count(DISTINCT i.store_id) FROM public.seller_read_incidents i
		     WHERE i.origin = $3 AND i.at_ms > $2)`,
		orgID, since, originEgressBlocked).Scan(
		&workspaceRefused, &workspaceActive, &deploymentRefused, &deploymentActive, &egressBlocked)
	if err != nil {
		return BreakerState{}, err
	}
	blocked := egressBlocked >= egressBlockMinStores
	return BreakerState{
		WorkspaceOpen: blocked || ratioOpen(workspaceRefused, workspaceActive,
			breakerWorkspaceRatio, breakerWorkspaceMinStore),
		DeploymentOpen: blocked || ratioOpen(deploymentRefused, deploymentActive,
			breakerDeploymentRatio, breakerDeploymentMinStore),
		EgressBlocked: blocked,
	}, nil
}

// ratioOpen fires only when the refused share crosses the ratio AND at least
// `floor` stores refused: share without scale is noise, scale without share is
// a coincidence.
func ratioOpen(refused, active int64, ratio float64, floor int64) bool {
	return refused >= floor && active > 0 && float64(refused)/float64(active) > ratio
}
