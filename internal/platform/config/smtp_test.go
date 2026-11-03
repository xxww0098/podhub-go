package config

import (
	"reflect"
	"testing"
)

func TestSMTPCapturesSettingsWithoutTrimmingPassword(t *testing.T) {
	for key, value := range map[string]string{
		"CLOUD_SMTP_ADDR": " smtp.example.invalid:587 ", "CLOUD_SMTP_USERNAME": " sender@example.invalid ",
		"CLOUD_SMTP_PASSWORD": " secret with spaces ", "CLOUD_SMTP_FROM": " PodHub <sender@example.invalid> ",
		"CLOUD_SMTP_TLS_MODE": " TLS ", "CLOUD_PUBLIC_URL": " https://podhub.example.invalid ",
	} {
		t.Setenv(key, value)
	}
	cfg := Load()
	want := SMTPSettings{Addr: "smtp.example.invalid:587", Username: "sender@example.invalid", Password: " secret with spaces ", From: "PodHub <sender@example.invalid>", TLSMode: "tls"}
	if !reflect.DeepEqual(cfg.SMTP, want) || cfg.PublicURL != "https://podhub.example.invalid" {
		t.Fatal("SMTP configuration was not captured correctly")
	}
	t.Setenv("CLOUD_SMTP_PASSWORD", "replacement")
	if cfg.SMTP.Password != want.Password {
		t.Fatal("SMTP credentials changed after startup")
	}
}

func TestSMTPDefaultsToSTARTTLSWithoutEnablingMail(t *testing.T) {
	for _, key := range []string{"CLOUD_SMTP_ADDR", "CLOUD_SMTP_USERNAME", "CLOUD_SMTP_PASSWORD", "CLOUD_SMTP_FROM", "CLOUD_SMTP_TLS_MODE", "CLOUD_PUBLIC_URL"} {
		t.Setenv(key, "")
	}
	cfg := Load()
	if cfg.SMTP.Addr != "" || cfg.SMTP.From != "" || cfg.SMTP.TLSMode != "starttls" || cfg.PublicURL != "" {
		t.Fatal("empty settings enabled SMTP or removed the TLS default")
	}
}
