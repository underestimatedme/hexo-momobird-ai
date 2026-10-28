#!/usr/bin/env bash
# Builds dist/hexo-momobird-ai-<version>.tgz and checks what went into it:
# index.js, lib/*.js, README.md, LICENSE and package.json, nothing else.
#
#   npm run package

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
NAME="$(node -p "require('./package.json').name")"
TARBALL="dist/$NAME-$VERSION.tgz"

mkdir -p dist
rm -f "$TARBALL"
npm pack --pack-destination dist --loglevel=error > /dev/null
[ -f "$TARBALL" ] || { echo "package: $TARBALL was not created" >&2; exit 1; }

LISTING="$(tar tzf "$TARBALL" | sort)"

# Every entry must be one of the allowed files ...
UNEXPECTED="$(echo "$LISTING" | grep -v -E '^package/(index\.js|README\.md|LICENSE|package\.json|lib/[A-Za-z0-9._-]+\.js)$' || true)"
if [ -n "$UNEXPECTED" ]; then
  echo "package: unexpected files in $TARBALL:" >&2
  echo "$UNEXPECTED" >&2
  exit 1
fi

# ... and every file that has to ship must be there: the four top-level files
# and exactly the lib/*.js that exist in the source tree.
EXPECTED="$( (printf 'package/index.js\npackage/README.md\npackage/LICENSE\npackage/package.json\n'; \
  (cd "$ROOT" && ls lib/*.js | sed 's#^#package/#')) | sort)"
if [ "$LISTING" != "$EXPECTED" ]; then
  echo "package: file list differs from what was expected" >&2
  diff <(echo "$EXPECTED") <(echo "$LISTING") >&2 || true
  exit 1
fi

# The fake key of the mock server and anything shaped like a real one must not
# ship. The tarball is unpacked into a directory and searched there: piping
# `tar xzOf` into `grep -q` is not reliable under pipefail, because grep leaves
# at the first match, tar then dies of SIGPIPE and the pipeline reports "no
# match" depending on timing.
KEY_PATTERN='HEXOLOCALTESTKEY|mbk_[A-Za-z0-9_-]{16,}'

# key_files TARBALL   prints the files inside it that hold a key-like string.
key_files() {
  local dir hits
  dir="$(mktemp -d)"
  tar xzf "$1" -C "$dir"
  hits="$(cd "$dir" && grep -rlE "$KEY_PATTERN" . || true)"
  rm -rf "$dir"
  echo "$hits"
}

FOUND="$(key_files "$TARBALL")"
if [ -n "$FOUND" ]; then
  echo "package: a key-like string is inside $TARBALL:" >&2
  echo "$FOUND" >&2
  exit 1
fi

# Self-test of the guard, on copies in a scratch directory (the tarball in
# dist/ is never touched): the same files with a fake key planted in one place
# at a time must all be caught, wherever the file sits in the archive.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
tar xzf "$TARBALL" -C "$SCRATCH"
PLANTED=0
for target in LICENSE lib/cache.js lib/plugin.js README.md package.json; do
  rm -rf "$SCRATCH/planted" "$SCRATCH/planted.tgz"
  mkdir "$SCRATCH/planted"
  cp -R "$SCRATCH/package" "$SCRATCH/planted/package"
  printf '\n// mbk_PLANTEDFAKEKEYPLANTEDFAKEKEY0123456789\n' >> "$SCRATCH/planted/package/$target"
  tar czf "$SCRATCH/planted.tgz" -C "$SCRATCH/planted" package
  CAUGHT="$(key_files "$SCRATCH/planted.tgz")"
  if [ "$CAUGHT" != "./package/$target" ]; then
    echo "package: the key guard did not catch a key planted in $target (it reported: ${CAUGHT:-nothing})" >&2
    exit 1
  fi
  PLANTED=$((PLANTED + 1))
done
echo "package: key guard self-test passed (a planted key was caught in $PLANTED of $PLANTED places); $TARBALL is clean"
echo

echo "$LISTING"
echo
echo "package: $TARBALL ($(wc -c < "$TARBALL" | tr -d ' ') bytes, $(echo "$LISTING" | wc -l | tr -d ' ') files)"
