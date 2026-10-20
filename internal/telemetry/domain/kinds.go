package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

func kindErr(msg string) error { return errors.New(msg) }

type field struct {
	key string
	raw json.RawMessage
}

func parseObject(payload string) ([]field, error) {
	dec := json.NewDecoder(strings.NewReader(payload))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return nil, kindErr("payload 不是合法 JSON")
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return nil, kindErr("not-object")
	}
	var fields []field
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, kindErr("payload 不是合法 JSON")
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, kindErr("payload 不是合法 JSON")
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, kindErr("payload 不是合法 JSON")
		}
		fields = append(fields, field{key: key, raw: raw})
	}
	tok, err = dec.Token()
	if err != nil || tok != json.Delim('}') {
		return nil, kindErr("payload 不是合法 JSON")
	}
	var extra any
	if err := dec.Decode(&extra); err == nil {
		return nil, kindErr("payload 不是合法 JSON")
	}
	return fields, nil
}

func fieldMap(fields []field) map[string]json.RawMessage {
	m := make(map[string]json.RawMessage, len(fields))
	for _, f := range fields {
		m[f.key] = f.raw
	}
	return m
}

func firstUnknown(fields []field, allow map[string]bool) string {
	for _, f := range fields {
		if !allow[f.key] {
			return f.key
		}
	}
	return ""
}

func jsonString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

func jsonInt(raw json.RawMessage) (int64, bool) {
	var n json.Number
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&n); err != nil {
		return 0, false
	}
	return isJSONInt(n)
}

