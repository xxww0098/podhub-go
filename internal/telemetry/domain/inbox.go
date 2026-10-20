// Package domain checks event_inbox_events column limits from
// the head schema fingerprint. PostgreSQL varchar(n) counts characters.
package domain

import (
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/telemetry/contract"
)

const (
	maxDeviceUID       = 128
	maxID              = 128
	maxKind            = 128
	maxClientCreatedAt = 64
)

// Event is one inbox row's bounded text. The HTTP JSON names are not proven.
type Event struct {
	DeviceUID       string
	ID              string
	Kind            string
	PayloadJSON     string
	ClientCreatedAt string
}

// Valid enforces the varchar widths. Empty strings are allowed: the table
// has no non-empty CHECK. Schema version has no CHECK and is not judged here.
func (e Event) Valid() error {
	if utf8.RuneCountInString(e.DeviceUID) > maxDeviceUID ||
		utf8.RuneCountInString(e.ID) > maxID ||
		utf8.RuneCountInString(e.Kind) > maxKind ||
		utf8.RuneCountInString(e.ClientCreatedAt) > maxClientCreatedAt {
		return contract.ErrTooLong
	}
	return nil
}
