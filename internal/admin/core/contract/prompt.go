package contract

// Prompt is SupplierPromptData. Null revisions are omitted.
type Prompt struct {
	ProductID               string   `json:"productId"`
	SourceID                string   `json:"sourceId"`
	ProductTitle            string   `json:"productTitle"`
	DescriptionCategoryID   int64    `json:"descriptionCategoryId"`
	TypeID                  int64    `json:"typeId"`
	PromptName              string   `json:"promptName"`
	PromptFileName          string   `json:"promptFileName"`
	PromptContent           string   `json:"promptContent"`
	FixedTags               []string `json:"fixedTags"`
	DraftPromptRevision     *int32   `json:"draftPromptRevision,omitempty"`
	PublishedPromptRevision *int32   `json:"publishedPromptRevision,omitempty"`
	Revision                int64    `json:"revision"`
}
