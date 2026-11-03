package readhttp

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/listing/read/domain"
)

type TaskRecordReader func(context.Context, pgx.Tx, int64, int64, int64, bool, domain.TaskRecordFilter) (domain.TaskRecordsPage, error)
