package domain

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
)

func ParsePostingSnapshot(raw []byte, postingNumber string) (contract.PostingUpdate, error) {
	body := unwrapResult(raw)
	var posting struct {
		Number      string `json:"posting_number"`
		Status      string `json:"status"`
		Substatus   string `json:"substatus"`
		InProcessAt string `json:"in_process_at"`
		Shipment    string `json:"shipment_date"`
	}
	if err := json.Unmarshal(body, &posting); err != nil {
		return contract.PostingUpdate{}, err
	}
	if posting.Number != postingNumber || postingNumber == "" || strings.TrimSpace(posting.Status) == "" {
		return contract.PostingUpdate{}, errors.New("posting identity or status is missing")
	}
	logistics, err := LogisticsFromV3(raw)
	if err != nil {
		return contract.PostingUpdate{}, err
	}
	out := contract.PostingUpdate{Status: posting.Status, Snapshot: ProjectSnapshot(body)}
	if strings.TrimSpace(logistics.Warehouse+logistics.DeliveryMethod+logistics.DeliveryType+logistics.TplProvider+logistics.City+logistics.Region) != "" {
		out.Logistics, err = json.Marshal(logistics)
	}
	return out, err
}
