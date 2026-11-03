// Package mail delivers plain-text mail through a configured, TLS-verified SMTP server.
package mail

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	stdmail "net/mail"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

var (
	ErrNotConfigured = errors.New("SMTP is not configured")
	ErrConfig        = errors.New("SMTP configuration is invalid")
	ErrMessage       = errors.New("mail message is invalid")
	ErrRejected      = errors.New("SMTP permanently rejected delivery")
	ErrUnavailable   = errors.New("SMTP delivery is unavailable")
)

type Message struct {
	To      string
	Subject string
	Body    string
}

type SMTP struct {
	settings  config.SMTPSettings
	from      *stdmail.Address
	host      string
	tlsConfig *tls.Config
	timeout   time.Duration
}

func New(settings config.SMTPSettings) (*SMTP, error) {
	if settings.Addr == "" && settings.From == "" && settings.Username == "" && settings.Password == "" {
		return nil, ErrNotConfigured
	}
	host, port, err := net.SplitHostPort(settings.Addr)
	n, portErr := strconv.Atoi(port)
	if err != nil || host == "" || strings.ContainsAny(host, " \t\r\n/@?#") || portErr != nil || n < 1 || n > 65535 {
		return nil, ErrConfig
	}
	if settings.TLSMode == "" {
		settings.TLSMode = "starttls"
	}
	if settings.TLSMode != "starttls" && settings.TLSMode != "tls" || (settings.Username == "") != (settings.Password == "") || strings.ContainsAny(settings.Username+settings.Password, "\r\n\x00") {
		return nil, ErrConfig
	}
	from, err := address(settings.From)
	if err != nil {
		return nil, ErrConfig
	}
	return &SMTP{settings: settings, from: from, host: host, timeout: 30 * time.Second,
		tlsConfig: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}}, nil
}

func (s *SMTP) Send(ctx context.Context, message Message) error {
	if s == nil {
		return ErrNotConfigured
	}
	to, err := address(message.To)
	if err != nil || !utf8.ValidString(message.Subject) || !utf8.ValidString(message.Body) || strings.ContainsAny(message.Subject, "\r\n\x00") || message.Subject == "" || len(message.Subject) > 998 || len(message.Body) > 1<<20 || strings.ContainsRune(message.Body, '\x00') {
		return ErrMessage
	}
	wire, err := s.message(to, message)
	if err != nil {
		return ErrMessage
	}
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	dialer := &net.Dialer{Timeout: s.timeout}
	var conn net.Conn
	if s.settings.TLSMode == "tls" {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: s.tlsConfig.Clone()}).DialContext(ctx, "tcp", s.settings.Addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", s.settings.Addr)
	}
	if err != nil {
		return deliveryError(ctx, "connect", err)
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return deliveryError(ctx, "deadline", err)
	}
	client, err := smtp.NewClient(conn, s.host)
	if err != nil {
		return deliveryError(ctx, "greeting", err)
	}
	defer client.Close()
	if s.settings.TLSMode == "starttls" {
		if err := client.Hello("localhost"); err != nil {
			return deliveryError(ctx, "greeting", err)
		}
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return fmt.Errorf("%w: TLS is required", ErrUnavailable)
		}
		if err := client.StartTLS(s.tlsConfig.Clone()); err != nil {
			return deliveryError(ctx, "TLS", err)
		}
	}
	if s.settings.Username != "" {
		if err := client.Auth(smtp.PlainAuth("", s.settings.Username, s.settings.Password, s.host)); err != nil {
			return deliveryError(ctx, "authentication", err)
		}
	}
	if err := client.Mail(s.from.Address); err != nil {
		return deliveryError(ctx, "sender", err)
	}
	if err := client.Rcpt(to.Address); err != nil {
		return deliveryError(ctx, "recipient", err)
	}
	writer, err := client.Data()
	if err != nil {
		return deliveryError(ctx, "data", err)
	}
	if _, err := writer.Write(wire); err != nil {
		return deliveryError(ctx, "body", err)
	}
	if err := writer.Close(); err != nil {
		return deliveryError(ctx, "acknowledgement", err)
	}
	// DATA's 250 is delivery acceptance; a lost QUIT reply must not retry mail.
	_ = conn.SetDeadline(time.Now().Add(time.Second))
	_ = client.Quit()
	return nil
}

func address(raw string) (*stdmail.Address, error) {
	if !utf8.ValidString(raw) || strings.ContainsAny(raw, "\r\n\x00") {
		return nil, ErrMessage
	}
	parsed, err := stdmail.ParseAddress(raw)
	if err != nil || parsed.Address == "" {
		return nil, ErrMessage
	}
	for _, r := range parsed.Address {
		if r < 33 || r > 126 {
			return nil, ErrMessage
		}
	}
	return parsed, nil
}

func (s *SMTP) message(to *stdmail.Address, message Message) ([]byte, error) {
	var out bytes.Buffer
	fmt.Fprintf(&out, "From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n", s.from.String(), to.String(), mime.BEncoding.Encode("UTF-8", message.Subject), time.Now().Format(time.RFC1123Z))
	writer := quotedprintable.NewWriter(&out)
	if _, err := writer.Write([]byte(message.Body)); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func deliveryError(ctx context.Context, stage string, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return context.DeadlineExceeded
	}
	var rejection *textproto.Error
	if errors.As(err, &rejection) && rejection.Code >= 500 && rejection.Code < 600 {
		return fmt.Errorf("%w: %s", ErrRejected, stage)
	}
	return fmt.Errorf("%w: %s", ErrUnavailable, stage)
}
