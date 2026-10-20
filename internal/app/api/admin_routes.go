package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/service"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func (h *adminHost) getPackage(w http.ResponseWriter, r *http.Request) {
	if _, ok := r.URL.Query()["category_id"]; !ok {
		badRequest(w)
		return
	}
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	actor, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	row, err := h.deps.ReadOfficial(ctx, actor, r.URL.Query().Get("category_id"))
	if !finish(w, err) {
		return
	}
	body := struct {
		Data struct {
			Package *officialWire `json:"package,omitempty"`
		} `json:"data"`
	}{}
	if row != nil {
		wire := officialWireOf(*row)
		body.Data.Package = &wire
	}
	jsonwire.Write(w, http.StatusOK, body)
}

func (h *adminHost) createPackage(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	actor, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	in, ok := packageBody(w, r)
	if !ok {
		return
	}
	row, err := h.deps.CreateOfficial(ctx, actor, in)
	if !finish(w, err) {
		return
	}
	writePackageMutation(w, http.StatusCreated, row)
}

func packageBody(w http.ResponseWriter, r *http.Request) (service.PackageWrite, bool) {
	fields, ok := readJSON(w, r, adminBodyLimit)
	if !ok {
		return service.PackageWrite{}, false
	}
	if !known(fields, "category_id", "name", "defaults_json", "dataset_json") {
		badRequest(w)
		return service.PackageWrite{}, false
	}
	category, okCat := strField(fields, "category_id", true, "")
	name, okName := strField(fields, "name", true, "")
	defaults, okDef := strField(fields, "defaults_json", false, "{}")
	dataset, okSet := strField(fields, "dataset_json", false, "[]")
	if !okCat || !okName || !okDef || !okSet {
		badRequest(w)
		return service.PackageWrite{}, false
	}
	return service.PackageWrite{CategoryID: category, Name: name, Defaults: defaults, Dataset: dataset}, true
}

func (h *adminHost) createPrompt(w http.ResponseWriter, r *http.Request) {
	h.writePrompt(w, r, "", true)
}

func (h *adminHost) updatePrompt(w http.ResponseWriter, r *http.Request) {
	h.writePrompt(w, r, chi.URLParam(r, "prompt_id"), false)
}

func (h *adminHost) writePrompt(w http.ResponseWriter, r *http.Request, id string, create bool) {
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	actor, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	fields, ok := readJSON(w, r, adminBodyLimit)
	if !ok {
		return
	}
	if !known(fields, "name", "fileName", "content", "descriptionCategoryId", "typeId", "fixedTags") {
		badRequest(w)
		return
	}
	name, okName := strField(fields, "name", true, "")
	file, okFile := strField(fields, "fileName", true, "")
	content, okContent := strField(fields, "content", true, "")
	category, okCat := intField(fields, "descriptionCategoryId")
	typeID, okType := intField(fields, "typeId")
	tags, okTags := tagsField(fields)
	if !okName || !okFile || !okContent || !okCat || !okType || !okTags {
		badRequest(w)
		return
	}
	in := service.PromptWrite{Name: name, FileName: file, Content: content, Category: category, TypeID: typeID, Tags: tags}
	var (
		row service.Prompt
		err error
	)
	if create {
		row, err = h.deps.CreatePrompt(ctx, actor, in)
	} else {
		row, err = h.deps.UpdatePrompt(ctx, actor, id, in)
	}
	if !finish(w, err) {
		return
	}
	status := http.StatusOK
	if create {
		status = http.StatusCreated
	}
	jsonwire.Write(w, status, struct {
		Data struct {
			Prompt promptWire `json:"prompt"`
		} `json:"data"`
	}{Data: struct {
		Prompt promptWire `json:"prompt"`
	}{Prompt: promptWireOf(row)}})
}

func (h *adminHost) deletePrompt(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	actor, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	id := chi.URLParam(r, "prompt_id")
	if err := h.deps.DeletePrompt(ctx, actor, id); !finish(w, err) {
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			PromptID string `json:"promptId"`
		} `json:"data"`
	}{Data: struct {
		PromptID string `json:"promptId"`
	}{PromptID: id}})
}

func (h *adminHost) createVideo(w http.ResponseWriter, r *http.Request) {
	h.writeVideo(w, r, "", true)
}

