package submit

import "github.com/xxww0098/podhub-go/internal/listing/core/contract"

// boundModule is installed by internal/app. submit imports only the
// listing-core contract, not the wasm host.
var boundModule contract.Module

// BindModule installs the listing-core host used by SendDrafts and SendStored.
func BindModule(m contract.Module) { boundModule = m }
