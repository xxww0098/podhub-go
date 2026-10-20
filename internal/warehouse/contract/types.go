package contract

import "time"

// Kinds are the write intents the browser may ask the server to fence.
const (
	KindCreate    = "create"
	KindUpdate    = "update"
	KindArchive   = "archive"
	KindUnarchive = "unarchive"
	KindFirstMile = "first_mile_update"
)

// GrantWrite is the intent recorded before a key is returned.
type GrantWrite struct {
	OrgID             int64
	UserID            int64
	StoreID           string
	ClientOperationID string
	Kind              string
	WarehouseID       *int64
	Confirm           bool
	RequestHash       string
	Now               time.Time
}

// PreparedGrant is a committed intent. The key is not part of this value.
type PreparedGrant struct {
	IntentID string
	State    string
}

// ReportWrite is the browser's report of one Ozon write.
type ReportWrite struct {
	OrgID       int64
	UserID      int64
	IntentID    string
	HTTPStatus  *int
	OperationID string
	Now         time.Time
}

// ReportDone is the intent after a successful report.
type ReportDone struct {
	IntentID    string
	State       string
	OperationID string
	ErrorCode   string
	Path        string
}

// Warehouse is one cached warehouse. IsActive is derived, not an Ozon column.
type Warehouse struct {
	WarehouseID int64
	Name        string
	Status      string
	IsRFBS      bool
	Archived    bool
	SyncedAt    time.Time
}

// Method is one cached delivery method. Unproven scalar types stay text.
type Method struct {
	MethodID    int64
	WarehouseID int64
	Name        string
	ProviderID  string
	TemplateID  string
	Cutoff      string
	SLACutIn    string
	Status      string
	CreatedAt   string
	UpdatedAt   string
	SyncedAt    time.Time
}

// Snapshot is one successful read. WriteWarehouses and WriteMethods select
// which cache is replaced inside the same tenant transaction.
type Snapshot struct {
	Warehouses      []Warehouse
	Methods         []Method
	At              time.Time
	WriteWarehouses bool
	WriteMethods    bool
}

// SyncStamp is the last successful sync for a store.
type SyncStamp struct {
	Warehouses time.Time
	Methods    time.Time
	HasWh      bool
	HasMethods bool
}

// Operation is a stored Ozon operation id owned by this org and store.
type Operation struct {
	IntentID    string
	StoreID     string
	OperationID string
}
