package service

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

const (
	integrationPlaceholder = "set-a-random-32-plus-character-server-secret"
	configAAD              = "platform_integration_config|v1"
)

// AIIn is one AI account from the replace body, after JSON defaults.
type AIIn struct {
	ID             string
	Label          string
	BaseURL        string
	APIFormat      string
	Model          string
	APIKey         string
	Active         bool
	Thinking       string
	ThinkingFormat string
	Priority       int64
}

// ConfigIn is the replace body the HTTP layer already decoded.
type ConfigIn struct {
	AIDefault *string
	Expected  int64
	AI        []AIIn
	Buckets   []domain.BucketIn
}

func (a *API) defaultModel(ctx context.Context) (string, *contract.Fault) {
	snap, fault := a.readSnapshot(ctx, true)
	if fault != nil {
		return "", fault
	}
	if snap == nil {
		return "", nil
	}
	return resolvedDefault(*snap), nil
}

func (a *API) readSnapshot(ctx context.Context, relay bool) (*domain.Snapshot, *contract.Fault) {
	blob, fault := a.DB.LoadConfig(ctx)
	if fault != nil {
		if relay {
			return nil, contract.Unavailable("RELAY_UNAVAILABLE", "AI 服务配置暂不可用")
		}
		return nil, fault
	}
	if !blob.Found {
		return nil, nil
	}
	snap, legacy, msg := a.decrypt(blob)
	if msg != "" {
		if relay {
			return nil, contract.Unavailable("RELAY_UNAVAILABLE", "AI 服务配置暂不可用")
		}
		return nil, contract.Internal(msg)
	}
	if legacy {
		if fault := a.rewriteCamel(ctx, blob, snap); fault != nil {
			return nil, fault
		}
	}
	return snap, nil
}

func (a *API) decrypt(blob domain.ConfigBlob) (*domain.Snapshot, bool, string) {
	key, fault := a.integrationKey()
	if fault != nil {
		return nil, false, fault.Message
	}
	if len(blob.Nonce) != 12 {
		return nil, false, "连接配置密文 nonce 长度无效"
	}
	plain, err := domain.Open(key, []byte(configAAD), blob.Nonce, blob.Ciphertext)
	if err != nil {
		plain, err = domain.Open(key, nil, blob.Nonce, blob.Ciphertext)
		if err != nil {
			return nil, false, "连接配置快照解密失败"
		}
	}
	snap, legacy, err := domain.ParseStored(plain)
	if err != nil {
		return nil, false, err.Error()
	}
	return &snap, legacy, ""
}

// rewriteCamel seals the same snapshot with camelCase names and replaces
// the ciphertext. Revision, actor, and updated_at stay put: this is not a
// second document and not a config replace.
func (a *API) rewriteCamel(ctx context.Context, blob domain.ConfigBlob, snap *domain.Snapshot) *contract.Fault {
	raw, err := json.Marshal(snap)
	if err != nil {
		return contract.Internal("连接配置快照无法序列化")
	}
	key, fault := a.integrationKey()
	if fault != nil {
		return fault
	}
	nonce, cipher, err := domain.Seal(key, []byte(configAAD), raw)
	if err != nil {
		return contract.Internal("连接配置快照加密失败")
	}
	return a.DB.RewriteSnapshot(ctx, blob.Revision, nonce, cipher)
}

func (a *API) integrationKey() ([]byte, *contract.Fault) {
	raw := strings.TrimSpace(a.IntegrationKey)
	if len(raw) < 32 {
		return nil, contract.Unavailable("UNAVAILABLE", "平台连接配置密钥未设置")
	}
	if raw == integrationPlaceholder {
		return nil, contract.Unavailable("UNAVAILABLE", "平台连接配置密钥不能使用 .env.example 中的占位值")
	}
	return domain.KeySHA256(raw), nil
}

