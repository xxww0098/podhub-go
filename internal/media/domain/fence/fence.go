// Package fence does not reimplement the media reference triggers.
//
// guard_media_reference_write, guard_media_lease_reference_identity, and
// lock_media_reference_identity stay in db/migrations/00290. This package
// mirrors only the pure extractors media_reference_candidates and
// is_media_gc_image_key / media_gc_image_identity so a caller can see the
// same pairs before a write. The trigger is what accepts or rejects the row.
// Integration tests compare these functions with the SQL ones.
package fence

import (
	"regexp"
	"strings"
)

// candidateRE is media_reference_candidates. It is not anchored: embedded keys match.
var candidateRE = regexp.MustCompile(`(?i)(?:teams|workspaces)/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})/sha256/([0-9a-f]{64})\.(?:jpg|png)`)

var imageKeyRE = regexp.MustCompile(`(?i)(^|/)(teams|workspaces)/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/sha256/[0-9a-f]{64}\.(jpg|png)$`)

var dotSegmentRE = regexp.MustCompile(`(^|/)\.\.?(/|$)`)

var videoRE = regexp.MustCompile(`(?i)(^|/)videos/(teams|workspaces)/[^/]+/sha256/[^/]+$`)

var healthRE = regexp.MustCompile(`(?i)/sha256/aa7bb0431aaeb198a77c26a14fe6dd714a75e4d7db94e3e1238a1fdcbfe1f8d4\.(jpg|png)$`)

var identityRE = regexp.MustCompile(`(?i)(?:teams|workspaces)/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})/sha256/([0-9a-f]{64})\.(?:jpg|png)$`)

// Candidate is one (workspace, digest) pair.
type Candidate struct {
	Workspace string
	Digest    string
}

// Candidates matches media_reference_candidates: distinct, lowercase digest.
func Candidates(text string) []Candidate {
	if text == "" {
		return nil
	}
	seen := map[Candidate]struct{}{}
	var out []Candidate
	for _, match := range candidateRE.FindAllStringSubmatch(text, -1) {
		item := Candidate{Workspace: strings.ToLower(match[1]), Digest: strings.ToLower(match[2])}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}

// IsGCImageKey matches is_media_gc_image_key.
func IsGCImageKey(objectKey string) bool {
	if objectKey == "" {
		return false
	}
	if !imageKeyRE.MatchString(objectKey) {
		return false
	}
	if dotSegmentRE.MatchString(objectKey) {
		return false
	}
	if videoRE.MatchString(objectKey) {
		return false
	}
	if healthRE.MatchString(objectKey) {
		return false
	}
	return true
}

// ImageIdentity matches media_gc_image_identity: "workspace:digest" or "".
func ImageIdentity(objectKey string) string {
	if !IsGCImageKey(objectKey) {
		return ""
	}
	match := identityRE.FindStringSubmatch(objectKey)
	if match == nil {
		return ""
	}
	return strings.ToLower(match[1]) + ":" + strings.ToLower(match[2])
}
