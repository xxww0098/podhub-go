package readhttp

import (
	"log/slog"
	"net/http"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

// refuseCore maps one listing-core failure to the response a row write sends.
// The core names its own failure: CORE_REFUSED is a business rule the merchant
// can act on, so it keeps the core's sentence as a 400 validation error. The
// other codes mean this server handed the core bytes or a handle it could not
// read — our bug, not the merchant's — so they answer 500 internal and the
// detail goes to the log rather than into the response.
func refuseCore(err error) (status int, message, code string) {
	coreErr, ok := AsCoreError(err)
	if !ok {
		return http.StatusInternalServerError, access.MsgUnavailable, "internal"
	}
	if coreErr.Code == CodeRefused {
		return http.StatusBadRequest, coreErr.Message, "validation"
	}
	slog.Error("listing core", "code", coreErr.Code, "reason", coreErr.ReasonCode, "retry", coreErr.RetryClass, "err", coreErr)
	return http.StatusInternalServerError, access.MsgUnavailable, "internal"
}

// coreUnreadable is the answer when the core reported success but the document
// it returned does not decode. That is this build disagreeing with the wasm it
// loaded, not a merchant mistake, so it answers 500 internal and the decode
// error goes to the log.
func coreUnreadable(op string, err error) rowRefuse {
	slog.Error("listing core", "op", op, "err", err)
	return rowRefuse{http.StatusInternalServerError, "上架内核返回的文档无法解析", "internal"}
}
