package api

import (
	rulesgen "github.com/xxww0098/podhub-go/internal/listing/rules/http/gen"
	healthgen "github.com/xxww0098/podhub-go/internal/platform/health/gen"
)

// Names that handler bodies already use. The declarations moved into the
// per-unit generated packages; these aliases keep the handler text the same.
type (
	DatabaseStatus    = healthgen.DatabaseStatus
	HealthResponse    = healthgen.HealthResponse
	WriterLeaseHealth = healthgen.WriterLeaseHealth

	GetListingRulesParams = rulesgen.GetListingRulesParams
)

const (
	Available   = healthgen.Available
	Unavailable = healthgen.Unavailable
)
