package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDomainsDoNotParseSwitches(t *testing.T) {
	forbidden := []string{"OZON_WRITE_KILL_SWITCH", "CLOUD_MEDIA_GC_DELETE", "os.Getenv"}
	for _, root := range []string{"../../ops", "../../automation", "../../telemetry", "../../admin", "../../mcp"} {
		err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return err
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			text := string(raw)
			for _, word := range forbidden {
				if strings.Contains(text, word) {
					t.Errorf("%s contains %s", path, word)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
