package domain

// Supplier catalog bounds copied from src/platform/supplier_dbs/mod.rs.
// Admission slot counts live in the process edge. The numbers confirmed for
// the default pool are recorded here so a test can pin them; this package
// does not install a second admission limiter.
const (
	MaxNameChars       = 80
	MaxShortChars      = 64
	MaxTextChars       = 255
	MaxNoteChars       = 2000
	MaxOptions         = 60
	MaxViewPrefsBytes  = 64 * 1024
	MaxPasswordBytes   = 72
	MaxEmailChars      = 254
	BusinessInFlight   = 84
	InteractiveReadCap = 16
	RegularWriteCap    = 10
	PsdUploadCap       = 6
	BodyLimitBytes     = 2 * 1024 * 1024
	ConfirmBodyLimit   = 64 * 1024
)

// Prop types stored in sc_source_prop_defs.type.
var PropTypes = map[string]bool{
	"text": true, "long_text": true, "number": true,
	"select": true, "multi_select": true, "checkbox": true,
}
