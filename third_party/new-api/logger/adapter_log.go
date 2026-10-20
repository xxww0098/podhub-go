package logger

import "fmt"

// Podhub adapter. logger/logger.go was not copied: it formats quota for the
// new-api console and reads display settings. Settlement does not call these.
// FormatQuota here prints the integer so a future log line cannot be mistaken
// for a second rounding step. ctx is any because callers pass
// *hostctx.Context, which is not a context.Context; nothing reads it.

func LogDebug(ctx any, msg string, args ...any) {}

func LogWarn(ctx any, msg string, args ...any) {}

func LogError(ctx any, msg string) {}

func FormatQuota(quota int) string { return fmt.Sprintf("%d", quota) }
