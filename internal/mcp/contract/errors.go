// Package contract is the MCP surface. The domain level is L6.
package contract

import "errors"

// ErrNotPorted is returned after the host and bearer checks pass.
var ErrNotPorted = errors.New("not_ported")

// ErrHostDenied means the Host or Origin is outside the parsed allow-list.
var ErrHostDenied = errors.New("mcp_host_denied")

// ErrBearerDenied means the Authorization header is not a Bearer opa_ grant.
var ErrBearerDenied = errors.New("mcp_bearer_denied")
