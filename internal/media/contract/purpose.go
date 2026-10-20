package contract

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// PurposeKind is the server-resolved upload purpose. The client never sends a
// path, a scope or an owner: it sends a resource id and this package derives
// the rest from the bucket role.
type PurposeKind string

const (
	// PurposeOrgFile is a general workspace file in the private bucket.
	PurposeOrgFile PurposeKind = "org_file"
	// PurposeOrgTemplate is a PSD template in the private bucket.
	PurposeOrgTemplate PurposeKind = "org_template"
	// PurposeDelegateBinding is a delegate original tied to one binding.
	PurposeDelegateBinding PurposeKind = "delegate_binding"
	// PurposeSource is a supplier product image in the assets bucket.
	PurposeSource PurposeKind = "source"
	// PurposeCatalog is a platform catalog image in the assets bucket.
	PurposeCatalog PurposeKind = "catalog"
)

// Purpose is one resolved upload target.
type Purpose struct {
	Kind   PurposeKind
	Bucket Role
	// Scope is the dedupe scope stored on the object row.
	Scope string
	// ID is the purpose id: the source id, binding uuid, catalog marker or org id.
	ID string
	// OrgID is the owning org; 0 for platform assets.
	OrgID int64
}

// ResolvePurpose reads the request pair and the caller's org. bindingID is
// required for delegate_binding and ignored otherwise. A client-supplied id
// can never move the object into another role, scope or org.
func ResolvePurpose(kind, id string, orgID int64, bindingID string) (Purpose, error) {
	if orgID <= 0 {
		return Purpose{}, ErrPurpose
	}
	switch PurposeKind(strings.TrimSpace(kind)) {
	case PurposeOrgFile:
		if strings.TrimSpace(id) != "" && strings.TrimSpace(id) != itoa(orgID) {
			return Purpose{}, ErrPurpose
		}
		return Purpose{Kind: PurposeOrgFile, Bucket: RolePrivate, Scope: "org:" + itoa(orgID) + ":file", ID: itoa(orgID), OrgID: orgID}, nil
	case PurposeOrgTemplate:
		if strings.TrimSpace(id) != "" && strings.TrimSpace(id) != itoa(orgID) {
			return Purpose{}, ErrPurpose
		}
		return Purpose{Kind: PurposeOrgTemplate, Bucket: RolePrivate, Scope: "org:" + itoa(orgID) + ":template", ID: itoa(orgID), OrgID: orgID}, nil
	case PurposeDelegateBinding:
		binding, err := normalizeBindingID(id)
		if err != nil {
			return Purpose{}, ErrPurpose
		}
		if strings.TrimSpace(bindingID) != "" && strings.TrimSpace(bindingID) != binding {
			return Purpose{}, ErrPurpose
		}
		return Purpose{Kind: PurposeDelegateBinding, Bucket: RolePrivate, Scope: "binding:" + binding, ID: binding, OrgID: orgID}, nil
	case PurposeSource:
		source := strings.TrimSpace(id)
		if source == "" || len(source) > 128 || strings.ContainsAny(source, "/: \t\r\n") {
			return Purpose{}, ErrPurpose
		}
		return Purpose{Kind: PurposeSource, Bucket: RoleAssets, Scope: "source:" + source, ID: source, OrgID: orgID}, nil
	case PurposeCatalog:
		if strings.TrimSpace(id) != "" && strings.TrimSpace(id) != "catalog" {
			return Purpose{}, ErrPurpose
		}
		return Purpose{Kind: PurposeCatalog, Bucket: RoleAssets, Scope: "catalog", ID: "catalog"}, nil
	default:
		return Purpose{}, ErrPurpose
	}
}

// normalizeBindingID requires a lowercase hyphenated UUID and returns it as
// text. The version nibble is not pinned: binding ids are database defaults,
// not browser-minted keys.
func normalizeBindingID(raw string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	return parsed.String(), nil
}

func itoa(value int64) string { return fmt.Sprintf("%d", value) }