func asciiHex(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func decodeDesktopV1(payload string) (string, error) {
	fields, err := parseObject(payload)
	if err != nil {
		if err.Error() == "not-object" {
			return "", kindErr("desktop_error_log 必须是对象")
		}
		return "", err
	}
	allow := map[string]bool{
		"schemaVersion": true, "source": true, "code": true, "fingerprint": true,
		"message": true, "appVersion": true, "os": true, "occurredAt": true, "stack": true,
	}
	if key := firstUnknown(fields, allow); key != "" {
		return "", kindErr("payload 含有未允许字段: " + key)
	}
	m := fieldMap(fields)
	ver, ok := jsonInt(m["schemaVersion"])
	if !ok || ver != 1 {
		return "", kindErr("payload.schemaVersion 必须为 1")
	}
	source, ok := jsonString(m["source"])
	if !ok || !v1Source(source) {
		return "", kindErr("source 无效")
	}
	code, ok := jsonString(m["code"])
	if !ok || strings.TrimSpace(code) == "" || len(strings.TrimSpace(code)) > 128 {
		return "", kindErr("code 无效")
	}
	code = strings.TrimSpace(code)
	fp, ok := jsonString(m["fingerprint"])
	if !ok || len(fp) < 16 || len(fp) > 64 || !asciiHex(fp) {
		return "", kindErr("fingerprint 无效")
	}
	message, ok := jsonString(m["message"])
	if !ok || strings.TrimSpace(message) == "" || len(strings.TrimSpace(message)) > 1024 {
		return "", kindErr("message 无效")
	}
	message = strings.TrimSpace(message)
	app, ok := jsonString(m["appVersion"])
	if !ok || len(app) > 128 {
		return "", kindErr("appVersion 无效")
	}
	osName, ok := jsonString(m["os"])
	if !ok || len(osName) > 512 {
		return "", kindErr("os 无效")
	}
	occurred, ok := jsonString(m["occurredAt"])
	if !ok || !parseRFC3339(occurred) {
		return "", kindErr("occurredAt 无效")
	}
	out := ordered{vals: map[string]json.RawMessage{
		"schemaVersion": rawInt(1),
		"source":        rawString(source),
		"code":          rawString(code),
		"fingerprint":   rawString(fp),
		"message":       rawString(message),
		"appVersion":    rawString(app),
		"os":            rawString(osName),
		"occurredAt":    rawString(occurred),
	}}
	out.keys = []string{"schemaVersion", "source", "code", "fingerprint", "message", "appVersion", "os", "occurredAt"}
	if raw, ok := m["stack"]; ok {
		stack, sok := jsonString(raw)
		if !sok {
			return "", kindErr("payload 不是合法 JSON")
		}
		if stack != "" && len(stack) <= 2048 {
			out.keys = append(out.keys, "stack")
			out.vals["stack"] = rawString(stack)
		}
	}
	text, err := compactJSON(out)
	return text, err
}

func v1Source(s string) bool {
	switch s {
	case "host_uncaught", "host_unhandled_rejection", "renderer_gone", "workbench":
		return true
	default:
		return false
	}
}

func decodeDesktopV2(payload string) (string, error) {
	return decodeDesktopShared(payload, 2, map[string]bool{
		"schemaVersion": true, "source": true, "code": true, "severity": true,
		"params": true, "frames": true, "fingerprint": true, "appVersion": true,
		"os": true, "occurredAtMs": true, "draftId": true,
	}, "payload.schemaVersion 必须为 2")
}

func decodeDesktopV3(payload string) (string, error) {
	allow := map[string]bool{
		"schemaVersion": true, "source": true, "code": true, "severity": true,
		"params": true, "frames": true, "fingerprint": true, "appVersion": true,
		"os": true, "occurredAtMs": true, "draftId": true, "context": true, "rawPayload": true,
	}
	fields, err := parseObject(payload)
	if err != nil {
		if err.Error() == "not-object" {
			return "", kindErr("desktop_error_log 必须是对象")
		}
		return "", err
	}
	if key := firstUnknown(fields, allow); key != "" {
		return "", kindErr(unknownField("payload", key))
	}
	m := fieldMap(fields)
	shared, err := decodeDesktopShared(payloadWithout(fields, "context", "rawPayload"), 3, map[string]bool{
		"schemaVersion": true, "source": true, "code": true, "severity": true,
		"params": true, "frames": true, "fingerprint": true, "appVersion": true,
		"os": true, "occurredAtMs": true, "draftId": true,
	}, "payload.schemaVersion 必须为 3")
	if err != nil {
		return "", err
	}
	if _, ok := m["context"]; !ok {
		return "", kindErr("context 必须是对象")
	}
	if _, ok := m["rawPayload"]; !ok {
		return "", kindErr("rawPayload 缺失")
	}
	ctx, err := decodeV3Context(m["context"])
	if err != nil {
		return "", err
	}
	raw, err := decodeV3Raw(m["rawPayload"])
	if err != nil {
		return "", err
	}
	base := ordered{vals: map[string]json.RawMessage{}}
	if err := json.Unmarshal([]byte(shared), &base.vals); err != nil {
		return "", kindErr("payload 不是合法 JSON")
	}
	base.keys = nil
	for _, key := range []string{"schemaVersion", "source", "code", "severity", "params", "frames", "fingerprint", "appVersion", "os", "occurredAtMs", "draftId"} {
		if _, ok := base.vals[key]; ok {
			base.keys = append(base.keys, key)
		}
	}
	base.keys = append(base.keys, "context", "rawPayload")
	base.vals["context"] = ctx
	base.vals["rawPayload"] = raw
	if len(raw) > 8192 {
		return "", kindErr("rawPayload 超过 8192 字节")
	}
	return compactJSON(base)
}

func payloadWithout(fields []field, drop ...string) string {
	skip := map[string]bool{}
	for _, d := range drop {
		skip[d] = true
	}
	o := ordered{vals: map[string]json.RawMessage{}}
	for _, f := range fields {
		if skip[f.key] {
			continue
		}
		o.keys = append(o.keys, f.key)
		o.vals[f.key] = f.raw
	}
	text, _ := compactJSON(o)
	return text
}

func unknownField(prefix, key string) string {
	if keyLabel(key) == "" {
		return prefix + " 含有未允许字段"
	}
	return prefix + " 含有未允许字段: " + key
}

func keyLabel(key string) string {
	if len(key) < 1 || len(key) > 64 {
		return ""
	}
	for i := 0; i < len(key); i++ {
		c := key[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
			return ""
		}
	}
	return key
}

func decodeV3Context(raw json.RawMessage) (json.RawMessage, error) {
	var fields []field
	text := strings.TrimSpace(string(raw))
	parsed, err := parseObject(text)
	if err != nil {
		return nil, kindErr("context 必须是对象")
	}
	fields = parsed
	allow := map[string]bool{"field": true, "platform": true}
	if key := firstUnknown(fields, allow); key != "" {
		return nil, kindErr(unknownField("context", key))
	}
	m := fieldMap(fields)
	o := ordered{vals: map[string]json.RawMessage{}}
	if raw, ok := m["platform"]; ok {
		s, sok := jsonString(raw)
		if !sok || !slugOK(s) {
			return nil, kindErr("context 含有未允许字段: platform")
		}
		o.keys = append(o.keys, "platform")
		o.vals["platform"] = rawString(s)
	}
	if raw, ok := m["field"]; ok {
		if string(raw) == "null" {
			o.keys = append(o.keys, "field")
			o.vals["field"] = json.RawMessage("null")
		} else {
			s, sok := jsonString(raw)
			if !sok || len(s) > 128 {
				return nil, kindErr("context.field 无效")
			}
			o.keys = append(o.keys, "field")
			o.vals["field"] = rawString(s)
		}
	}
	return compactRaw(o)
}

func slugOK(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func decodeV3Raw(raw json.RawMessage) (json.RawMessage, error) {
	fields, err := parseObject(string(raw))
	if err != nil {
		return nil, kindErr("rawPayload 缺失")
	}
	allow := map[string]bool{"kind": true, "data": true}
	if key := firstUnknown(fields, allow); key != "" {
		return nil, kindErr(unknownField("rawPayload", key))
	}
	m := fieldMap(fields)
	kind, ok := jsonString(m["kind"])
	if !ok || kind == "" || len(kind) > 64 {
		return nil, kindErr("rawPayload.kind 无效")
	}
	data := m["data"]
	if len(data) == 0 || string(data) == "null" {
		return nil, kindErr("rawPayload.data 必须是非空对象")
	}
	dataFields, err := parseObject(string(data))
	if err != nil || len(dataFields) == 0 {
		return nil, kindErr("rawPayload.data 必须是非空对象")
	}
	if err := boundRaw(data, "rawPayload.data", 0); err != nil {
		return nil, err
	}
	encoded, err := compactJSON(json.RawMessage(data))
	if err != nil {
		return nil, kindErr("payload 不是合法 JSON")
	}
	if len(encoded) > 8192 || len(data) > 8192 {
		return nil, kindErr("rawPayload 超过 8192 字节")
	}
	o := ordered{keys: []string{"kind", "data"}, vals: map[string]json.RawMessage{
		"kind": rawString(kind),
		"data": json.RawMessage(data),
	}}
	return compactRaw(o)
}

func boundRaw(raw json.RawMessage, path string, depth int) error {
	if depth > 8 {
		return kindErr("rawPayload 嵌套过深")
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil
	}
	switch raw[0] {
	case '{':
		fields, err := parseObject(string(raw))
		if err != nil {
			return kindErr("payload 不是合法 JSON")
		}
		if len(fields) > 32 {
			return kindErr(path + " 最多 32 项")
		}
		for _, f := range fields {
			if keyLabel(f.key) == "" {
				return kindErr(unknownField(path, f.key))
			}
			if err := boundRaw(f.raw, path+"."+f.key, depth+1); err != nil {
				return err
			}
		}
	case '[':
		var items []json.RawMessage
		if json.Unmarshal(raw, &items) != nil {
			return kindErr("payload 不是合法 JSON")
		}
		if len(items) > 32 {
			return kindErr(path + " 最多 32 项")
		}
		for _, item := range items {
			if err := boundRaw(item, path, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func compactRaw(o ordered) (json.RawMessage, error) {
	b, err := o.MarshalJSON()
	return b, err
}

func decodeDesktopShared(payload string, version int64, allow map[string]bool, versionMsg string) (string, error) {
	fields, err := parseObject(payload)
	if err != nil {
		if err.Error() == "not-object" {
			return "", kindErr("desktop_error_log 必须是对象")
		}
		return "", err
	}
	if key := firstUnknown(fields, allow); key != "" {
		return "", kindErr("payload 含有未允许字段: " + key)
	}
	m := fieldMap(fields)
	ver, ok := jsonInt(m["schemaVersion"])
	if !ok || ver != version {
		return "", kindErr(versionMsg)
	}
	source, ok := jsonString(m["source"])
	if !ok || !v2Source(source) {
		return "", kindErr("source 无效")
	}
	code, ok := jsonString(m["code"])
	if !ok || !v2Code(code) {
		return "", kindErr("code 无效")
	}
	severity, ok := jsonString(m["severity"])
	if !ok || (severity != "blocking" && severity != "degraded") {
		return "", kindErr("severity 无效")
	}
	params, err := decodeParams(m["params"])
	if err != nil {
		return "", err
	}
	frames, err := decodeFrames(m["frames"])
	if err != nil {
		return "", err
	}
	fp, ok := jsonString(m["fingerprint"])
	if !ok || len(fp) != 32 || !asciiHex(fp) {
		return "", kindErr("fingerprint 无效")
	}
	app, ok := jsonString(m["appVersion"])
	if !ok || !tokenOK(app, 1, 32, appCharset) {
		return "", kindErr("appVersion 无效")
	}
	osRaw, err := decodeOS(m["os"])
	if err != nil {
		return "", err
	}
	occurred, ok := jsonInt(m["occurredAtMs"])
	if !ok || occurred < 0 {
		return "", kindErr("occurredAtMs 无效")
	}
	out := ordered{vals: map[string]json.RawMessage{
		"schemaVersion": rawInt(version),
		"source":        rawString(source),
		"code":          rawString(code),
		"severity":      rawString(severity),
		"params":        params,
		"frames":        frames,
		"fingerprint":   rawString(fp),
		"appVersion":    rawString(app),
		"os":            osRaw,
		"occurredAtMs":  rawInt(occurred),
	}}
	out.keys = []string{"schemaVersion", "source", "code", "severity", "params", "frames", "fingerprint", "appVersion", "os", "occurredAtMs"}
	if raw, ok := m["draftId"]; ok {
		if s, sok := jsonString(raw); sok && draftOK(s) {
			out.keys = append(out.keys, "draftId")
			out.vals["draftId"] = rawString(s)
		}
	}
	return compactJSON(out)
}

func v2Source(s string) bool {
	switch s {
	case "workbench", "renderer_uncaught", "renderer_rejection":
		return true
	default:
		return false
	}
}

func v2Code(s string) bool {
	i := strings.IndexByte(s, ':')
	if i < 1 || i == len(s)-1 {
		return false
	}
	stage, rest := s[:i], s[i+1:]
	if len(rest) < 1 || len(rest) > 64 {
		return false
	}
	for j := 0; j < len(stage); j++ {
		if stage[j] < 'a' || stage[j] > 'z' {
			return false
		}
	}
	for j := 0; j < len(rest); j++ {
		c := rest[j]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-') {
			return false
		}
	}
	return true
}

func decodeParams(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		return json.RawMessage("{}"), nil
	}
	fields, err := parseObject(string(raw))
	if err != nil {
		return nil, kindErr("params 必须是对象")
	}
	allow := map[string]bool{"imageIndex": true, "occurrences": true}
	if key := firstUnknown(fields, allow); key != "" {
		return nil, kindErr("params 含有未允许字段: " + key)
	}
	o := ordered{vals: map[string]json.RawMessage{}}
	m := fieldMap(fields)
	for _, key := range []string{"imageIndex", "occurrences"} {
		raw, ok := m[key]
		if !ok {
			continue
		}
		n, ok := jsonInt(raw)
		if !ok {
			return nil, kindErr("params." + key + " 必须是整数")
		}
		o.keys = append(o.keys, key)
		o.vals[key] = rawInt(n)
	}
	b, err := o.MarshalJSON()
	return b, err
}

func decodeFrames(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		return json.RawMessage("[]"), nil
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil || (len(raw) > 0 && raw[0] != '[') {
		return nil, kindErr("frames 必须是数组")
	}
	if len(items) > 20 {
		return nil, kindErr("frames 最多 20 条")
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		s, ok := jsonString(item)
		if !ok || len(s) < 1 || len(s) > 200 || !frameOK(s) {
			return nil, kindErr("frames 含有不合规帧")
		}
		out = append(out, s)
	}
	b, err := compactJSON(out)
	return json.RawMessage(b), err
}

func frameOK(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '_' || c == ':' || c == '<' || c == '>' || c == '.' || c == '$' || c == '-':
		default:
			return false
		}
	}
	return true
}

func appCharset(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		return true
	case c == '_' || c == '.' || c == ':' || c == '-':
		return true
	default:
		return false
	}
}

func tokenOK(s string, min, max int, ok func(byte) bool) bool {
	if len(s) < min || len(s) > max {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !ok(cByte(s[i])) {
			return false
		}
	}
	return true
}

func cByte(c byte) byte { return c }

func decodeOS(raw json.RawMessage) (json.RawMessage, error) {
	fields, err := parseObject(string(raw))
	if err != nil {
		return nil, kindErr("os 必须是对象")
	}
	allow := map[string]bool{"name": true, "version": true, "arch": true}
	if key := firstUnknown(fields, allow); key != "" {
		return nil, kindErr("os 含有未允许字段: " + key)
	}
	m := fieldMap(fields)
	o := ordered{vals: map[string]json.RawMessage{}}
	for _, key := range []string{"name", "version", "arch"} {
		s, ok := jsonString(m[key])
		if !ok || !tokenOK(s, 1, 32, appCharset) {
			return nil, kindErr("os." + key + " 无效")
		}
		o.keys = append(o.keys, key)
		o.vals[key] = rawString(s)
	}
	b, err := o.MarshalJSON()
	return b, err
}

func draftOK(s string) bool {
	const prefix = "workflow_instance_"
	if !strings.HasPrefix(s, prefix) {
		return false
	}
	rest := s[len(prefix):]
	if len(rest) < 1 || len(rest) > 64 {
		return false
	}
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return false
		}
	}
	return true
}

