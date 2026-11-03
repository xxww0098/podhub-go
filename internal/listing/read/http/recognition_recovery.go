package readhttp

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
)

type ocrAttempt struct {
	Attempt   string `json:"attempt"`
	Status    string `json:"status"`
	RequestID string `json:"request_id,omitempty"`
	Usable    *bool  `json:"result_usable,omitempty"`
}
type ocrRecovery struct {
	Attempts []ocrAttempt `json:"attempts"`
	JobState string       `json:"job_state"`
	Epoch    int64        `json:"lease_epoch"`
}

func (h Host) readOCRRecovery(r *http.Request, org int64, rowID string) (ocrRecovery, error) {
	out := ocrRecovery{Attempts: []ocrAttempt{{Attempt: "original", Status: "absent"}}}
	id, ok := CanonicalUUID(r.URL.Query().Get("jobId"))
	if !ok {
		return out, rowRefuse{400, "识别任务编号无效", "validation"}
	}
	err := h.withOrg(r.Context(), org, func(tx pgx.Tx) error {
		var key string
		var payload []byte
		err := tx.QueryRow(r.Context(), `SELECT state,lease_epoch,idempotency_key,payload FROM jobs WHERE org_id=$1 AND id=$2::uuid AND aggregate_id=$3::uuid AND kind='ai.recognize'`, org, id, rowID).Scan(&out.JobState, &out.Epoch, &key, &payload)
		if err != nil {
			return err
		}
		var pin ai.Pin
		_ = json.Unmarshal(payload, &pin)
		for i := range out.Attempts {
			attemptKey := key
			var body []byte
			err = tx.QueryRow(r.Context(), `SELECT status,public_id,response_body FROM ai_requests WHERE org_id=$1 AND job_id=$2::uuid AND operation='ocr' AND idempotency_key=$3 ORDER BY id DESC LIMIT 1`, org, id, attemptKey).Scan(&out.Attempts[i].Status, &out.Attempts[i].RequestID, &body)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			if out.Attempts[i].Status == "settled" {
				usable := false
				if h.core() != nil && len(body) > 0 {
					_, err = h.ValidateOCR(r.Context(), pin, body)
					usable = err == nil
				}
				out.Attempts[i].Usable = &usable
			}
		}
		return nil
	})
	return out, err
}
