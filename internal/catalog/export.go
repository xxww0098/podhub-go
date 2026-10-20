// Package catalog is the category cache's stable import path.
//
// The pieces live under domain, service, and http. This package re-exports
// the same names, so existing callers keep the qualifier catalog.
package catalog

import (
	"github.com/xxww0098/podhub-go/internal/catalog/domain"
	cataloghttp "github.com/xxww0098/podhub-go/internal/catalog/http"
	"github.com/xxww0098/podhub-go/internal/catalog/service"
)

type (
	TreeNode = domain.TreeNode
	TreeData = domain.TreeData
	Host     = cataloghttp.Host
)

const TreeTTL = domain.TreeTTL

var (
	DecodeTree  = domain.DecodeTree
	Fresh       = domain.Fresh
	LanguageKey = domain.LanguageKey
	NextFixed   = service.NextFixed
	TickFetch   = service.TickFetch
	Mount       = cataloghttp.Mount
)