func (h *adminHost) updateVideo(w http.ResponseWriter, r *http.Request) {
	h.writeVideo(w, r, chi.URLParam(r, "video_id"), false)
}

func (h *adminHost) writeVideo(w http.ResponseWriter, r *http.Request, id string, create bool) {
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	actor, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	fields, ok := readJSON(w, r, adminBodyLimit)
	if !ok {
		return
	}
	if !known(fields, "name", "videoUrl", "durationMs", "descriptionCategoryId", "typeId") {
		badRequest(w)
		return
	}
	name, okName := strField(fields, "name", true, "")
	url, okURL := strField(fields, "videoUrl", true, "")
	duration, okDur := intField(fields, "durationMs")
	category, okCat := intField(fields, "descriptionCategoryId")
	typeID, okType := intField(fields, "typeId")
	if !okName || !okURL || !okDur || !okCat || !okType {
		badRequest(w)
		return
	}
	in := service.VideoWrite{Name: name, URL: url, Duration: duration, Category: category, TypeID: typeID}
	var (
		row service.Video
		err error
	)
	if create {
		row, err = h.deps.CreateVideo(ctx, actor, in)
	} else {
		row, err = h.deps.UpdateVideo(ctx, actor, id, in)
	}
	if !finish(w, err) {
		return
	}
	status := http.StatusOK
	if create {
		status = http.StatusCreated
	}
	jsonwire.Write(w, status, struct {
		Data struct {
			Video videoWire `json:"video"`
		} `json:"data"`
	}{Data: struct {
		Video videoWire `json:"video"`
	}{Video: videoWireOf(row)}})
}

func (h *adminHost) deleteVideo(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	actor, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	id := chi.URLParam(r, "video_id")
	if err := h.deps.DeleteVideo(ctx, actor, id); !finish(w, err) {
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			VideoID string `json:"videoId"`
		} `json:"data"`
	}{Data: struct {
		VideoID string `json:"videoId"`
	}{VideoID: id}})
}

func (h *adminHost) storage(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	actor, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	var accountID *string
	if _, present := r.URL.Query()["accountId"]; present {
		value := r.URL.Query().Get("accountId")
		accountID = &value
	}
	view, err := h.deps.Storage(ctx, actor, accountID, r.URL.Query().Get("prefix"))
	if !finish(w, err) {
		return
	}
	groups := make([]groupWire, 0, len(view.Groups))
	for _, group := range view.Groups {
		groups = append(groups, groupWire{Prefix: group.Prefix, WorkspaceName: group.WorkspaceName, Objects: group.Objects, Bytes: group.Bytes})
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data storageWire `json:"data"`
	}{Data: storageWire{
		AccountID: view.AccountID, Bucket: view.Bucket, Prefix: view.Prefix, Objects: view.Objects,
		Bytes: view.Bytes, Truncated: view.Truncated, ScannedAtMS: view.ScannedAt, Groups: groups,
	}})
}

func (h *adminHost) purge(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	actor, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	fields, ok := readJSON(w, r, adminBodyLimit)
	if !ok {
		return
	}
	if !known(fields, "accountId", "prefix") {
		badRequest(w)
		return
	}
	accountID, okID := strField(fields, "accountId", true, "")
	prefix, okPrefix := strField(fields, "prefix", true, "")
	if !okID || !okPrefix {
		badRequest(w)
		return
	}
	view, err := h.deps.Purge(ctx, actor, accountID, prefix)
	if !finish(w, err) {
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data purgeWire `json:"data"`
	}{Data: purgeWire{
		AccountID: view.AccountID, Prefix: view.Prefix, Deleted: view.Deleted, Missing: view.Missing,
		Failed: view.Failed, Bytes: view.Bytes, Remaining: view.Remaining,
	}})
}

