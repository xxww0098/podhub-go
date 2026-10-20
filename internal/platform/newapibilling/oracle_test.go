package newapibilling

import (
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
)

// Numbers below were printed by the copied functions (QuoteText, QuotePerCall,
// QuotaFromFloat, QuotaFromFloatStrict, QuotaFromDecimal) on this tree.
// The binary-exact rows match the N1 hand table. dall-e-3 is 0.04 and is
// locked to the function output, not to a hand-written product of 0.04.

func TestCopiedTextOracles(t *testing.T) {
	cases := []struct {
		name               string
		prompt, completion int
		cache, cacheCreate int
		semantic           string
		pre, settled       int
	}{
		{"gpt-4o 1000/200/100", 1000, 100, 200, 0, "", 1250, 1625},
		{"gpt-4o prompt 3", 3, 0, 0, 0, "", 3, 4},
		{"gpt-4o 1000", 1000, 0, 0, 0, "", 1250, 1250},
		{"claude semantic", 1000, 100, 200, 0, "anthropic", 1250, 1875},
		{"negative base clamp", 100, 0, 80, 50, "", 125, 128},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pre, settled, err := service.QuoteText("gpt-4o", "default", tc.prompt, tc.completion, tc.cache, tc.cacheCreate, tc.semantic)
			if err != nil {
				t.Fatal(err)
			}
			if pre != tc.pre || settled != tc.settled {
				t.Fatalf("pre=%d settled=%d want %d %d", pre, settled, tc.pre, tc.settled)
			}
		})
	}
}

func TestCopiedPerCallAndSaturation(t *testing.T) {
	sora, err := service.QuotePerCall("sora-2-pro", "default")
	if err != nil || sora != 250000 {
		t.Fatalf("sora-2-pro %d %v", sora, err)
	}

	price, ok := ratio_setting.GetModelPrice("dall-e-3", false)
	if !ok {
		t.Fatal("dall-e-3 price missing")
	}
	strict, err := common.QuotaFromFloatStrict(price * common.QuotaPerUnit)
	if err != nil {
		t.Fatal(err)
	}
	dalle, err := service.QuotePerCall("dall-e-3", "default")
	if err != nil || dalle != strict || dalle != 20000 {
		t.Fatalf("dall-e-3 quote=%d strict=%d price=%v err=%v", dalle, strict, price, err)
	}

	if got := common.QuotaFromFloat(float64(common.MaxQuota) + 42); got != common.MaxQuota {
		t.Fatalf("QuotaFromFloat sat %d", got)
	}
	if got := service.QuotaFromDecimalInt(3_000_000_000); got != common.MaxQuota {
		t.Fatalf("QuotaFromDecimal sat %d", got)
	}
	if _, err := common.QuotaFromFloatStrict(float64(common.MaxQuota) + 42); err == nil {
		t.Fatal("strict overflow returned a value")
	}

	_, _, err = service.QuoteText("no-such-model-zz", "default", 1, 0, 0, 0, "")
	if err == nil || !strings.Contains(err.Error(), "relay.model_price_not_configured") {
		t.Fatalf("unset model: %v", err)
	}
}

func TestGroupRatioZeroStaysZero(t *testing.T) {
	prev := ratio_setting.GroupRatio2JSONString()
	t.Cleanup(func() {
		if err := ratio_setting.UpdateGroupRatioByJSONString(prev); err != nil {
			t.Errorf("restore group ratio: %v", err)
		}
	})
	if err := ratio_setting.UpdateGroupRatioByJSONString(`{"zero":0}`); err != nil {
		t.Fatal(err)
	}
	pre, settled, err := service.QuoteText("gpt-4o", "zero", 1000, 100, 200, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if pre != 0 || settled != 0 {
		t.Fatalf("group ratio 0 pre=%d settled=%d", pre, settled)
	}
}
