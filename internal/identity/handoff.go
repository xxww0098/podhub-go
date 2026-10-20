package identity

import "time"

func newHandoffStore() *handoffStore {
	return &handoffStore{mu: make(chan struct{}, 1), items: map[string]time.Time{}}
}

func (h *handoffStore) put(code, _ string, until time.Time) {
	h.mu <- struct{}{}
	defer func() { <-h.mu }()
	now := time.Now()
	for key, exp := range h.items {
		if !exp.After(now) {
			delete(h.items, key)
		}
	}
	h.items[code] = until
}
