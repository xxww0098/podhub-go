package domain

import "strings"

// WorkspaceName formats "{label} 的工作空间".
func WorkspaceName(display, email string) string {
	label := strings.TrimSpace(display)
	if i := strings.IndexByte(label, '@'); i >= 0 {
		label = strings.TrimSpace(label[:i])
	}
	if label == "" {
		label = email
		if i := strings.IndexByte(label, '@'); i >= 0 {
			label = label[:i]
		}
	}
	if strings.TrimSpace(label) == "" {
		label = "PodHub"
	}
	return label + " 的工作空间"
}

const maxOwnedWorkspaces = 3

// OwnedLimit is MAX_OWNED_WORKSPACES.
func OwnedLimit() int64 { return maxOwnedWorkspaces }
