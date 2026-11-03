package app

import (
	"io"
	"os"
	"strings"
	"testing"
)

func TestMainRejectsInvalidDNSBeforeServing(t *testing.T) {
	t.Setenv("CLOUD_DNS_SERVER", "resolver.example:53")
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	previous := os.Stderr
	os.Stderr = write
	t.Cleanup(func() { os.Stderr = previous; read.Close(); write.Close() })
	code := Main()
	write.Close()
	os.Stderr = previous
	output, _ := io.ReadAll(read)
	if code != 1 || !strings.Contains(string(output), "dns: CLOUD_DNS_SERVER") {
		t.Fatalf("invalid DNS did not fail startup: code=%d output=%s", code, output)
	}
}
