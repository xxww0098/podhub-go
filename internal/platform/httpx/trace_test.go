package httpx

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestRestrictedClientSpanLeavesRequestAndResponseAlone(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(prev) })

	var seen [3]http.Header
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen[calls] = r.Header.Clone()
		calls++
		w.Header().Set("X-Back", "1")
		w.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(w, "body-bytes")
	}))
	defer srv.Close()

	send := func(client *http.Client) (int, string, string) {
		ctx, parent := provider.Tracer("t").Start(context.Background(), "parent")
		defer parent.End()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/p?q=1", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-Api-Key", "k")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, res.Header.Get("X-Back"), string(raw)
	}
	plainStatus, plainHeader, plainBody := send(&http.Client{Transport: Restricted(), CheckRedirect: UseLast})
	tracedStatus, tracedHeader, tracedBody := send(RestrictedClient())
	ozonStatus, ozonHeader, ozonBody := send(OzonClient())

	if !reflect.DeepEqual(seen[0], seen[1]) || !reflect.DeepEqual(seen[0], seen[2]) {
		t.Fatalf("request headers changed:\n%v\n%v\n%v", seen[0], seen[1], seen[2])
	}
	if plainStatus != tracedStatus || plainHeader != tracedHeader || plainBody != tracedBody {
		t.Fatalf("response changed: %d %q %q vs %d %q %q", plainStatus, plainHeader, plainBody, tracedStatus, tracedHeader, tracedBody)
	}
	if plainStatus != ozonStatus || plainHeader != ozonHeader || plainBody != ozonBody {
		t.Fatalf("ozon response changed: %d %q %q vs %d %q %q", plainStatus, plainHeader, plainBody, ozonStatus, ozonHeader, ozonBody)
	}

	var client sdktrace.ReadOnlySpan
	for _, s := range recorder.Ended() {
		if s.Name() == "HTTP POST" {
			client = s
		}
	}
	if client == nil {
		t.Fatal("no client span")
	}
	attrs := map[attribute.Key]attribute.Value{}
	for _, kv := range client.Attributes() {
		attrs[kv.Key] = kv.Value
	}
	if attrs["url.path"].AsString() != "/p" || attrs["http.response.status_code"].AsInt64() != http.StatusTeapot {
		t.Fatalf("attributes %v", client.Attributes())
	}
	if !client.Parent().IsValid() {
		t.Fatal("client span has no parent")
	}
}
