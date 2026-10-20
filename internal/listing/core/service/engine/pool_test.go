package engine

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"testing"

	"github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

func TestBannedOutcomeOrderUnderPool(t *testing.T) {
	eng, err := openSized(context.Background(), embeddedTagsWASM, 2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = eng.Close(context.Background()) })
	rules := []Rule{{Term: "сигарета", MatchMode: "stem"}}
	tags := []string{"#роза", "#сигареты"}
	want, err := eng.Call(context.Background(), "partition", "", "", "", tags, rules)
	if err != nil {
		t.Fatal(err)
	}
	if len(want.Kept) != 1 || want.Kept[0] != "#роза" || len(want.Rejected) != 1 || want.Rejected[0] != "#сигареты" {
		t.Fatalf("order %+v", want)
	}
	var wg sync.WaitGroup
	errc := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := eng.Call(context.Background(), "partition", "", "", "", tags, rules)
			if err != nil {
				errc <- err
				return
			}
			if len(got.Kept) != 1 || got.Kept[0] != want.Kept[0] || len(got.Rejected) != 1 || got.Rejected[0] != want.Rejected[0] {
				errc <- fmt.Errorf("order %+v", got)
			}
		}()
	}
	wg.Wait()
	close(errc)
	for err := range errc {
		t.Error(err)
	}
}

func TestTrapDropsOnlyThatTagsGuest(t *testing.T) {
	eng, err := openSized(context.Background(), embeddedTagsWASM, 2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = eng.Close(context.Background()) })
	ctx := context.Background()
	a, err := eng.pool.Borrow(ctx)
	if err != nil {
		t.Fatal(err)
	}
	b, err := eng.pool.Borrow(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := eng.instance(ctx, a); err != nil {
		t.Fatal(err)
	}
	if _, err := eng.instance(ctx, b); err != nil {
		t.Fatal(err)
	}
	live := b.Guest
	a.Close(ctx)
	eng.pool.Return(a)
	rules := []contract.Rule{{Term: "сигарета", MatchMode: "stem"}}
	got, err := eng.Call(ctx, "partition", "", "", "", []string{"#роза", "#сигареты"}, rules)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Kept) != 1 || got.Kept[0] != "#роза" || len(got.Rejected) != 1 || got.Rejected[0] != "#сигареты" {
		t.Fatalf("%+v", got)
	}
	if b.Guest != live {
		t.Fatal("trap dropped the other instance")
	}
	eng.pool.Return(b)
}

func BenchmarkListingTagsPool(b *testing.B) {
	rules := []Rule{{Term: "сигарета", MatchMode: "stem"}}
	tags := []string{"#роза", "#сигареты"}
	for _, size := range []int{2, runtime.GOMAXPROCS(0)} {
		for _, conc := range []int{1, 8} {
			b.Run(fmt.Sprintf("pool%d/conc%d", size, conc), func(b *testing.B) {
				eng, err := openSized(context.Background(), embeddedTagsWASM, size)
				if err != nil {
					b.Fatal(err)
				}
				b.Cleanup(func() { _ = eng.Close(context.Background()) })
				reportTags(b, conc, func() error {
					got, err := eng.Call(context.Background(), "partition", "", "", "", tags, rules)
					if err != nil {
						return err
					}
					if len(got.Kept) != 1 || got.Kept[0] != "#роза" || len(got.Rejected) != 1 || got.Rejected[0] != "#сигареты" {
						return fmt.Errorf("order %+v", got)
					}
					return nil
				})
			})
		}
	}
}
