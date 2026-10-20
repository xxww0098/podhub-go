package contract

// Account is ACCOUNT_PROJECTION.
type Account struct {
	ID            int64
	OrgID         *int64
	PublicID      string
	Email         string
	Name          string
	Role          string
	Plan          string
	OrgPlan       string
	CreatedAt     string
	Disabled      bool
	SeatLimit     int64
	SeatsUsed     int64
	TokensUsed    int64
	TokensMonthly int64
}

// Person is one directory member or unaffiliated account.
type Person struct {
	UserID         int64
	PublicID       string
	Email          string
	Name           string
	Role           string
	CreatedAt      string
	LastLogin      string
	Disabled       bool
	Manual         bool
	Quota          bool
	MembershipRole string
	HasMembership  bool
}

// Workspace is one live organization in the directory.
type Workspace struct {
	ID            int64
	UUID          string
	Name          string
	Plan          string
	CreatedAt     string
	OwnerUUID     string
	OwnerID       int64
	SeatLimit     int64
	SeatsUsed     int64
	TokensUsed    int64
	TokensMonthly int64
	Available     int64
	Held          int64
	Members       []Person
}

// Directory is the three directory queries plus wallets.
type Directory struct {
	Workspaces   []Workspace
	Unaffiliated []Person
	UserCount    int
}

// SeatLoad is one organization plus the rows the planner needs.
type SeatLoad struct {
	State   SeatState
	Members []MemberRow
	Stores  []StoreRow
}
