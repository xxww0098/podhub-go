package domain

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestInboxColumnLimits(t *testing.T) {
	ok := Event{
		DeviceUID:       strings.Repeat("a", 128),
		ID:              strings.Repeat("b", 128),
		Kind:            strings.Repeat("c", 128),
		PayloadJSON:     `{"n":1}`,
		ClientCreatedAt: strings.Repeat("d", 64),
	}
	if err := ok.Valid(); err != nil {
		t.Fatal(err)
	}
	wide := Event{DeviceUID: strings.Repeat("界", 128)}
	if utf8.RuneCountInString(wide.DeviceUID) != 128 || wide.Valid() != nil {
		t.Fatal(wide.Valid())
	}
	wide.DeviceUID = strings.Repeat("界", 129)
	if wide.Valid() == nil {
		t.Fatal("expected length failure")
	}
	ok.ClientCreatedAt = strings.Repeat("e", 65)
	if ok.Valid() == nil {
		t.Fatal("expected client timestamp failure")
	}
}
