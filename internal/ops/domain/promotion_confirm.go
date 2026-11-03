package domain

import (
	"encoding/json"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
)

type promotionTarget struct {
	ID                        int64
	OfferID, Amount, Currency string
	Stock                     *int64
}

type promotionIntent struct {
	ActionID   int64
	ActionType string
	Joining    bool
	Targets    []promotionTarget
}

func promotionIntentOf(m Mutation) (promotionIntent, *contract.Fail) {
	out := promotionIntent{Joining: m.Kind == "promotion_join"}
	if out.Joining {
		if fail := validateJoin(m.Raw); fail != nil {
			return out, fail
		}
		var body joinBody
		_ = json.Unmarshal(m.Raw, &body)
		out.ActionID, out.ActionType = body.ActionID, body.ActionType
		for _, it := range body.Items {
			out.Targets = append(out.Targets, promotionTarget{ID: it.ProductID, OfferID: strings.TrimSpace(it.OfferID), Amount: it.ActionPrice, Currency: it.CurrencyCode, Stock: it.Stock})
		}
	} else {
		if fail := validateLeave(m.Raw); fail != nil {
			return out, fail
		}
		var body leaveBody
		_ = json.Unmarshal(m.Raw, &body)
		out.ActionID, out.ActionType = body.ActionID, body.ActionType
		prices := map[int64]exitPrice{}
		for _, ex := range body.ExitPrices {
			prices[ex.ProductID] = ex
		}
		for _, id := range body.ProductIDs {
			ex := prices[id]
			out.Targets = append(out.Targets, promotionTarget{ID: id, Amount: ex.ExitPrice, Currency: ex.CurrencyCode})
		}
	}
	return out, nil
}

func promotionActionRead(id int64, read contract.PromotionRead) (contract.PromotionAction, *contract.Fail) {
	if read == nil {
		return contract.PromotionAction{}, contract.Internal("")
	}
	actions, fail := read.Actions()
	if fail != nil {
		return contract.PromotionAction{}, fail
	}
	for _, action := range actions {
		if action.ActionID == id {
			return action, nil
		}
	}
	return contract.PromotionAction{}, contract.Validation("该店铺当前没有此活动")
}

func promotionCompare(a, b string) (int, bool) {
	x, xok := new(big.Rat).SetString(a)
	y, yok := new(big.Rat).SetString(b)
	if !xok || !yok {
		return 0, false
	}
	return x.Cmp(y), true
}

// PreflightPromotion checks current Seller facts after the persisted operation begins.
func PreflightPromotion(m Mutation, read contract.PromotionRead, now time.Time) *contract.Fail {
	intent, fail := promotionIntentOf(m)
	if fail != nil {
		return fail
	}
	action, fail := promotionActionRead(intent.ActionID, read)
	if fail != nil {
		return fail
	}
	if action.ActionType != intent.ActionType {
		return contract.Validation("活动类型已变化，请重新读取活动")
	}
	if strings.TrimSpace(action.FreezeDate) != "" {
		return contract.Validation("活动已冻结，不能修改商品或活动价格")
	}
	if action.DateEnd != "" {
		end, err := time.Parse(time.RFC3339, action.DateEnd)
		if err != nil {
			return promotionReadFailure()
		}
		if !now.Before(end) {
			return contract.Validation("活动已结束，请重新读取活动")
		}
	}
	wanted := make(map[int64]bool, len(intent.Targets))
	for _, target := range intent.Targets {
		wanted[target.ID] = true
	}
	active, fail := promotionProductsFor(intent.ActionID, true, wanted, read)
	if fail != nil {
		return fail
	}
	eligible := map[int64]contract.PromotionOffer{}
	for _, row := range active {
		eligible[row.ProductID] = row
		delete(wanted, row.ProductID)
	}
	if intent.Joining && len(wanted) > 0 {
		candidates, fail := promotionProductsFor(intent.ActionID, false, wanted, read)
		if fail != nil {
			return fail
		}
		for _, row := range candidates {
			if wanted[row.ProductID] {
				eligible[row.ProductID] = row
			}
		}
	}
	ids := make([]int64, 0, len(intent.Targets))
	for _, target := range intent.Targets {
		row, ok := eligible[target.ID]
		if !ok {
			return contract.Validation("所选商品已不在当前活动的可操作范围，请刷新活动")
		}
		if row.PriceQuarantined != nil && *row.PriceQuarantined {
			return contract.Validation("所选商品的价格正在隔离审核，未提交修改")
		}
		if target.Amount != "" {
			cmp, valid := promotionCompare(target.Amount, row.MaxActionPrice)
			if !valid || row.CurrencyCode == "" {
				return promotionReadFailure()
			}
			if row.CurrencyCode != target.Currency {
				return contract.Validation("提交币种与当前活动币种不一致，未提交修改")
			}
			if intent.Joining && cmp > 0 {
				return contract.Validation("提交价格超过当前活动上限，未提交修改")
			}
			if !intent.Joining && cmp <= 0 {
				return contract.Validation("退出价必须高于当前活动上限，未提交修改")
			}
		}
		if intent.Joining && intent.ActionType == "PROMOCODE" {
			if row.MinStock == nil {
				return contract.Validation("活动最低库存未知，请重新读取活动")
			}
			if *target.Stock < *row.MinStock {
				return contract.Validation("活动库存低于当前最低要求，未提交修改")
			}
		}
		ids = append(ids, target.ID)
	}
	details, fail := read.Details(ids)
	if fail != nil {
		return fail
	}
	identities := map[int64]contract.PromotionIdentity{}
	for _, row := range details {
		identities[row.ProductID] = row
	}
	priced := []int64{}
	for _, target := range intent.Targets {
		row, ok := identities[target.ID]
		if !ok || target.OfferID != "" && row.OfferID != target.OfferID {
			return contract.Validation("商品货号与当前店铺商品不一致，请重新读取")
		}
		if target.Amount != "" {
			priced = append(priced, target.ID)
		}
	}
	if len(priced) > 0 {
		prices, fail := read.Prices(priced)
		if fail != nil {
			return fail
		}
		byID := map[int64]contract.PromotionPrice{}
		for _, row := range prices {
			byID[row.ProductID] = row
		}
		for _, target := range intent.Targets {
			if target.Amount == "" {
				continue
			}
			price, ok := byID[target.ID]
			if !ok || price.OfferID != identities[target.ID].OfferID {
				return promotionReadFailure()
			}
			if price.CurrencyCode != target.Currency {
				return contract.Validation("活动与商品卡片币种不一致，无法直接确认改价；未提交修改")
			}
		}
	}
	return nil
}

