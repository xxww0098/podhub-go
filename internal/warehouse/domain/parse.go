package domain

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
)

// PageLimit is the local cap on read pages. It matches the existing
// warehouse list loop bound in this repository.
const PageLimit = 50

// WarehousePageLimit is the page size the existing list caller sends.
const WarehousePageLimit = 200

// MethodPageLimit is the verified delivery-method page size.
const MethodPageLimit = 50

// WarehousePaths the sync is allowed to dial. v1 warehouse list is absent.
const (
	PathWarehouseList = "/v2/warehouse/list"
	PathMethodList    = "/v2/delivery-method/list"
	PathOperation     = "/v1/warehouse/operation/status"
)

// ParsedWarehouses is one warehouse-list page.
type ParsedWarehouses struct {
	Rows     []contract.Warehouse
	Cursor   string
	HasNext  bool
	Obsolete bool
}

// ParsedMethods is one delivery-method page.
type ParsedMethods struct {
	Rows     []contract.Method
	Cursor   string
	HasNext  bool
	Obsolete bool
}

// ParsedOperation is the verified operation-status shape.
type ParsedOperation struct {
	Status      string
	WarehouseID *int64
	Obsolete    bool
}

type envelope struct {
	Code    json.RawMessage `json:"code"`
	Message string          `json:"message"`
	Cursor  string          `json:"cursor"`
	HasNext bool            `json:"has_next"`
	Result  json.RawMessage `json:"result"`
}

// Obsolete reports code 9, the verified obsolete-method code.
func Obsolete(raw []byte) bool {
	var env envelope
	if json.Unmarshal(raw, &env) != nil {
		return false
	}
	if codeNumber(env.Code) == 9 {
		return true
	}
	return strings.Contains(strings.ToLower(env.Message), "obsolete")
}

// OzonCode returns a numeric or string code for the error catalog.
// The message is not returned.
func OzonCode(raw []byte) string {
	var env envelope
	if json.Unmarshal(raw, &env) != nil {
		return ""
	}
	return scalarText(env.Code)
}

// ParseWarehouses reads warehouse_id, name, status, and is_rfbs.
// Rows may sit on warehouses or result.warehouses. Both shapes are already
// read by this repository. Other fields are ignored.
func ParseWarehouses(raw []byte) (ParsedWarehouses, error) {
	if Obsolete(raw) {
		return ParsedWarehouses{Obsolete: true}, nil
	}
	var body struct {
		Cursor     string          `json:"cursor"`
		HasNext    bool            `json:"has_next"`
		Warehouses json.RawMessage `json:"warehouses"`
		Result     struct {
			Warehouses json.RawMessage `json:"warehouses"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return ParsedWarehouses{}, err
	}
	list := body.Warehouses
	if len(list) == 0 {
		list = body.Result.Warehouses
	}
	rows, err := decodeHouses(list)
	if err != nil {
		return ParsedWarehouses{}, err
	}
	return ParsedWarehouses{Rows: rows, Cursor: strings.TrimSpace(body.Cursor), HasNext: body.HasNext}, nil
}

func decodeHouses(raw json.RawMessage) ([]contract.Warehouse, error) {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return nil, contract.Ozon()
	}
	var rows []struct {
		WarehouseID int64  `json:"warehouse_id"`
		Name        string `json:"name"`
		Status      string `json:"status"`
		IsRFBS      bool   `json:"is_rfbs"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	out := make([]contract.Warehouse, 0, len(rows))
	seen := map[int64]int{}
	for _, row := range rows {
		name := strings.TrimSpace(row.Name)
		if row.WarehouseID <= 0 || name == "" {
			return nil, contract.Ozon()
		}
		item := contract.Warehouse{
			WarehouseID: row.WarehouseID,
			Name:        name,
			Status:      strings.TrimSpace(row.Status),
			IsRFBS:      row.IsRFBS,
		}
		if i, ok := seen[row.WarehouseID]; ok {
			out[i] = item
			continue
		}
		seen[row.WarehouseID] = len(out)
		out = append(out, item)
	}
	return out, nil
}

// ParseMethods reads the v2 delivery-method list and its continuation cursor.
func ParseMethods(raw []byte) (ParsedMethods, error) {
	if Obsolete(raw) {
		return ParsedMethods{Obsolete: true}, nil
	}
	var body struct {
		Cursor          string          `json:"cursor"`
		HasNext         bool            `json:"has_next"`
		DeliveryMethods json.RawMessage `json:"delivery_methods"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return ParsedMethods{}, err
	}
	rows, err := decodeMethods(body.DeliveryMethods)
	if err != nil {
		return ParsedMethods{}, err
	}
	return ParsedMethods{Rows: rows, Cursor: strings.TrimSpace(body.Cursor), HasNext: body.HasNext}, nil
}

func decodeMethods(raw json.RawMessage) ([]contract.Method, error) {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return nil, contract.Ozon()
	}
	var rows []struct {
		ID          int64           `json:"id"`
		Name        string          `json:"name"`
		WarehouseID int64           `json:"warehouse_id"`
		ProviderID  json.RawMessage `json:"provider_id"`
		TemplateID  json.RawMessage `json:"template_id"`
		Cutoff      json.RawMessage `json:"cutoff"`
		SLACutIn    json.RawMessage `json:"sla_cut_in"`
		Status      string          `json:"status"`
		CreatedAt   json.RawMessage `json:"created_at"`
		UpdatedAt   json.RawMessage `json:"updated_at"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	out := make([]contract.Method, 0, len(rows))
	seen := map[int64]int{}
	for _, row := range rows {
		name := strings.TrimSpace(row.Name)
		if row.ID <= 0 || row.WarehouseID <= 0 || name == "" {
			return nil, contract.Ozon()
		}
		item := contract.Method{
			MethodID:    row.ID,
			WarehouseID: row.WarehouseID,
			Name:        name,
			ProviderID:  scalarText(row.ProviderID),
			TemplateID:  scalarText(row.TemplateID),
			Cutoff:      scalarText(row.Cutoff),
			SLACutIn:    scalarText(row.SLACutIn),
			Status:      strings.TrimSpace(row.Status),
			CreatedAt:   scalarText(row.CreatedAt),
			UpdatedAt:   scalarText(row.UpdatedAt),
		}
		if i, ok := seen[row.ID]; ok {
			out[i] = item
			continue
		}
		seen[row.ID] = len(out)
		out = append(out, item)
	}
	return out, nil
}

// ParseOperation reads status and result.warehouse_id.
func ParseOperation(raw []byte) (ParsedOperation, error) {
	if Obsolete(raw) {
		return ParsedOperation{Obsolete: true}, nil
	}
	var body struct {
		Status string `json:"status"`
		Result struct {
			WarehouseID *int64 `json:"warehouse_id"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return ParsedOperation{}, err
	}
	return ParsedOperation{Status: strings.TrimSpace(body.Status), WarehouseID: body.Result.WarehouseID}, nil
}

func scalarText(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s
		}
	}
	return string(raw)
}

func codeNumber(raw json.RawMessage) int {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] == '"' {
		return 0
	}
	var n int
	if json.Unmarshal(raw, &n) != nil {
		return 0
	}
	return n
}

// IsActive is status created and not locally archived.
func IsActive(status string, archived bool) bool {
	return status == ActiveStatus && !archived
}
