package supplierrepo

import (
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"

	bill "github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

func fail(status int, code, message string) *contract.Failure {
	return contract.Fail(status, code, message)
}

func mapDB(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := contract.AsFailure(err); ok {
		return err
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		msg := pg.Message
		switch {
		case strings.Contains(msg, "DELEGATE_TERMINAL"):
			return fail(409, "conflict", "当前状态不能执行该动作")
		case strings.Contains(msg, "DELEGATE_FORBIDDEN"), strings.Contains(msg, "DELEGATE_NOT_FOUND"):
			return fail(404, "not_found", "派发包不存在")
		}
		switch pg.Code {
		case "55P03":
			f := fail(503, "internal", "资源正在更新，请稍后重试")
			f.RetryAfter = "1"
			return f
		case "P0M01":
			return fail(409, "internal", "媒体对象已进入回收，请重新上传")
		}
	}
	return err
}

func mapMoney(err error, verb string) error {
	if err == nil {
		return nil
	}
	if _, ok := contract.AsFailure(err); ok {
		return err
	}
	var be *bill.Error
	if errors.As(err, &be) {
		if be.Insufficient {
			if verb == "结算" {
				return fail(409, "conflict", "可用余额不足")
			}
			return fail(409, "conflict", "卖家余额不足，暂时无法"+verb)
		}
		msg := be.Msg
		switch {
		case strings.Contains(msg, "refunded reservation"):
			return fail(409, "conflict", "这笔冻结已退回，不能结算")
		case strings.Contains(msg, "settled reservation cannot be refunded"):
			return fail(409, "conflict", "这笔成本已经划出，不能退回")
		}
		return mapDB(err)
	}
	text := err.Error()
	switch {
	case strings.Contains(text, "未标成本"):
		return fail(409, "conflict", "有商品未标成本，无法"+verb)
	case strings.Contains(text, "结算金额超出范围"):
		return fail(409, "conflict", "结算金额超出范围")
	case strings.Contains(text, "结算已结束"):
		return fail(409, "conflict", "结算已结束，不能再接单")
	case strings.Contains(text, "结算没有写入"), strings.Contains(text, "结算状态"):
		return fail(409, "conflict", text)
	case strings.Contains(text, "派发包不存在"):
		return fail(404, "not_found", "派发包不存在")
	case strings.Contains(text, "厂家钱包不可写"):
		return fail(409, "conflict", "厂家钱包不可写")
	}
	return mapDB(err)
}
