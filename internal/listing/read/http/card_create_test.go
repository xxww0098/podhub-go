package readhttp

import (
	"encoding/json"
	"testing"
)

func TestValidateCreateOrder(t *testing.T) {
	pack := "pack"
	source := "source"
	product := "sku"
	blank := CreateCard{CreateMode: "blank"}
	if _, ok := ValidateCreate(blank); !ok {
		t.Fatal("blank")
	}
	if msg, ok := ValidateCreate(CreateCard{CreateMode: "fromPack"}); ok || msg.Message != "不再支持字段包导入" {
		t.Fatal(msg)
	}
	if msg, ok := ValidateCreate(CreateCard{CreateMode: "blank", FieldPackID: &pack}); ok || msg.Message != "此创建方式不接受 fieldPackId" {
		t.Fatal(msg)
	}
	if msg, ok := ValidateCreate(CreateCard{CreateMode: "blank", SupplierProductID: &product}); ok || msg.Message != "supplierProductId 仅用于 fromSupplier" {
		t.Fatal(msg)
	}
	if msg, ok := ValidateCreate(CreateCard{CreateMode: "blank", Payload: json.RawMessage(`{"supplierProductId":"x"}`)}); ok || msg.Message != "请从平台货源选择规格创建方案" {
		t.Fatal(msg)
	}
	if msg, ok := ValidateCreate(CreateCard{CreateMode: "copyCard"}); ok || msg.Message != "copyCard 需要 sourceCardId" {
		t.Fatal(msg)
	}
	if _, ok := ValidateCreate(CreateCard{CreateMode: "copyCard", SourceCardID: &source}); !ok {
		t.Fatal("copy proceeds to the source read")
	}
	if msg, ok := ValidateCreate(CreateCard{CreateMode: "fromSupplier", Payload: json.RawMessage(`{}`)}); ok || msg.Message != "fromSupplier 不接受 payload 或 sourceCardId" {
		t.Fatal(msg)
	}
	if msg, ok := ValidateCreate(CreateCard{CreateMode: "fromSupplier"}); ok || msg.Message != "fromSupplier 需要 supplierProductId" {
		t.Fatal(msg)
	}
	if _, ok := ValidateCreate(CreateCard{CreateMode: "fromSupplier", SupplierProductID: &product}); !ok {
		t.Fatal("supplier proceeds to the product read")
	}
}

func TestCreateKeyPair(t *testing.T) {
	if err := CreateKeyPair(nil, nil); err != nil {
		t.Fatal(err)
	}
	key := "abc"
	if err := CreateKeyPair(&key, nil); err == nil || err.Error() != "createKey 与 requestFingerprint 必须同时提交" {
		t.Fatal(err)
	}
	bad := "has space"
	finger := "ok"
	if err := CreateKeyPair(&bad, &finger); err == nil {
		t.Fatal("charset")
	}
	if err := CreateKeyPair(&key, &finger); err != nil {
		t.Fatal(err)
	}
}
