package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	adminsvc "github.com/xxww0098/podhub-go/internal/admin/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
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

func (a codeAdmin) CreateQuota(ctx context.Context, caller mcpdomain.Caller, raw json.RawMessage) (json.RawMessage, error) {
	if err := a.gate(ctx, caller); err != nil {
		return nil, err
	}
	spec, fault := admindomain.ParseRedeemBody(raw, a.clock())
	if fault != nil {
		return nil, codeFault(fault)
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
	if !access.IsSuperAdmin(caller.PlatformRole) {
		return &mcpsvc.CodeError{Code: "forbidden", Message: "需要超级管理员权限"}
	}
	return nil
}

func actorOf(caller mcpdomain.Caller) admindomain.Actor {
	return admindomain.Actor{
		UserID: caller.UserID, OrgID: caller.OrgID, PublicID: caller.PublicID,
		Role: caller.PlatformRole, TokenHash: caller.TokenHash,
	}
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
