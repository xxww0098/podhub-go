// Package config loads process settings once.
//
// OZON_WRITE_KILL_SWITCH matches src/store/egress.rs is_truthy / env_truthy:
// only 1, true, yes, or on (trim, ASCII lower) disables Seller writes.
// Unset, empty, and every other value leave writes enabled. The value is
// captured here when the process starts; later changes to the environment
// are ignored, same as the Rust pool reading it once.
//
// CLOUD_MEDIA_GC_DELETE matches src/media/slice_purge.rs enabled(): unset
// enables the purge, 1/true/on/yes enable it, 0/false/off/no disable it,
// and any other value logs an error and leaves it disabled without aborting
// the process. An empty string is set, so it is an invalid value, not the
// unset default.
//
// Nothing else in this module may read those two variables. During the Go
// rewrite, internal/storage deletes only when this parse says the purge is
// enabled and every R2 setting names http(s)://127.0.0.1. Any other R2 host,
// or a partial R2 setting, refuses the client.
package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	envDatabaseURL       = "DATABASE_URL"
	envBind              = "CLOUD_BIND"
	envOzonKillSwitch    = "OZON_WRITE_KILL_SWITCH"
	envMediaGCDelete     = "CLOUD_MEDIA_GC_DELETE"
	envR2Endpoint        = "R2_ENDPOINT"
	envR2Bucket          = "R2_BUCKET"
	envR2AccessKeyID     = "R2_ACCESS_KEY_ID"
	envR2Secret          = "R2_SECRET_ACCESS_KEY"
	envLoadTestMode      = "PODHUB_LOADTEST_MODE"
	envProductSyncOff    = "OZON_PRODUCT_SYNC_DISABLED"
	envDelegateSync      = "DELEGATE_SYNC_INTERVAL_MS"
	envDelegateAuto      = "DELEGATE_AUTO_DISPATCH"
	envLaneCostLimit     = "CLOUD_LANE_QUEUED_COST_LIMIT"
	envListingFlight     = "CLOUD_WORKER_LISTING_MAX_IN_FLIGHT"
	envReconcileFlight   = "CLOUD_RECONCILER_MAX_IN_FLIGHT"
	envSyncFlight        = "CLOUD_SYNC_WORKER_MAX_IN_FLIGHT"
	envMCPHosts          = "CLOUD_MCP_ALLOWED_HOSTS"
	envMCPOrigins        = "CLOUD_MCP_ALLOWED_ORIGINS"
	envMCPRunner         = "CLOUD_MCP_RUNNER_PATH"
	envClientLogCollect  = "CLOUD_CLIENT_LOG_COLLECT"
	envShippingInject    = "SHIPPING_INJECT_OZON_WRITES"
	envSellerRelayDir    = "CLOUD_SELLER_RELAY_DIR"
	envSellerRelaySwitch = "CLOUD_SELLER_RELAY_SWITCH_DIR"
	envSellerKey         = "CLOUD_SELLER_CREDENTIAL_KEY"
	envSellerKeyID       = "CLOUD_SELLER_CREDENTIAL_KEY_ID"
	envSellerKeyPrevious = "CLOUD_SELLER_CREDENTIAL_KEY_PREVIOUS"
	envIntegrationKey    = "CLOUD_INTEGRATION_CONFIG_KEY"
	envInstanceID        = "CLOUD_INSTANCE_ID"
	envAdminTotpKey      = "CLOUD_ADMIN_TOTP_KEY"
	envAILoopback        = "CLOUD_AI_EGRESS_ALLOW_LOOPBACK"
	envAIPublic          = "CLOUD_AI_EGRESS_ALLOW_PUBLIC"
	envSellerBase        = "CLOUD_SELLER_BASE_URL"
	envRatingSync        = "STORE_RATING_SYNC_INTERVAL"
	envRatingKeep        = "STORE_RATING_RETENTION"
	envRatingRank        = "STORE_RATING_STATUS_RANK"
	envOTLPTraces        = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
	defaultBind          = "127.0.0.1:8080"
	defaultDelegate      = 60 * time.Second
	defaultMCPRunner     = "podhub-mcp-runner"
)

