package seal

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// StoredPaymentConfig is StoredConfig.payment. The segment itself is optional
// on StoredConfig; when present, providers is required.
type StoredPaymentConfig struct {
	Providers []StoredPaymentProvider `json:"providers"`
}

// StoredPaymentProvider is one channel row. values keys stay as stored;
// JSON object order is not significant, and encoding/json sorts them.
type StoredPaymentProvider struct {
	Provider string            `json:"provider"`
	Enabled  bool              `json:"enabled"`
	Values   map[string]string `json:"values"`
}

// UnmarshalJSON rejects a missing providers field and any unknown key.
// serde missing-field is a snapshot parse failure, not an empty list.
func (p *StoredPaymentConfig) UnmarshalJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	var obj map[string]json.RawMessage
	if err := dec.Decode(&obj); err != nil {
		return err
	}
	if dec.More() {
		return fmt.Errorf("trailing payment json")
	}
	raw, ok := obj["providers"]
	if !ok {
		return fmt.Errorf("missing field `providers`")
	}
	for key := range obj {
		if key != "providers" {
			return fmt.Errorf("unknown field `%s`", key)
		}
	}
	if string(raw) == "null" {
		return fmt.Errorf("invalid type: null, expected a sequence")
	}
	var providers []StoredPaymentProvider
	if err := json.Unmarshal(raw, &providers); err != nil {
		return err
	}
	if providers == nil {
		providers = []StoredPaymentProvider{}
	}
	p.Providers = providers
	return nil
}

func (p *StoredPaymentProvider) UnmarshalJSON(b []byte) error {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(b, &obj); err != nil {
		return err
	}
	for key := range obj {
		switch key {
		case "provider", "enabled", "values":
		default:
			return fmt.Errorf("unknown field `%s`", key)
		}
	}
	for _, key := range []string{"provider", "enabled", "values"} {
		if _, ok := obj[key]; !ok {
			return fmt.Errorf("missing field `%s`", key)
		}
	}
	if err := json.Unmarshal(obj["provider"], &p.Provider); err != nil {
		return err
	}
	if err := json.Unmarshal(obj["enabled"], &p.Enabled); err != nil {
		return err
	}
	if string(obj["values"]) == "null" {
		return fmt.Errorf("invalid type: null, expected a map")
	}
	p.Values = map[string]string{}
	if err := json.Unmarshal(obj["values"], &p.Values); err != nil {
		return err
	}
	if p.Values == nil {
		p.Values = map[string]string{}
	}
	return nil
}
