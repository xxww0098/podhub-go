package main

import (
	"os"

	"github.com/xxww0098/podhub-go/internal/app"
)

func main() { os.Exit(app.BootstrapWriterLease(os.Args)) }
