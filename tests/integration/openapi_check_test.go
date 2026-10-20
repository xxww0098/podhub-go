package integration

import (
	"fmt"
	"net/http"
	"sync"

	"github.com/xxww0098/podhub-go/tests/testkit"
)

// specCheckedPrefixes are the route prefixes whose responses from the shared
// MountDomains handlers are checked against api/openapi.yaml.
var specCheckedPrefixes = []string{
	"/api/catalog/",
	"/api/listing/",
	"/api/field-packs",
	"/api/field-library",
}

var specChecks struct {
	once     sync.Once
	spec     *testkit.OpenAPI
	err      error
	mu       sync.Mutex
	failures []string
}

// specChecked wraps a MountDomains router. TestMain fails the run when any
// wrapped response does not match the spec.
func specChecked(h http.Handler) http.Handler {
	specChecks.once.Do(func() { specChecks.spec, specChecks.err = testkit.LoadOpenAPI() })
	if specChecks.err != nil {
		panic(specChecks.err)
	}
	return specChecks.spec.Checked(h, func(err error) {
		specChecks.mu.Lock()
		defer specChecks.mu.Unlock()
		specChecks.failures = append(specChecks.failures, err.Error())
	}, specCheckedPrefixes...)
}

func specFailures() []string {
	specChecks.mu.Lock()
	defer specChecks.mu.Unlock()
	return append([]string(nil), specChecks.failures...)
}

func reportSpecFailures(code int) int {
	failures := specFailures()
	for _, f := range failures {
		fmt.Printf("openapi response mismatch: %s\n", f)
	}
	if code == 0 && len(failures) > 0 {
		return 1
	}
	return code
}
