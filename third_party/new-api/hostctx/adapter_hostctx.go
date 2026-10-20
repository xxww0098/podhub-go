// Package hostctx is a podhub adapter. It replaces the three gin symbols the
// copied formula files name in signatures and literals, so the billing
// packages do not link gin.
//
//   - Context stands in for *gin.Context. Get, GetString, and GetBool are the
//     bodies of gin v1.10.1 context.go; Request is the same field.
//   - H is gin.H (map[string]any). gin's MarshalXML is not copied; nothing
//     here encodes H as XML.
//   - Validator stands in for gin/binding.Validator. It is nil, so
//     common.DecodeJsonWithValidation only decodes. That function has no
//     caller in this module or in podhub.
package hostctx

import (
	"net/http"
	"sync"
)

type H map[string]any

type Context struct {
	Request *http.Request

	mu   sync.RWMutex
	Keys map[string]any
}

func (c *Context) Get(key string) (value any, exists bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	value, exists = c.Keys[key]
	return
}

func (c *Context) GetString(key string) (s string) {
	if val, ok := c.Get(key); ok && val != nil {
		s, _ = val.(string)
	}
	return
}

func (c *Context) GetBool(key string) (b bool) {
	if val, ok := c.Get(key); ok && val != nil {
		b, _ = val.(bool)
	}
	return
}

type StructValidator interface {
	ValidateStruct(any) error
}

var Validator StructValidator
