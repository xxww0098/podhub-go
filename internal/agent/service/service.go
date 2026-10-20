package service

import (
	"errors"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
)

// Service is the agent use-case layer. It does not speak HTTP.
type Service struct {
	repo Repository
}

// New returns a service. A nil repo fails calls with the internal failure.
func New(repo Repository) *Service {
	return &Service{repo: repo}
}

func authorize(actor contract.Actor) error {
	if actor.UserID <= 0 {
		return contract.Fail(contract.KindUnauth, "未登录")
	}
	return nil
}

func unavailable() error {
	return contract.Fail(contract.KindInternal, "服务暂不可用")
}

func notAgent(err error) error {
	if errors.Is(err, contract.ErrNotAgent) {
		return contract.Fail(contract.KindNotFound, "你不是代理")
	}
	return err
}