// ReplaceConfig validates, seals, and CAS-writes the platform snapshot.
func (a *API) ReplaceConfig(ctx context.Context, actor domain.Actor, in ConfigIn) (any, *contract.Fault) {
	if _, fault := a.integrationKey(); fault != nil {
		return nil, fault
	}
	old, fault := a.readSnapshot(ctx, false)
	if fault != nil {
		return nil, fault
	}
	snap, view, fault := normalizeConfig(old, in, a.Loopback)
	if fault != nil {
		return nil, fault
	}
	if in.Expected == math.MaxInt64 {
		return nil, contract.Conflict("连接配置已被其他管理员更新，请刷新后重试")
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		return nil, contract.Internal("连接配置快照无法序列化")
	}
	key, _ := a.integrationKey()
	nonce, cipher, err := domain.Seal(key, []byte(configAAD), raw)
	if err != nil {
		return nil, contract.Internal("连接配置快照加密失败")
	}
	next := in.Expected + 1
	if fault := a.DB.SaveConfig(ctx, actor, in.Expected, next, nonce, cipher, len(snap.AIAccounts), bucketRoles(snap.Buckets)); fault != nil {
		return nil, fault
	}
	view.Revision = next
	return struct {
		Data configView `json:"data"`
	}{view}, nil
}

type configView struct {
	AIDefault string      `json:"aiDefaultModel"`
	Schema    int         `json:"schemaVersion"`
	Revision  int64       `json:"revision"`
	CacheTTL  int         `json:"cacheTtlSeconds"`
	AI        []aiView    `json:"aiAccounts"`
	Buckets   []mediaView `json:"storageBuckets"`
}

type aiView struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	BaseURL        string `json:"baseUrl"`
	APIFormat      string `json:"apiFormat"`
	Model          string `json:"model"`
	Active         bool   `json:"active"`
	Thinking       string `json:"thinking"`
	ThinkingFormat string `json:"thinkingFormat"`
	Priority       int64  `json:"priority"`
}

type mediaView struct {
	ID         string `json:"id"`
	Role       string `json:"role"`
	Label      string `json:"label"`
	Provider   string `json:"provider"`
	Endpoint   string `json:"endpoint"`
	Region     string `json:"region"`
	Bucket     string `json:"bucket"`
	KeyPrefix  string `json:"keyPrefix"`
	PublicBase string `json:"publicBaseUrl"`
	ForcePath  bool   `json:"forcePathStyle"`
	Active     bool   `json:"active"`
}

func normalizeConfig(old *domain.Snapshot, in ConfigIn, loopback bool) (domain.Snapshot, configView, *contract.Fault) {
	if in.Expected < 0 {
		return domain.Snapshot{}, configView{}, contract.Validation("配置 revision 无效")
	}
	if len(in.AI) > 64 {
		return domain.Snapshot{}, configView{}, contract.Validation("AI 最多配置 64 个账号")
	}
	ais, fault := mergeAI(old, in.AI, loopback)
	if fault != nil {
		return domain.Snapshot{}, configView{}, fault
	}
	buckets, fault := mergeBuckets(old, in.Buckets)
	if fault != nil {
		return domain.Snapshot{}, configView{}, fault
	}
	def, msg := defaultModel(old, in.AIDefault, ais)
	if msg != "" {
		return domain.Snapshot{}, configView{}, contract.Validation(msg)
	}
	snap := domain.Snapshot{
		SchemaVersion: 1, AIDefaultModel: def, AIAccounts: ais, Buckets: buckets,
	}
	if old != nil {
		snap.Payment = old.Payment
	}
	return snap, viewOf(snap, in.Expected+1), nil
}