// Config is the only parsed view of the environment.
type Config struct {
	DatabaseURL string
	Bind        string

	// ozonWritesDisabled is true only when OZON_WRITE_KILL_SWITCH is truthy.
	ozonWritesDisabled bool
	// shippingInjectWrites is SHIPPING_INJECT_OZON_WRITES. Unset is false.
	// Only 1/true/yes/on (trim, ASCII lower) enables logistics injection writes.
	// This is not the Ozon kill switch. Safe-continue reads it; reconcile does not.
	shippingInjectWrites bool
	// mediaDeleteEnabled follows slice_purge::enabled, including the unset default.
	mediaDeleteEnabled bool

	R2Endpoint  string
	R2Bucket    string
	R2AccessKey string
	R2Secret    string

	LoadTestMode string

	// productSyncDisabled is OZON_PRODUCT_SYNC_DISABLED, read once.
	// Only 1/true/yes/on disables the product-sync scan.
	productSyncDisabled bool
	delegateSync        time.Duration
	// delegateAutoDispatch is DELEGATE_AUTO_DISPATCH, read once.
	// 0/false/no/off disables. Unset and every other value enable.
	delegateAutoDispatch bool
	laneQueuedCostLimit  int64
	listingInFlight      int
	reconcilerInFlight   int
	syncInFlight         int

	// mcp is CLOUD_MCP_ALLOWED_HOSTS, CLOUD_MCP_ALLOWED_ORIGINS, and
	// CLOUD_MCP_RUNNER_PATH. Domains receive this value; they do not read
	// the environment.
	mcp MCP

	// clientLogCollect is CLOUD_CLIENT_LOG_COLLECT. Only 1/true/yes/on
	// turns collection on. Unset, empty, and every other value leave it off.
	clientLogCollect bool
	// sellerRelayDir and sellerRelaySwitchDir are the sidecar directories.
	// An empty value is the same as unset.
	sellerRelayDir       string
	sellerRelaySwitchDir string

	// Credential secrets are captured here. Callers decrypt with the bytes.
	// They are not the two protected switches.
	SellerCredentialKey         string
	SellerCredentialKeyID       string
	SellerCredentialKeyPrevious string
	IntegrationConfigKey        string
	AdminTotpKey                string
	AIEgressAllowLoopback       bool
	// AIEgressAllowPublic is the public model-probe switch. Only the trimmed
	// value 1 turns it on. Unset and every other value leave it off. It does
	// not share a parser with the Ozon kill switch or the media-delete switch.
	AIEgressAllowPublic bool
	// sellerBaseURL is CLOUD_SELLER_BASE_URL trimmed at Load. The seller
	// domain turns a non-loopback value into the official host.
	sellerBaseURL string

	// ratingSync is STORE_RATING_SYNC_INTERVAL. Empty or invalid is 6h.
	ratingSync time.Duration
	// ratingKeep is STORE_RATING_RETENTION. Empty or invalid is 90 days.
	ratingKeep time.Duration
	// ratingRank is STORE_RATING_STATUS_RANK. Higher severity is worse.
	// Unset is UNKNOWN=0, which never notifies.
	ratingRank map[string]int

	// writerInstance is CLOUD_INSTANCE_ID trimmed. Blank becomes axum-{pid}.
	writerInstance string

	// otlpTraces is OTEL_EXPORTER_OTLP_TRACES_ENDPOINT trimmed. Empty is off.
	otlpTraces string
}

// MCP is the parsed MCP allow-list. RunnerPath is never empty.
type MCP struct {
	AllowedHosts   []string
	AllowedOrigins []string
	RunnerPath     string
}

