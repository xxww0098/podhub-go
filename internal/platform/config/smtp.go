package config

import (
	"os"
	"strings"
)

// SMTPSettings is captured at startup; credentials are never sent to the browser.
type SMTPSettings struct {
	Addr     string
	Username string
	Password string
	From     string
	TLSMode  string
}

func loadSMTP() SMTPSettings {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("CLOUD_SMTP_TLS_MODE")))
	if mode == "" {
		mode = "starttls"
	}
	return SMTPSettings{
		Addr:     strings.TrimSpace(os.Getenv("CLOUD_SMTP_ADDR")),
		Username: strings.TrimSpace(os.Getenv("CLOUD_SMTP_USERNAME")),
		Password: os.Getenv("CLOUD_SMTP_PASSWORD"),
		From:     strings.TrimSpace(os.Getenv("CLOUD_SMTP_FROM")),
		TLSMode:  mode,
	}
}
