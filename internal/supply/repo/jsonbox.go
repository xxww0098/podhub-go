package supplyrepo

import (
	"encoding/json"

	"github.com/xxww0098/podhub-go/internal/supply/contract"
	"github.com/xxww0098/podhub-go/internal/supply/domain"
)

func jsonStrings(raw []byte) []string {
	if len(raw) == 0 {
		return []string{}
	}
	var probe []json.RawMessage
	if json.Unmarshal(raw, &probe) != nil {
		return []string{}
	}
	out := make([]string, 0, len(probe))
	for _, item := range probe {
		var s string
		if json.Unmarshal(item, &s) != nil {
			return []string{}
		}
		out = append(out, s)
	}
	return out
}

func jsonSpecs(raw []byte) contract.Object {
	out := contract.Object{}
	if len(raw) == 0 {
		return out
	}
	var probe map[string]json.RawMessage
	if json.Unmarshal(raw, &probe) != nil {
		return out
	}
	for k, item := range probe {
		var s string
		if json.Unmarshal(item, &s) != nil {
			return contract.Object{}
		}
		out[k] = s
	}
	return out
}

type snapFile struct {
	MediaAssetID string  `json:"mediaAssetId"`
	ContentHash  *string `json:"contentHash,omitempty"`
}

type snapBody struct {
	PlatformSkuID       string     `json:"platformSkuId"`
	SpecVersion         int64      `json:"specVersion"`
	DesignRevision      int64      `json:"designRevision"`
	ProductionFiles     []snapFile `json:"productionFiles"`
	QuantityPlaceholder int64      `json:"quantityPlaceholder"`
}

// readSnapshot uses the JSON when the three required keys are present.
// Otherwise it falls back to the row columns, empty files, and quantity 1.
func readSnapshot(raw []byte, sku string, spec, design int64) (string, int64, int64, []contract.ProductionFile, int64) {
	var probe struct {
		PlatformSkuID       *string         `json:"platformSkuId"`
		SpecVersion         *int64          `json:"specVersion"`
		DesignRevision      *int64          `json:"designRevision"`
		ProductionFiles     json.RawMessage `json:"productionFiles"`
		QuantityPlaceholder *int64          `json:"quantityPlaceholder"`
	}
	if json.Unmarshal(raw, &probe) != nil || probe.PlatformSkuID == nil || probe.SpecVersion == nil || probe.DesignRevision == nil {
		return sku, spec, design, []contract.ProductionFile{}, 1
	}
	files := []contract.ProductionFile{}
	if len(probe.ProductionFiles) > 0 && string(probe.ProductionFiles) != "null" {
		var parsed []snapFile
		if json.Unmarshal(probe.ProductionFiles, &parsed) == nil {
			files = make([]contract.ProductionFile, 0, len(parsed))
			for _, file := range parsed {
				files = append(files, contract.ProductionFile{MediaAssetID: file.MediaAssetID, ContentHash: file.ContentHash})
			}
		}
	}
	qty := int64(1)
	if probe.QuantityPlaceholder != nil {
		qty = *probe.QuantityPlaceholder
	}
	return *probe.PlatformSkuID, *probe.SpecVersion, *probe.DesignRevision, files, qty
}

func writeSnapshot(sku string, spec, design int64, files []domain.ProductionFile, qty int64) ([]byte, error) {
	body := snapBody{
		PlatformSkuID: sku, SpecVersion: spec, DesignRevision: design,
		ProductionFiles: make([]snapFile, 0, len(files)), QuantityPlaceholder: qty,
	}
	for _, file := range files {
		item := snapFile{MediaAssetID: file.MediaAssetID}
		if file.HasHash {
			hash := file.ContentHash
			item.ContentHash = &hash
		}
		body.ProductionFiles = append(body.ProductionFiles, item)
	}
	return json.Marshal(body)
}

func domainFiles(files []contract.ProductionFile) []domain.ProductionFile {
	out := make([]domain.ProductionFile, 0, len(files))
	for _, file := range files {
		item := domain.ProductionFile{MediaAssetID: file.MediaAssetID}
		if file.ContentHash != nil {
			item.ContentHash = *file.ContentHash
			item.HasHash = true
		}
		out = append(out, item)
	}
	return out
}