func decodeAITokens(payload string) (string, error) {
	fields, err := parseObject(payload)
	if err != nil {
		if err.Error() == "not-object" {
			return "", kindErr("billing.ai-token-usage 必须是对象")
		}
		return "", err
	}
	allow := map[string]bool{
		"schemaVersion": true, "provider": true, "model": true, "inputTokens": true,
		"outputTokens": true, "totalTokens": true, "occurredAt": true, "responseId": true,
	}
	if key := firstUnknown(fields, allow); key != "" {
		return "", kindErr("payload 含有未允许字段: " + key)
	}
	m := fieldMap(fields)
	ver, ok := jsonInt(m["schemaVersion"])
	if !ok || ver != 1 {
		return "", kindErr("payload.schemaVersion 必须为 1")
	}
	provider, ok := jsonString(m["provider"])
	if !ok || strings.TrimSpace(provider) == "" || len(strings.TrimSpace(provider)) > 64 {
		return "", kindErr("provider 无效")
	}
	provider = strings.TrimSpace(provider)
	model, ok := jsonString(m["model"])
	if !ok || len(model) > 128 {
		return "", kindErr("model 无效")
	}
	in, ok := jsonInt(m["inputTokens"])
	if !ok || in < 0 {
		return "", kindErr("inputTokens 无效")
	}
	outN, ok := jsonInt(m["outputTokens"])
	if !ok || outN < 0 {
		return "", kindErr("outputTokens 无效")
	}
	total, ok := jsonInt(m["totalTokens"])
	if !ok || total < 0 {
		return "", kindErr("totalTokens 无效")
	}
	occurred, ok := jsonString(m["occurredAt"])
	if !ok || !parseRFC3339(occurred) {
		return "", kindErr("occurredAt 无效")
	}
	o := ordered{keys: []string{"schemaVersion", "provider", "model", "inputTokens", "outputTokens", "totalTokens", "occurredAt"}, vals: map[string]json.RawMessage{
		"schemaVersion": rawInt(1),
		"provider":      rawString(provider),
		"model":         rawString(model),
		"inputTokens":   rawInt(in),
		"outputTokens":  rawInt(outN),
		"totalTokens":   rawInt(total),
		"occurredAt":    rawString(occurred),
	}}
	if raw, ok := m["responseId"]; ok {
		s, sok := jsonString(raw)
		if sok && s != "" && len(s) <= 255 {
			o.keys = append(o.keys, "responseId")
			o.vals["responseId"] = rawString(s)
		}
	}
	return compactJSON(o)
}

