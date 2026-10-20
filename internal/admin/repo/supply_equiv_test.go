package adminrepo

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
)

func TestMapDBMatchesLegacy(t *testing.T) {
	own := &contract.Fail{Kind: contract.KindValidation, Message: "请求格式无效"}
	errs := []error{
		nil,
		own,
		fmt.Errorf("wrap: %w", own),
		&pgconn.PgError{Code: "55P03"},
		fmt.Errorf("wrap: %w", &pgconn.PgError{Code: "P0M01"}),
		&pgconn.PgError{Code: "23505", ConstraintName: "ux_sc_sources_name"},
		errors.New("boom"),
	}
	for _, err := range errs {
		got, want := mapDB(err), legacyMapDB(err)
		if (got == nil) != (want == nil) {
			t.Fatalf("%v: got %v want %v", err, got, want)
		}
		gf, gok := contract.AsFail(got)
		wf, wok := contract.AsFail(want)
		if gok != wok || (gok && (gf.Kind != wf.Kind || gf.Message != wf.Message || gf.Status != wf.Status || gf.RetryAfter != wf.RetryAfter)) {
			t.Fatalf("%v: got %+v want %+v", err, gf, wf)
		}
		if gok && want == own && got != own {
			t.Fatal("passed-through fail is a different pointer")
		}
		if constraint(err) != legacyConstraint(err) || isFK(err) != legacyIsFK(err) {
			t.Fatalf("constraint %v", err)
		}
	}
	if notFound("记录不存在或已删除").Error() != "记录不存在或已删除" || conflict("同名属性已存在").Kind != contract.KindConflict {
		t.Fatal("messages")
	}
	if internal().Message != "服务暂不可用" || forbidden("no").Kind != contract.KindForbidden {
		t.Fatal("internal")
	}
	if corerepo.MissingRow != "记录不存在或已删除" {
		t.Fatal("missing row")
	}
	sum := sha256.Sum256([]byte("secret"))
	if !bytes.Equal(aesKey("secret"), sum[:]) {
		t.Fatal("aes key")
	}
	nonce, cipher, err := seal(aesKey("secret"), []byte(`{"schemaVersion":1}`))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := open(aesKey("secret"), nonce, cipher)
	if err != nil || string(plain) != `{"schemaVersion":1}` {
		t.Fatalf("open %q %v", plain, err)
	}
	if err := corerepo.WithRead(nil, nil, nil, 1, nil); err == nil || err.Error() != "服务暂不可用" {
		t.Fatalf("nil read %v", err)
	}
	if err := corerepo.WithWrite(nil, nil, nil, 1, nil); err == nil || err.Error() != "服务暂不可用" {
		t.Fatalf("nil write %v", err)
	}
	if err := corerepo.WithTx(nil, nil, nil, 1, nil); err == nil || err.Error() != "服务暂不可用" {
		t.Fatalf("nil tx %v", err)
	}
}

func legacyMapDB(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := contract.AsFail(err); ok {
		return err
	}
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		switch pe.Code {
		case "55P03":
			return &contract.Fail{Kind: contract.KindInternal, Status: 503, RetryAfter: 1, Message: "资源正在更新，请稍后重试"}
		case "P0M01":
			return &contract.Fail{Kind: contract.KindInternal, Status: 409, Message: "媒体对象已进入回收，请重新上传"}
		}
	}
	return &contract.Fail{Kind: contract.KindInternal, Message: "服务暂不可用"}
}

func legacyConstraint(err error) string {
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23505" {
		return pe.ConstraintName
	}
	return ""
}

func legacyIsFK(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23503"
}
