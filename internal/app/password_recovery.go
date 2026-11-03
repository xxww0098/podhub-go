package app

import (
	"context"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/mail"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func newIdentity(pool *pgxpool.Pool, cfg config.Config) *identity.Service {
	service := identity.New(pool)
	publicURL, err := passwordResetPublicURL(cfg.PublicURL)
	if err != nil || len(strings.TrimSpace(cfg.IntegrationConfigKey)) < 32 {
		return service
	}
	sender, err := mail.New(cfg.SMTP)
	if err != nil {
		return service
	}
	return service.WithPasswordRecovery(passwordResetMailer{sender: sender, publicURL: publicURL}, seal.DeriveKEK(cfg.IntegrationConfigKey))
}

type resetMessageSender interface {
	Send(context.Context, mail.Message) error
}

type passwordResetMailer struct {
	sender    resetMessageSender
	publicURL string
}

func (m passwordResetMailer) SendPasswordReset(ctx context.Context, email, token string) error {
	link := m.publicURL + "#" + url.Values{"password_reset": {token}}.Encode()
	err := m.sender.Send(ctx, mail.Message{
		To:      email,
		Subject: "重置 PodHub 密码",
		Body:    "请打开以下链接设置新的 PodHub 密码：\n\n" + link + "\n\n链接过期后，请重新申请。\n如果这不是你的操作，请忽略此邮件。\n",
	})
	if errors.Is(err, mail.ErrRejected) || errors.Is(err, mail.ErrMessage) {
		return identity.ErrResetMailRejected
	}
	return err
}

func (m passwordResetMailer) SendEmailChange(ctx context.Context, email, token string) error {
	link := m.publicURL + "#" + url.Values{"email_change": {token}}.Encode()
	err := m.sender.Send(ctx, mail.Message{
		To:      email,
		Subject: "确认更换 PodHub 登录邮箱",
		Body:    "请打开以下链接确认更换 PodHub 登录邮箱：\n\n" + link + "\n\n链接 30 分钟内有效，只能使用一次。确认后请使用新邮箱重新登录。\n如果这不是你的操作，请忽略此邮件。\n",
	})
	if errors.Is(err, mail.ErrRejected) || errors.Is(err, mail.ErrMessage) {
		return identity.ErrResetMailRejected
	}
	return err
}

// Recovery links always use this configured origin, never request Host headers.
func passwordResetPublicURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || u.Hostname() == "" || u.RawQuery != "" || u.ForceQuery || strings.Contains(raw, "#") || u.Path != "" && u.Path != "/" {
		return "", errors.New("password reset public URL is invalid")
	}
	host := u.Hostname()
	loopback := strings.EqualFold(host, "localhost")
	if ip := net.ParseIP(host); ip != nil {
		loopback = ip.IsLoopback()
	}
	if u.Scheme != "https" && (u.Scheme != "http" || !loopback) {
		return "", errors.New("password reset public URL requires HTTPS")
	}
	if port := u.Port(); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 1 || value > 65535 {
			return "", errors.New("password reset public URL port is invalid")
		}
	}
	u.Path, u.RawPath = "/", ""
	return u.String(), nil
}
