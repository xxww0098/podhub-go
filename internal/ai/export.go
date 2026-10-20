// Package ai is the relay's stable import path.
//
// The pieces live under service, http, and jobs. This package re-exports the
// same names, so existing callers keep the qualifier ai.
package ai

import (
	aihttp "github.com/xxww0098/podhub-go/internal/ai/http"
	"github.com/xxww0098/podhub-go/internal/ai/jobs/reaper"
	"github.com/xxww0098/podhub-go/internal/ai/service"
)

type (
	Limits       = service.Limits
	Lease        = service.Lease
	Upstream     = aihttp.Upstream
	HTTPUpstream = aihttp.HTTPUpstream
	Deps         = aihttp.Deps
	Response     = aihttp.Response
	HTTPDeps     = aihttp.HTTPDeps
)

var (
	LimitsFromEnv  = service.LimitsFromEnv
	Acquire        = service.Acquire
	Key            = service.Key
	Stamp          = service.Stamp
	ParseUsage     = service.ParseUsage
	FoldCompletion = service.FoldCompletion
	Loopback       = aihttp.Loopback
	Chat           = aihttp.Chat
	Register       = aihttp.Register
	SweepStranded  = reaper.SweepStranded
	PruneBodies    = reaper.PruneBodies
)
