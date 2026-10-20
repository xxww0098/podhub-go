package identity

import (
	"encoding/json"
	"net/http"
)

// WriteResult emits one identity reply. 204 has no JSON body.
func WriteResult(w http.ResponseWriter, res Result) {
	for _, cookie := range res.Cookies {
		w.Header().Add("Set-Cookie", cookie)
	}
	if res.RetryAfter != "" {
		w.Header().Set("Retry-After", res.RetryAfter)
	}
	if res.Status == http.StatusNoContent {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeBytes(w, res.Status, res.Body)
}

func writeBytes(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeCloud(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	raw, _ := json.Marshal(struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message})
	writeBytes(w, status, raw)
}

func writeCloudRetry(w http.ResponseWriter, status int, message string, retryAfter int) {
	w.Header().Set("Retry-After", itoa(int64(retryAfter)))
	writeCloud(w, status, "internal", message)
}

type authUserWire struct {
	UUID       string  `json:"uuid"`
	Role       string  `json:"role"`
	Email      string  `json:"email"`
	Name       string  `json:"name"`
	SupplierID *string `json:"supplierId,omitempty"`
}

type loginWire struct {
	Data struct {
		Token  string       `json:"token"`
		User   authUserWire `json:"user"`
		Target string       `json:"target"`
	} `json:"data"`
}

func loginBody(token, publicID, role, email, name, supplierID, target string) []byte {
	var body loginWire
	body.Data.Token = token
	body.Data.User = authUserWire{UUID: publicID, Role: role, Email: email, Name: name}
	if supplierID != "" {
		body.Data.User.SupplierID = &supplierID
	}
	body.Data.Target = target
	raw, _ := json.Marshal(body)
	return raw
}

type workspaceWire struct {
	ID             int64  `json:"id"`
	UUID           string `json:"uuid"`
	Name           string `json:"name"`
	Plan           string `json:"plan"`
	Role           string `json:"role"`
	IsOwned        bool   `json:"is_owned"`
	MemberCount    int64  `json:"member_count"`
	AvatarRevision *int64 `json:"avatar_revision,omitempty"`
}

type sessionAccountWire struct {
	UUID           string `json:"uuid"`
	Email          string `json:"email"`
	Name           string `json:"name"`
	Active         bool   `json:"active"`
	AvatarRevision *int64 `json:"avatar_revision,omitempty"`
}

type sessionWire struct {
	Data sessionDataWire `json:"data"`
}

type sessionDataWire struct {
	Authenticated      bool                 `json:"authenticated"`
	IsAdmin            *bool                `json:"is_admin,omitempty"`
	Email              *string              `json:"email,omitempty"`
	Name               *string              `json:"name,omitempty"`
	Role               *string              `json:"role,omitempty"`
	SupplierID         *string              `json:"supplier_id,omitempty"`
	ActiveWorkspace    *workspaceWire       `json:"active_workspace"`
	Workspaces         []workspaceWire      `json:"workspaces"`
	UnusableWorkspaces []workspaceWire      `json:"unusable_workspaces"`
	AccountMode        *string              `json:"account_mode,omitempty"`
	AvatarRevision     *int64               `json:"avatar_revision,omitempty"`
	NameChangedAtMS    *int64               `json:"name_changed_at_ms,omitempty"`
	Accounts           []sessionAccountWire `json:"accounts"`
	EmailVerified      *bool                `json:"email_verified,omitempty"`
}

func anonymousSessionBody() []byte {
	body := sessionWire{Data: sessionDataWire{
		Workspaces:         []workspaceWire{},
		UnusableWorkspaces: []workspaceWire{},
		Accounts:           []sessionAccountWire{},
	}}
	raw, _ := json.Marshal(body)
	return raw
}

type meWire struct {
	Data struct {
		UUID       string `json:"uuid"`
		Role       string `json:"role"`
		Email      string `json:"email"`
		Name       string `json:"name"`
		SupplierID string `json:"supplierId"`
	} `json:"data"`
}

func meBody(publicID, role, email, name, supplierID string) []byte {
	var body meWire
	body.Data.UUID = publicID
	body.Data.Role = role
	body.Data.Email = email
	body.Data.Name = name
	body.Data.SupplierID = supplierID
	raw, _ := json.Marshal(body)
	return raw
}

type handoffWire struct {
	Data struct {
		Code      string `json:"code"`
		ExpiresIn int    `json:"expiresIn"`
	} `json:"data"`
}

type directoryMember struct {
	ID          int64  `json:"id"`
	Email       string `json:"email"`
	Role        string `json:"role"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`
}

type directoryPerms struct {
	InviteRoles []string `json:"inviteRoles"`
}

type directoryData struct {
	Members     []directoryMember `json:"members"`
	Permissions directoryPerms    `json:"permissions"`
}

type directoryWire struct {
	Data directoryData `json:"data"`
}

func handoffBody(code string) []byte {
	var body handoffWire
	body.Data.Code = code
	body.Data.ExpiresIn = 60
	raw, _ := json.Marshal(body)
	return raw
}
