package service

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/delegate/domain"
)

func (s Seller) ReadPosting(ctx context.Context, actor Actor, target contract.SyncTarget) (contract.PostingUpdate, error) {
	cred, err := s.DB.PostingCredential(ctx, actor.OrgID, target, s.millis())
	if err != nil {
		return contract.PostingUpdate{}, asAPI(err)
	}
	clientID, apiKey, err := s.open(cred)
	if err != nil {
		return contract.PostingUpdate{}, asAPI(err)
	}
	body, err := domain.GetV3Body(target.PostingNumber)
	if err != nil {
		return contract.PostingUpdate{}, err
	}
	raw, err := s.seller(ctx, clientID, apiKey, "/v3/posting/fbs/get", body, "同步 FBS 委托单")
	if err != nil {
		return contract.PostingUpdate{}, err
	}
	update, err := domain.ParsePostingSnapshot(raw, target.PostingNumber)
	if err != nil {
		return contract.PostingUpdate{}, contract.Upstream(domain.SellerReadMessage("同步 FBS 委托单", "/v3/posting/fbs/get", 0, "decode"))
	}
	return update, nil
}
