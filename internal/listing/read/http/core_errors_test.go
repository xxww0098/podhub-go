package readhttp

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

// The core names its failure and the host used to flatten it into a string, so
// every failure looked like the merchant's bad input. refuseCore keeps the
// merchant-actionable refusals at 400 and answers everything else 500.
func TestRefuseCoreMapsCodes(t *testing.T) {
	refused := contract.NewCoreError(contract.CodeRefused, "价格必须为正数")
	status, message, code := refuseCore(refused)
	if status != http.StatusBadRequest || message != "价格必须为正数" || code != "validation" {
		t.Fatalf("%d %s %s", status, message, code)
	}
	for _, want := range []string{contract.CodeDecode, contract.CodeSchemaHandle} {
		status, message, code = refuseCore(contract.NewCoreError(want, "listing-core call rejected: boom"))
		if status != http.StatusInternalServerError || message == "" || code != "internal" {
			t.Fatalf("%s -> %d %s %s", want, status, message, code)
		}
	}
}

// The slot holds the contract's JSON. SlotError has to recover the code from it
// and still answer something usable when the slot is empty or unreadable.
func TestSlotErrorReadsTheSlot(t *testing.T) {
	coreErr := contract.SlotError("listing-core call rejected", []byte(`{"code":"CORE_REFUSED","message":"banned term"}`))
	if coreErr.Code != contract.CodeRefused || coreErr.Message != "banned term" {
		t.Fatalf("%s %s", coreErr.Code, coreErr.Message)
	}
	empty := contract.SlotError("listing-core call rejected", nil)
	if empty.Code != contract.CodeDecode || empty.Error() == "" {
		t.Fatalf("%s %s", empty.Code, empty.Error())
	}
}

// An OCR contract refusal is the one failure that carries the contract's
// reason_code and retry_class beside the code. They reach the log, so dropping
// them would hide why the operator has to act.
func TestSlotErrorKeepsTheOcrReason(t *testing.T) {
	raw := []byte(`{"code":"CORE_REFUSED","message":"tags","reason_code":"configured_tags","retry_class":"corrective"}`)
	coreErr := contract.SlotError("listing-core call rejected", raw)
	if coreErr.Code != contract.CodeRefused || coreErr.ReasonCode != "configured_tags" || coreErr.RetryClass != "corrective" {
		t.Fatalf("%s %s %s", coreErr.Code, coreErr.ReasonCode, coreErr.RetryClass)
	}
}

// A wrapped CoreError stays reachable through errors.As and through the host's
// own error values, which is how the handlers see it.
func TestAsCoreErrorThroughWrap(t *testing.T) {
	wrapped := fmt.Errorf("row write: %w", contract.NewCoreError(contract.CodeSchemaHandle, "no schema"))
	coreErr, ok := contract.AsCoreError(wrapped)
	if !ok || coreErr.Code != contract.CodeSchemaHandle {
		t.Fatalf("%v %v", ok, coreErr)
	}
	if _, ok := contract.AsCoreError(errors.New("plain")); ok {
		t.Fatal("plain error matched")
	}
	if _, ok := contract.AsCoreError(nil); ok {
		t.Fatal("nil matched")
	}
}
