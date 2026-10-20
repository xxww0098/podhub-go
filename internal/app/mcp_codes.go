package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	adminsvc "github.com/xxww0098/podhub-go/internal/admin/service"
	mcpdomain "github.com/xxww0098/podhub-go/internal/mcp/domain"
	mcpsvc "github.com/xxww0098/podhub-go/internal/mcp/service"
)

// codeAdmin is the MCP issuer over the admin billing port. It does not
// generate codes itself and it does not log the response.
type codeAdmin struct {
	billing adminsvc.BillingAPI
	now     func() time.Time
}

func (a codeAdmin) clock() time.Time {
	if a.now != nil {
		return a.now()
	}
	return time.Now()
}

func (a codeAdmin) CreateActivation(ctx context.Context, caller mcpdomain.Caller, raw json.RawMessage) (json.RawMessage, error) {
	return a.create(ctx, caller, raw, "member_seats", "激活码工具只生成成员名额兑换码")
}

func (a codeAdmin) CreateQuota(ctx context.Context, caller mcpdomain.Caller, raw json.RawMessage) (json.RawMessage, error) {
	return a.create(ctx, caller, raw, "wallet_credits", "额度卡工具只生成钱包额度兑换码")
}

func (a codeAdmin) create(ctx context.Context, caller mcpdomain.Caller, raw json.RawMessage, product, mismatch string) (json.RawMessage, error) {
	if err := a.gate(ctx, caller); err != nil {
		return nil, err
	}
	body, err := withProduct(raw, product)
	if err != nil {
		return nil, err
	}
	spec, fault := admindomain.ParseRedeemBody(body, a.clock())
	if fault != nil {
		return nil, codeFault(fault)
	}
	if spec.Product != product {
		return nil, &mcpsvc.CodeError{Code: "invalid_arguments", Message: mismatch}
	}
	out, err := a.billing.CreateRedeem(ctx, actorOf(caller), spec)
	if err != nil {
		return nil, codeErr(err)
	}
	return out, nil
}

func (a codeAdmin) ListCodes(ctx context.Context, caller mcpdomain.Caller, raw json.RawMessage) (json.RawMessage, error) {
	if err := a.gate(ctx, caller); err != nil {
		return nil, err
	}
	if err := emptyObject(raw); err != nil {
		return nil, err
	}
	out, err := a.billing.ListRedeem(ctx, actorOf(caller))
	if err != nil {
		return nil, codeErr(err)
	}
	return out, nil
}

func (a codeAdmin) gate(ctx context.Context, caller mcpdomain.Caller) error {
	if a.billing == nil {
		return &mcpsvc.CodeError{Code: "internal", Message: "服务暂不可用"}
	}
	if !admindomain.SuperAdmin(caller.PlatformRole) {
		return &mcpsvc.CodeError{Code: "forbidden", Message: "需要超级管理员权限"}
	}
	standing, err := a.billing.Standing(ctx, caller.UserID, caller.TokenHash)
	if err != nil {
		return codeErr(err)
	}
	if standing.Missing {
		return &mcpsvc.CodeError{Code: "internal", Message: "服务暂不可用"}
	}
	if !standing.Enrolled {
		return &mcpsvc.CodeError{Code: "forbidden", Message: "请先绑定验证器"}
	}
	if !standing.Elevated {
		return &mcpsvc.CodeError{Code: "forbidden", Message: "管理操作需要重新验证"}
	}
	return nil
}

func actorOf(caller mcpdomain.Caller) admindomain.Actor {
	return admindomain.Actor{
		UserID: caller.UserID, OrgID: caller.OrgID, PublicID: caller.PublicID,
		Role: caller.PlatformRole, TokenHash: caller.TokenHash,
	}
}

func withProduct(raw json.RawMessage, product string) ([]byte, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = []byte(`{}`)
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return nil, &mcpsvc.CodeError{Code: "invalid_arguments", Message: "请求格式无效"}
	}
	if _, ok := obj["product"]; ok {
		return raw, nil
	}
	encoded, err := json.Marshal(product)
	if err != nil {
		return nil, &mcpsvc.CodeError{Code: "internal", Message: "服务暂不可用"}
	}
	obj["product"] = encoded
	body, err := json.Marshal(obj)
	if err != nil {
		return nil, &mcpsvc.CodeError{Code: "internal", Message: "服务暂不可用"}
	}
	return body, nil
}

func emptyObject(raw json.RawMessage) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var obj struct{}
	if err := dec.Decode(&obj); err != nil {
		return &mcpsvc.CodeError{Code: "invalid_arguments", Message: "请求格式无效"}
	}
	return nil
}

func codeErr(err error) error {
	if err == nil {
		return nil
	}
	var coded *mcpsvc.CodeError
	if errors.As(err, &coded) {
		return err
	}
	var fault *admindomain.Fault
	if errors.As(err, &fault) {
		return codeFault(fault)
	}
	return &mcpsvc.CodeError{Code: "internal", Message: "服务暂不可用"}
}

func codeFault(fault *admindomain.Fault) error {
	if fault == nil {
		return &mcpsvc.CodeError{Code: "internal", Message: "服务暂不可用"}
	}
	code := "internal"
	message := fault.Message
	switch fault.Kind {
	case "validation":
		code = "invalid_arguments"
	case "forbidden":
		code = "forbidden"
	case "writes_disabled":
		code = "writes_disabled"
	case "conflict":
		code = "conflict"
	case "not_found":
		code = "not_found"
	default:
		message = "服务暂不可用"
	}
	if message == "" {
		message = "服务暂不可用"
	}
	return &mcpsvc.CodeError{Code: code, Message: message}
}
