package writer

// leaseDomains is every domain accepted by the writer_leases_domain_known
// check. admin/domain keeps its own display list; both must stay identical.
var leaseDomains = []string{
	"auth",
	"entitlement",
	"catalog",
	"recipe",
	"telemetry",
	"admin",
	"release",
	"billing",
}

// Domains returns a copy of the known writer-lease domains.
func Domains() []string {
	return append([]string(nil), leaseDomains...)
}

// KnownDomain reports whether domain has a writer_leases row.
func KnownDomain(domain string) bool {
	for _, name := range leaseDomains {
		if name == domain {
			return true
		}
	}
	return false
}
