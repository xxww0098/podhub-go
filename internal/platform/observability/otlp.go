package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/xxww0098/podhub-go/internal/platform/httpx"
)

// otlpExporter posts spans as OTLP/HTTP JSON (ExportTraceServiceRequest).
// It is written here so the exporter does not pull the OTLP protobuf and
// gRPC modules into the build.
type otlpExporter struct {
	endpoint string
	client   *http.Client
}

func newOTLPExporter(endpoint string, rt http.RoundTripper) *otlpExporter {
	return &otlpExporter{
		endpoint: endpoint,
		client:   &http.Client{Transport: rt, CheckRedirect: httpx.UseLast, Timeout: 10 * time.Second},
	}
}

func (e *otlpExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	if len(spans) == 0 {
		return nil
	}
	body, err := json.Marshal(otlpRequest(spans))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := e.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("otlp export: status %d", res.StatusCode)
	}
	return nil
}

func (e *otlpExporter) Shutdown(context.Context) error { return nil }

type otlpKV struct {
	Key   string    `json:"key"`
	Value otlpValue `json:"value"`
}

type otlpValue struct {
	String *string     `json:"stringValue,omitempty"`
	Bool   *bool       `json:"boolValue,omitempty"`
	Int    *string     `json:"intValue,omitempty"`
	Double *float64    `json:"doubleValue,omitempty"`
	Array  *otlpValues `json:"arrayValue,omitempty"`
}

type otlpValues struct {
	Values []otlpValue `json:"values"`
}

type otlpSpan struct {
	TraceID      string     `json:"traceId"`
	SpanID       string     `json:"spanId"`
	ParentSpanID string     `json:"parentSpanId,omitempty"`
	Name         string     `json:"name"`
	Kind         int        `json:"kind"`
	Start        string     `json:"startTimeUnixNano"`
	End          string     `json:"endTimeUnixNano"`
	Attributes   []otlpKV   `json:"attributes,omitempty"`
	Status       otlpStatus `json:"status"`
}

type otlpStatus struct {
	Code    int    `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

type otlpScopeSpans struct {
	Scope struct {
		Name    string `json:"name"`
		Version string `json:"version,omitempty"`
	} `json:"scope"`
	Spans []otlpSpan `json:"spans"`
}

type otlpResourceSpans struct {
	Resource struct {
		Attributes []otlpKV `json:"attributes,omitempty"`
	} `json:"resource"`
	ScopeSpans []*otlpScopeSpans `json:"scopeSpans"`
}

type otlpTraceRequest struct {
	ResourceSpans []*otlpResourceSpans `json:"resourceSpans"`
}

// otlpRequest groups spans by resource and scope, keeping input order.
func otlpRequest(spans []sdktrace.ReadOnlySpan) otlpTraceRequest {
	var out otlpTraceRequest
	resources := map[string]*otlpResourceSpans{}
	scopes := map[string]*otlpScopeSpans{}
	for _, s := range spans {
		resKey := ""
		var resAttrs []attribute.KeyValue
		if res := s.Resource(); res != nil {
			resKey = res.Encoded(attribute.DefaultEncoder())
			resAttrs = res.Attributes()
		}
		rs, ok := resources[resKey]
		if !ok {
			rs = &otlpResourceSpans{}
			rs.Resource.Attributes = otlpAttrs(resAttrs)
			resources[resKey] = rs
			out.ResourceSpans = append(out.ResourceSpans, rs)
		}
		scope := s.InstrumentationScope()
		scopeKey := resKey + "\x00" + scope.Name + "\x00" + scope.Version
		ss, ok := scopes[scopeKey]
		if !ok {
			ss = &otlpScopeSpans{}
			ss.Scope.Name = scope.Name
			ss.Scope.Version = scope.Version
			scopes[scopeKey] = ss
			rs.ScopeSpans = append(rs.ScopeSpans, ss)
		}
		ss.Spans = append(ss.Spans, otlpSpanOf(s))
	}
	return out
}

func otlpSpanOf(s sdktrace.ReadOnlySpan) otlpSpan {
	sc := s.SpanContext()
	span := otlpSpan{
		TraceID:    sc.TraceID().String(),
		SpanID:     sc.SpanID().String(),
		Name:       s.Name(),
		Kind:       int(s.SpanKind()),
		Start:      strconv.FormatInt(s.StartTime().UnixNano(), 10),
		End:        strconv.FormatInt(s.EndTime().UnixNano(), 10),
		Attributes: otlpAttrs(s.Attributes()),
	}
	if p := s.Parent(); p.SpanID().IsValid() {
		span.ParentSpanID = p.SpanID().String()
	}
	// OTLP: 0 unset, 1 ok, 2 error. codes: 0 unset, 1 error, 2 ok.
	switch st := s.Status(); st.Code {
	case codes.Ok:
		span.Status.Code = 1
	case codes.Error:
		span.Status.Code = 2
		span.Status.Message = st.Description
	}
	return span
}

func otlpAttrs(kvs []attribute.KeyValue) []otlpKV {
	if len(kvs) == 0 {
		return nil
	}
	out := make([]otlpKV, 0, len(kvs))
	for _, kv := range kvs {
		out = append(out, otlpKV{Key: string(kv.Key), Value: otlpValueOf(kv.Value)})
	}
	return out
}

func otlpValueOf(v attribute.Value) otlpValue {
	switch v.Type() {
	case attribute.BOOL:
		b := v.AsBool()
		return otlpValue{Bool: &b}
	case attribute.INT64:
		s := strconv.FormatInt(v.AsInt64(), 10)
		return otlpValue{Int: &s}
	case attribute.FLOAT64:
		f := v.AsFloat64()
		return otlpValue{Double: &f}
	case attribute.BOOLSLICE:
		var vals []otlpValue
		for _, b := range v.AsBoolSlice() {
			vals = append(vals, otlpValueOf(attribute.BoolValue(b)))
		}
		return otlpValue{Array: &otlpValues{Values: vals}}
	case attribute.INT64SLICE:
		var vals []otlpValue
		for _, n := range v.AsInt64Slice() {
			vals = append(vals, otlpValueOf(attribute.Int64Value(n)))
		}
		return otlpValue{Array: &otlpValues{Values: vals}}
	case attribute.FLOAT64SLICE:
		var vals []otlpValue
		for _, f := range v.AsFloat64Slice() {
			vals = append(vals, otlpValueOf(attribute.Float64Value(f)))
		}
		return otlpValue{Array: &otlpValues{Values: vals}}
	case attribute.STRINGSLICE:
		var vals []otlpValue
		for _, s := range v.AsStringSlice() {
			vals = append(vals, otlpValueOf(attribute.StringValue(s)))
		}
		return otlpValue{Array: &otlpValues{Values: vals}}
	default:
		s := v.Emit()
		return otlpValue{String: &s}
	}
}