func decodeObjectUpload(payload string) (string, error) {
	fields, err := parseObject(payload)
	if err != nil {
		if err.Error() == "not-object" {
			return "", kindErr("billing.object-upload-usage 必须是对象")
		}
		return "", err
	}
	allow := map[string]bool{
		"schemaVersion": true, "bytes": true, "occurredAt": true, "objectKey": true,
		"contentHash": true, "outcome": true,
	}
	if key := firstUnknown(fields, allow); key != "" {
		return "", kindErr("payload 含有未允许字段: " + key)
	}
	m := fieldMap(fields)
	ver, ok := jsonInt(m["schemaVersion"])
	if !ok || ver != 1 {
		return "", kindErr("payload.schemaVersion 必须为 1")
	}
	n, ok := jsonInt(m["bytes"])
	if !ok || n < 0 {
		return "", kindErr("bytes 无效")
	}
	occurred, ok := jsonString(m["occurredAt"])
	if !ok || !parseRFC3339(occurred) {
		return "", kindErr("occurredAt 无效")
	}
	key, ok := jsonString(m["objectKey"])
	if !ok || len(key) > 512 {
		return "", kindErr("objectKey 无效")
	}
	hash, ok := jsonString(m["contentHash"])
	if !ok || len(hash) > 128 {
		return "", kindErr("contentHash 无效")
	}
	outcome := "uploaded"
	if raw, exists := m["outcome"]; exists {
		s, sok := jsonString(raw)
		if !sok || (s != "uploaded" && s != "deduplicated") {
			return "", kindErr("outcome 必须为 uploaded 或 deduplicated")
		}
		outcome = s
	}
	o := ordered{keys: []string{"schemaVersion", "bytes", "occurredAt", "objectKey", "contentHash", "outcome"}, vals: map[string]json.RawMessage{
		"schemaVersion": rawInt(1),
		"bytes":         rawInt(n),
		"occurredAt":    rawString(occurred),
		"objectKey":     rawString(key),
		"contentHash":   rawString(hash),
		"outcome":       rawString(outcome),
	}}
	return compactJSON(o)
}

