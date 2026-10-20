package contract

// Scope is an observation filter. Blank ids mean no filter.
type Scope struct {
	WorkspaceID string
	StoreID     string
}

// ProductQuery is the product list filter.
type ProductQuery struct {
	Scope       Scope
	Status      string
	Q           string
	IncludeGone bool
	Cursor      string
	Limit       *int64
}

// Thumbnail is one product image request.
type Thumbnail struct {
	StoreID   string
	ProductID string
}

// ImageBytes is a sniffed raster.
type ImageBytes struct {
	Type string
	Body []byte
}
