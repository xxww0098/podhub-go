// Package dbschema embeds the goose migrations shipped at db/migrations.
package dbschema

import "embed"

// Migrations is the goose filesystem. Schema snapshots for sqlc live in
// db/schema and are not applied from here.
//
//go:embed migrations/*.sql
var Migrations embed.FS
