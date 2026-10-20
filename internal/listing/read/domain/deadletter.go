package domain

// Dead-letter replay matches src/listing/api/dlq.rs replay_refusal.
// None means the row may be requeued. An unclassified failure stays closed.

const (
	RefusalSellerWrite  = "not_replayable_seller_write"
	RefusalBrowser      = "not_replayable_browser_stage"
	RefusalCancelled    = "not_replayable_cancelled"
	RefusalUnclassified = "not_replayable_unclassified"
)

// ReplayRefusal reports the refusal that owns this exhausted failure.
// refused is false only for the three mirror/reconcile kinds with a replayable code.
// executorIsBrowser is payload executor == "browser". An empty executor is not a browser.
func ReplayRefusal(kind string, executorIsBrowser bool, errorCode string, hasError bool) (code string, refused bool) {
	if executorIsBrowser {
		return RefusalBrowser, true
	}
	switch kind {
	case "store.product_sync", "delegate.posting_sync", "listing.reconcile":
		switch {
		case hasError && (errorCode == "product_sync_failed" || errorCode == "delegate_sync_failed" || errorCode == "listing_reconcile_failed" || errorCode == "max_attempts_exhausted"):
			return "", false
		case hasError && errorCode == "cancel_requested":
			return RefusalCancelled, true
		default:
			return RefusalUnclassified, true
		}
	default:
		switch {
		case hasError && (errorCode == "listing_submit_failed" || errorCode == "listing_submit_batch_failed"):
			return RefusalSellerWrite, true
		case hasError && errorCode == "cancel_requested":
			return RefusalCancelled, true
		default:
			return RefusalUnclassified, true
		}
	}
}

// RefusalSentence is the Chinese clause placed before "（refusal: code）".
func RefusalSentence(code string) string {
	switch code {
	case RefusalSellerWrite:
		return "Seller 写入类失败由意图恢复轨道重投；在死信面重放可能重复写入，请走意图恢复"
	case RefusalBrowser:
		return "浏览器准备阶段失败由准备轨道重试；死信面不重放浏览器作业"
	case RefusalCancelled:
		return "已请求取消的作业不能重投"
	default:
		return "失败原因未归类；先核实 last_error_code 再决定是否重投"
	}
}
