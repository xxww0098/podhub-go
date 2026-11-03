package service

import (
	"bytes"
	"context"
	"encoding/csv"
	"strings"
	"time"
	"unicode"

	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

type ProductWorkspaceDirectory interface {
	ExportProducts(context.Context, int64, []domain.Row, domain.ProductQuery) ([]domain.ProductExportRow, *contract.APIError)
}

func (s Service) WithProductWorkspace(dir ProductWorkspaceDirectory) Service {
	s.productWorkspace = dir
	return s
}

func (s Service) ExportProductsCSV(ctx context.Context, orgID, userID int64, storeID, status, q string, includeGone bool) ([]byte, *contract.APIError) {
	if s.productWorkspace == nil || s.roster == nil {
		return nil, contract.Internal()
	}
	query, api := domain.NormalizeProductQuery(status, q, "", includeGone, nil)
	if api != nil {
		return nil, api
	}
	actor, api := s.roster.LoadActor(ctx, userID, orgID)
	if api != nil {
		return nil, api
	}
	scope, api := s.visibleScope(ctx, orgID, actor, storeID)
	if api != nil {
		return nil, api
	}
	rows, api := s.productWorkspace.ExportProducts(ctx, orgID, scope, query)
	if api != nil {
		return nil, api
	}
	return productExportCSV(rows)
}

func productExportCSV(rows []domain.ProductExportRow) ([]byte, *contract.APIError) {
	if len(rows) > domain.MaxProductExportRows {
		return nil, contract.ProductExportTooLarge()
	}
	var out bytes.Buffer
	out.WriteString("\uFEFF")
	w := csv.NewWriter(&out)
	w.UseCRLF = true
	_ = w.Write([]string{"商品名称", "货号", "SKU", "店铺", "售价", "币种", "库存", "商品状态", "快照更新时间"})
	for _, row := range rows {
		state := "未知"
		if row.State != nil {
			switch *row.State {
			case "on_sale":
				state = "在售"
			case "processing":
				state = "处理中"
			case "hidden":
				state = "隐藏"
			case "moderation_failed":
				state = "审核失败"
			case "archived":
				state = "已归档"
			}
		}
		if row.Gone {
			state = "已下架"
		}
		stamp := ""
		if row.SnapshotAtMS != nil && *row.SnapshotAtMS > 0 {
			stamp = time.UnixMilli(*row.SnapshotAtMS).UTC().Format(time.RFC3339Nano)
		}
		cells := []string{stringValue(row.Name), row.OfferID, stringValue(row.SKU), row.StoreName,
			stringValue(row.Price), row.Currency, stringValue(row.Stock), state, stamp}
		for i := range cells {
			cells[i] = safeCSVCell(cells[i])
		}
		if err := w.Write(cells); err != nil {
			return nil, contract.Internal()
		}
		w.Flush()
		if w.Error() != nil {
			return nil, contract.Internal()
		}
		if out.Len() > domain.MaxProductExportBytes {
			return nil, contract.ProductExportTooLarge()
		}
	}
	w.Flush()
	if w.Error() != nil {
		return nil, contract.Internal()
	}
	return out.Bytes(), nil
}

func stringValue(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func safeCSVCell(value string) string {
	trimmed := strings.TrimLeftFunc(value, unicode.IsSpace)
	if trimmed != "" && strings.ContainsRune("=+@-", rune(trimmed[0])) {
		return "'" + value
	}
	if len(value) >= 16 && strings.IndexFunc(value, func(r rune) bool { return r < '0' || r > '9' }) == -1 {
		return "'" + value
	}
	return value
}
