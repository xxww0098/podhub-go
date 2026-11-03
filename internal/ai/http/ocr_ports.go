package aihttp

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

// App assembles job or supplier-test authorization, private media and model routing.
type OCRRuntime struct {
	TestAuthorize func(context.Context, access.Principal, string, string) error
	Authorize     func(context.Context, pgx.Tx, access.Principal, ai.Claim, string, bool) (ai.Binding, error)
	Models        func(context.Context) ([]string, string, error)
	Resolve       func(context.Context, ai.Routing) (OCRProvider, error)
	Issue         func(context.Context, access.Principal, ai.Claim, ai.Binding, ai.Image) (any, error)
	Read          func(context.Context, access.Principal, ai.Claim, ai.Binding, string) ([]byte, string, error)
	Settle        func(context.Context, access.Principal, ai.Claim, string) (json.RawMessage, error)
	// Validate returns assembled prose and globally filtered fixed + theme tags.
	Validate func(context.Context, ai.Pin, []byte) (json.RawMessage, error)
}
type OCRProvider struct {
	AccountID string
	Model     string
	Complete  func(context.Context, []byte) (int, []byte, error)
}
