// Package catalog reads the platform category caches. A miss is not filled
// from Ozon. storeId would pay for a live download in Rust; this package
// refuses that path.
package domain

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"time"
)

// TreeTTL is the 24h freshness window. Expired rows are deleted, not served.
const TreeTTL = 24 * time.Hour

// StorageNode is one cached Seller category node as stored in the cache
// payload: still recursive, still without parent pointers.
type StorageNode struct {
	DescriptionCategoryID int64         `json:"description_category_id"`
	CategoryName          string        `json:"category_name"`
	TypeID                int64         `json:"type_id"`
	TypeName              string        `json:"type_name"`
	Disabled              bool          `json:"disabled"`
	Children              []StorageNode `json:"children"`
}

// TreeNode carries the effective category and its parent's index in the flat list.
type TreeNode struct {
	DescriptionCategoryID int64  `json:"description_category_id"`
	CategoryName          string `json:"category_name"`
	TypeID                int64  `json:"type_id"`
	TypeName              string `json:"type_name"`
	Disabled              bool   `json:"disabled"`
	ParentIndex           *int64 `json:"parent_index"`
}

// TreeData is a fresh cache hit.
type TreeData struct {
	Language    string     `json:"language"`
	FetchedAtMs int64      `json:"fetched_at_ms"`
	Items       []TreeNode `json:"items"`
}

// FlattenTree uses array positions because category nodes share type_id=0.
func FlattenTree(nodes []StorageNode) []TreeNode {
	out := make([]TreeNode, 0, len(nodes))
	var walk func(rows []StorageNode, parent *int64, category int64)
	walk = func(rows []StorageNode, parent *int64, category int64) {
		for _, node := range rows {
			id := int64(len(out))
			current := node.DescriptionCategoryID
			if current <= 0 {
				current = category
			}
			out = append(out, TreeNode{
				DescriptionCategoryID: current,
				CategoryName:          node.CategoryName,
				TypeID:                node.TypeID,
				TypeName:              node.TypeName,
				Disabled:              node.Disabled,
				ParentIndex:           parent,
			})
			walk(node.Children, &id, current)
		}
	}
	walk(nodes, nil, 0)
	return out
}

// DecodeTree gunzips a cache payload and flattens the node list.
func DecodeTree(payload []byte) ([]TreeNode, error) {
	reader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	raw, err := io.ReadAll(io.LimitReader(reader, 4<<20))
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var nodes []StorageNode
	if err := dec.Decode(&nodes); err != nil {
		return nil, err
	}
	return FlattenTree(nodes), nil
}

// Fresh reports whether fetchedAt is inside the 24h window at now.
func Fresh(now time.Time, fetchedAtMs int64) bool {
	age := now.UnixMilli() - fetchedAtMs
	return age >= 0 && age <= TreeTTL.Milliseconds()
}

// LanguageKey accepts the snake_case cache languages.
func LanguageKey(raw string) (string, bool) {
	switch raw {
	case "default", "ru", "en", "tr", "zh_hans":
		return raw, true
	default:
		return "", false
	}
}
