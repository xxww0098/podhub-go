package r2

import (
	"context"
	"encoding/xml"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

type Object struct {
	Key          string `json:"key" xml:"Key"`
	Size         uint64 `json:"size" xml:"Size"`
	LastModified string `json:"last_modified" xml:"LastModified"`
	ETag         string `json:"etag" xml:"ETag"`
}

type ObjectPage struct {
	Objects []Object `json:"objects"`
	Folders []string `json:"folders"`
	Next    string   `json:"next_cursor"`
}

// ListObjects always stays inside the configured namespace. Delimiter browsing
// and a complete flat scan share the same validated S3 response parser.
func ListObjects(ctx context.Context, account sigv4.Account, prefix, cursor string, limit int, folders bool) (ObjectPage, error) {
	var out ObjectPage
	if account.KeyPrefix == "" || !strings.HasPrefix(prefix, account.KeyPrefix) || len(prefix) > 1024 || len(cursor) > 4096 || limit < 1 || limit > 1000 {
		return out, errors.New("invalid object listing")
	}
	query := [][2]string{{"list-type", "2"}, {"prefix", prefix}, {"max-keys", strconv.Itoa(limit)}}
	if cursor != "" {
		query = append(query, [2]string{"continuation-token", cursor})
	}
	if folders {
		query = append(query, [2]string{"delimiter", "/"})
	}
	raw, _, err := sigv4.PresignURL(account, http.MethodGet, "", "", time.Now(), 5*time.Minute, query, nil)
	if err != nil {
		return out, err
	}
	response, err := ExchangeAccount(ctx, account, Request{Method: http.MethodGet, URL: raw, Timeout: 20 * time.Second, StrictRead: true, MaxBytes: 2 << 20})
	if err != nil || response.Status != http.StatusOK {
		return out, errors.New("object listing failed")
	}
	var page struct {
		XMLName  xml.Name `xml:"ListBucketResult"`
		Contents []Object `xml:"Contents"`
		Prefixes []struct {
			Prefix string `xml:"Prefix"`
		} `xml:"CommonPrefixes"`
		Truncated bool   `xml:"IsTruncated"`
		Next      string `xml:"NextContinuationToken"`
	}
	if xml.Unmarshal(response.Body, &page) != nil || len(page.Contents)+len(page.Prefixes) > limit {
		return out, errors.New("invalid object listing response")
	}
	out.Objects = []Object{}
	out.Folders = []string{}
	for _, object := range page.Contents {
		if !strings.HasPrefix(object.Key, prefix) || len(object.Key) > 1024 || object.Size > 5<<40 {
			return ObjectPage{}, errors.New("object outside namespace")
		}
		out.Objects = append(out.Objects, object)
	}
	for _, folder := range page.Prefixes {
		if !strings.HasPrefix(folder.Prefix, prefix) || !strings.HasSuffix(folder.Prefix, "/") {
			return ObjectPage{}, errors.New("folder outside namespace")
		}
		out.Folders = append(out.Folders, folder.Prefix)
	}
	if page.Truncated {
		if page.Next == "" || page.Next == cursor {
			return ObjectPage{}, errors.New("invalid object cursor")
		}
		out.Next = page.Next
	}
	return out, nil
}