func decodeErrorFeedback(payload, id string) (string, error) {
	if len(payload) > 2048 {
		return "", kindErr("error feedback 格式无效")
	}
	fields, err := parseObject(payload)
	if err != nil {
		return "", kindErr("error feedback 格式无效")
	}
	allow := map[string]bool{
		"errorId": true, "code": true, "traceId": true, "status": true, "stage": true,
		"rowId": true, "cardId": true, "appVersion": true, "userId": true, "workspaceId": true,
		"userAgent": true, "requestId": true, "apiPath": true, "apiStatus": true,
		"refusalReason": true, "media": true,
	}
	if key := firstUnknown(fields, allow); key != "" {
		return "", kindErr("error feedback 格式无效")
	}
	m := fieldMap(fields)
	errorID, ok := jsonString(m["errorId"])
	if !ok || errorID != id {
		return "", kindErr("error feedback 格式无效")
	}
	code, ok := jsonString(m["code"])
	if !ok || code == "" {
		return "", kindErr("error feedback 格式无效")
	}
	o := ordered{keys: []string{"errorId", "code"}, vals: map[string]json.RawMessage{
		"errorId": rawString(errorID),
		"code":    rawString(code),
	}}
	for _, key := range []string{"traceId", "status", "stage", "rowId", "cardId", "appVersion", "userId", "workspaceId", "userAgent", "requestId", "apiPath", "apiStatus", "refusalReason"} {
		raw, exists := m[key]
		if !exists {
			continue
		}
		s, sok := jsonString(raw)
		if !sok {
			return "", kindErr("error feedback 格式无效")
		}
		o.keys = append(o.keys, key)
		o.vals[key] = rawString(s)
	}
	if raw, ok := m["media"]; ok {
		if _, err := parseObject(string(raw)); err != nil {
			return "", kindErr("error feedback 格式无效")
		}
		o.keys = append(o.keys, "media")
		o.vals["media"] = raw
	}
	return compactJSON(o)
}

