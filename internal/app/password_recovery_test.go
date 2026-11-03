package app

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/mail"
)

type resetMailCapture struct {
	message mail.Message
	err     error
}

func (c *resetMailCapture) Send(_ context.Context, message mail.Message) error {
	c.message = message
	return c.err
}

func TestPasswordRecoveryRequiresEveryConfigurationDependency(t *testing.T) {
	// A canceled context proves configured recovery reaches the repository without
	// requiring a database or opening a connection to an external service.
	pool, err := pgxpool.New(context.Background(), "postgres://localhost:1/podhub?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	good := config.Config{
		PublicURL:            "https://podhub.example",
		IntegrationConfigKey: "password-recovery-test-key-at-least-32-bytes",
		SMTP:                 config.SMTPSettings{Addr: "smtp.example.invalid:587", From: "sender@example.invalid"},
	}
	if _, err := newIdentity(pool, good).DeliverPasswordResets(ctx, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("valid recovery configuration was not connected: %v", err)
	}
	for _, tc := range []struct {
		name   string
		mutate func(*config.Config)
	}{
		{"missing origin", func(c *config.Config) { c.PublicURL = "" }},
		{"unsafe origin", func(c *config.Config) { c.PublicURL = "http://podhub.example" }},
		{"short key", func(c *config.Config) { c.IntegrationConfigKey = "short" }},
		{"padded short key", func(c *config.Config) { c.IntegrationConfigKey = strings.Repeat(" ", 32) + "short" }},
		{"missing SMTP", func(c *config.Config) { c.SMTP = config.SMTPSettings{} }},
		{"invalid SMTP", func(c *config.Config) { c.SMTP.TLSMode = "plain" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := good
			tc.mutate(&cfg)
			if count, err := newIdentity(pool, cfg).DeliverPasswordResets(ctx, 1); count != 0 || err != nil {
				t.Fatalf("incomplete recovery configuration reached delivery: %d %v", count, err)
			}
		})
	}
}

func TestPasswordResetPublicURLRejectsUnsafeOrigins(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"https://podhub.example", "https://podhub.example/"},
		{" https://podhub.example:8443/ ", "https://podhub.example:8443/"},
		{"http://localhost:5173", "http://localhost:5173/"},
		{"http://127.0.0.1:5173/", "http://127.0.0.1:5173/"},
		{"http://[::1]:5173", "http://[::1]:5173/"},
	} {
		got, err := passwordResetPublicURL(tc.input)
		if err != nil || got != tc.want {
			t.Errorf("valid origin rejected: %q %q %v", tc.input, got, err)
		}
	}
	for _, input := range []string{
		"", "//podhub.example", "http://podhub.example", "http://localhost.evil.example",
		"http://192.168.1.1", "https://user:password@podhub.example", "https://podhub.example/app",
		"https://podhub.example/?token=x", "https://podhub.example/?", "https://podhub.example/#token",
		"https://podhub.example/#", "https:podhub.example", "https://podhub.example:0",
		"https://podhub.example:65536", "https://podhub.example/%2F", "https://podhub.example\r\nLocation: https://evil.example",
	} {
		if _, err := passwordResetPublicURL(input); err == nil {
			t.Errorf("unsafe origin accepted: %q", input)
		}
	}
}

func TestPasswordResetEmailUsesConfiguredOriginAndEncodesTokenFragment(t *testing.T) {
	capture := &resetMailCapture{}
	adapter := passwordResetMailer{sender: capture, publicURL: "https://podhub.example/"}
	token := "token+/=&?# space\n"
	if err := adapter.SendPasswordReset(context.Background(), "recipient@example.invalid", token); err != nil {
		t.Fatal(err)
	}
	message := capture.message
	if message.To != "recipient@example.invalid" || message.Subject != "重置 PodHub 密码" || !strings.Contains(message.Body, "如果这不是你的操作，请忽略此邮件。") {
		t.Fatal("password reset mail is missing its recipient or instructions")
	}
	var link string
	for _, line := range strings.Split(message.Body, "\n") {
		if strings.HasPrefix(line, "https://") {
			link = line
		}
	}
	u, err := url.Parse(link)
	if err != nil || u.Scheme != "https" || u.Host != "podhub.example" || u.Path != "/" || u.RawQuery != "" {
		t.Fatalf("reset link changed the configured origin or exposed a query token: %q", link)
	}
	fragment, err := url.ParseQuery(u.EscapedFragment())
	if err != nil || fragment.Get("password_reset") != token || len(fragment) != 1 {
		t.Fatalf("reset token did not round trip through the fragment: %q %v", link, err)
	}
}

func TestEmailChangeMailUsesConfiguredOrigin(t *testing.T) {
	capture := &resetMailCapture{}
	adapter := passwordResetMailer{sender: capture, publicURL: "https://podhub.example/"}
	token := "token+/=&?# space"
	if err := adapter.SendEmailChange(context.Background(), "new@example.invalid", token); err != nil {
		t.Fatal(err)
	}
	var link string
	for _, line := range strings.Split(capture.message.Body, "\n") {
		if strings.HasPrefix(line, "https://") {
			link = line
		}
	}
	u, err := url.Parse(link)
	if err != nil || u.Host != "podhub.example" || u.RawQuery != "" || capture.message.To != "new@example.invalid" {
		t.Fatalf("bad confirmation mail: %q %v", link, err)
	}
	fragment, err := url.ParseQuery(u.EscapedFragment())
	if err != nil || fragment.Get("email_change") != token || len(fragment) != 1 {
		t.Fatalf("bad confirmation fragment: %q %v", link, err)
	}
	capture.err = mail.ErrRejected
	if err := adapter.SendEmailChange(context.Background(), "new@example.invalid", token); !errors.Is(err, identity.ErrResetMailRejected) {
		t.Fatalf("permanent rejection not classified: %v", err)
	}
}

func TestPasswordResetMailerClassifiesDeliveryFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want error
	}{
		{"accepted", nil, nil},
		{"permanent SMTP rejection", fmt.Errorf("%w: recipient", mail.ErrRejected), identity.ErrResetMailRejected},
		{"invalid recipient", mail.ErrMessage, identity.ErrResetMailRejected},
		{"temporary failure", mail.ErrUnavailable, mail.ErrUnavailable},
		{"cancellation", context.Canceled, context.Canceled},
		{"timeout", context.DeadlineExceeded, context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			adapter := passwordResetMailer{sender: &resetMailCapture{err: tc.err}, publicURL: "https://podhub.example/"}
			if got := adapter.SendPasswordReset(context.Background(), "recipient@example.invalid", "token"); !errors.Is(got, tc.want) {
				t.Fatalf("delivery error mapping: %v", got)
			}
		})
	}
}
