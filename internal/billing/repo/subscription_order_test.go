package billingrepo

import (
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/billing/domain"
)

func TestQuotedChangePeriods(t *testing.T) {
	now := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
	p := domain.Period{ID: 1, Start: now.Add(-time.Hour), End: now.Add(time.Hour),
		Target: domain.Target{PlanKey: "lite"}, PlanStores: 5, PlanMembers: 1, PlanMonthlyCents: 10000}
	appended := p
	appended.ID, appended.Start, appended.End = 2, p.End, p.End.Add(time.Hour)
	shortened, repriced, relisted := p, p, p
	shortened.End = p.End.Add(-time.Minute)
	repriced.PlanMonthlyCents++
	relisted.KeepStores = []string{"new-retention-choice"}
	for _, tc := range []struct {
		name    string
		quoted  []domain.Period
		current []domain.Period
		at      time.Time
		want    int
		bad     bool
	}{
		{"exclude appended purchase", []domain.Period{p}, []domain.Period{p, appended}, now, 1, false},
		{"retention edit keeps price", []domain.Period{p}, []domain.Period{relisted}, now, 1, false},
		{"expired quote grants nothing", []domain.Period{p}, []domain.Period{appended}, p.End, 0, false},
		{"missing snapshot", nil, []domain.Period{p}, now, 0, true},
		{"replaced period", []domain.Period{p}, []domain.Period{appended}, now, 0, true},
		{"shortened interval", []domain.Period{p}, []domain.Period{shortened}, now, 0, true},
		{"changed purchase price", []domain.Period{p}, []domain.Period{repriced}, now, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := quotedChangePeriods(tc.quoted, tc.current, tc.at)
			if (err != nil) != tc.bad || (!tc.bad && len(got) != tc.want) {
				t.Fatalf("selected=%+v err=%v", got, err)
			}
			if !tc.bad && len(got) > 0 && got[0].ID != p.ID {
				t.Fatalf("selected unquoted period: %+v", got)
			}
		})
	}
}
