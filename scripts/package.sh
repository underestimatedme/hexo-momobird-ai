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

# The fake key of the mock server and anything shaped like a real one must not ship.
if tar xzOf "$TARBALL" | grep -q -E 'HEXOLOCALTESTKEY|mbk_[A-Za-z0-9]{20}'; then
  echo "package: a key-like string is inside $TARBALL" >&2
  exit 1
fi

echo "$LISTING"
echo
echo "package: $TARBALL ($(wc -c < "$TARBALL" | tr -d ' ') bytes, $(echo "$LISTING" | wc -l | tr -d ' ') files)"
