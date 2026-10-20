package domain

import "testing"

func TestWatchCardsMatchesRust(t *testing.T) {
	one, err := WatchCards("abc:0", "4")
	if err != "" || len(one) != 1 || one[0].ID != "abc" || one[0].Seq != 4 {
		t.Fatalf("last event id: %+v %s", one, err)
	}
	many, err := WatchCards("a:1,b:2", "9")
	if err != "" || len(many) != 2 || many[0] != (WatchedCard{"a", 1}) || many[1] != (WatchedCard{"b", 2}) {
		t.Fatalf("many: %+v %s", many, err)
	}
	if _, err := WatchCards("", ""); err == "" {
		t.Fatal("empty")
	}
	if _, err := WatchCards("nope", ""); err == "" {
		t.Fatal("no colon")
	}
	if _, err := WatchCards("a:-1", ""); err == "" {
		t.Fatal("negative")
	}
	if _, err := WatchCards("a:1,a:2", ""); err != "重复的卡片" {
		t.Fatal(err)
	}
	var items []string
	for i := 0; i < 129; i++ {
		items = append(items, "c"+itoa(i)+":0")
	}
	joined := ""
	for i, item := range items {
		if i > 0 {
			joined += ","
		}
		joined += item
	}
	if _, err := WatchCards(joined, ""); err != "打开的卡片过多" {
		t.Fatal(err)
	}
}

func TestParseCardHint(t *testing.T) {
	card, seq, ok := ParseCardHint("abc 12")
	if !ok || card != "abc" || seq != 12 {
		t.Fatalf("%s %d %v", card, seq, ok)
	}
	if _, _, ok := ParseCardHint("abc"); ok {
		t.Fatal("no seq")
	}
	if _, _, ok := ParseCardHint(" 1"); ok {
		t.Fatal("blank card")
	}
}

func TestClassifyReplay(t *testing.T) {
	if page := ClassifyReplay(0, 0, 1); page.Reset || page.Overflow {
		t.Fatalf("empty head: %+v", page)
	}
	if page := ClassifyReplay(0, 65, 1); !page.Reset || !page.Overflow {
		t.Fatalf("buffer: %+v", page)
	}
	if page := ClassifyReplay(10, 9, 1); !page.Reset || page.Overflow {
		t.Fatalf("ahead: %+v", page)
	}
	if page := ClassifyReplay(0, 10, 5); !page.Reset || page.Overflow {
		t.Fatalf("behind floor: %+v", page)
	}
}

func TestKeepAliveComment(t *testing.T) {
	if SSEKeepAlive != ": ping\n\n" {
		t.Fatal(SSEKeepAlive)
	}
	if CardEventChannel != "listing_card_events" {
		t.Fatal(CardEventChannel)
	}
	if StreamLiveBuffer != 64 || StreamBatch != 32 || StreamRetainedEvents != 10_000 {
		t.Fatal("stream constants")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
