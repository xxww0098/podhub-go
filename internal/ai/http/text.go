package aihttp

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/platform/aiclient"
)

// TextProvider is one resolved text account. Complete posts the already
// stamped body to the account's native endpoint; it must not retry a call
// whose result is unknown.
type TextProvider struct {
	AccountID string
	Model     string
	Format    aiclient.Format
	Complete  func(context.Context, []byte) (int, []byte, error)
}

// TextResolver picks the active account for a model and wire format. An error
// refuses the request before a hold is opened.
type TextResolver interface {
	Resolve(ctx context.Context, model string, format aiclient.Format) (TextProvider, error)
}
