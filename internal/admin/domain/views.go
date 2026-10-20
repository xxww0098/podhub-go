package domain

import (
	"time"

	userscontract "github.com/xxww0098/podhub-go/internal/admin/users/contract"
)

// Grant is one support_grants row.
type Grant struct {
	ID          int64
	OrgID       int64
	StaffUserID int64
	StaffEmail  string
	Reason      string
	ExpiresAt   int64
	RevokedAt   int64
	CreatedBy   int64
	CreatedAt   int64
	LastAccess  int64
}

// LeaseRow is one writer_leases row. RevokedAt nil means the column is null.
type LeaseRow struct {
	ID             int64
	Domain         string
	Holder         string
	HolderInstance string
	Fence          int64
	GrantedAt      int64
	ExpiresAt      int64
	HeartbeatAt    int64
	RevokedAt      *int64
	Reason         string
}

// UsageRow is one ledger page row.
type UsageRow struct {
	RequestID  string
	Workspace  string
	Email      string
	Model      string
	Channel    *string
	Thinking   *string
	APIFormat  *string
	Operation  string
	Status     string
	Input      int64
	Output     int64
	Cached     int64
	Reasoning  int64
	Total      int64
	Charged    int64
	Absorbed   int64
	ErrorClass *string
	Upstream   *string
	CreatedAt  time.Time
	Latency    *int64
	Speed      *int64
}

// UsageSummary is the aggregate row. Percentiles are nil when SQL returns null.
type UsageSummary struct {
	Settled, Failed, Unknown, InFlight, Total int64
	Input, Cached, Output                     int64
	Charged, Absorbed                         int64
	P50, P90, P99                             *int64
	UP50, UP90, UP99                          *int64
	Speed                                     *int64
	Classes                                   []UsageClass
}

// UsageClass is one failure_classes element.
type UsageClass struct {
	ErrorClass string
	Count      int64
}

// PriceRow is one current price.
type PriceRow struct {
	Model                                             string
	BillingMode                                       string
	Input, Cached, Output, Reasoning, PerRequest, Max int64
	Effective                                         time.Time
}

// TotpRow is the sealed verifier.
type TotpRow struct {
	Nonce     []byte
	Cipher    []byte
	Confirmed bool
	Failed    int
	ResetAt   *time.Time
}

// ConfigBlob is the ciphertext row.
type ConfigBlob struct {
	Revision   int64
	Nonce      []byte
	Ciphertext []byte
	Found      bool
}

// The account views live in the users contract; these aliases keep the
// admin names.
type (
	Account   = userscontract.Account
	Person    = userscontract.Person
	Workspace = userscontract.Workspace
	Directory = userscontract.Directory
	SeatLoad  = userscontract.SeatLoad
)
