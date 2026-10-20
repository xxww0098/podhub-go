package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

func socketCount(t *testing.T) int {
	t.Helper()
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range entries {
		target, err := os.Readlink(filepath.Join("/proc/self/fd", e.Name()))
		if err == nil && strings.HasPrefix(target, "socket:") {
			n++
		}
	}
	return n
}

func restoreGlobals(t *testing.T) {
	logger := slog.Default()
	provider := otel.GetTracerProvider()
	t.Cleanup(func() {
		slog.SetDefault(logger)
		otel.SetTracerProvider(provider)
	})
}

func TestInitWithoutEndpointOpensNoSocket(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("counts sockets through /proc/self/fd")
	}
	restoreGlobals(t)
	for _, value := range []string{"", "   ", "ftp://127.0.0.1:4318/v1/traces", "http://collector.example:4318/v1/traces", "::"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", value)
			before := socketCount(t)
			shutdown, err := Init("podhub-test", config.Load())
			if err != nil {
				t.Fatal(err)
			}
			ctx, span := otel.Tracer("test").Start(context.Background(), "work")
			slog.InfoContext(ctx, "inside span")
			span.End()
			if err := shutdown(context.Background()); err != nil {
				t.Fatal(err)
			}
			if after := socketCount(t); after != before {
				t.Fatalf("sockets before %d after %d", before, after)
			}
		})
	}
}

func TestOTLPExporterPostsJSON(t *testing.T) {
	var got []byte
	var contentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/traces" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		contentType = r.Header.Get("Content-Type")
		got, _ = io.ReadAll(r.Body)
	}))
	defer srv.Close()

	exp := newOTLPExporter(srv.URL+"/v1/traces", http.DefaultTransport)
	provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp))
	ctx, parent := provider.Tracer("scope-a").Start(context.Background(), "parent")
	_, child := provider.Tracer("scope-a").Start(ctx, "child")
	child.SetAttributes(attribute.String("s", "v"), attribute.Int64("n", 7), attribute.Bool("b", true))
	child.SetStatus(codes.Error, "boom")
	child.End()
	parent.End()
	if err := provider.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}

	if contentType != "application/json" {
		t.Fatalf("content type %q", contentType)
	}
	var req struct {
		ResourceSpans []struct {
			ScopeSpans []struct {
				Scope struct{ Name string }
				Spans []struct {
					TraceID, SpanID, ParentSpanID, Name string
					Kind                                int
					Attributes                          []struct {
						Key   string
						Value map[string]any
					}
					Status struct {
						Code    int
						Message string
					}
				}
			}
		}
	}
	if err := json.Unmarshal(got, &req); err != nil {
		t.Fatalf("%v: %s", err, got)
	}
	if len(req.ResourceSpans) != 1 || len(req.ResourceSpans[0].ScopeSpans) != 1 {
		t.Fatalf("%s", got)
	}
	ss := req.ResourceSpans[0].ScopeSpans[0]
	if ss.Scope.Name != "scope-a" || len(ss.Spans) != 2 {
		t.Fatalf("%s", got)
	}
	span, parentSpan := ss.Spans[0], ss.Spans[1]
	if parentSpan.Name != "parent" || parentSpan.ParentSpanID != "" || span.ParentSpanID != parentSpan.SpanID || span.TraceID != parentSpan.TraceID {
		t.Fatalf("%s", got)
	}
	if span.Name != "child" || span.Kind != 1 || len(span.TraceID) != 32 || len(span.SpanID) != 16 || len(span.ParentSpanID) != 16 {
		t.Fatalf("%+v", span)
	}
	if span.Status.Code != 2 || span.Status.Message != "boom" {
		t.Fatalf("status %+v", span.Status)
	}
	want := map[string]string{"s": `{"stringValue":"v"}`, "n": `{"intValue":"7"}`, "b": `{"boolValue":true}`}
	for _, kv := range span.Attributes {
		raw, _ := json.Marshal(kv.Value)
		if want[kv.Key] != string(raw) {
			t.Fatalf("%s = %s", kv.Key, raw)
		}
		delete(want, kv.Key)
	}
	if len(want) != 0 {
		t.Fatalf("missing %v", want)
	}
}

func TestTraceHandlerAddsIDsOnlyInsideSpan(t *testing.T) {
	provider := sdktrace.NewTracerProvider()
	defer provider.Shutdown(context.Background())

	var plain, wrapped bytes.Buffer
	plainLog := slog.New(slog.NewJSONHandler(&plain, nil)).With("service", "s")
	wrappedLog := slog.New(traceHandler{slog.NewJSONHandler(&wrapped, nil)}).With("service", "s")
	plainLog.Info("no context", "k", 1)
	wrappedLog.Info("no context", "k", 1)
	plainLog.InfoContext(context.Background(), "empty context")
	wrappedLog.InfoContext(context.Background(), "empty context")
	strip := func(s string) string {
		var out []string
		for _, line := range strings.Split(strings.TrimSpace(s), "\n") {
			var m map[string]any
			_ = json.Unmarshal([]byte(line), &m)
			delete(m, "time")
			raw, _ := json.Marshal(m)
			out = append(out, string(raw))
		}
		return strings.Join(out, "\n")
	}
	if strip(plain.String()) != strip(wrapped.String()) {
		t.Fatalf("without a span the record changed:\n%s\n%s", plain.String(), wrapped.String())
	}

	wrapped.Reset()
	ctx, span := provider.Tracer("t").Start(context.Background(), "op")
	wrappedLog.InfoContext(ctx, "inside")
	span.End()
	var rec map[string]any
	if err := json.Unmarshal(wrapped.Bytes(), &rec); err != nil {
		t.Fatal(err)
	}
	sc := span.SpanContext()
	if rec["trace_id"] != sc.TraceID().String() || rec["span_id"] != sc.SpanID().String() || rec["service"] != "s" {
		t.Fatalf("%v", rec)
	}
}
