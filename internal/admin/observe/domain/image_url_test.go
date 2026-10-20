package domain

import "testing"

func TestClassifyImageFixture(t *testing.T) {
	class, url := ClassifyImage(" https://CDN1.ozone.ru/s3/multimedia-1/6010930878.jpg ")
	if class != ImageProxy || url != "https://cdn1.ozone.ru/s3/multimedia-1/6010930878.jpg" {
		t.Fatal(class, url)
	}
	class, url = ClassifyImage("http://ir.ozone.ru/s3/multimedia-1-y/wc200/1.jpg")
	if class != ImageProxy || url != "https://ir.ozone.ru/s3/multimedia-1-y/wc200/1.jpg" {
		t.Fatal(class, url)
	}
	class, url = ClassifyImage("http://cdn1.ozone.ru:80/a.jpg")
	if class != ImageProxy || url != "https://cdn1.ozone.ru/a.jpg" {
		t.Fatal(class, url)
	}
	if class, _ := ClassifyImage("https://cdn.example/p.jpg"); class != ImageDirect {
		t.Fatal(class)
	}
	if class, _ := ClassifyImage("https://cdn1.ozone.ru.evil.com/a.jpg"); class != ImageDirect {
		t.Fatal("suffix", class)
	}
	for _, raw := range []string{"http://cdn.example/p.jpg", "/s3/a.jpg", "javascript:alert(1)", "  ", "https://user:secret@cdn1.ozone.ru/a.jpg", "https://cdn1.ozone.ru:8443/a.jpg"} {
		if class, _ := ClassifyImage(raw); class != ImageDrop {
			t.Fatal(raw, class)
		}
	}
	if class, _ := ClassifyImage("https://127.0.0.1/a.jpg"); class != ImageDirect {
		t.Fatal("ip")
	}
	shown, ok := AdminImageURL("11111111-1111-4111-8111-111111111111", 42, "https://cdn1.ozone.ru/s3/a.jpg")
	if !ok || shown == "" || shown == AdminImageURLMust(t, "https://cdn1.ozone.ru/s3/b.jpg") {
		t.Fatal(shown)
	}
	if !hasPrefix(shown, "/api/admin/stores/11111111-1111-4111-8111-111111111111/products/42/thumbnail?v=") {
		t.Fatal(shown)
	}
	again, _ := AdminImageURL("11111111-1111-4111-8111-111111111111", 42, "https://cdn1.ozone.ru/s3/a.jpg")
	if shown != again {
		t.Fatal("unstable")
	}
	direct, ok := AdminImageURL("store", 7, "https://cdn.example/p.jpg")
	if !ok || direct != "https://cdn.example/p.jpg" {
		t.Fatal(direct, ok)
	}
	hop, ok := NextHop("https://cdn1.ozone.ru/s3/old.jpg", "https://ir.ozone.ru/s3/new.jpg")
	if !ok || hop == "" {
		t.Fatal(hop, ok)
	}
	if _, ok := NextHop("https://cdn1.ozone.ru/s3/old.jpg", "https://evil.example/a.jpg"); ok {
		t.Fatal("evil")
	}
	if _, ok := NextHop("https://cdn1.ozone.ru/s3/old.jpg", "https://cdn1.ozone.ru.evil.com/a.jpg"); ok {
		t.Fatal("suffix hop")
	}
	if sniff := SniffImage([]byte{0xFF, 0xD8, 0xFF, 0x00}); sniff != "image/jpeg" {
		t.Fatal(sniff)
	}
	if SniffImage([]byte("<html><script>")) != "" {
		t.Fatal("html")
	}
}

func AdminImageURLMust(t *testing.T, raw string) string {
	t.Helper()
	got, ok := AdminImageURL("11111111-1111-4111-8111-111111111111", 42, raw)
	if !ok {
		t.Fatal(raw)
	}
	return got
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