func decodeDesktopV4(payload, id string) (string, error) {
	if len(payload) > 16384 {
		return "", kindErr("diagnostic v4 格式无效")
	}
	fields, err := parseObject(payload)
	if err != nil {
		return "", kindErr("diagnostic v4 格式无效")
	}
	allow := map[string]bool{
		"schemaVersion": true, "diagnosticId": true, "platform": true, "stage": true,
		"field": true, "code": true, "occurredAt": true, "traceId": true,
		"payloadSha256": true, "summary": true,
	}
	for _, f := range fields {
		if !allow[f.key] {
			return "", kindErr("diagnostic v4 格式无效")
		}
	}
	m := fieldMap(fields)
	for _, key := range []string{"schemaVersion", "diagnosticId", "platform", "stage", "field", "code", "occurredAt", "traceId", "payloadSha256", "summary"} {
		if _, ok := m[key]; !ok {
			return "", kindErr("diagnostic v4 格式无效")
		}
	}
	ver, ok := jsonInt(m["schemaVersion"])
	if !ok || ver != 4 {
		return "", kindErr("diagnostic v4 格式无效")
	}
	diag, ok := jsonString(m["diagnosticId"])
	if !ok || diag == "" || diag != id {
		return "", kindErr("diagnostic v4 格式无效")
	}
	platform, ok := jsonString(m["platform"])
	if !ok || platform == "" || len(platform) > 64 {
		return "", kindErr("diagnostic v4 格式无效")
	}
	stage, ok := jsonString(m["stage"])
	if !ok || !v4Stage(stage) {
		return "", kindErr("diagnostic v4 格式无效")
	}
	if !nullableString(m["field"], 128) {
		return "", kindErr("diagnostic v4 格式无效")
	}
	code, ok := jsonString(m["code"])
	if !ok || !v4Code(code) {
		return "", kindErr("diagnostic v4 格式无效")
	}
	occurred, ok := jsonString(m["occurredAt"])
	if !ok || !parseRFC3339(occurred) {
		return "", kindErr("diagnostic v4 格式无效")
	}
	trace, ok := jsonString(m["traceId"])
	if !ok || len(trace) > 128 {
		return "", kindErr("diagnostic v4 格式无效")
	}
	if !nullableSHA(m["payloadSha256"]) {
		return "", kindErr("diagnostic v4 格式无效")
	}
	summary, err := decodeV4Summary(m["summary"])
	if err != nil {
		return "", err
	}
	if summary != "[]" && string(m["payloadSha256"]) == "null" {
		return "", kindErr("diagnostic v4 格式无效")
	}
	o := ordered{keys: []string{"schemaVersion", "diagnosticId", "platform", "stage", "field", "code", "occurredAt", "traceId", "payloadSha256", "summary"}, vals: map[string]json.RawMessage{
		"schemaVersion": rawInt(4),
		"diagnosticId":  rawString(diag),
		"platform":      rawString(platform),
		"stage":         rawString(stage),
		"field":         m["field"],
		"code":          rawString(code),
		"occurredAt":    rawString(occurred),
		"traceId":       rawString(trace),
		"payloadSha256": m["payloadSha256"],
		"summary":       json.RawMessage(summary),
	}}
	if string(m["field"]) != "null" {
		s, _ := jsonString(m["field"])
		o.vals["field"] = rawString(s)
	}
	if string(m["payloadSha256"]) != "null" {
		s, _ := jsonString(m["payloadSha256"])
		o.vals["payloadSha256"] = rawString(strings.ToLower(s))
	}
	return compactJSON(o)
}

