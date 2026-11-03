// Package ai is the relay's stable import path.
//
// The pieces live under service, http, and jobs. This package re-exports the
// same names, so existing callers keep the qualifier ai.
package ai

import (
	aihttp "github.com/xxww0098/podhub-go/internal/ai/http"
	"github.com/xxww0098/podhub-go/internal/ai/jobs/reaper"
	"github.com/xxww0098/podhub-go/internal/ai/service"
	"github.com/xxww0098/podhub-go/internal/platform/aiclient"
)

type (
	Limits             = service.Limits
	Lease              = service.Lease
	TextResolver       = aihttp.TextResolver
	TextProvider       = aihttp.TextProvider
	Deps               = aihttp.Deps
	Response           = aihttp.Response
	HTTPDeps           = aihttp.HTTPDeps
	Wallet             = aihttp.Wallet
	Querier            = aihttp.Querier
	ImageRuntime       = aihttp.ImageRuntime
	OCRRuntime         = aihttp.OCRRuntime
	OCRProvider        = aihttp.OCRProvider
	ImageGenerator     = aihttp.ImageGenerator
	ImageAssets        = aihttp.ImageAssets
	ImageAsset         = aihttp.ImageAsset
	ImageSetView       = aihttp.ImageSetView
	ImageSetCapability = aihttp.ImageSetCapability
	ImageProviderError = aihttp.ImageProviderError
)

var (
	ImageEndpoint            = aihttp.ImageEndpoint
	ImageNetworkClient       = aihttp.ImageNetworkClient
	NewImageClient           = aihttp.NewImageClient
	NewBailianImageGenerator = aihttp.NewBailianImageGenerator
	Acquire                  = service.Acquire
	Key                      = service.Key
	Stamp                    = aiclient.Stamp
	ParseUsage               = service.ParseUsage
	FoldCompletion           = service.FoldCompletion
	ApplyThinking            = service.ApplyThinking
	Chat                     = aihttp.Chat
	Register                 = aihttp.Register
	SweepStranded            = reaper.SweepStranded
	PruneBodies              = reaper.PruneBodies
)