func (h *adminHost) listObjects(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	for key := range query {
		switch key {
		case "accountId", "prefix", "cursor":
		default:
			badRequest(w)
			return
		}
	}
	if _, ok := query["accountId"]; !ok {
		badRequest(w)
		return
	}
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	if _, ok := h.admit(w, r.WithContext(ctx)); !ok {
		return
	}
	var cursor *string
	if _, present := query["cursor"]; present {
		value := query.Get("cursor")
		cursor = &value
	}
	page, err := h.deps.ListObjects(ctx, query.Get("accountId"), query.Get("prefix"), cursor)
	if !finish(w, err) {
		return
	}
	items := make([]itemWire, 0, len(page.Items))
	for _, item := range page.Items {
		wire := itemWire{Path: item.Path, Kind: item.Kind, Bytes: item.Bytes}
		if item.HasModified {
			value := item.LastModified
			wire.LastModified = &value
		}
		if item.HasPublic {
			value := item.PublicURL
			wire.PublicURL = &value
		}
		items = append(items, wire)
	}
	body := objectPageWire{AccountID: page.AccountID, Prefix: page.Prefix, Items: items}
	if page.HasCursor {
		value := page.NextCursor
		body.NextCursor = &value
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data objectPageWire `json:"data"`
	}{Data: body})
}

func (h *adminHost) createDirectory(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	_, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	fields, ok := readJSON(w, r, adminBodyLimit)
	if !ok {
		return
	}
	if !known(fields, "accountId", "path") {
		badRequest(w)
		return
	}
	accountID, okID := strField(fields, "accountId", true, "")
	path, okPath := strField(fields, "path", true, "")
	if !okID || !okPath {
		badRequest(w)
		return
	}
	storedID, rel, err := h.deps.CreateDirectory(ctx, accountID, path)
	if !finish(w, err) {
		return
	}
	jsonwire.Write(w, http.StatusCreated, struct {
		Data struct {
			AccountID string `json:"accountId"`
			Path      string `json:"path"`
		} `json:"data"`
	}{Data: struct {
		AccountID string `json:"accountId"`
		Path      string `json:"path"`
	}{AccountID: storedID, Path: rel}})
}

func (h *adminHost) presign(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	actor, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	fields, ok := readJSON(w, r, adminBodyLimit)
	if !ok {
		return
	}
	if !known(fields, "accountId", "path", "contentType", "bytes", "sha256") {
		badRequest(w)
		return
	}
	accountID, okID := strField(fields, "accountId", true, "")
	path, okPath := strField(fields, "path", true, "")
	contentType, okType := strField(fields, "contentType", true, "")
	sha, okSHA := strField(fields, "sha256", true, "")
	n, okN := intField(fields, "bytes")
	if !okID || !okPath || !okType || !okSHA || !okN {
		badRequest(w)
		return
	}
	checksum := strings.TrimSpace(r.Header.Get("x-podhub-store-checksum")) == "sha256"
	grant, err := h.deps.PresignUpload(ctx, actor, accountID, path, contentType, sha, n, checksum)
	if !finish(w, err) {
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	headers := uploadHeaders{ContentType: grant.ContentType, IfNoneMatch: grant.IfNoneMatch}
	if grant.Checksum != "" {
		value := grant.Checksum
		headers.Checksum = &value
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			AccountID string `json:"accountId"`
			Upload    struct {
				Path   string `json:"path"`
				Upload struct {
					URL     string        `json:"url"`
					Headers uploadHeaders `json:"headers"`
					Expires int64         `json:"expiresAtMs"`
				} `json:"upload"`
				Ticket string `json:"uploadTicket"`
			} `json:"upload"`
		} `json:"data"`
	}{Data: struct {
		AccountID string `json:"accountId"`
		Upload    struct {
			Path   string `json:"path"`
			Upload struct {
				URL     string        `json:"url"`
				Headers uploadHeaders `json:"headers"`
				Expires int64         `json:"expiresAtMs"`
			} `json:"upload"`
			Ticket string `json:"uploadTicket"`
		} `json:"upload"`
	}{
		AccountID: grant.AccountID,
		Upload: struct {
			Path   string `json:"path"`
			Upload struct {
				URL     string        `json:"url"`
				Headers uploadHeaders `json:"headers"`
				Expires int64         `json:"expiresAtMs"`
			} `json:"upload"`
			Ticket string `json:"uploadTicket"`
		}{
			Path: grant.Path,
			Upload: struct {
				URL     string        `json:"url"`
				Headers uploadHeaders `json:"headers"`
				Expires int64         `json:"expiresAtMs"`
			}{URL: grant.URL, Headers: headers, Expires: grant.ExpiresAtMS},
			Ticket: grant.Ticket,
		},
	}})
}

