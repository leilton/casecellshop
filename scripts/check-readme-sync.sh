#!/bin/sh
# Keeps README.pt-BR.md structurally in step with README.md (the source of truth): same number of sections,
# tables and code blocks, and every relative link must exist. It cannot judge the translation itself, but it
# catches the usual drift: a section, table or diagram added to one file and forgotten in the other.
set -eu
cd "$(dirname "$0")/.."

en=README.md
pt=README.pt-BR.md
fail=0

count() { grep -cE "$2" "$1" || true; }

check() {
  label=$1
  pattern=$2
  a=$(count "$en" "$pattern")
  b=$(count "$pt" "$pattern")
  if [ "$a" != "$b" ]; then
    echo "readme-sync: $label differ: $en has $a, $pt has $b" >&2
    fail=1
  fi
}

check "sections (##)" '^## '
check "sub-sections (###)" '^### '
check "tables" '^\| *:?-{3,}'
check "code fences" '^```'
check "mermaid diagrams" '^```mermaid'
check "images" '^!\[|[^`]!\[[^]]*\]\('

for file in "$en" "$pt"; do
  for target in $(grep -oE '\]\([^)]+\)' "$file" | sed 's/^](//; s/)$//' | grep -vE '^(https?:|mailto:|#)' | sed 's/#.*//' | sort -u); do
    if [ ! -e "$target" ]; then
      echo "readme-sync: $file links to missing file: $target" >&2
      fail=1
    fi
  done
done

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "readme-sync: ok"
