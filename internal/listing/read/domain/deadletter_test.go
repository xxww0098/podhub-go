package domain

import "testing"

func TestReplayRefusalTable(t *testing.T) {
	cases := []struct {
		kind    string
		browser bool
		code    string
		has     bool
		want    string
		refused bool
	}{
		{"listing.submit", true, "listing_submit_failed", true, RefusalBrowser, true},
		{"store.product_sync", true, "product_sync_failed", true, RefusalBrowser, true},
		{"listing.submit", false, "listing_submit_failed", true, RefusalSellerWrite, true},
		{"listing.submit.batch", false, "listing_submit_batch_failed", true, RefusalSellerWrite, true},
		{"listing.submit", false, "cancel_requested", true, RefusalCancelled, true},
		{"listing.submit", false, "something_else", true, RefusalUnclassified, true},
		{"listing.submit", false, "", false, RefusalUnclassified, true},
		{"store.product_sync", false, "product_sync_failed", true, "", false},
		{"delegate.posting_sync", false, "delegate_sync_failed", true, "", false},
		{"listing.reconcile", false, "listing_reconcile_failed", true, "", false},
		{"listing.reconcile", false, "max_attempts_exhausted", true, "", false},
		{"store.product_sync", false, "cancel_requested", true, RefusalCancelled, true},
		{"store.product_sync", false, "listing_submit_failed", true, RefusalUnclassified, true},
		{"delegate.posting_sync", false, "", false, RefusalUnclassified, true},
		{"other.kind", false, "max_attempts_exhausted", true, RefusalUnclassified, true},
	}
	for _, tc := range cases {
		got, refused := ReplayRefusal(tc.kind, tc.browser, tc.code, tc.has)
		if got != tc.want || refused != tc.refused {
			t.Fatalf("%s browser=%v code=%q has=%v → %s refused=%v", tc.kind, tc.browser, tc.code, tc.has, got, refused)
		}
	}
	if RefusalSentence(RefusalSellerWrite) == "" || RefusalSentence("nope") == "" {
		t.Fatal("sentence")
	}
}
