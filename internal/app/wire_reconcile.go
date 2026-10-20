package app

// Importing the worker package runs its init, which installs seller.Attach.
// cmd/worker-reconcile already imports app, so the probe tick is set before
// the claim loop prepares scans.
import _ "github.com/xxww0098/podhub-go/internal/app/worker"
