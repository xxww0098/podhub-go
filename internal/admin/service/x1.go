package service

import (
	"context"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

func (s Service) catalog() (Rows, error) {
	if s.Cat != nil {
		return s.Cat, nil
	}
	return nil, unavailable(nil)
}

func (s Service) clock() time.Time {
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	return now().UTC()
}

func notConfigured() error {
	return &contract.Fail{Kind: contract.KindUnavailable, Code: "STORAGE_NOT_CONFIGURED", Message: "先配置平台货源存储桶"}
}

func storageDown() error {
	return &contract.Fail{Status: httpStatusBadGateway, Code: "STORAGE_UNAVAILABLE", Message: "对象存储暂不可用"}
}

const httpStatusBadGateway = 502

func (s Service) storageAccount(ctx context.Context) (sign.Account, error) {
	if s.Accounts == nil {
		return sign.Account{}, notConfigured()
	}
	account, ok, err := s.Accounts(ctx)
	if err != nil {
		return sign.Account{}, unavailable(err)
	}
	if !ok {
		return sign.Account{}, notConfigured()
	}
	return account, nil
}

func (s Service) Detail(ctx context.Context, actor contract.Actor, sourceID string) (domain.DbDetail, error) {
	cat, err := s.catalog()
	if err != nil {
		return domain.DbDetail{}, err
	}
	return cat.Detail(ctx, actor, sourceID, s.nowMs())
}

func (s Service) CreateRow(ctx context.Context, actor contract.Actor, sourceID string, body []byte) (domain.RowData, error) {
	in, err := domain.DecodeRow(body, false)
	if err != nil {
		return domain.RowData{}, err
	}
	cat, err := s.catalog()
	if err != nil {
		return domain.RowData{}, err
	}
	productID, err := domain.MintID("scp")
	if err != nil {
		return domain.RowData{}, unavailable(err)
	}
	skuID, err := domain.MintID("scs")
	if err != nil {
		return domain.RowData{}, unavailable(err)
	}
	publicID, err := s.publicID()
	if err != nil {
		return domain.RowData{}, unavailable(err)
	}
	row, err := cat.CreateRow(ctx, actor, sourceID, in, productID, skuID, domain.PlatformCode(in.PlatformCode, publicID), s.nowMs())
	return row, fillDisabled(err, msgDbWrites)
}

func (s Service) UpdateRow(ctx context.Context, actor contract.Actor, sourceID, productID string, body []byte) (domain.RowData, error) {
	in, err := domain.DecodeRow(body, true)
	if err != nil {
		return domain.RowData{}, err
	}
	cat, err := s.catalog()
	if err != nil {
		return domain.RowData{}, err
	}
	row, err := cat.UpdateRow(ctx, actor, sourceID, productID, in, s.nowMs())
	return row, fillDisabled(err, msgDbWrites)
}

func (s Service) AdjustPrice(ctx context.Context, actor contract.Actor, sourceID, productID string, body []byte) (domain.RowData, error) {
	in, err := domain.DecodePrice(body)
	if err != nil {
		return domain.RowData{}, err
	}
	cat, err := s.catalog()
	if err != nil {
		return domain.RowData{}, err
	}
	row, err := cat.AdjustPrice(ctx, actor, sourceID, productID, in.Cents, in.Note, s.nowMs())
	return row, fillDisabled(err, msgDbWrites)
}

func (s Service) PublishRow(ctx context.Context, actor contract.Actor, sourceID, productID string, on bool) (domain.RowData, error) {
	cat, err := s.catalog()
	if err != nil {
		return domain.RowData{}, err
	}
	row, err := cat.SetPublished(ctx, actor, sourceID, productID, on, s.nowMs())
	return row, fillDisabled(err, msgDbWrites)
}

func (s Service) LoadOzon(ctx context.Context, actor contract.Actor, sourceID, productID string) (domain.OzonConfig, error) {
	cat, err := s.catalog()
	if err != nil {
		return domain.OzonConfig{}, err
	}
	return cat.LoadOzon(ctx, actor, sourceID, productID, s.nowMs())
}

func (s Service) SaveOzon(ctx context.Context, actor contract.Actor, sourceID, productID string, body []byte) (domain.OzonConfig, error) {
	in, err := domain.DecodeOzon(body)
	if err != nil {
		return domain.OzonConfig{}, err
	}
	cat, err := s.catalog()
	if err != nil {
		return domain.OzonConfig{}, err
	}
	cfg, err := cat.SaveOzon(ctx, actor, sourceID, productID, in, s.nowMs())
	return cfg, fillDisabled(err, msgDbWrites)
}

func (s Service) PromptDiff(ctx context.Context, actor contract.Actor, sourceID, productID string, revision *int32) (domain.PromptDiff, error) {
	cat, err := s.catalog()
	if err != nil {
		return domain.PromptDiff{}, err
	}
	return cat.PromptDiff(ctx, actor, sourceID, productID, revision)
}

func (s Service) PreviewPrompt(body []byte) (domain.Preview, error) {
	in, err := domain.DecodePreview(body)
	if err != nil {
		return domain.Preview{}, err
	}
	return domain.BuildPreview(in.Brief, in.Tags)
}

func (s Service) PublishPrompt(ctx context.Context, actor contract.Actor, sourceID, productID string, body []byte) (domain.PromptPublish, error) {
	revision, err := domain.DecodeRevision(body)
	if err != nil {
		return domain.PromptPublish{}, err
	}
	cat, err := s.catalog()
	if err != nil {
		return domain.PromptPublish{}, err
	}
	out, err := cat.PublishPrompt(ctx, actor, sourceID, productID, revision, s.nowMs())
	return out, fillDisabled(err, msgDbWrites)
}

func (s Service) PatchPrompt(ctx context.Context, actor contract.Actor, productID string, body []byte) (domain.Prompt, error) {
	in, err := domain.DecodePromptPatch(body)
	if err != nil {
		return domain.Prompt{}, err
	}
	cat, err := s.catalog()
	if err != nil {
		return domain.Prompt{}, err
	}
	row, err := cat.PatchPrompt(ctx, actor, productID, in, s.nowMs())
	return row, fillDisabled(err, msgDbWrites)
}

func (s Service) SyncPrompts(ctx context.Context, actor contract.Actor) (domain.SyncReport, error) {
	cat, err := s.catalog()
	if err != nil {
		return domain.SyncReport{}, err
	}
	report, err := cat.SyncPrompts(ctx, actor, s.nowMs())
	return report, fillDisabled(err, msgDbWrites)
}

func wantsStoreChecksum(header string) bool {
	return strings.EqualFold(strings.TrimSpace(header), "sha256")
}