func nullableString(raw json.RawMessage, max int) bool {
	if string(raw) == "null" {
		return true
	}
	s, ok := jsonString(raw)
	return ok && len(s) <= max
}

func nullableSHA(raw json.RawMessage) bool {
	if string(raw) == "null" {
		return true
	}
	s, ok := jsonString(raw)
	return ok && len(s) == 64 && asciiHex(s)
}

func v4Stage(s string) bool {
	switch s {
	case "import", "edit", "prepare", "validate", "build", "freeze", "preview", "pre_dispatch", "submit", "reconcile", "repair", "result":
		return true
	default:
		return false
	}
}

func v4Code(s string) bool {
	switch s {
	case "contract_violation", "unclassified_server", "wasm_exception", "result_unknown":
		return true
	default:
		return false
	}
}

func decodeV4Summary(raw json.RawMessage) (string, error) {
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil || (len(bytes.TrimSpace(raw)) > 0 && bytes.TrimSpace(raw)[0] != '[') {
		return "", kindErr("diagnostic v4 格式无效")
	}
	if len(items) > 32 {
		return "", kindErr("diagnostic v4 格式无效")
	}
	var buf bytes.Buffer
	buf.WriteByte('[')
	for i, item := range items {
		fields, err := parseObject(string(item))
		if err != nil {
			return "", kindErr("diagnostic v4 格式无效")
		}
		allow := map[string]bool{"field": true, "fieldId": true, "valueType": true, "length": true, "enumValue": true}
		for _, f := range fields {
			if !allow[f.key] {
				return "", kindErr("diagnostic v4 格式无效")
			}
		}
		m := fieldMap(fields)
		for _, key := range []string{"field", "fieldId", "valueType", "length", "enumValue"} {
			if _, ok := m[key]; !ok {
				return "", kindErr("diagnostic v4 格式无效")
			}
		}
		fieldName, ok := jsonString(m["field"])
		if !ok || fieldName == "" || len(fieldName) > 64 {
			return "", kindErr("diagnostic v4 格式无效")
		}
		if !nullableString(m["fieldId"], 128) {
			return "", kindErr("diagnostic v4 格式无效")
		}
		vt, ok := jsonString(m["valueType"])
		if !ok || !v4ValueType(vt) {
			return "", kindErr("diagnostic v4 格式无效")
		}
		if string(m["length"]) != "null" {
			n, ok := jsonInt(m["length"])
			if !ok || n < 0 {
				return "", kindErr("diagnostic v4 格式无效")
			}
		}
		if string(m["enumValue"]) != "null" {
			ev, ok := jsonString(m["enumValue"])
			if !ok || !v4Enum(ev) {
				return "", kindErr("diagnostic v4 格式无效")
			}
		}
		if i > 0 {
			buf.WriteByte(',')
		}
		row := ordered{keys: []string{"field", "fieldId", "valueType", "length", "enumValue"}, vals: map[string]json.RawMessage{
			"field": rawString(fieldName), "fieldId": m["fieldId"], "valueType": rawString(vt),
			"length": m["length"], "enumValue": m["enumValue"],
		}}
		if string(m["fieldId"]) != "null" {
			s, _ := jsonString(m["fieldId"])
			row.vals["fieldId"] = rawString(s)
		}
		if string(m["length"]) != "null" {
			n, _ := jsonInt(m["length"])
			row.vals["length"] = rawInt(n)
		}
		if string(m["enumValue"]) != "null" {
			s, _ := jsonString(m["enumValue"])
			row.vals["enumValue"] = rawString(s)
		}
		b, err := row.MarshalJSON()
		if err != nil {
			return "", err
		}
		buf.Write(b)
	}
	buf.WriteByte(']')
	return buf.String(), nil
}

func v4ValueType(s string) bool {
	switch s {
	case "null", "boolean", "number", "string", "array", "object":
		return true
	default:
		return false
	}
}

func v4Enum(s string) bool {
	switch s {
	case "RUB", "USD", "EUR", "CNY", "mm", "cm", "m", "g", "kg":
		return true
	default:
		return false
	}
}
