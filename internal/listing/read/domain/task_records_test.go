package domain

import (
	"net/url"
	"testing"
)

func TestTaskRecordFiltersValidateBoundaries(t *testing.T) {
	for _, query := range []string{"limit=0", "limit=101", "limit=2&limit=3", "status=succeeded", "kind=secret", "storeId=", "cursor=broken", "unknown=yes"} {
		q, _ := url.ParseQuery(query)
		if _, message := ParseTaskRecordsQuery(q); message == "" {
			t.Errorf("accepted %s", query)
		}
	}
	q, _ := url.ParseQuery("kind=listing&status=attention&limit=100&storeId=12345678-1234-4234-8234-123456789abc&cursor=1793404800000000:12345678-1234-4234-8234-123456789abc")
	f, message := ParseTaskRecordsQuery(q)
	if message != "" || f.Limit != 100 || f.CursorMicros != 1793404800000000 || f.StoreID == "" {
		t.Fatalf("filter=%+v error=%s", f, message)
	}
}
