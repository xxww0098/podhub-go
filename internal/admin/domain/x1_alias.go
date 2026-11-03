package domain

import (
	x1contract "github.com/xxww0098/podhub-go/internal/admin/x1/contract"
)

type AiOutput = x1contract.AiOutput

type BrowserGrant = x1contract.BrowserGrant

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

func DecodeRow(body []byte, update bool) (x1contract.RowInput, error) {
	return x1contract.DecodeRow(body, update)
}

func DefaultAI() x1contract.AiOutput { return x1contract.DefaultAI() }

type DirectoryCreated = x1contract.DirectoryCreated

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

type RowData = x1contract.RowData

type RowFacts = x1contract.RowFacts

type RowInput = x1contract.RowInput

type RowPriceInput = x1contract.RowPriceInput

type RowReadiness = x1contract.RowReadiness

func TemplateSHA256() string { return x1contract.TemplateSHA256() }

type UploadBody = x1contract.UploadBody

type UploadPart = x1contract.UploadPart

type VideoItem = x1contract.VideoItem
