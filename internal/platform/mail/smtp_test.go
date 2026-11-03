package mail

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math/big"
	"mime"
	"mime/quotedprintable"
	"net"
	stdmail "net/mail"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/config"
)

type smtpTestOptions struct {
	implicitTLS, noSTARTTLS, quitDrop bool
	rejectAt, closeAt, stallAt        string
	rejectCode                        int
}

type smtpTestServer struct {
	addr      string
	roots     *x509.CertPool
	wire      chan []byte
	commands  chan string
	connected chan struct{}
	done      chan struct{}
}

func testCertificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true, IsCA: true}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(leaf)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, roots
}

func smtpServer(t *testing.T, options smtpTestOptions) smtpTestServer {
	t.Helper()
	cert, roots := testCertificate(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := smtpTestServer{addr: listener.Addr().String(), roots: roots, wire: make(chan []byte, 1), commands: make(chan string, 32), connected: make(chan struct{}), done: make(chan struct{})}
	t.Cleanup(func() {
		_ = listener.Close()
		select {
		case <-server.done:
		case <-time.After(2 * time.Second):
			t.Error("SMTP fixture did not close")
		}
	})
	go func() {
		defer close(server.done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		close(server.connected)
		secured := options.implicitTLS
		if secured {
			conn = tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
		}
		if options.closeAt == "greeting" {
			return
		}
		if options.stallAt == "greeting" {
			_, _ = io.Copy(io.Discard, conn)
			return
		}
		if _, err := io.WriteString(conn, "220 fixture.example ESMTP\r\n"); err != nil {
			return
		}
		reader := textproto.NewReader(bufio.NewReader(conn))
		for {
			line, err := reader.ReadLine()
			if err != nil {
				return
			}
			server.commands <- line
			verb, _, _ := strings.Cut(line, " ")
			if options.closeAt == verb {
				return
			}
			if options.stallAt == verb {
				_, _ = io.Copy(io.Discard, conn)
				return
			}
			if options.rejectAt == verb {
				code := options.rejectCode
				if code == 0 {
					code = 550
				}
				_, _ = fmt.Fprintf(conn, "%d fixture-secret recipient@example.invalid password_reset=secret-token\r\n", code)
				continue
			}
			switch verb {
			case "EHLO":
				if !secured && !options.noSTARTTLS {
					_, _ = io.WriteString(conn, "250-fixture.example\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n")
				} else {
					_, _ = io.WriteString(conn, "250-fixture.example\r\n250 AUTH PLAIN\r\n")
				}
			case "STARTTLS":
				_, _ = io.WriteString(conn, "220 ready\r\n")
				conn = tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
				secured = true
				reader = textproto.NewReader(bufio.NewReader(conn))
			case "AUTH":
				if !secured {
					t.Error("credentials sent before TLS")
					return
				}
				parts := strings.Split(line, " ")
				if len(parts) != 3 {
					t.Error("unexpected AUTH command")
					return
				}
				decoded, err := base64.StdEncoding.DecodeString(parts[2])
				if err != nil || string(decoded) != "\x00sender@example.invalid\x00fixture-secret" {
					t.Error("incorrect SMTP credentials")
					return
				}
				_, _ = io.WriteString(conn, "235 authenticated\r\n")
			case "MAIL", "RCPT":
				_, _ = io.WriteString(conn, "250 accepted\r\n")
			case "DATA":
				_, _ = io.WriteString(conn, "354 send body\r\n")
				body, err := reader.ReadDotBytes()
				if err != nil {
					return
				}
				server.wire <- body
				if options.rejectAt == "DATA_ACK" {
					_, _ = io.WriteString(conn, "550 fixture-secret recipient@example.invalid password_reset=secret-token\r\n")
				} else {
					_, _ = io.WriteString(conn, "250 queued\r\n")
				}
			case "QUIT":
				if !options.quitDrop {
					_, _ = io.WriteString(conn, "221 goodbye\r\n")
				}
				return
			default:
				_, _ = io.WriteString(conn, "500 unsupported\r\n")
			}
		}
	}()
	return server
}

func testSender(t *testing.T, server smtpTestServer, mode string) *SMTP {
	t.Helper()
	sender, err := New(config.SMTPSettings{Addr: server.addr, From: "PodHub <sender@example.invalid>", Username: "sender@example.invalid", Password: "fixture-secret", TLSMode: mode})
	if err != nil {
		t.Fatal(err)
	}
	sender.tlsConfig.RootCAs = server.roots
	return sender
}

func TestSMTPDeliversUTF8OverVerifiedTLS(t *testing.T) {
	for _, mode := range []string{"starttls", "tls"} {
		t.Run(mode, func(t *testing.T) {
			server := smtpServer(t, smtpTestOptions{implicitTLS: mode == "tls"})
			sender := testSender(t, server, mode)
			message := Message{To: "用户 <recipient@example.invalid>", Subject: "重置 PodHub 密码", Body: "你好\n.\nhttps://podhub.example.invalid/#password_reset=secret-token\n"}
			if err := sender.Send(context.Background(), message); err != nil {
				t.Fatal(err)
			}
			wire := <-server.wire
			parsed, err := stdmail.ReadMessage(strings.NewReader(string(wire)))
			if err != nil {
				t.Fatal(err)
			}
			subject, err := new(mime.WordDecoder).DecodeHeader(parsed.Header.Get("Subject"))
			if err != nil || subject != message.Subject || parsed.Header.Get("MIME-Version") != "1.0" || parsed.Header.Get("Content-Type") != "text/plain; charset=UTF-8" {
				t.Fatalf("bad MIME headers: %s", wire)
			}
			body, err := io.ReadAll(quotedprintable.NewReader(parsed.Body))
			if err != nil || string(body) != message.Body {
				t.Fatalf("body changed: %q %v", body, err)
			}
			var commands []string
			for len(server.commands) > 0 {
				commands = append(commands, <-server.commands)
			}
			joined := strings.Join(commands, "\n")
			if !strings.Contains(joined, "MAIL FROM:<sender@example.invalid>") || !strings.Contains(joined, "RCPT TO:<recipient@example.invalid>") {
				t.Fatalf("wrong envelope: %s", joined)
			}
		})
	}
}

func TestSMTPFailuresAreClassifiedWithoutServerSecrets(t *testing.T) {
	for _, tc := range []struct {
		name     string
		options  smtpTestOptions
		expected error
	}{
		{"recipient permanent rejection", smtpTestOptions{rejectAt: "RCPT", rejectCode: 550}, ErrRejected},
		{"authentication rejection", smtpTestOptions{rejectAt: "AUTH", rejectCode: 535}, ErrRejected},
		{"recipient temporary failure", smtpTestOptions{rejectAt: "RCPT", rejectCode: 450}, ErrUnavailable},
		{"DATA rejection", smtpTestOptions{rejectAt: "DATA_ACK"}, ErrRejected},
		{"greeting disconnect", smtpTestOptions{closeAt: "greeting"}, ErrUnavailable},
		{"DATA disconnect", smtpTestOptions{closeAt: "DATA"}, ErrUnavailable},
		{"TLS downgrade", smtpTestOptions{noSTARTTLS: true}, ErrUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := smtpServer(t, tc.options)
			err := testSender(t, server, "starttls").Send(context.Background(), Message{To: "recipient@example.invalid", Subject: "reset", Body: "password_reset=secret-token"})
			if !errors.Is(err, tc.expected) {
				t.Fatalf("wrong failure class: %v", err)
			}
			for _, secret := range []string{"fixture-secret", "recipient@example.invalid", "secret-token"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("SMTP error leaked protected data: %v", err)
				}
			}
			if tc.options.noSTARTTLS {
				for len(server.commands) > 0 {
					if strings.HasPrefix(<-server.commands, "AUTH ") {
						t.Fatal("AUTH attempted without TLS")
					}
				}
			}
		})
	}
}