// ConfirmPromotion reads only the items explicitly accepted in the write ACK.
func ConfirmPromotion(m Mutation, receipt json.RawMessage, read contract.PromotionRead) *contract.Fail {
	intent, fail := promotionIntentOf(m)
	if fail != nil {
		return fail
	}
	var view mutationView
	if json.Unmarshal(receipt, &view) != nil || len(view.Items) != len(intent.Targets) {
		return promotionReceiptUnknown()
	}
	accepted := map[string]bool{}
	wanted := map[string]bool{}
	for _, target := range intent.Targets {
		wanted[strconv.FormatInt(target.ID, 10)] = true
	}
	seen := map[string]bool{}
	for _, item := range view.Items {
		if !wanted[item.Identity] || seen[item.Identity] {
			return promotionReceiptUnknown()
		}
		seen[item.Identity] = true
		if item.Succeeded {
			accepted[item.Identity] = true
		}
	}
	targets := intent.Targets[:0]
	for _, target := range intent.Targets {
		if accepted[strconv.FormatInt(target.ID, 10)] {
			targets = append(targets, target)
		}
	}
	intent.Targets = targets
	if len(targets) == 0 {
		return nil
	}
	state, note := observePromotion(intent, read)
	if state != "applied" {
		return &contract.Fail{Status: 409, Code: contract.CodeSellerUnknown, Message: "Ozon 活动写入尚未通过独立只读核对：" + note + "；不要重复提交"}
	}
	return nil
}

func observePromotion(intent promotionIntent, read contract.PromotionRead) (string, string) {
	action, fail := promotionActionRead(intent.ActionID, read)
	if fail != nil {
		return "indeterminate", fail.Message
	}
	if action.ActionType != intent.ActionType {
		return "indeterminate", "当前活动类型与请求不一致"
	}
	var wanted map[int64]bool
	if intent.Joining {
		wanted = make(map[int64]bool, len(intent.Targets))
		for _, target := range intent.Targets {
			wanted[target.ID] = true
		}
	}
	active, fail := promotionProductsFor(intent.ActionID, true, wanted, read)
	if fail != nil {
		return "indeterminate", fail.Message
	}
	members := map[int64]contract.PromotionOffer{}
	for _, row := range active {
		members[row.ProductID] = row
	}
	priced := []int64{}
	for _, target := range intent.Targets {
		if target.Amount != "" {
			priced = append(priced, target.ID)
		}
	}
	prices := map[int64]contract.PromotionPrice{}
	if len(priced) > 0 {
		rows, fail := read.Prices(priced)
		if fail != nil {
			return "indeterminate", fail.Message
		}
		for _, row := range rows {
			prices[row.ProductID] = row
		}
	}
	matches := true
	observations := make([]string, 0, len(intent.Targets))
	for _, target := range intent.Targets {
		member, present := members[target.ID]
		matches = matches && present == intent.Joining
		note := strconv.FormatInt(target.ID, 10) + ":" + strconv.FormatBool(present)
		if target.Amount != "" {
			price, ok := prices[target.ID]
			if !ok || target.OfferID != "" && price.OfferID != target.OfferID {
				return "indeterminate", "商品卡片价格回读缺失或身份不匹配"
			}
			cmp, valid := promotionCompare(price.Price, target.Amount)
			if !valid {
				return "indeterminate", "商品卡片价格回读无效"
			}
			matches = matches && cmp == 0 && price.CurrencyCode == target.Currency
			amount, _ := new(big.Rat).SetString(price.Price)
			note += ":" + amount.RatString() + ":" + price.CurrencyCode
			if intent.Joining && present {
				cmp, valid := promotionCompare(member.ActionPrice, target.Amount)
				matches = matches && valid && cmp == 0 && member.CurrencyCode == target.Currency
				note += ":" + member.ActionPrice + ":" + member.CurrencyCode
			}
		}
		if intent.Joining && intent.ActionType == "PROMOCODE" && present {
			if member.Stock == nil {
				return "indeterminate", "活动库存回读缺失"
			}
			matches = matches && *member.Stock == *target.Stock
			note += ":" + strconv.FormatInt(*member.Stock, 10)
		}
		observations = append(observations, note)
	}
	sort.Strings(observations)
	summary := "活动及商品卡片统一价格核对：" + strings.Join(observations, ",")
	if matches {
		return "applied", summary
	}
	return "contradicted", summary
}
