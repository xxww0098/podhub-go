package domain

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
	"unicode"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

const maxPromoPages = 20

type PromotionsRequest struct {
	StoreID       string
	ProductIDs    []int64
	ActionID      *int64
	Participating *bool
	Cursor        string
}

func DecodePromotions(raw []byte) (PromotionsRequest, error) {
	m, err := object(raw, "store_id", "product_ids", "action_id", "participating", "cursor")
	if err != nil {
		return PromotionsRequest{}, err
	}
	store, ok, err := rawString(m, "store_id")
	if err != nil || !ok {
		return PromotionsRequest{}, errJSON
	}
	req := PromotionsRequest{StoreID: store}
	ids, ok := m["product_ids"]
	if !ok || !bytes.HasPrefix(bytes.TrimSpace(ids), []byte("[")) || json.Unmarshal(ids, &req.ProductIDs) != nil {
		return PromotionsRequest{}, errJSON
	}
	if _, exists := m["action_id"]; exists {
		id, ok, err := rawI64(m, "action_id")
		if err != nil || !ok {
			return PromotionsRequest{}, errJSON
		}
		req.ActionID = &id
	}
	if _, exists := m["participating"]; exists {
		value, ok, err := rawBool(m, "participating")
		if err != nil || !ok {
			return PromotionsRequest{}, errJSON
		}
		req.Participating = &value
	}
	if value, exists, err := rawString(m, "cursor"); err != nil {
		return PromotionsRequest{}, errJSON
	} else if exists {
		if string(m["cursor"]) == "null" {
			return PromotionsRequest{}, errJSON
		}
		req.Cursor = value
	}
	return req, nil
}

func ValidatePromotions(req PromotionsRequest) *contract.Fail {
	if len(req.ProductIDs) > 1000 {
		return contract.Validation("每次最多读取 1000 件商品的活动")
	}
	for _, id := range req.ProductIDs {
		if !sellerID(id) {
			return contract.Validation("促销活动包含无效的商品编号")
		}
	}
	if len(req.Cursor) > 256 || strings.IndexFunc(req.Cursor, unicode.IsControl) >= 0 {
		return contract.Validation("活动分页游标无效")
	}
	if req.ActionID == nil {
		if req.Participating != nil || req.Cursor != "" {
			return contract.Validation("活动分页必须指定活动和参加状态")
		}
	} else if !sellerID(*req.ActionID) || req.Participating == nil || len(req.ProductIDs) != 0 {
		return contract.Validation("活动分页须指定有效活动、参加状态，且商品选择为空")
	}
	return nil
}

func promotionReadFailure() *contract.Fail {
	return &contract.Fail{Status: 502, Code: contract.CodeProducts, Message: "Ozon 活动商品资料或分页不完整，请重新读取"}
}

func Promotions(req PromotionsRequest, read contract.PromotionRead) (json.RawMessage, *contract.Fail) {
	if fail := ValidatePromotions(req); fail != nil {
		return nil, fail
	}
	if read == nil {
		return nil, contract.Internal("")
	}
	actions, fail := read.Actions()
	if fail != nil {
		return nil, fail
	}
	offers := []contract.PromotionOffer{}
	var total *int64
	var next *string
	if req.ActionID != nil {
		var selected *contract.PromotionAction
		for i := range actions {
			if actions[i].ActionID == *req.ActionID {
				selected = &actions[i]
				break
			}
		}
		if selected == nil {
			return nil, &contract.Fail{Status: 404, Code: contract.CodeNotFound, Message: "该店铺当前没有此活动"}
		}
		page, fail := promotionPageRead(*req.ActionID, *req.Participating, req.Cursor, read)
		if fail != nil {
			return nil, fail
		}
		if page.NextCursor != "" && page.NextCursor == req.Cursor {
			return nil, promotionReadFailure()
		}
		actions, offers, total = []contract.PromotionAction{*selected}, page.Offers, &page.Total
		if page.NextCursor != "" {
			next = &page.NextCursor
		}
	} else if len(req.ProductIDs) > 0 {
		wanted := map[int64]bool{}
		for _, id := range req.ProductIDs {
			wanted[id] = true
		}
		selected := []contract.PromotionAction{}
		for _, action := range actions {
			if action.PotentialProductsTotal == 0 && action.ParticipatingProductsTotal == 0 {
				continue
			}
			missing := make(map[int64]bool, len(wanted))
			for id := range wanted {
				missing[id] = true
			}
			for _, participating := range []bool{true, false} {
				if len(missing) == 0 {
					break
				}
				rows, fail := promotionProductsFor(action.ActionID, participating, missing, read)
				if fail != nil {
					return nil, fail
				}
				for _, row := range rows {
					if !missing[row.ProductID] {
						continue
					}
					delete(missing, row.ProductID)
					offers = append(offers, row)
					action.EligibleSelected++
					if participating {
						action.ParticipatingSelected++
					}
				}
			}
			if action.EligibleSelected > 0 {
				selected = append(selected, action)
			}
		}
		actions = selected
		sort.Slice(actions, func(i, j int) bool {
			if actions[i].ParticipatingSelected != actions[j].ParticipatingSelected {
				return actions[i].ParticipatingSelected > actions[j].ParticipatingSelected
			}
			if actions[i].EligibleSelected != actions[j].EligibleSelected {
				return actions[i].EligibleSelected > actions[j].EligibleSelected
			}
			return actions[i].Title < actions[j].Title
		})
	}
	if fail := promotionDetails(offers, read); fail != nil {
		return nil, fail
	}
	if actions == nil {
		actions = []contract.PromotionAction{}
	}
	return mustData(struct {
		Actions    []contract.PromotionAction `json:"actions"`
		Offers     []contract.PromotionOffer  `json:"offers"`
		Total      *int64                     `json:"total,omitempty"`
		NextCursor *string                    `json:"next_cursor"`
	}{actions, offers, total, next}), nil
}

