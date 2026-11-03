package identity

import (
	"context"
	"errors"
)

// PasswordResetMailer is supplied by app. Delivery never runs inside a DB transaction.
type PasswordResetMailer interface {
	SendPasswordReset(context.Context, string, string) error
}

type EmailChangeMailer interface {
	SendEmailChange(context.Context, string, string) error
}

var ErrResetMailRejected = errors.New("password reset mail permanently rejected")

// WithPasswordRecovery configures recovery before the service starts handling requests.
func (s *Service) WithPasswordRecovery(mailer PasswordResetMailer, key []byte) *Service {
	if mailer != nil && len(key) == 32 {
		s.resetMailer = mailer
		s.emailChangeMailer, _ = mailer.(EmailChangeMailer)
		s.resetKey = append([]byte(nil), key...)
	}
	return s
}
