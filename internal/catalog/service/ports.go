package service

import "context"

// FetchClaim fences cache writes against a newer process or configuration.
type FetchClaim struct {
	Epoch     int64
	StartedAt int64
}

// FetchResult is one run's receipt. A scheduled run refreshes only the
// category tree; field schemas and dictionaries are loaded on demand.
type FetchResult struct {
	RootNodes   int
	ClientID    string
	KeyAttempts int
}

type FetchWork func(context.Context, FetchClaim) (FetchResult, error)
