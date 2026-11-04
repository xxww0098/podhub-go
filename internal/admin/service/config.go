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
	Purpose        string
}

// ConfigIn is the replace body the HTTP layer already decoded. Runtime nil
// retains the stored AI runtime settings.
type ConfigIn struct {
	AIDefault *string
	Expected  int64
	AI        []AIIn
	Runtime   *domain.AIRuntime
	Storage   *[]StorageIn
}

// Bounds of the AI runtime settings; zero turns a ceiling off.
const (
	maxRuntimeCeiling = 100000
	maxLeaseSeconds   = 3600
)

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

// rewriteCamel drops retired storage settings while normalizing field names.
// Revision, actor, and updated_at stay put: this is not a config replace.
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

// GetConfig returns the same credential-free view used by configuration writes.
func (a *API) GetConfig(ctx context.Context) (any, *contract.Fault) {
	blob, fault := a.DB.LoadConfig(ctx)
	if fault != nil {
		return nil, fault
	}
	snap := &domain.Snapshot{SchemaVersion: 1, AIAccounts: []domain.StoredAI{}, AIRuntime: domain.DefaultAIRuntime()}
	if blob.Found {
		var message string
		snap, _, message = a.decrypt(blob)
		if message != "" {
			return nil, contract.Internal(message)
		}
	}
	return struct {
		Data configView `json:"data"`
	}{Data: viewOf(*snap, blob.Revision)}, nil
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
	if fault := a.DB.SaveConfig(ctx, actor, in.Expected, next, nonce, cipher, len(snap.AIAccounts)); fault != nil {
		return nil, fault
	}
	view.Revision = next
	return struct {
		Data configView `json:"data"`
	}{view}, nil
}

type configView struct {
	AIDefault string        `json:"ai_default_model"`
	Schema    int           `json:"schema_version"`
	Revision  int64         `json:"revision"`
	CacheTTL  int           `json:"cache_ttl_seconds"`
	AI        []aiView      `json:"ai_accounts"`
	Runtime   runtimeView   `json:"ai_runtime"`
	Storage   []storageView `json:"system_storage"`
}

type runtimeView struct {
	MaxConcurrencyGlobal  int  `json:"max_concurrency_global"`
	MaxConcurrencyUser    int  `json:"max_concurrency_user"`
	MaxConcurrencyAccount int  `json:"max_concurrency_account"`
	UserRatePerMinute     int  `json:"user_rate_per_minute"`
	LeaseTTLSeconds       int  `json:"lease_ttl_seconds"`
	AllowPublicEgress     bool `json:"allow_public_egress"`
}

type aiView struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	BaseURL        string `json:"base_url"`
	APIFormat      string `json:"api_format"`
	Model          string `json:"model"`
	Active         bool   `json:"active"`
	Thinking       string `json:"thinking"`
	ThinkingFormat string `json:"thinking_format"`
	Priority       int64  `json:"priority"`
	Purpose        string `json:"purpose"`
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
	def, msg := defaultModel(old, in.AIDefault, ais)
	if msg != "" {
		return domain.Snapshot{}, configView{}, contract.Validation(msg)
	}
	runtime, msg := mergeRuntime(old, in.Runtime)
	if msg != "" {
		return domain.Snapshot{}, configView{}, contract.Validation(msg)
	}
	snap := domain.Snapshot{
		SchemaVersion: 1, AIDefaultModel: def, AIAccounts: ais, AIRuntime: runtime,
	}
	if old != nil {
		snap.Payment = old.Payment
		snap.SystemStorage = old.SystemStorage
	}
	if in.Storage != nil {
		var fault *contract.Fault
		snap.SystemStorage, fault = mergeSystemStorage(old, *in.Storage)
		if fault != nil {
			return domain.Snapshot{}, configView{}, fault
		}
	}
	return snap, viewOf(snap, in.Expected+1), nil
}

// mergeRuntime validates a supplied runtime block; nil keeps the stored one,
// or the defaults when nothing is stored.
func mergeRuntime(old *domain.Snapshot, requested *domain.AIRuntime) (domain.AIRuntime, string) {
	if requested == nil {
		if old != nil {
			return old.AIRuntime, ""
		}
		return domain.DefaultAIRuntime(), ""
	}
	r := *requested
	for _, n := range []int{r.MaxConcurrencyGlobal, r.MaxConcurrencyUser, r.MaxConcurrencyAccount, r.UserRatePerMinute} {
		if n < 0 || n > maxRuntimeCeiling {
			return domain.AIRuntime{}, "AI 并发与频率上限必须在 0 到 100000 之间（0 表示不限制）"
		}
	}
	if r.LeaseTTLSeconds < 1 || r.LeaseTTLSeconds > maxLeaseSeconds {
		return domain.AIRuntime{}, "AI 租约时长必须在 1 到 3600 秒之间"
	}
	return r, ""
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
		purpose := strings.TrimSpace(row.Purpose)
		if purpose != domain.PurposeOCR && purpose != domain.PurposeImage && purpose != domain.PurposeChat {
			return nil, contract.Validation("AI 账号用途必须是 ocr、image 或 chat")
		}
		format := strings.TrimSpace(row.APIFormat)
		if format == "" {
			format = "chat_completions"
		}
		if purpose != domain.PurposeChat && format != "chat_completions" {
			return nil, contract.Validation("识图和套图账号只支持 Chat Completions")
		}
		if format != "chat_completions" && format != "anthropic_messages" && format != "responses" {
			return nil, contract.Validation("AI API 格式无效")
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
			Purpose: purpose,
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
		return "", "AI 默认模型必须由启用的识图用途 Chat Completions 账号提供；停用该账号前请先更换默认模型"
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
		if !row.Active || row.APIFormat != "chat_completions" || row.Purpose != domain.PurposeOCR {
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
		if row.Active && row.APIFormat == "chat_completions" && row.Purpose == domain.PurposeOCR && row.Model == model {
			return true
		}
	}
	return false
}

func viewOf(snap domain.Snapshot, revision int64) configView {
	ai := make([]aiView, 0, len(snap.AIAccounts))
	for _, row := range snap.AIAccounts {
		ai = append(ai, aiView{row.ID, row.Label, row.BaseURL, row.APIFormat, row.Model, row.Active, row.Thinking, row.ThinkingFormat, row.Priority, row.Purpose})
	}
	return configView{
		AIDefault: snap.AIDefaultModel, Schema: 1, Revision: revision, CacheTTL: 300,
		AI: ai, Runtime: runtimeView(snap.AIRuntime), Storage: storageViews(snap.SystemStorage),
	}
}
