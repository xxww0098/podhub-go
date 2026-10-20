package contract

// Actor is the admin caller. Users and AI-auth fill ID, Email, Role, and
// TokenHash. Billing and observation fill UserID and PublicID.
type Actor struct {
	ID        int64
	UserID    int64
	OrgID     int64
	Email     string
	PublicID  string
	Role      string
	TokenHash string
}