// mergeBuckets validates the whole three-bucket roster. Secrets may be left
// empty only when the same account id already exists and the endpoint did not
// change, which is the same rule the AI accounts use.
func mergeBuckets(old *domain.Snapshot, rows []domain.BucketIn) ([]domain.StoredBucket, *contract.Fault) {
	prev := map[string]domain.StoredBucket{}
	if old != nil {
		for _, row := range old.Buckets {
			prev[row.ID] = row
		}
	}
	out := make([]domain.StoredBucket, 0, len(rows))
	seen := map[string]bool{}
	for _, row := range rows {
		id := strings.TrimSpace(row.ID)
		if seen[id] {
			return nil, contract.Validation("存储账号标识重复")
		}
		seen[id] = true
		if !domain.AIID(id) {
			return nil, contract.Validation("存储账号标识无效")
		}
		label := strings.TrimSpace(row.Label)
		if label == "" || utf8.RuneCountInString(label) > 80 {
			return nil, contract.Validation("存储账号名称无效")
		}
		access := strings.TrimSpace(row.AccessKey)
		secret := strings.TrimSpace(row.SecretKey)
		session := row.Session
		if access == "" && secret == "" {
			existing, ok := prev[id]
			if !ok {
				return nil, contract.Validation("首次配置必须填写 Access Key / Secret Key")
			}
			if strings.TrimRight(existing.Endpoint, "/") != strings.TrimRight(strings.TrimSpace(row.Endpoint), "/") {
				return nil, contract.Validation("更改存储端点时必须重新填写 Access Key / Secret Key")
			}
			access, secret, session = existing.AccessKey, existing.SecretKey, existing.SessionToken
		} else if access == "" || secret == "" {
			return nil, contract.Validation("S3 必须同时提供 access_key_id 与 secret_access_key")
		}
		out = append(out, domain.StoredBucket{
			ID: id, Label: label, Role: strings.TrimSpace(row.Role), Provider: strings.TrimSpace(row.Provider),
			Endpoint: strings.TrimSpace(row.Endpoint), Region: strings.TrimSpace(row.Region),
			Bucket: strings.TrimSpace(row.Bucket), KeyPrefix: row.KeyPrefix,
			PublicBase: strings.TrimSpace(row.PublicBase), ForcePath: row.ForcePath,
			AccessKey: access, SecretKey: secret, SessionToken: session, Active: row.Active,
		})
	}
	inputs := make([]domain.BucketIn, 0, len(out))
	for _, row := range out {
		inputs = append(inputs, domain.BucketIn{
			ID: row.ID, Label: row.Label, Role: row.Role, Provider: row.Provider,
			Endpoint: row.Endpoint, Region: row.Region, Bucket: row.Bucket, KeyPrefix: row.KeyPrefix,
			PublicBase: row.PublicBase, ForcePath: row.ForcePath, AccessKey: row.AccessKey,
			SecretKey: row.SecretKey, Session: row.SessionToken, Active: row.Active,
		})
	}
	if _, msg := domain.Buckets(inputs); msg != "" {
		return nil, contract.Validation(msg)
	}
	return out, nil
}

func mergeAI(old *domain.Snapshot, rows []AIIn, loopback bool) ([]domain.StoredAI, *contract.Fault) {
	seen := map[string]bool{}
	var out []domain.StoredAI
	for _, row := range rows {
		id := strings.TrimSpace(row.ID)
		if seen[id] {
			return nil, contract.Validation("AI 账号标识重复")
		}
		seen[id] = true
		if !domain.AIID(id) {
			return nil, contract.Validation("AI 账号标识无效")
		}
		label := strings.TrimSpace(row.Label)
		if label == "" || utf8.RuneCountInString(label) > 80 {
			return nil, contract.Validation("AI 账号名称无效")
		}
		base, ok := domain.ConfiguredURL(row.BaseURL, loopback)
		if !ok {
			return nil, contract.Validation("AI 端点必须是 https URL（本机测试允许 loopback http）")
		}
		format := strings.TrimSpace(row.APIFormat)
		if format == "" {
			format = "chat_completions"
		}
		model := strings.TrimSpace(row.Model)
		key := strings.TrimSpace(row.APIKey)
		var prev *domain.StoredAI
		if old != nil {
			for i := range old.AIAccounts {
				if strings.TrimSpace(old.AIAccounts[i].ID) == id {
					prev = &old.AIAccounts[i]
					break
				}
			}
		}
		if key == "" {
			if prev == nil {
				return nil, contract.Validation("首次配置必须填写 API Key")
			}
			if strings.TrimRight(prev.BaseURL, "/") != base || prev.APIFormat != format {
				return nil, contract.Validation("更改 AI 端点或 API 格式时必须重新填写 API Key")
			}
			key = prev.APIKey
		}
		if model == "" || len(model) > 128 || key == "" || len(key) > 512 {
			return nil, contract.Validation("AI 模型或 API Key 不合法")
		}
		thinking := row.Thinking
		if thinking == "" {
			thinking = "provider_default"
		}
		formatThinking := row.ThinkingFormat
		if formatThinking == "" {
			formatThinking = "none"
		}
		if msg := domain.ThinkingOK(format, thinking, formatThinking); msg != "" {
			return nil, contract.Validation(msg)
		}
		out = append(out, domain.StoredAI{
			ID: id, Label: label, BaseURL: base, APIFormat: format, Model: model, APIKey: key,
			Active: row.Active, Thinking: thinking, ThinkingFormat: formatThinking, Priority: row.Priority,
		})
	}
	if out == nil {
		out = []domain.StoredAI{}
	}
	return out, nil
}