func TestSMTPDoesNotRetryAnAcceptedMessageAfterLostQuit(t *testing.T) {
	server := smtpServer(t, smtpTestOptions{quitDrop: true})
	if err := testSender(t, server, "starttls").Send(context.Background(), Message{To: "recipient@example.invalid", Subject: "reset", Body: "accepted"}); err != nil {
		t.Fatalf("accepted message became a retry: %v", err)
	}
}

func TestSMTPVerifiesServerCertificates(t *testing.T) {
	for _, mode := range []string{"starttls", "tls"} {
		t.Run(mode, func(t *testing.T) {
			server := smtpServer(t, smtpTestOptions{implicitTLS: mode == "tls"})
			sender := testSender(t, server, mode)
			sender.tlsConfig.RootCAs = nil
			if err := sender.Send(context.Background(), Message{To: "recipient@example.invalid", Subject: "reset", Body: "secret-token"}); !errors.Is(err, ErrUnavailable) {
				t.Fatalf("untrusted certificate accepted: %v", err)
			}
		})
	}
}

func TestSMTPTimeoutAndCancellationCloseTheConnection(t *testing.T) {
	for _, stage := range []string{"greeting", "EHLO", "STARTTLS", "AUTH", "DATA"} {
		t.Run("timeout/"+stage, func(t *testing.T) {
			server := smtpServer(t, smtpTestOptions{stallAt: stage})
			sender := testSender(t, server, "starttls")
			sender.timeout = 30 * time.Millisecond
			if err := sender.Send(context.Background(), Message{To: "recipient@example.invalid", Subject: "reset", Body: "secret-token"}); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("timeout not preserved: %v", err)
			}
		})
		t.Run("cancellation/"+stage, func(t *testing.T) {
			server := smtpServer(t, smtpTestOptions{stallAt: stage})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			sender := testSender(t, server, "starttls")
			go func() {
				result <- sender.Send(ctx, Message{To: "recipient@example.invalid", Subject: "reset", Body: "secret-token"})
			}()
			<-server.connected
			if stage != "greeting" {
				for command := range server.commands {
					if strings.HasPrefix(command, stage+" ") || command == stage {
						break
					}
				}
			}
			cancel()
			select {
			case err := <-result:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation not preserved: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("cancelled SMTP connection remained open")
			}
		})
	}
}