func promotionPageRead(actionID int64, participating bool, cursor string, read contract.PromotionRead) (contract.PromotionPage, *contract.Fail) {
	page, fail := read.Products(actionID, participating, cursor)
	if fail != nil {
		return contract.PromotionPage{}, fail
	}
	if cursor == "" && int64(len(page.Offers)) == page.Total {
		page.NextCursor = ""
	}
	if page.NextCursor != "" && len(page.Offers) == 0 || cursor == "" && page.NextCursor == "" && int64(len(page.Offers)) != page.Total {
		return contract.PromotionPage{}, promotionReadFailure()
	}
	return page, nil
}

func promotionProductsFor(actionID int64, participating bool, wanted map[int64]bool, read contract.PromotionRead) ([]contract.PromotionOffer, *contract.Fail) {
	out := []contract.PromotionOffer{}
	seen, cursors := map[int64]bool{}, map[string]bool{}
	found := 0
	cursor := ""
	var total int64 = -1
	for i := 0; i < maxPromoPages; i++ {
		page, fail := read.Products(actionID, participating, cursor)
		if fail != nil {
			return nil, fail
		}
		for _, row := range page.Offers {
			if seen[row.ProductID] {
				return nil, promotionReadFailure()
			}
			seen[row.ProductID] = true
			out = append(out, row)
			if wanted[row.ProductID] {
				found++
			}
		}
		// Positive target rows prove membership; absence still needs the complete roster.
		if len(wanted) > 0 && found == len(wanted) {
			return out, nil
		}
		if total >= 0 && total != page.Total {
			return nil, promotionReadFailure()
		}
		total = page.Total
		if int64(len(out)) > total {
			return nil, promotionReadFailure()
		}
		if int64(len(out)) == total {
			return out, nil
		}
		if page.NextCursor == "" || len(page.Offers) == 0 {
			return nil, promotionReadFailure()
		}
		if cursors[page.NextCursor] {
			return nil, promotionReadFailure()
		}
		cursors[page.NextCursor] = true
		cursor = page.NextCursor
	}
	return nil, &contract.Fail{Status: 502, Code: contract.CodeProducts, Message: "活动商品超出完整读取页数上限，请使用活动分页管理"}
}

func promotionDetails(offers []contract.PromotionOffer, read contract.PromotionRead) *contract.Fail {
	ids := []int64{}
	seen := map[int64]bool{}
	for _, row := range offers {
		if !seen[row.ProductID] {
			ids = append(ids, row.ProductID)
			seen[row.ProductID] = true
		}
	}
	details := map[int64]contract.PromotionIdentity{}
	for start := 0; start < len(ids); start += 100 {
		end := start + 100
		if end > len(ids) {
			end = len(ids)
		}
		rows, fail := read.Details(ids[start:end])
		if fail != nil {
			return fail
		}
		for _, row := range rows {
			details[row.ProductID] = row
		}
	}
	for i := range offers {
		row, ok := details[offers[i].ProductID]
		if !ok {
			return promotionReadFailure()
		}
		offers[i].OfferID, offers[i].Name, offers[i].SKU = row.OfferID, row.Name, row.SKU
	}
	return nil
}
