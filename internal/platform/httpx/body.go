package httpx

import "io"

// ReadLimit reads at most limit bytes, then discards the rest so the
// connection can return to the idle pool. limit <= 0 reads until EOF.
// The returned slice is the prefix io.LimitReader would have returned.
// An error from the discard does not replace a successful prefix read.
// A slow discard still runs inside the request deadline. body is closed.
func ReadLimit(body io.ReadCloser, limit int64) ([]byte, error) {
	if body == nil {
		return nil, nil
	}
	defer body.Close()
	var (
		raw []byte
		err error
	)
	if limit > 0 {
		raw, err = io.ReadAll(io.LimitReader(body, limit))
	} else {
		raw, err = io.ReadAll(body)
	}
	_, _ = io.Copy(io.Discard, body)
	return raw, err
}

// Discard reads a response body to EOF and closes it so the connection
// can be reused. A nil body is ignored. The bytes are not returned.
func Discard(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, body)
	_ = body.Close()
}
