package testkit

import (
	"context"
	"fmt"

	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

// StartPostgres starts a throwaway database and returns its DSN.
// The DSN is never the fixed address 127.0.0.1:5432. A missing Docker
// daemon is not a reason to skip: the helper tries a local cluster on
// Linux, and returns an error only when neither starter works.
func StartPostgres(ctx context.Context) (dsn string, cleanup func(), err error) {
	var dockerErr error
	if dockerAvailable() {
		dsn, cleanup, dockerErr = startDockerPostgres(ctx)
		if dockerErr == nil {
			return dsn, cleanup, nil
		}
	}
	dsn, cleanup, err = startLocalPostgres(ctx)
	if err == nil {
		return dsn, cleanup, nil
	}
	if dockerErr != nil {
		return "", nil, fmt.Errorf("docker postgres: %v; local postgres: %w", dockerErr, err)
	}
	return "", nil, err
}

func startDockerPostgres(ctx context.Context) (string, func(), error) {
	container, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("podhub"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("postgres"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = container.Terminate(context.Background()) }
	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		cleanup()
		return "", nil, err
	}
	return dsn, cleanup, nil
}
