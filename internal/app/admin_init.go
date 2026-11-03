package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"golang.org/x/term"

	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// InitializeAdmin runs the one-time interactive administrator setup.
func InitializeAdmin(args []string) int {
	if len(args) == 2 && (args[1] == "-h" || args[1] == "--help") {
		fmt.Println("用法：admin-init（使用 DATABASE_URL，交互输入邮箱和密码）")
		return 0
	}
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "用法：admin-init；邮箱和密码请在终端提示后输入")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.Connect(ctx, config.Load())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer pool.Close()
	svc := identity.New(pool)
	initialized, err := svc.AdminInitialized(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	cancel()
	if initialized {
		fmt.Println(identity.ErrAdminInitialized)
		return 0
	}
	email, password, err := readAdminCredentials()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := svc.InitializeAdmin(ctx, email, password); err != nil {
		if errors.Is(err, identity.ErrAdminInitialized) {
			fmt.Println(err)
			return 0
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println("超级管理员已初始化。请打开 /admin 登录。")
	return 0
}

func readAdminCredentials() (string, string, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return "", "", errors.New("请在交互终端运行 admin-init；密码不接受命令行参数或管道输入")
	}
	state, err := term.MakeRaw(fd)
	if err != nil {
		return "", "", err
	}
	defer term.Restore(fd, state)
	terminal := term.NewTerminal(struct {
		io.Reader
		io.Writer
	}{os.Stdin, os.Stdout}, "邮箱：")
	email, err := terminal.ReadLine()
	if err != nil {
		return "", "", err
	}
	password, err := terminal.ReadPassword("密码：")
	if err != nil {
		return "", "", err
	}
	confirmation, err := terminal.ReadPassword("再次输入密码：")
	if err != nil {
		return "", "", err
	}
	if password != confirmation {
		return "", "", errors.New("两次密码不一致")
	}
	return email, password, nil
}
