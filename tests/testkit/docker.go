package testkit

import (
	"net"
	"os"
	"path/filepath"
	"strings"
)

// dockerSockets lists the socket paths this repository checks, in order.
// The first is the Linux default; the rest are where Desktop installs it.
func dockerSockets() []string {
	paths := []string{"/var/run/docker.sock"}
	if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths,
			filepath.Join(home, ".docker", "run", "docker.sock"),
			filepath.Join(home, ".colima", "default", "docker.sock"),
			filepath.Join(home, ".orbstack", "run", "docker.sock"),
		)
	}
	return paths
}

// dockerAvailable reports whether a daemon answers. Docker Desktop on macOS
// does not create /var/run/docker.sock, so a path check alone under-reports.
// DOCKER_HOST is honoured first; a tcp:// or unix:// host is dialed, which
// is what testcontainers will do anyway.
func dockerAvailable() bool {
	if host := os.Getenv("DOCKER_HOST"); host != "" {
		network, address := "unix", host
		if rest, ok := strings.CutPrefix(host, "unix://"); ok {
			address = rest
		} else if rest, ok := strings.CutPrefix(host, "tcp://"); ok {
			network, address = "tcp", rest
		}
		conn, err := net.Dial(network, address)
		if err != nil {
			return false
		}
		_ = conn.Close()
		return true
	}
	for _, p := range dockerSockets() {
		conn, err := net.Dial("unix", p)
		if err != nil {
			continue
		}
		_ = conn.Close()
		return true
	}
	return false
}
