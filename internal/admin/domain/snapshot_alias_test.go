package domain

import (
	"testing"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
)

func TestParseStoredMatchesCore(t *testing.T) {
	camel := []byte(`{"schemaVersion":1,"aiAccounts":[],"aiDefaultModel":"","storageBuckets":[{"id":"m","label":"","role":"assets","provider":"","endpoint":"","region":"","bucket":"","keyPrefix":"","publicBaseUrl":"https://cdn","forcePathStyle":false,"accessKeyId":"","secretAccessKey":"","sessionToken":"","active":false}]}`)
	snake := []byte(`{"schema_version":1,"ai_default_model":"","ai_accounts":[],"media_accounts":[{"id":"m","label":"","provider":"","endpoint":"","region":"","bucket":"","key_prefix":"","public_base_url":"https://old","force_path_style":false,"access_key_id":"","secret_access_key":"","session_token":"","active":false}]}`)
	cases := []struct {
		name    string
		raw     []byte
		legacy  bool
		base    string
		wantErr string
	}{
		{name: "camel", raw: camel, base: "https://cdn"},
		{name: "snake", raw: snake, legacy: true, base: "https://old"},
		{name: "empty", raw: []byte(``), wantErr: "已加密的连接配置快照无法解析"},
		{name: "version", raw: []byte(`{"schemaVersion":2}`), wantErr: "已存储的连接配置 schema 版本不受支持"},
		{name: "trailing", raw: []byte(`{"schemaVersion":1}{}`), wantErr: "已加密的连接配置快照无法解析"},
		{name: "unknown", raw: []byte(`{"schemaVersion":1,"extra":true}`), wantErr: "已加密的连接配置快照无法解析"},
		{name: "snake version", raw: []byte(`{"schema_version":2}`), wantErr: "已存储的连接配置 schema 版本不受支持"},
	}
	for _, c := range cases {
		got, legacy, err := ParseStored(c.raw)
		core, coreLegacy, coreErr := corecontract.ParseStored(c.raw)
		if (err == nil) != (coreErr == nil) || legacy != coreLegacy || (err != nil && err.Error() != coreErr.Error()) {
			t.Fatalf("%s: domain %v %v core %v %v", c.name, legacy, err, coreLegacy, coreErr)
		}
		if c.wantErr != "" {
			if err == nil || err.Error() != c.wantErr {
				t.Fatalf("%s: %v", c.name, err)
			}
			continue
		}
		if err != nil || legacy != c.legacy || len(got.Buckets) != 1 || got.Buckets[0].PublicBase != c.base || core.Buckets[0].PublicBase != c.base {
			t.Fatalf("%s: legacy %v err %v base %+v", c.name, legacy, err, got.Buckets)
		}
	}
}