func (h *adminHost) confirm(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, _ := h.ctx(w, r, confirmDeadline)
	defer cancel()
	actor, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	fields, ok := readJSON(w, r, confirmBodyLimit)
	if !ok {
		return
	}
	if !known(fields, "accountId", "path", "uploadTicket") {
		badRequest(w)
		return
	}
	accountID, okID := strField(fields, "accountId", true, "")
	path, okPath := strField(fields, "path", true, "")
	ticket, okTicket := strField(fields, "uploadTicket", true, "")
	if !okID || !okPath || !okTicket {
		badRequest(w)
		return
	}
	confirmed, err := h.deps.Confirm(ctx, actor, accountID, path, ticket, func(ctx context.Context) error {
		_, ok := h.admit(w, r.WithContext(ctx))
		if !ok {
			return errWritten
		}
		return nil
	})
	if err == errWritten {
		return
	}
	if !finish(w, err) {
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie, Authorization")
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			AccountID string `json:"accountId"`
			Path      string `json:"path"`
			PublicURL string `json:"publicUrl"`
		} `json:"data"`
	}{Data: struct {
		AccountID string `json:"accountId"`
		Path      string `json:"path"`
		PublicURL string `json:"publicUrl"`
	}{AccountID: confirmed.AccountID, Path: confirmed.Path, PublicURL: confirmed.PublicURL}})
}

var errWritten = service.NewFail(0, "", "")

func (h *adminHost) moveObject(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	_, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	fields, ok := readJSON(w, r, adminBodyLimit)
	if !ok {
		return
	}
	if !known(fields, "accountId", "sourcePath", "destinationPath", "kind") {
		badRequest(w)
		return
	}
	accountID, okID := strField(fields, "accountId", true, "")
	source, okSource := strField(fields, "sourcePath", true, "")
	dest, okDest := strField(fields, "destinationPath", true, "")
	kind, okKind := strField(fields, "kind", true, "")
	if !okID || !okSource || !okDest || !okKind {
		badRequest(w)
		return
	}
	if err := h.deps.MoveObject(ctx, accountID, source, dest, kind); !finish(w, err) {
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data struct {
			AccountID string `json:"accountId"`
			Source    string `json:"sourcePath"`
			Dest      string `json:"destinationPath"`
		} `json:"data"`
	}{Data: struct {
		AccountID string `json:"accountId"`
		Source    string `json:"sourcePath"`
		Dest      string `json:"destinationPath"`
	}{AccountID: accountID, Source: source, Dest: dest}})
}

func (h *adminHost) deleteObjects(w http.ResponseWriter, r *http.Request) {
	ctx, cancel, _ := h.ctx(w, r, adminDeadline)
	defer cancel()
	_, ok := h.admit(w, r.WithContext(ctx))
	if !ok {
		return
	}
	fields, ok := readJSON(w, r, adminBodyLimit)
	if !ok {
		return
	}
	if !known(fields, "accountId", "path", "kind") {
		badRequest(w)
		return
	}
	accountID, okID := strField(fields, "accountId", true, "")
	path, okPath := strField(fields, "path", true, "")
	kind, okKind := strField(fields, "kind", true, "")
	if !okID || !okPath || !okKind {
		badRequest(w)
		return
	}
	view, err := h.deps.DeleteObjects(ctx, accountID, path, kind)
	if !finish(w, err) {
		return
	}
	jsonwire.Write(w, http.StatusOK, struct {
		Data deleteWire `json:"data"`
	}{Data: deleteWire{
		AccountID: view.AccountID, Path: view.Path, Kind: view.Kind, Deleted: view.Deleted,
		Missing: view.Missing, Failed: view.Failed, Remaining: view.Remaining,
	}})
}

func writePackageMutation(w http.ResponseWriter, status int, row service.Official) {
	jsonwire.Write(w, status, struct {
		Data struct {
			OK      bool         `json:"ok"`
			Package officialWire `json:"package"`
		} `json:"data"`
	}{Data: struct {
		OK      bool         `json:"ok"`
		Package officialWire `json:"package"`
	}{OK: true, Package: officialWireOf(row)}})
}

func okBody() struct {
	Data struct {
		OK bool `json:"ok"`
	} `json:"data"`
} {
	return struct {
		Data struct {
			OK bool `json:"ok"`
		} `json:"data"`
	}{Data: struct {
		OK bool `json:"ok"`
	}{OK: true}}
}