// Load reads the environment. It does not dial anything.
func Load() Config {
	bind := strings.TrimSpace(os.Getenv(envBind))
	if bind == "" {
		bind = defaultBind
	}
	ozonRaw, ozonSet := os.LookupEnv(envOzonKillSwitch)
	mediaRaw, mediaSet := os.LookupEnv(envMediaGCDelete)
	syncRaw, syncSet := os.LookupEnv(envProductSyncOff)
	collectRaw, collectSet := os.LookupEnv(envClientLogCollect)
	injectRaw, injectSet := os.LookupEnv(envShippingInject)
	relayDir, relaySet := os.LookupEnv(envSellerRelayDir)
	switchDir, switchSet := os.LookupEnv(envSellerRelaySwitch)
	if !relaySet {
		relayDir = ""
	}
	if !switchSet {
		switchDir = ""
	}
	autoRaw, autoSet := os.LookupEnv(envDelegateAuto)
	return Config{
		DatabaseURL:                 strings.TrimSpace(os.Getenv(envDatabaseURL)),
		Bind:                        bind,
		ozonWritesDisabled:          ozonSet && isTruthy(ozonRaw),
		mediaDeleteEnabled:          mediaDeleteEnabled(mediaRaw, mediaSet),
		R2Endpoint:                  strings.TrimSpace(os.Getenv(envR2Endpoint)),
		R2Bucket:                    strings.TrimSpace(os.Getenv(envR2Bucket)),
		R2AccessKey:                 strings.TrimSpace(os.Getenv(envR2AccessKeyID)),
		R2Secret:                    strings.TrimSpace(os.Getenv(envR2Secret)),
		LoadTestMode:                strings.TrimSpace(os.Getenv(envLoadTestMode)),
		productSyncDisabled:         syncSet && isTruthy(syncRaw),
		delegateSync:                durationMS(os.Getenv(envDelegateSync), defaultDelegate),
		delegateAutoDispatch:        delegateAutoDispatch(autoRaw, autoSet),
		laneQueuedCostLimit:         laneLimit(os.Getenv(envLaneCostLimit)),
		listingInFlight:             inFlight(os.Getenv(envListingFlight), 4, 16),
		reconcilerInFlight:          inFlight(os.Getenv(envReconcileFlight), 2, 8),
		syncInFlight:                inFlight(os.Getenv(envSyncFlight), 4, 16),
		mcp:                         loadMCP(),
		clientLogCollect:            collectSet && isTruthy(collectRaw),
		shippingInjectWrites:        injectSet && isTruthy(injectRaw),
		sellerRelayDir:              relayDir,
		sellerRelaySwitchDir:        switchDir,
		SellerCredentialKey:         os.Getenv(envSellerKey),
		SellerCredentialKeyID:       strings.TrimSpace(os.Getenv(envSellerKeyID)),
		SellerCredentialKeyPrevious: os.Getenv(envSellerKeyPrevious),
		IntegrationConfigKey:        os.Getenv(envIntegrationKey),
		AdminTotpKey:                os.Getenv(envAdminTotpKey),
		AIEgressAllowLoopback:       strings.TrimSpace(os.Getenv(envAILoopback)) == "1",
		AIEgressAllowPublic:         strings.TrimSpace(os.Getenv(envAIPublic)) == "1",
		sellerBaseURL:               strings.TrimSpace(os.Getenv(envSellerBase)),
		ratingSync:                  ratingInterval(os.Getenv(envRatingSync)),
		ratingKeep:                  ratingRetention(os.Getenv(envRatingKeep)),
		ratingRank:                  ratingRanks(os.Getenv(envRatingRank)),
		writerInstance:              writerInstanceID(),
		otlpTraces:                  strings.TrimSpace(os.Getenv(envOTLPTraces)),
	}
}

// RatingSyncInterval is the per-store seller-info gap captured by Load.
func (c Config) RatingSyncInterval() time.Duration { return c.ratingSync }

// RatingRetention is how long rating history is kept.
func (c Config) RatingRetention() time.Duration { return c.ratingKeep }

// RatingStatusRank is a copy of the status severity map. A higher number
// is worse. The default map contains only UNKNOWN at 0.
func (c Config) RatingStatusRank() map[string]int {
	out := make(map[string]int, len(c.ratingRank))
	for k, v := range c.ratingRank {
		out[k] = v
	}
	return out
}

// SellerBaseURL is the trimmed CLOUD_SELLER_BASE_URL captured by Load.
// It is not resolved. A later change to the environment does not alter it.
func (c Config) SellerBaseURL() string { return c.sellerBaseURL }