func defaultModel(old *domain.Snapshot, requested *string, ais []domain.StoredAI) (string, string) {
	var model string
	if requested == nil {
		if old != nil {
			model = resolvedDefault(*old)
		}
	} else {
		model = strings.TrimSpace(*requested)
	}
	if model == "" {
		model = deriveDefault(ais)
	}
	if len(model) > 128 {
		return "", "AI 默认模型不能超过 128 字节"
	}
	if model != "" && hasActive(ais) && !chatHas(ais, model) {
		return "", "AI 默认模型必须由启用的 Chat Completions 账号提供；停用该账号前请先更换默认模型"
	}
	return model, ""
}

func resolvedDefault(snap domain.Snapshot) string {
	if strings.TrimSpace(snap.AIDefaultModel) != "" {
		return strings.TrimSpace(snap.AIDefaultModel)
	}
	return deriveDefault(snap.AIAccounts)
}

func deriveDefault(ais []domain.StoredAI) string {
	var best *domain.StoredAI
	for i := range ais {
		row := &ais[i]
		if !row.Active || row.APIFormat != "chat_completions" {
			continue
		}
		if best == nil || row.Priority > best.Priority {
			best = row
		}
	}
	if best == nil {
		return ""
	}
	return best.Model
}

func hasActive(ais []domain.StoredAI) bool {
	for _, row := range ais {
		if row.Active {
			return true
		}
	}
	return false
}

func chatHas(ais []domain.StoredAI, model string) bool {
	for _, row := range ais {
		if row.Active && row.APIFormat == "chat_completions" && row.Model == model {
			return true
		}
	}
	return false
}

func bucketRoles(rows []domain.StoredBucket) []string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Role)
	}
	return out
}

func viewOf(snap domain.Snapshot, revision int64) configView {
	ai := make([]aiView, 0, len(snap.AIAccounts))
	for _, row := range snap.AIAccounts {
		ai = append(ai, aiView{row.ID, row.Label, row.BaseURL, row.APIFormat, row.Model, row.Active, row.Thinking, row.ThinkingFormat, row.Priority})
	}
	buckets := make([]mediaView, 0, len(snap.Buckets))
	for _, row := range snap.Buckets {
		buckets = append(buckets, mediaViewOf(row))
	}
	return configView{
		AIDefault: snap.AIDefaultModel, Schema: 1, Revision: revision, CacheTTL: 300,
		AI: ai, Buckets: buckets,
	}
}

func mediaViewOf(row domain.StoredBucket) mediaView {
	return mediaView{
		ID: row.ID, Role: row.Role, Label: row.Label, Provider: row.Provider, Endpoint: row.Endpoint,
		Region: row.Region, Bucket: row.Bucket, KeyPrefix: row.KeyPrefix, PublicBase: row.PublicBase,
		ForcePath: row.ForcePath, Active: row.Active,
	}
}
