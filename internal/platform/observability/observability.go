// Package observability installs slog and the process OpenTelemetry tracer.
//
// Spans are always created in process. They leave the process only when
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT names a loopback collector; otherwise
// no exporter is registered and nothing is dialed. Trace context is not
// propagated in outbound headers: no global propagator is set.
package observability

import (
	"context"
	"log/slog"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"
)

// Init sets the process logger and tracer provider. The returned shutdown
// flushes the exporter when one is configured. An invalid endpoint is
// logged and leaves the exporter off; it does not stop the process.
func Init(service string, cfg config.Config) (func(context.Context) error, error) {
	base := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})
	slog.SetDefault(slog.New(traceHandler{base}).With("service", service))
	opts := []sdktrace.TracerProviderOption{
		sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", service))),
	}
	endpoint, err := cfg.OTLPTracesEndpoint()
	if err != nil {
		slog.Error("otlp exporter stays off", "err", err)
	}
	if endpoint != "" {
		opts = append(opts, sdktrace.WithBatcher(newOTLPExporter(endpoint, httpx.Restricted())))
	}
	provider := sdktrace.NewTracerProvider(opts...)
	otel.SetTracerProvider(provider)
	return provider.Shutdown, nil
}