// WriterInstanceID is WriterIdentity::axum_from_env's instance string.
// CLOUD_INSTANCE_ID is trimmed. Blank or unset becomes axum-{pid}.
func (c Config) WriterInstanceID() string {
	if strings.TrimSpace(c.writerInstance) == "" {
		return fmt.Sprintf("axum-%d", os.Getpid())
	}
	return c.writerInstance
}

func writerInstanceID() string {
	id := strings.TrimSpace(os.Getenv(envInstanceID))
	if id == "" {
		return fmt.Sprintf("axum-%d", os.Getpid())
	}
	return id
}

// OTLPTracesEndpoint is OTEL_EXPORTER_OTLP_TRACES_ENDPOINT captured by Load.
// Unset or blank returns "" and nil: no exporter, nothing is dialed. A set
// value must be an http(s) URL whose host is loopback; anything else
// returns an error and the caller keeps the exporter off.
func (c Config) OTLPTracesEndpoint() (string, error) {
	raw := c.otlpTraces
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("%s: %w", envOTLPTraces, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("%s: scheme must be http or https", envOTLPTraces)
	}
	switch strings.ToLower(u.Hostname()) {
	case "localhost", "127.0.0.1", "::1":
		return u.String(), nil
	default:
		return "", fmt.Errorf("%s: host must be loopback", envOTLPTraces)
	}
}

// MCPSettings is the MCP allow-list captured by Load.
func (c Config) MCPSettings() MCP { return c.mcp }

// ClientLogCollect reports CLOUD_CLIENT_LOG_COLLECT. The telemetry domain
// receives the bool and does not read the environment.
func (c Config) ClientLogCollect() bool { return c.clientLogCollect }

// ProductSyncDisabled reports OZON_PRODUCT_SYNC_DISABLED. It is read once
// at Load. Only 1/true/yes/on disables the scan. Reads are not Seller writes.
func (c Config) ProductSyncDisabled() bool { return c.productSyncDisabled }

// DelegateSyncInterval is DELEGATE_SYNC_INTERVAL_MS, or 60s when unset.
// The delegate scan does not back off.
func (c Config) DelegateSyncInterval() time.Duration { return c.delegateSync }

// DelegateAutoDispatch is DELEGATE_AUTO_DISPATCH, read once at Load.
// Trimmed 0/false/no/off disables automatic delegate_dispatches inserts.
// Unset and every other value, including empty, leave it enabled.
func (c Config) DelegateAutoDispatch() bool { return c.delegateAutoDispatch }

func delegateAutoDispatch(value string, set bool) bool {
	if !set {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

// LaneQueuedCostLimit is CLOUD_LANE_QUEUED_COST_LIMIT clamped to 1..1024.
// Unset stays at 256.
func (c Config) LaneQueuedCostLimit() int64 { return c.laneQueuedCostLimit }

// InFlight is the process claim cap for a worker role. Defaults are 4, 2,
// and 4; caps are 16, 8, and 16.
func (c Config) InFlight(role string) int {
	switch role {
	case "reconcile":
		return c.reconcilerInFlight
	case "sync":
		return c.syncInFlight
	default:
		return c.listingInFlight
	}
}

// OzonWritesDisabled reports the kill switch. Callers that would send a
// Seller write must go through internal/ozon, which calls this.
func (c Config) OzonWritesDisabled() bool { return c.ozonWritesDisabled }

// ShippingInjectWrites reports the inject-only switch. Unset, empty, and
// every non-truthy value leave warehouse writes off.
func (c Config) ShippingInjectWrites() bool { return c.shippingInjectWrites }

// ShippingInjectOzonWrites is ShippingInjectWrites. Safe-continue reads this
// bool. It does not read the environment, and it is not the Seller kill switch.
func (c Config) ShippingInjectOzonWrites() bool { return c.shippingInjectWrites }

// SellerRelayDir is CLOUD_SELLER_RELAY_DIR. Empty means the sidecar is absent.
func (c Config) SellerRelayDir() string { return c.sellerRelayDir }

// SellerRelaySwitchDir is CLOUD_SELLER_RELAY_SWITCH_DIR. Empty means save
// does not touch the sidecar active file.
func (c Config) SellerRelaySwitchDir() string { return c.sellerRelaySwitchDir }

// MediaDeleteEnabled reports the purge switch. Callers that would remove
// an object must go through internal/storage, which calls this.
func (c Config) MediaDeleteEnabled() bool { return c.mediaDeleteEnabled }

// R2Configured reports whether any R2 setting is present. It does not dial.
func (c Config) R2Configured() bool {
	return c.R2Endpoint != "" || c.R2Bucket != "" || c.R2AccessKey != "" || c.R2Secret != ""
}

// CheckDatabase allows an empty URL (the process will not connect) and
// otherwise only loopback hosts. Production endpoints are refused.
func (c Config) CheckDatabase() error {
	if c.DatabaseURL == "" {
		return nil
	}
	u, err := url.Parse(c.DatabaseURL)
	if err != nil {
		return fmt.Errorf("DATABASE_URL: %w", err)
	}
	if u.Scheme != "postgres" && u.Scheme != "postgresql" {
		return fmt.Errorf("DATABASE_URL scheme %q is not postgres", u.Scheme)
	}
	host := strings.Trim(strings.ToLower(u.Hostname()), "[]")
	switch host {
	case "", "localhost", "127.0.0.1", "::1":
		return nil
	default:
		return fmt.Errorf("refusing database host %q; this process only dials loopback", host)
	}
}

func laneLimit(raw string) int64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 256
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 256
	}
	if n < 1 {
		return 1
	}
	if n > 1024 {
		return 1024
	}
	return n
}

