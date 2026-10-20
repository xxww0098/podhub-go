package api

// Importing queue runs the init that assigns jobsched.Finish, EnqueueOn, and
// MutateRunning. listing/submit calls those variables and does not import queue.
import _ "github.com/xxww0098/podhub-go/internal/queue"