func TestSMTPRejectsInvalidConfigurationAndHeaderInjection(t *testing.T) {
	if _, err := New(config.SMTPSettings{}); !errors.Is(err, ErrNotConfigured) {
		t.Fatal(err)
	}
	good := config.SMTPSettings{Addr: "smtp.example.invalid:587", From: "sender@example.invalid", TLSMode: "starttls"}
	for _, mutate := range []func(*config.SMTPSettings){
		func(s *config.SMTPSettings) { s.Addr = "smtp.example.invalid" },
		func(s *config.SMTPSettings) { s.Addr = "smtp.example.invalid:0" },
		func(s *config.SMTPSettings) { s.TLSMode = "plain" },
		func(s *config.SMTPSettings) { s.Username = "sender" },
		func(s *config.SMTPSettings) { s.From = "sender@example.invalid\r\nBcc: attacker@example.invalid" },
		func(s *config.SMTPSettings) { s.Username, s.Password = "sender", "secret\x00invalid" },
	} {
		settings := good
		mutate(&settings)
		if _, err := New(settings); !errors.Is(err, ErrConfig) {
			t.Fatalf("invalid settings accepted: %v", err)
		}
	}
	sender, err := New(good)
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range []Message{
		{To: "recipient@example.invalid\r\nBcc: attacker@example.invalid", Subject: "reset"},
		{To: "a@example.invalid,b@example.invalid", Subject: "reset"},
		{To: "recipient@example.invalid", Subject: "reset\r\nBcc: attacker@example.invalid"},
		{To: "recipient@example.invalid", Subject: "reset", Body: "bad\x00token"},
	} {
		if err := sender.Send(context.Background(), message); !errors.Is(err, ErrMessage) {
			t.Fatalf("unsafe message reached delivery: %v", err)
		}
	}
}