type officialWire struct {
	ID          int64  `json:"id"`
	CategoryID  string `json:"category_id"`
	Name        string `json:"name"`
	Status      string `json:"status"`
	Defaults    string `json:"defaults_json"`
	Dataset     string `json:"dataset_json"`
	PublishedAt int64  `json:"published_at_ms"`
	UpdatedAt   int64  `json:"updated_at_ms"`
}

func officialWireOf(row service.Official) officialWire {
	return officialWire{
		ID: row.ID, CategoryID: row.CategoryID, Name: row.Name, Status: row.Status,
		Defaults: row.Defaults, Dataset: row.Dataset, PublishedAt: row.PublishedAt, UpdatedAt: row.UpdatedAt,
	}
}

type promptWire struct {
	PromptID    string   `json:"promptId"`
	Name        string   `json:"name"`
	FileName    string   `json:"fileName"`
	Content     string   `json:"content"`
	Category    int64    `json:"descriptionCategoryId"`
	TypeID      int64    `json:"typeId"`
	FixedTags   []string `json:"fixedTags"`
	UpdatedAtMS int64    `json:"updatedAtMs"`
}

func promptWireOf(row service.Prompt) promptWire {
	tags := row.FixedTags
	if tags == nil {
		tags = []string{}
	}
	return promptWire{
		PromptID: row.ID, Name: row.Name, FileName: row.FileName, Content: row.Content,
		Category: row.Category, TypeID: row.TypeID, FixedTags: tags, UpdatedAtMS: row.UpdatedAt,
	}
}

type videoWire struct {
	VideoID     string `json:"videoId"`
	Name        string `json:"name"`
	URL         string `json:"videoUrl"`
	Duration    int64  `json:"durationMs"`
	Category    int64  `json:"descriptionCategoryId"`
	TypeID      int64  `json:"typeId"`
	UpdatedAtMS int64  `json:"updatedAtMs"`
}

func videoWireOf(row service.Video) videoWire {
	return videoWire{
		VideoID: row.ID, Name: row.Name, URL: row.URL, Duration: row.Duration,
		Category: row.Category, TypeID: row.TypeID, UpdatedAtMS: row.UpdatedAt,
	}
}

type groupWire struct {
	Prefix        string `json:"prefix"`
	WorkspaceName string `json:"workspaceName"`
	Objects       int64  `json:"objects"`
	Bytes         int64  `json:"bytes"`
}

type storageWire struct {
	AccountID   string      `json:"accountId"`
	Bucket      string      `json:"bucket"`
	Prefix      string      `json:"prefix"`
	Objects     int64       `json:"objects"`
	Bytes       int64       `json:"bytes"`
	Truncated   bool        `json:"truncated"`
	ScannedAtMS int64       `json:"scannedAtMs"`
	Groups      []groupWire `json:"groups"`
}

type purgeWire struct {
	AccountID string `json:"accountId"`
	Prefix    string `json:"prefix"`
	Deleted   int64  `json:"deleted"`
	Missing   int64  `json:"missing"`
	Failed    int64  `json:"failed"`
	Bytes     int64  `json:"bytes"`
	Remaining bool   `json:"remaining"`
}

type itemWire struct {
	Path         string  `json:"path"`
	Kind         string  `json:"kind"`
	Bytes        int64   `json:"bytes"`
	LastModified *string `json:"lastModified,omitempty"`
	PublicURL    *string `json:"publicUrl,omitempty"`
}

type objectPageWire struct {
	AccountID  string     `json:"accountId"`
	Prefix     string     `json:"prefix"`
	Items      []itemWire `json:"items"`
	NextCursor *string    `json:"nextCursor,omitempty"`
}

type uploadHeaders struct {
	ContentType string  `json:"contentType"`
	IfNoneMatch string  `json:"ifNoneMatch"`
	Checksum    *string `json:"checksumSha256,omitempty"`
}

type deleteWire struct {
	AccountID string `json:"accountId"`
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Deleted   int64  `json:"deleted"`
	Missing   int64  `json:"missing"`
	Failed    int64  `json:"failed"`
	Remaining bool   `json:"remaining"`
}
