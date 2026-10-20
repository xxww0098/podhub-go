package contract

// SealedCredential is one store_seller_credentials row before it is opened.
type SealedCredential struct {
	ClientID           *string
	KeyID              string
	Nonce              []byte
	Ciphertext         []byte
	WrappedDEK         []byte
	DEKNonce           []byte
	KeyFingerprint     []byte
	EnvelopeVersion    int16
	StoreUUID          string
	OrgID              int64
	StorePK            int64
	CredentialRevision int64
}

// AssetIdentity is the confirmed object a commit compares.
type AssetIdentity struct {
	Key, SHA, Mime, FileName, BindingID, StoreID string
	Bytes                                        int64
	Position                                     int32
}

// DeletedAsset is a removed asset row.
type DeletedAsset struct {
	AssetID   string
	ObjectKey string
	Reclaimed bool
}

// OrderQuery is the keyset filter. AllStores means the uuid filter is NULL.
type OrderQuery struct {
	Stores        []string
	AllStores     bool
	State         string
	CursorMS      *int64
	CursorOrderID string
	Limit         int64
}

// CreateLine is one assembled posting line.
type CreateLine struct {
	OfferID  string
	SKU      int64
	Name     string
	Quantity int32
}

// CreateInput is the write half of POST /orders.
type CreateInput struct {
	StoreID, PostingNumber, SellerNote, IdempotencyKey string
	Snapshot, Logistics                                []byte
	Lines                                              []CreateLine
	OfferIDs                                           []string
	OfferIDsSet                                        bool
	Auto                                               bool
	NowMS                                              int64
	UserID                                             int64
	CanManage                                          bool
}

// OpenPosting is one open order used to merge the posting screen.
type OpenPosting struct {
	PostingNumber string
	OrderID       string
	State         string
	Offers        []string
}

// MergeSnapshot is ready offers plus open orders for one store.
type MergeSnapshot struct {
	Ready  []string
	Orders []OpenPosting
}

// PostingHit is one open order touched by posting-states.
type PostingHit struct {
	PostingNumber string
	OrderID       string
	State         string
	Offers        []string
}
