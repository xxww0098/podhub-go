package common

import (
	"fmt"
	"log"

	"github.com/QuantumNous/new-api/constant"

	"github.com/QuantumNous/new-api/hostctx"
)

// Podhub adapter. Not part of the verbatim copy.
//
// SysError / SysLog in new-api write through gin.DefaultErrorWriter (common/sys_log.go).
// That file also calls GetNetworkIps and IsRunningInContainer, which are outside
// the billing formula. These two functions keep the same signatures and only
// print the line. Quota numbers do not depend on the writer.
//
// LogText in new-api (common/log_text.go) formats with fmt.Sprintf when the
// translation table is nil, which is the English default. log_text.zh-CN.json
// was not copied. This matches that default path.

func SysLog(s string)   { log.Print(s) }
func SysError(s string) { log.Print(s) }

func LogText(format string, args ...any) string {
	return fmt.Sprintf(format, args...)
}

// GetContextKeyString and GetContextKeyBool are the bodies of common/gin.go
// lines 177-179 and 241-243. The rest of gin.go masks upstream hosts and was
// not copied.

func GetContextKeyString(c *hostctx.Context, key constant.ContextKey) string {
	return c.GetString(string(key))
}

func GetContextKeyBool(c *hostctx.Context, key constant.ContextKey) bool {
	return c.GetBool(string(key))
}
