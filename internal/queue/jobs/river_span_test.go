package jobs

import (
	"context"
	"errors"
	"testing"

	"github.com/riverqueue/river/rivertype"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestWorkSpanReturnsWorkerErrorUnchanged(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(prev) })

	job := &rivertype.JobRow{ID: 9, Kind: "podhub.noop", Queue: "default", Attempt: 2}
	boom := errors.New("boom")
	var inner context.Context
	err := workSpan.Work(context.Background(), job, func(ctx context.Context) error {
		inner = ctx
		return boom
	})
	if err != boom {
		t.Fatalf("err %v", err)
	}
	if err := workSpan.Work(context.Background(), job, func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	ended := recorder.Ended()
	if len(ended) != 2 {
		t.Fatalf("%d spans", len(ended))
	}
	first := ended[0]
	if first.Name() != "river.work podhub.noop" || first.SpanKind() != trace.SpanKindConsumer || first.Status().Code != codes.Error {
		t.Fatalf("%s %v %v", first.Name(), first.SpanKind(), first.Status())
	}
	if trace.SpanContextFromContext(inner).SpanID() != first.SpanContext().SpanID() {
		t.Fatal("worker did not run inside the span")
	}
	if ended[1].Status().Code != codes.Unset {
		t.Fatalf("success status %v", ended[1].Status())
	}
}