func inFlight(raw string, fallback, cap int) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return fallback
	}
	if n > cap {
		return cap
	}
	return n
}

func ratingInterval(raw string) time.Duration {
	return ratingDuration(raw, 6*time.Hour, "STORE_RATING_SYNC_INTERVAL")
}

func ratingRetention(raw string) time.Duration {
	return ratingDuration(raw, 90*24*time.Hour, "STORE_RATING_RETENTION")
}

func ratingDuration(raw string, fallback time.Duration, name string) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < time.Second {
		slog.Error(name + " is not a positive duration of at least one second; using the default")
		return fallback
	}
	return d
}

func ratingRanks(raw string) map[string]int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return map[string]int{"UNKNOWN": 0}
	}
	out := map[string]int{}
	for _, part := range strings.Split(raw, ",") {
		name, n, ok := splitRank(part)
		if !ok {
			slog.Error("STORE_RATING_STATUS_RANK has an unrecognized entry; that entry is ignored")
			continue
		}
		out[name] = n
	}
	if len(out) == 0 {
		slog.Error("STORE_RATING_STATUS_RANK has no usable entry; default UNKNOWN only")
		return map[string]int{"UNKNOWN": 0}
	}
	return out
}

func splitRank(part string) (string, int, bool) {
	name, num, ok := strings.Cut(strings.TrimSpace(part), "=")
	if !ok {
		return "", 0, false
	}
	name = strings.TrimSpace(name)
	if name == "" || strings.ContainsAny(name, " \t") {
		return "", 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(num))
	if err != nil {
		return "", 0, false
	}
	return name, n, true
}

func durationMS(raw string, fallback time.Duration) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return fallback
	}
	return time.Duration(n) * time.Millisecond
}

func loadMCP() MCP {
	runner := strings.TrimSpace(os.Getenv(envMCPRunner))
	if runner == "" {
		runner = defaultMCPRunner
	}
	return MCP{
		AllowedHosts:   splitCSV(os.Getenv(envMCPHosts)),
		AllowedOrigins: splitCSV(os.Getenv(envMCPOrigins)),
		RunnerPath:     runner,
	}
}

// splitCSV splits on commas, trims, and drops empty pieces. That is
// allowed_list in spec-aomt-mcp section 2.4. See docs/parity/mcp-parity.md.
func splitCSV(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		out = append(out, part)
	}
	return out
}

func isTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func mediaDeleteEnabled(value string, set bool) bool {
	if !set {
		return true
	}
	if !utf8.ValidString(value) {
		slog.Error("CLOUD_MEDIA_GC_DELETE is not valid UTF-8; slice purge stays off")
		return false
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "on", "yes":
		return true
	case "0", "false", "off", "no":
		return false
	default:
		slog.Error("CLOUD_MEDIA_GC_DELETE is not a recognized value; slice purge stays off")
		return false
	}
}
