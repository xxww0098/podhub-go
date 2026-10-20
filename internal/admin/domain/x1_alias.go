package domain

import (
	x1contract "github.com/xxww0098/podhub-go/internal/admin/x1/contract"
)

type AiOutput = x1contract.AiOutput

type BrowserGrant = x1contract.BrowserGrant

func BuildDiff(revision int32, publishedRevision *int32, publishedBrief string, publishedTags []string, publishedAI x1contract.AiOutput, draftBrief string, draftTags []string, draftAI x1contract.AiOutput) x1contract.PromptDiff {
	return x1contract.BuildDiff(revision, publishedRevision, publishedBrief, publishedTags, publishedAI, draftBrief, draftTags, draftAI)
}

func BuildPreview(brief string, tags []string) (x1contract.Preview, error) {
	return x1contract.BuildPreview(brief, tags)
}

type CatalogStamp = x1contract.CatalogStamp

type ConfirmedUpload = x1contract.ConfirmedUpload

type DbDetail = x1contract.DbDetail

func DecodeOzon(body []byte) (x1contract.OzonPut, error) { return x1contract.DecodeOzon(body) }

func DecodePreview(body []byte) (x1contract.PreviewInput, error) {
	return x1contract.DecodePreview(body)
}

func DecodePrice(body []byte) (x1contract.RowPriceInput, error) { return x1contract.DecodePrice(body) }

func DecodePromptPatch(body []byte) (x1contract.PromptPatchInput, error) {
	return x1contract.DecodePromptPatch(body)
}

func DecodeRevision(body []byte) (int32, error) { return x1contract.DecodeRevision(body) }

func DecodeRow(body []byte, update bool) (x1contract.RowInput, error) {
	return x1contract.DecodeRow(body, update)
}

func DefaultAI() x1contract.AiOutput { return x1contract.DefaultAI() }

type DiffLine = x1contract.DiffLine

type DirectoryCreated = x1contract.DirectoryCreated

func EmptySync() x1contract.SyncReport { return x1contract.EmptySync() }

type FileItem = x1contract.FileItem

type GalleryItem = x1contract.GalleryItem

type GrantHeaders = x1contract.GrantHeaders

type JudgeResult = x1contract.JudgeResult

type MovedObject = x1contract.MovedObject

type MultipartPlan = x1contract.MultipartPlan

type OzonConfig = x1contract.OzonConfig

type OzonPut = x1contract.OzonPut

type Preview = x1contract.Preview

type PreviewInput = x1contract.PreviewInput

type PromptDiff = x1contract.PromptDiff

type PromptPatchInput = x1contract.PromptPatchInput

type PromptPublish = x1contract.PromptPublish

type RowData = x1contract.RowData

type RowFacts = x1contract.RowFacts

type RowInput = x1contract.RowInput

type RowPriceInput = x1contract.RowPriceInput

type RowReadiness = x1contract.RowReadiness

type SyncCounts = x1contract.SyncCounts

type SyncFailure = x1contract.SyncFailure

type SyncItem = x1contract.SyncItem

type SyncMiss = x1contract.SyncMiss

type SyncReport = x1contract.SyncReport

func TemplateSHA256() string { return x1contract.TemplateSHA256() }

type UploadBody = x1contract.UploadBody

type UploadPart = x1contract.UploadPart

type VideoItem = x1contract.VideoItem
