package config

import (
	"os"
	"reflect"
	"testing"
)

func TestMCPDefaults(t *testing.T) {
	t.Setenv(envMCPHosts, "sentinel")
	t.Setenv(envMCPOrigins, "sentinel")
	t.Setenv(envMCPRunner, "sentinel")
	os.Unsetenv(envMCPHosts)
	os.Unsetenv(envMCPOrigins)
	os.Unsetenv(envMCPRunner)
	got := Load().MCPSettings()
	if got.AllowedHosts != nil || got.AllowedOrigins != nil || got.RunnerPath != defaultMCPRunner {
		t.Fatalf("%+v", got)
	}
}

func TestMCPParsesCommaListsAndBlankRunner(t *testing.T) {
	t.Setenv(envMCPHosts, " mcp.example , 127.0.0.1:8080, ,")
	t.Setenv(envMCPOrigins, " https://app.example ")
	t.Setenv(envMCPRunner, "  ")
	got := Load().MCPSettings()
	if !reflect.DeepEqual(got.AllowedHosts, []string{"mcp.example", "127.0.0.1:8080"}) {
		t.Fatalf("hosts %#v", got.AllowedHosts)
	}
	if !reflect.DeepEqual(got.AllowedOrigins, []string{"https://app.example"}) {
		t.Fatalf("origins %#v", got.AllowedOrigins)
	}
	if got.RunnerPath != defaultMCPRunner {
		t.Fatalf("runner %q", got.RunnerPath)
	}
	t.Setenv(envMCPRunner, "custom-runner")
	if Load().MCPSettings().RunnerPath != "custom-runner" {
		t.Fatal(Load().MCPSettings().RunnerPath)
	}
}
