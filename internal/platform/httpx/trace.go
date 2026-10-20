package httpx

import (
	"net/http"
	"strconv"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// traced records one client span per request. It does not touch the
// request headers, so no trace context reaches the remote host, and it does
// not wrap the response body, so streamed bodies are read unchanged.
type traced struct {
	base *http.Transport
}

func (t traced) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx, span := otel.Tracer("podhub/httpx").Start(req.Context(), "HTTP "+req.Method,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("http.request.method", req.Method),
			attribute.String("server.address", req.URL.Hostname()),
			attribute.String("url.path", req.URL.Path),
		))
	defer span.End()
	res, err := t.base.RoundTrip(req.WithContext(ctx))
	if err != nil {
		span.SetStatus(codes.Error, err.Error())
		return res, err
	}
	span.SetAttributes(attribute.Int("http.response.status_code", res.StatusCode))
	if res.StatusCode >= 500 {
		span.SetStatus(codes.Error, strconv.Itoa(res.StatusCode))
	}
	return res, nil
}

// Base returns the shared Transport under a client transport from this
// package, or rt itself when it is not wrapped.
func Base(rt http.RoundTripper) http.RoundTripper {
	if t, ok := rt.(traced); ok {
		return t.base
	}
	return rt
}
