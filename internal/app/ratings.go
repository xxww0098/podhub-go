package app

import (
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	ratinghttp "github.com/xxww0098/podhub-go/internal/ratings/http"
	ratingrepo "github.com/xxww0098/podhub-go/internal/ratings/repo"
	ratingsvc "github.com/xxww0098/podhub-go/internal/ratings/service"
)

// mountRatings registers the store rating reads. Sync stays on the worker.
func mountRatings(r chi.Router, pool *pgxpool.Pool, resolver access.Resolver) {
	var svc *ratingsvc.Service
	if pool != nil {
		svc = ratingsvc.New(ratingrepo.New(pool))
	}
	ratinghttp.Mount(r, ratinghttp.Deps{Access: resolver, Svc: svc})
}
