package readhttp_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	core "github.com/xxww0098/podhub-go/internal/listing/core"
	"github.com/xxww0098/podhub-go/internal/listing/core/service/engine"
	readhttp "github.com/xxww0098/podhub-go/internal/listing/read/http"
)

func TestValidateOCRFiltersCombinedTags(t *testing.T) {
	ctx := context.Background()
	mod, err := core.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer mod.Close(ctx)
	for _, tc := range []struct {
		name  string
		fixed []string
		theme string
		tags  []string
		rules []readhttp.Rule
		want  []string
	}{
		{"fixed and theme stems", []string{"#кружка", "#табачный"}, "Кот с вейпом", []string{"#кот_с_вейпом", "#вейп", "#вейпинг", "#дым_вейпа", "#табачный_дым"}, []readhttp.Rule{{Term: "табак", MatchMode: "stem"}, {Term: "вейп", MatchMode: "stem"}}, []string{"#кружка"}},
		{"all tags removed", []string{"#вейпы"}, "Кот с вейпом", []string{"#кот_с_вейпом", "#вейп", "#вейпинг", "#дым_вейпа", "#вейпы"}, []readhttp.Rule{{Term: "вейп", MatchMode: "stem"}}, []string{}},
		{"plain still filters fixed tags", []string{"#вейпы", "#роза"}, "", nil, []readhttp.Rule{{Term: "вейп", MatchMode: "stem"}}, []string{"#роза"}},
		{"phrase across fixed tags", []string{"#роза", "#электронная", "#сигарета", "#море"}, "", nil, []readhttp.Rule{{Term: "электронная_сигарета", MatchMode: "stem"}}, []string{"#роза", "#море"}},
		{"exact keeps inflections", []string{"#роза"}, "Розы в вазе", []string{"#розы_в_вазе", "#цветы", "#ваза", "#лепестки", "#букет"}, []readhttp.Rule{{Term: "роза", MatchMode: "exact"}}, []string{"#розы_в_вазе", "#цветы", "#ваза", "#лепестки", "#букет"}},
		{"no rules keeps order and removes fixed duplicates", []string{"#кружка", "#подарок", "#Кот"}, "Кот с чашкой", []string{"#кот", "#чашка", "#цветы", "#листья", "#тёплые_тона"}, nil, []string{"#кружка", "#подарок", "#Кот", "#чашка", "#цветы", "#листья", "#тёплые_тона"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			original := append([]string{}, tc.fixed...)
			host := readhttp.Host{Core: mod, Engine: engine.New(mod), LoadRules: func(context.Context) ([]readhttp.Rule, error) { return tc.rules, nil }}
			pin := ai.Pin{Prompt: ai.Prompt{Content: `{"product_type_ru":"Кружка","facts_ru":"330 мл"}`, FixedTags: tc.fixed}}
			state := "clear"
			description := "На рисунке изображены крупные объекты на переднем плане. Фон заполнен плавными линиями и цветными узорами."
			tags := tc.tags
			if tc.theme == "" {
				state = "plain"
				description = ""
				tags = []string{}
			}
			content, _ := json.Marshal(map[string]any{"state": state, "theme_ru": tc.theme, "description_ru": description, "tags": tags})
			completion, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(content)}}}})
			raw, err := host.ValidateOCR(ctx, pin, completion)
			if err != nil {
				t.Fatal(err)
			}
			var answer ai.Answer
			if err := json.Unmarshal(raw, &answer); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(answer.Tags, tc.want) || !reflect.DeepEqual(pin.Prompt.FixedTags, original) {
				t.Fatalf("tags %v; want %v; input %v", answer.Tags, tc.want, pin.Prompt.FixedTags)
			}
			wantTitle := "Кружка 330 мл"
			if tc.theme != "" {
				wantTitle += ` "` + tc.theme + `"`
			}
			if answer.RU != wantTitle {
				t.Fatalf("tag filtering changed title: %q", answer.RU)
			}
		})
	}
}

func TestValidateOCRTagFilterFailsClosed(t *testing.T) {
	ctx := context.Background()
	mod, err := core.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer mod.Close(ctx)
	load := func(context.Context) ([]readhttp.Rule, error) { return nil, nil }
	for _, tc := range []struct {
		name string
		host readhttp.Host
	}{
		{"missing loader", readhttp.Host{Core: mod, Engine: engine.New(mod)}},
		{"failed load", readhttp.Host{Core: mod, Engine: engine.New(mod), LoadRules: func(context.Context) ([]readhttp.Rule, error) { return nil, errors.New("rules unavailable") }}},
		{"missing matcher", readhttp.Host{Core: mod, LoadRules: load}},
		{"failed matcher", readhttp.Host{Core: mod, Engine: engine.New(nil), LoadRules: load}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pin := ai.Pin{Prompt: ai.Prompt{Content: `{"product_type_ru":"Кружка","facts_ru":""}`, FixedTags: []string{"#кружка"}}}
			raw, err := tc.host.ValidateOCR(ctx, pin, []byte(`{"choices":[{"message":{"content":"{\"state\":\"plain\",\"theme_ru\":\"\",\"description_ru\":\"\",\"tags\":[]}"}}]}`))
			var violation *ai.ContractError
			if err == nil || raw != nil || errors.As(err, &violation) {
				t.Fatalf("unavailable filtering must be retryable and return no answer: %s %v", raw, err)
			}
		})
	}
}
