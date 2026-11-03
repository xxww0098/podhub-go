package app

import (
	"context"
	"encoding/json"

	"github.com/xxww0098/podhub-go/internal/ops/contract"
	opsdomain "github.com/xxww0098/podhub-go/internal/ops/domain"
	ozon "github.com/xxww0098/podhub-go/internal/seller/ozon/contract"
)

type opsPromotionRead struct {
	port   sellerPort
	ctx    context.Context
	secret contract.Secret
}

func (p sellerPort) promotionRead(ctx context.Context, secret contract.Secret) contract.PromotionRead {
	return opsPromotionRead{port: p, ctx: ctx, secret: secret}
}

func (p opsPromotionRead) call(method, path string, body any) ([]byte, *contract.Fail) {
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	status, response, err := p.port.Call(p.ctx, contract.LaneInteractiveRead, method, path, raw, p.secret)
	if err != nil {
		return nil, opsdomain.Egress(err, contract.CodeProducts)
	}
	if status != 200 {
		return nil, opsdomain.SellerHTTP(status, response, "读取 Ozon 活动", path, contract.CodeProducts)
	}
	return []byte(response), nil
}

func promotionReadInvalid() *contract.Fail {
	return &contract.Fail{Status: 502, Code: contract.CodeProducts, Message: "Ozon 活动或商品资料不完整，请重新读取"}
}

func (p opsPromotionRead) Actions() ([]contract.PromotionAction, *contract.Fail) {
	raw, fail := p.call("GET", ozon.PromotionActionsPath, nil)
	if fail != nil {
		return nil, fail
	}
	rows, err := ozon.ParsePromotionActions(raw)
	if err != nil {
		return nil, promotionReadInvalid()
	}
	out := make([]contract.PromotionAction, 0, len(rows))
	for _, row := range rows {
		out = append(out, contract.PromotionAction{ActionID: row.ID, Title: row.Title, ActionType: row.Type, DateStart: row.DateStart, DateEnd: row.DateEnd, FreezeDate: row.FreezeDate, IsParticipating: row.Participating, PotentialProductsTotal: row.PotentialProducts, ParticipatingProductsTotal: row.ParticipatingProducts})
	}
	return out, nil
}

func (p opsPromotionRead) Products(actionID int64, participating bool, cursor string) (contract.PromotionPage, *contract.Fail) {
	path := ozon.PromotionCandidatesPath
	if participating {
		path = ozon.PromotionProductsPath
	}
	raw, fail := p.call("POST", path, map[string]any{"action_id": actionID, "limit": 100, "last_id": cursor})
	if fail != nil {
		return contract.PromotionPage{}, fail
	}
	page, err := ozon.ParsePromotionProducts(raw)
	if err != nil {
		return contract.PromotionPage{}, promotionReadInvalid()
	}
	out := contract.PromotionPage{Offers: make([]contract.PromotionOffer, 0, len(page.Products)), Total: page.Total, NextCursor: page.LastID}
	for _, row := range page.Products {
		offer := contract.PromotionOffer{ActionID: actionID, ProductID: row.ID, Participating: participating, Price: row.Price.Amount, PriceCurrencyCode: row.Price.Currency, ActionPrice: row.ActionPrice.Amount, MaxActionPrice: row.MaxActionPrice.Amount, CurrencyCode: row.ActionPrice.Currency, AddMode: row.AddMode, Stock: row.Stock, MinStock: row.MinStock, CurrentBoost: row.CurrentBoost, MinBoost: row.MinBoost, MaxBoost: row.MaxBoost, PriceQuarantined: row.PriceQuarantined}
		if row.PriceMinElastic != nil {
			offer.PriceMinElastic = row.PriceMinElastic.Amount
		}
		if row.PriceMaxElastic != nil {
			offer.PriceMaxElastic = row.PriceMaxElastic.Amount
		}
		out.Offers = append(out.Offers, offer)
	}
	return out, nil
}

func (p opsPromotionRead) Details(ids []int64) ([]contract.PromotionIdentity, *contract.Fail) {
	raw, fail := p.call("POST", "/v3/product/info/list", map[string]any{"product_id": ids})
	if fail != nil {
		return nil, fail
	}
	rows, err := ozon.ParsePromotionDetails(raw, ids)
	if err != nil {
		return nil, promotionReadInvalid()
	}
	out := make([]contract.PromotionIdentity, 0, len(rows))
	for _, row := range rows {
		out = append(out, contract.PromotionIdentity{ProductID: row.ProductID, OfferID: row.OfferID, Name: row.Name, SKU: row.SKU})
	}
	return out, nil
}

func (p opsPromotionRead) Prices(ids []int64) ([]contract.PromotionPrice, *contract.Fail) {
	raw, fail := p.call("POST", "/v5/product/info/prices", map[string]any{"filter": map[string]any{"product_id": ids, "visibility": "ALL"}, "limit": 1000})
	if fail != nil {
		return nil, fail
	}
	rows, err := ozon.ParsePromotionPrices(raw, ids)
	if err != nil {
		return nil, promotionReadInvalid()
	}
	out := make([]contract.PromotionPrice, 0, len(rows))
	for _, row := range rows {
		out = append(out, contract.PromotionPrice{ProductID: row.ProductID, OfferID: row.OfferID, Price: row.Price, CurrencyCode: row.CurrencyCode})
	}
	return out, nil
}
