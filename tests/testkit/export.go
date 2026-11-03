package testkit

// DockerAvailable reports whether the shared Postgres container can start.
func DockerAvailable() bool { return dockerAvailable() }

// QuoteIdent quotes a SQL identifier for use in a statement built by a test.
func QuoteIdent(name string) string { return quoteIdent(name) }

// quoteIdent doubles embedded quotes and wraps the name in double quotes.
func quoteIdent(name string) string {
	out := make([]byte, 0, len(name)+2)
	out = append(out, '"')
	for i := 0; i < len(name); i++ {
		if name[i] == '"' {
			out = append(out, '"')
		}
		out = append(out, name[i])
	}
	return string(append(out, '"'))
}
