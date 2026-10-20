package contract

import "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"

// Failure kinds. HTTP maps them onto each route family's code spelling.
const (
	KindValidation     = outcome.KindValidation
	KindNotFound       = outcome.KindNotFound
	KindConflict       = outcome.KindConflict
	KindForbidden      = outcome.KindForbidden
	KindWritesDisabled = outcome.KindWritesDisabled
	KindInternal       = outcome.KindInternal
	KindUnavailable    = outcome.KindUnavailable
)

// Fail is the supplier-admin outcome. The type is outcome.Fail.
type Fail = outcome.Fail

// AsFail reports a Fail in err.
func AsFail(err error) (*Fail, bool) { return outcome.AsFail(err) }

// Actor is the platform account already authenticated by the edge.
type Actor = outcome.Actor
