//go:build linux

package testkit

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
)

// startLocalPostgres starts a throwaway cluster with the local Postgres
// binaries. It is Linux-only: SysProcAttr.Pdeathsig exists on no other
// platform, and CI runs on Linux. Other platforms use the Docker starter.
func startLocalPostgres(ctx context.Context) (string, func(), error) {
	bin, err := pgBin("postgres")
	if err != nil {
		return "", nil, err
	}
	initdb, err := pgBin("initdb")
	if err != nil {
		return "", nil, err
	}
	isready, err := pgBin("pg_isready")
	if err != nil {
		return "", nil, err
	}
	dir, err := os.MkdirTemp("", "podhub-pg-")
	if err != nil {
		return "", nil, err
	}
	fail := func(err error) (string, func(), error) {
		_ = os.RemoveAll(dir)
		return "", nil, err
	}
	init := exec.CommandContext(ctx, initdb, "-D", dir, "--username=postgres", "--auth=trust", "--no-sync", "--locale=C", "--encoding=UTF8")
	out, err := init.CombinedOutput()
	if err != nil {
		return fail(fmt.Errorf("initdb: %w: %s", err, out))
	}
	var log bytes.Buffer
	cmd := exec.Command(bin,
		"-D", dir,
		"-c", "listen_addresses=",
		"-c", "unix_socket_directories="+dir,
		"-c", "fsync=off",
		"-c", "full_page_writes=off",
		"-c", "synchronous_commit=off",
	)
	cmd.Stdout = &log
	cmd.Stderr = &log
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
	if err := cmd.Start(); err != nil {
		return fail(err)
	}
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()
	cleanup := func() {
		if cmd.Process != nil {
			_ = cmd.Process.Signal(syscall.SIGTERM)
		}
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			<-exited
		}
		_ = os.RemoveAll(dir)
	}
	deadline := time.Now().Add(30 * time.Second)
	var readyErr error
	for {
		select {
		case <-exited:
			cleanup()
			return "", nil, fmt.Errorf("postgres exited before ready: %s", log.Bytes())
		default:
		}
		readyErr = exec.Command(isready, "-h", dir, "-U", "postgres").Run()
		if readyErr == nil {
			break
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			cleanup()
			return "", nil, fmt.Errorf("postgres not ready: %w: %s", readyErr, log.Bytes())
		}
		time.Sleep(50 * time.Millisecond)
	}
	admin := socketDSN(dir, "postgres")
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	_, err = conn.Exec(ctx, `CREATE DATABASE podhub`)
	_ = conn.Close(ctx)
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("create database: %w", err)
	}
	return socketDSN(dir, "podhub"), cleanup, nil
}

func socketDSN(dir, database string) string {
	q := url.Values{}
	q.Set("host", dir)
	q.Set("sslmode", "disable")
	u := url.URL{
		Scheme:   "postgres",
		User:     url.User("postgres"),
		Path:     "/" + database,
		RawQuery: q.Encode(),
	}
	return u.String()
}

func pgBin(name string) (string, error) {
	matches, _ := filepath.Glob("/usr/lib/postgresql/*/bin/" + name)
	sort.Strings(matches)
	if len(matches) > 0 {
		return matches[len(matches)-1], nil
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("%s: %w", name, err)
	}
	return path, nil
}
