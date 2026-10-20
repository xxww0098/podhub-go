// Package contract is the telemetry surface. The domain level is L2.
package contract

import "errors"

// ErrNotPorted is the mounted handler and the retention job.
var ErrNotPorted = errors.New("not_ported")

// ErrTooLong is a column past its varchar limit.
var ErrTooLong = errors.New("event inbox field exceeds the column limit")
