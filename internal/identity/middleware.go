package identity

import "net/http"

func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" || (r.Header.Get("Cookie") == "" && r.Header.Get("Authorization") == "") {
			next.ServeHTTP(w, r)
			return
		}
		class := Classify(r.URL.Path, r.Method)
		_, token, acc, err := s.resolveRequest(r)
		if err != nil {
			writeCloudRetry(w, http.StatusServiceUnavailable, "服务繁忙，请稍后重试", 1)
			return
		}
		if token == "" {
			next.ServeHTTP(w, r)
			return
		}
		release, status, message, retry := s.admission.Admit(acc.id, class)
		if release == nil {
			writeCloudRetry(w, status, message, retry)
			return
		}
		defer release()
		next.ServeHTTP(w, r)
	})
}
