// Package loadtest accepts only Mode R.
//
// Mode R does not open a socket, does not send Ozon traffic, and does not
// delete objects. Any other mode is refused. The Rust pretest
// (GO-MIGRATION-PRETEST.md) measured a local replay with the write kill
// switch on; this package does not rerun that benchmark.
package loadmode

import (
	"fmt"
	"strings"
)

// ModeR is the only allowed load-test mode.
const ModeR = "R"

// ErrModeNotAllowed is returned for every mode other than Mode R.
var ErrModeNotAllowed = fmt.Errorf("load tests only allow Mode %s", ModeR)

// Run checks the mode and returns. It has no client and no clock loop.
func Run(mode string) error {
	if strings.TrimSpace(mode) != ModeR {
		return ErrModeNotAllowed
	}
	return nil
}
