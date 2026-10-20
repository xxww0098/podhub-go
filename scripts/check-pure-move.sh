#!/usr/bin/env bash
# scripts/check-pure-move.sh [base-ref]
# Fails when a migration PR changed anything except: file renames, `package`
# clauses, and in-module import paths. Run from the repo root, with the PR
# changes staged or committed relative to BASE (default origin/main).
set -euo pipefail
base="${1:-origin/main}"
mod='github.com/xxww0098/podhub-go/'
bad=0
norm() { # strip package clause, module import lines, blank lines, gofmt import ordering noise
  grep -v -E '^(package [a-zA-Z0-9_]+|[[:space:]]*(import )?([a-zA-Z0-9_]+ )?"'"${mod}"'[^"]*")[[:space:]]*$' | grep -v -E '^[[:space:]]*$' || true
}
while IFS=$'\t' read -r status a b; do
  case "$status" in
    R*) old="$a"; new="$b" ;;
    M)  old="$a"; new="$a" ;;
    A|D) echo "ADD/DELETE not allowed in a pure move: $a"; bad=1; continue ;;
    *) continue ;;
  esac
  # The ratchet baseline only shrinks (archtest fails if a line is added) and
  # docs/architecture-tree.md records the path map. Neither is production
  # logic. This script is listed so the exception itself stays reviewable.
  # Every Go file is still compared below.
  case "$new" in
    tests/archtest/baseline.txt|docs/architecture-tree.md|scripts/check-pure-move.sh) continue ;;
  esac
  case "$new" in *.go) ;; *) [ "$old" = "$new" ] || continue; echo "non-Go file modified: $new"; bad=1; continue ;; esac
  # identifiers qualified by a moved package alias may be rewritten (e.g. config.X -> config.X is unchanged);
  # a changed alias shows up here and must be reviewed by hand.
  d=$(diff <(git show "$base:$old" | norm) <(git show ":$new" 2>/dev/null | norm || cat "$new" | norm) || true)
  if [ -n "$d" ]; then echo "== logic/text change in $old -> $new"; echo "$d" | head -20 || true; bad=1; fi
done < <(git diff -M --name-status "$base" -- . ':!*_gen.go' ':!*.gen.go')
exit $bad
