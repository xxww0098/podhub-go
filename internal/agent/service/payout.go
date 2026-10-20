package service

// SavePayout lives in writes.go. The request is three optional strings so a
// JSON null stays distinct from a missing key; the repository normalizes them
// inside the auth write gate.
