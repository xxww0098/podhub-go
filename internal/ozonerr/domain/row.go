// Package domain is the pure shape of an Ozon error observation.
// It does not dial, and it does not read the environment.
package domain

// Sources stored on ozon_error_catalog. docs_seed is inserted by migration
// 00320 and is not written by the running process.
const (
	SourceImportInfo = "ozon_import_info"
	SourceRequest    = "ozon_request"
	SourceDocsSeed   = "docs_seed"
)

// Limits applied before a row is stored.
const (
	MaxErrors  = 100
	MaxCode    = 128
	MaxField   = 128
	MaxName    = 200
	MaxState   = 64
	MaxLevel   = 32
	MaxSample  = 500
	MaxOffer   = 200
	MaxTaskKey = 80
)

// DensitySample is the only description the task text gives for a seeded code.
// The other seven seeded codes have an empty sample. The en dash is U+2013.
const DensitySample = "密度 0.001\u201313.55"

// DocsSeed is the eight codes named in the task, in insertion order.
// attribute_id, description_category_id, and type_id are 0: the note did not
// attach them to a category.
var DocsSeed = []struct {
	Code   string
	Sample string
}{
	{Code: "SPU_already_exists"},
	{Code: "Invalid_state"},
	{Code: "Incorrect_density", Sample: DensitySample},
	{Code: "item_limit_exceeded"},
	{Code: "product_is_not_created"},
	{Code: "offer_id_not_found"},
	{Code: "WAREHOUSE_NOT_FOUND"},
	{Code: "FLAMMABLE_ONLY_ON_SELF_OR_PROVIDER_DELIVERY"},
}

// Row is one observation ready to store. TaskKey and OfferKey are the
// idempotency dimensions. They are not columns of the global catalog.
// A zero attribute, category, or type means the payload did not carry one.
type Row struct {
	Source                string
	Code                  string
	AttributeID           int64
	DescriptionCategoryID int64
	TypeID                int64
	Level                 string
	State                 string
	Field                 string
	AttributeName         string
	Sample                string
	TaskKey               string
	OfferKey              string
}

// RequestError is the browser report of one import POST that returned 4xx.
// Message is the gateway message only. The request body is not here.
// TaskKey is a decimal task id when the report names one. It is the shared
// idempotency key with a proxied 4xx. Empty keeps the intent id as the key.
type RequestError struct {
	IntentID    string
	HTTPStatus  int
	GatewayCode *int64
	Message     string
	TaskKey     string
}

// Entry is one catalog or observation row returned to a reader.
type Entry struct {
	Source                string
	Code                  string
	AttributeID           int64
	DescriptionCategoryID int64
	TypeID                int64
	Level                 string
	State                 string
	Field                 string
	AttributeName         string
	Sample                string
	Occurrences           int64
	FirstSeen             string
	LastSeen              string
	LastSeenUnix          int64
}
