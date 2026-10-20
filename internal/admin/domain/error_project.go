package domain

import (
	"encoding/json"
	"strings"
)

// ErrorRow is one admin error-log line. raw_payload is never set.
type ErrorRow struct {
	EventID       string  `json:"event_id"`
	WorkspaceName string  `json:"workspace_name"`
	Email         string  `json:"email"`
	DeviceUID     string  `json:"device_uid"`
	Source        string  `json:"source"`
	Code          string  `json:"code"`
	Severity      string  `json:"severity"`
	Fingerprint   *string `json:"fingerprint,omitempty"`
	Message       *string `json:"message,omitempty"`
	Params        *string `json:"params,omitempty"`
	AppVersion    *string `json:"app_version,omitempty"`
	OS            *string `json:"os,omitempty"`
	OccurredAt    *string `json:"occurred_at,omitempty"`
	ReceivedAt    string  `json:"received_at"`
	Context       *string `json:"context,omitempty"`
	Diagnostic    *string `json:"diagnostic,omitempty"`
}

// ProjectErrorLog maps a stored payload. Invalid JSON is a fault.
// v3 private-dimension rejection is not fully specified and is not applied here.
func ProjectErrorLog(kind string, eventID, device, workspace, email, received, payload string) (ErrorRow, *Fault) {
	var doc map[string]any
	if err := json.Unmarshal([]byte(payload), &doc); err != nil {
		return ErrorRow{}, Internal("INTERNAL", "诊断日志读取失败，请联系管理员核对迁移与数据库状态")
	}
	row := ErrorRow{
		EventID: eventID, WorkspaceName: workspace, Email: email, DeviceUID: device, ReceivedAt: received,
	}
	code, _ := doc["code"].(string)
	row.Code = code
	severity, _ := doc["severity"].(string)
	row.Severity = SeverityLabel(severity, code)
	if fp, ok := doc["fingerprint"].(string); ok && fp != "" {
		row.Fingerprint = &fp
	}
	if msg, ok := doc["message"].(string); ok {
		row.Message = &msg
	}
	if app, ok := doc["appVersion"].(string); ok && app != "" {
		row.AppVersion = &app
	}
	if osRaw, ok := doc["os"]; ok {
		switch value := osRaw.(type) {
		case string:
			if label := OSLabel(value); label != "" {
				row.OS = &label
			}
		default:
			encoded, _ := json.Marshal(value)
			if label := OSLabel(string(encoded)); label != "" {
				row.OS = &label
			}
		}
	}
	if occurred, ok := doc["occurredAt"]; ok {
		switch value := occurred.(type) {
		case string:
			if label := OccurredAtLabel(value); label != "" {
				row.OccurredAt = &label
			}
		case float64:
			label := OccurredAtLabel(strings.TrimRight(strings.TrimRight(formatFloat(value), "0"), "."))
			row.OccurredAt = &label
		}
	}
	switch kind {
	case "desktop_error_log.v4":
		row.Source = "workbench"
		row.Diagnostic = canonical(doc)
		row.Context = contextOf(doc, "platform", "stage", "field", "traceId")
	case "error_feedback.v1":
		row.Source = "error_feedback"
		if id, ok := doc["errorId"].(string); ok && id != "" {
			row.EventID = id
		}
		body := string(must(json.Marshal(doc)))
		row.Params = &body
		row.Diagnostic = &body
		row.Message = nil
		row.Context = contextOf(doc, "stage", "traceId", "status", "rowId", "cardId", "appVersion", "userId", "workspaceId", "userAgent", "requestId", "apiPath", "apiStatus", "media")
	case "desktop_error_log.v3":
		delete(doc, "rawPayload")
		delete(doc, "payloadSha256")
		row.Source = stringField(doc, "source")
		row.Diagnostic = canonical(doc)
		row.Context = contextOf(doc, "platform", "stage", "field", "traceId")
	default:
		row.Source = stringField(doc, "source")
		if params, ok := doc["params"]; ok {
			body := string(must(json.Marshal(params)))
			row.Params = &body
		}
	}
	return row, nil
}

func stringField(doc map[string]any, key string) string {
	value, _ := doc[key].(string)
	return value
}

func canonical(doc map[string]any) *string {
	body := string(must(json.Marshal(doc)))
	return &body
}

func contextOf(doc map[string]any, keys ...string) *string {
	out := map[string]any{}
	nested, _ := doc["context"].(map[string]any)
	for _, key := range keys {
		if value, ok := doc[key]; ok {
			out[key] = value
			continue
		}
		if value, ok := nested[key]; ok {
			out[key] = value
		}
	}
	if len(out) == 0 {
		return nil
	}
	body := string(must(json.Marshal(out)))
	return &body
}

func must(body []byte, err error) []byte {
	if err != nil {
		return []byte("null")
	}
	return body
}

func formatFloat(value float64) string {
	return strings.TrimSpace(strings.ReplaceAll(floatText(value), ",", ""))
}

func floatText(value float64) string {
	body, _ := json.Marshal(value)
	return string(body)
}
