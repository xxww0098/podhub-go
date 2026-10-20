package domain

// Audit is one audit_logs row the repo inserts.
type Audit struct {
	OrgID, UserID                                      int64
	Module, EntityType, EntityID, Method, Path, Action string
	Message                                            string
}
