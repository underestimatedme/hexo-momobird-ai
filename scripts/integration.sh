#!/usr/bin/env bash
# Runs the plugin against real Hexo 5.4.2, 7.3.0 and 8.1.2 with the local mock
# of the connect API (dev/mock-connect.js). Nothing here talks to MomoBird.
#
#   npm run test:integration
#   HEXO_VERSIONS="8.1.2" bash scripts/integration.sh     # only some versions
#   KEEP_WORK=1 bash scripts/integration.sh               # keep the temp dirs
#
# For every version the fixture site (test/fixtures/site) is copied to a temp
# directory, Hexo and the renderers are installed there together with the
# plugin as the tarball `npm pack` makes (so the `files` list is exercised too),
# and a series of real `hexo` commands is run. Each check prints PASS or FAIL
# with its evidence; any FAIL makes the script exit 1.
#
# Check numbers 1-10 are the Hexo-runtime assumptions Task 7's review listed
# (check 11, Node 14, is test/node14-smoke.js); B4-B9 are the numbered steps of
# the task; X1-X5 are extra scenarios; X7 is a plan that expired (402 on
# push), X8 a post whose front-matter Hexo cannot parse, X9 flag values as
# hexo-cli really parses them; T and C are the theme-field and category-order
# observations.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPERS="$ROOT/scripts/integration-helpers.js"
KEY='mbk_HEXOLOCALTESTKEYHEXOLOCALTESTKEYHEXOLOCAL'
BAD_KEY='mbk_WRONGKEYWRONGKEYWRONGKEYWRONGKEYWRONGKEYWR'
SITE_URL='https://hexo.example.com'
SOURCE_ID='0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
HEXO_VERSIONS="${HEXO_VERSIONS:-5.4.2 7.3.0 8.1.2}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hexo-momobird-it.XXXXXX")"
RESULTS="$WORK/results.tsv"
: > "$RESULTS"
MOCK_PIDS=""
HELPER_PIDS=""
HELPER_ENV=""

stop_mocks() {
  local pid
  for pid in $MOCK_PIDS; do
    kill "$pid" 2>/dev/null || true
  done
  MOCK_PIDS=""
}

# The helpers (scripts/integration-helpers.js run) keep hexo in a process group
# of its own, so an interrupted script has to stop them itself: a TERM makes a
# helper take its hexo process group down and exit.
stop_helpers() {
  local pid
  for pid in $HELPER_PIDS; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in $HELPER_PIDS; do
    wait "$pid" 2>/dev/null || true
  done
  HELPER_PIDS=""
}

cleanup() {
  trap - EXIT
  stop_helpers
  stop_mocks
  if [ "${KEEP_WORK:-}" = 1 ]; then
    echo "kept $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT
# Without these, bash would only act on a signal once the command it is
# waiting for has finished.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

die() {
  echo "integration: $*" >&2
  exit 1
}

h() {
  node "$HELPERS" "$@"
}

# ----- Hexo versions and the renderers that belong to them ---------------------
# hexo-starter is not published on npm (`npm view hexo-starter` only knows a
# 0.0.0 placeholder), so the versions come from its package.json history on
# GitHub: the commit before "bump hexo from 5.4.0 to 6.0.0" for Hexo 5, the
# commit with hexo ^7.3.0 and hexo-renderer-marked ^6.3.0 for Hexo 7, and master
# (hexo ^8.0.0) for Hexo 8.
deps_for() {
  case "$1" in
    5.*) echo "hexo-renderer-ejs@^2.0.0 hexo-renderer-marked@^4.0.0 hexo-generator-index@^2.0.0 hexo-server@^2.0.0" ;;
    7.*) echo "hexo-renderer-ejs@^2.0.0 hexo-renderer-marked@^6.3.0 hexo-generator-index@^4.0.0 hexo-server@^3.0.0" ;;
    8.*) echo "hexo-renderer-ejs@^2.0.0 hexo-renderer-marked@^7.0.0 hexo-generator-index@^4.0.0 hexo-server@^3.0.0" ;;
    *) die "no renderer set known for Hexo $1" ;;
  esac
}

# ----- the mock ----------------------------------------------------------------

# start_mock NAME SITE_URL [mock args...] sets NAME_LOG and NAME_PORT.
start_mock() {
  local name=$1 site=$2
  shift 2
  local log="$VDIR/$name.jsonl" portfile="$VDIR/$name.port" pid i=0
  : > "$log"
  rm -f "$portfile"
  node "$ROOT/dev/mock-connect.js" --site-url "$site" --log "$log" --port-file "$portfile" "$@" > "$VDIR/$name.out" 2>&1 &
  pid=$!
  MOCK_PIDS="$MOCK_PIDS $pid"
  while [ ! -s "$portfile" ]; do
    i=$((i + 1))
    if [ "$i" -gt 100 ] || ! kill -0 "$pid" 2>/dev/null; then
      cat "$VDIR/$name.out" >&2 || true
      die "mock $name did not start"
    fi
    sleep 0.1
  done
  printf -v "${name}_LOG" '%s' "$log"
  printf -v "${name}_PORT" '%s' "$(tr -d '\n' < "$portfile")"
}

lines_of() {
  wc -l < "$1" | tr -d ' '
}

# Requests after the first $2 lines of the mock log $1, one per line.
requests_since() {
  tail -n +"$(($2 + 1))" "$1" | h requests
}

# The same on one line, for evidence.
requests_line() {
  local text
  text="$(requests_since "$1" "$2" | paste -sd'|' - | sed 's/|/; /g')"
  echo "${text:-(no requests)}"
}

# Number of requests since the mark whose summary matches the pattern.
count_requests() {
  local n
  n="$(requests_since "$1" "$2" | grep -c -E "$3" || true)"
  echo "$n"
}

occurrences() {
  local n
  n="$(grep -o -F -- "$2" "$1" | wc -l || true)"
  echo "${n//[[:space:]]/}"
}

# ----- running Hexo ------------------------------------------------------------

# helper_run LOGFILE helper-args...   (environment: HELPER_ENV, as env arguments)   Runs `integration-helpers.js run` in the
# background and waits for it, so that a signal sent to this script is handled
# at once and the helper is stopped by the trap. Output goes to LOGFILE, the
# exit status to RC.
helper_run() {
  local log=$1 pid
  shift
  # The key goes into the helper's environment (which the hexo process then
  # inherits), not onto a command line where `ps` would show it.
  # shellcheck disable=SC2086
  env $HELPER_ENV node "$HELPERS" run "$@" < /dev/null > "$log" 2>&1 &
  pid=$!
  HELPER_PIDS="$HELPER_PIDS $pid"
  RC=0
  wait "$pid" || RC=$?
  HELPER_PIDS="${HELPER_PIDS/ $pid/}"
}

# hexo_run LABEL KEYMODE hexo-args...   KEYMODE: key | none | bad
# Output goes to $OUT/LABEL.log, the exit status to RC.
hexo_run() {
  local label=$1 mode=$2 keyenv
  shift 2
  case "$mode" in
    key) keyenv="MOMOBIRD_KEY=$KEY" ;;
    bad) keyenv="MOMOBIRD_KEY=$BAD_KEY" ;;
    none) keyenv="-u MOMOBIRD_KEY" ;;
    *) die "bad key mode $mode" ;;
  esac
  HELPER_ENV="$keyenv"
  helper_run "$OUT/$label.log" --cwd "$SITE" --limit 180 -- "$HEXO" "$@" --config "$CFG"
}

# hexo_for SECONDS LABEL hexo-args...   (with the key) for commands that never end on their own.
hexo_for() {
  local seconds=$1 label=$2
  shift 2
  HELPER_ENV="MOMOBIRD_KEY=$KEY"
  helper_run "$OUT/$label.log" --cwd "$SITE" --stop-after "$seconds" -- "$HEXO" "$@" --config "$CFG"
}

# ----- verdicts ----------------------------------------------------------------

# record NUM NAME STATUS EVIDENCE
record() {
  local evidence
  evidence="$(printf '%s' "$4" | tr '\n\t' '  ')"
  printf '%s\t%s\t%s\t%s\t%s\n' "$CUR" "$1" "$2" "$3" "$evidence" >> "$RESULTS"
  printf '  [%-4s] %-4s %s\n         %s\n' "$3" "$1" "$2" "$evidence"
}

# verdict NUM NAME EVIDENCE test-command...   PASS when the command succeeds.
verdict() {
  local num=$1 name=$2 evidence=$3
  shift 3
  if "$@"; then
    record "$num" "$name" PASS "$evidence"
  else
    record "$num" "$name" FAIL "$evidence"
  fi
}

eq() { [ "$1" = "$2" ]; }
has() { grep -q -F -- "$2" "$1"; }
hasnt() { ! grep -q -F -- "$2" "$1"; }

page() {
  echo "$SITE/public/$1/index.html"
}

# ----- key scans ---------------------------------------------------------------

# Files under the given paths that hold the key, a fragment of it or anything
# starting like a key.
key_hits() {
  grep -rlF -e "$KEY" -e mbk_ -e HEXOLOCALTESTKEY -e WRONGKEY "$@" 2>/dev/null || true
}

# public_leak_scan LABEL
# Scans public/ for the key while it holds plugin output. The scan only means
# something if there is plugin output to scan, so it first asserts that every
# page carries the widget tag (data-project=) and that placeholders
# (momobird-podcast) exist. The builds that follow later (origin mismatch, wrong
# key) emit none of that.
public_leak_scan() {
  local label=$1 pages widgets placeholders hits
  pages="$(find "$SITE/public" -name '*.html' | wc -l | tr -d ' ')"
  widgets="$(grep -rlF 'data-project=' "$SITE/public" 2>/dev/null | wc -l | tr -d ' ' || true)"
  placeholders="$(grep -rlF 'momobird-podcast' "$SITE/public" 2>/dev/null | wc -l | tr -d ' ' || true)"
  verdict B9 "$label: public/ holds plugin output before it is scanned" \
    "html pages=$pages, pages with data-project=$widgets, pages with momobird-podcast=$placeholders" \
    test "$pages" -gt 0 -a "$widgets" -eq "$pages" -a "$placeholders" -gt 0
  hits="$(key_hits "$SITE/public")"
  verdict B9 "$label: no key, not even the mbk_ prefix, in public/" \
    "scanned $pages pages and $(find "$SITE/public" -type f | wc -l | tr -d ' ') files; files with a match: ${hits:-none}" \
    test -z "$hits"
}

# ----- one Hexo version --------------------------------------------------------

run_version() {
  local V=$1
  CUR=$V
  VDIR="$WORK/hexo-$V"
  SITE="$VDIR/site"
  OUT="$VDIR/out"
  HEXO="$SITE/node_modules/.bin/hexo"
  mkdir -p "$VDIR" "$OUT"
  cp -R "$ROOT/test/fixtures/site" "$SITE"

  echo
  echo "=== Hexo $V (node $(node -v), npm $(npm -v)) ==="
  # shellcheck disable=SC2046
  (cd "$SITE" && npm install --no-audit --no-fund --loglevel=error --save-exact \
    "hexo@$V" hexo-cli@4.3.2 $(deps_for "$V") "$TARBALL") > "$OUT/npm-install.log" 2>&1 \
    || { cat "$OUT/npm-install.log" >&2; die "npm install failed for Hexo $V"; }
  echo "installed: $(cd "$SITE" && npm ls --depth=0 2>/dev/null | grep -o '[a-z][a-z0-9-]*@[0-9][^ ]*' | paste -sd' ' -)"
  eq "$(node -p "require('$SITE/node_modules/hexo/package.json').version")" "$V" || die "installed Hexo is not $V"

  # A deployer that only leaves a marker file, to see whether `hexo g -d` deploys.
  mkdir -p "$SITE/scripts"
  cat > "$SITE/scripts/probe-deployer.js" <<'EOF'
/* global hexo */
const fs = require('fs');
const path = require('path');
hexo.extend.deployer.register('probe', function () {
  fs.writeFileSync(path.join(hexo.base_dir, 'deployed.marker'), 'deployed\n');
});
EOF
  printf 'deploy:\n  type: probe\n' > "$SITE/_deploy.yml"

  start_mock M1 "$SITE_URL"
  printf 'momobird:\n  api: http://127.0.0.1:%s\n' "$M1_PORT" > "$SITE/_mock.yml"
  CFG="_config.yml,_mock.yml"

  local hello_src="_posts/hello-world.md" nested_src="_posts/categories-nested.md" extra_src="_posts/extra-post.md"
  local hello_id nested_id extra_id mark rc_text n expected_local
  hello_id="$(h external-id "$hello_src")"
  nested_id="$(h external-id "$nested_src")"
  extra_id="$(h external-id "$extra_src")"
  expected_local="$(grep -L -E '^(published: false|password:)' "$SITE"/source/_posts/*.md | wc -l | tr -d ' ')"
  echo "ids: hello-world=$hello_id categories-nested=$nested_id; syncable fixture posts=$expected_local"

  # --- 4, X2: no key ---------------------------------------------------------
  mark="$(lines_of "$M1_LOG")"
  hexo_run nokey-sync none momobird sync
  verdict 4 "momobird sync without MOMOBIRD_KEY exits non-zero" "exit status $RC; $(grep -h 'MOMOBIRD_KEY' "$OUT/nokey-sync.log" | head -1)" \
    test "$RC" -ne 0
  hexo_run nokey-gen none generate
  verdict X2 "hexo g without a key: one notice, no request, exit 0, no widget" \
    "exit $RC; notices=$(grep -c '未设置 MOMOBIRD_KEY，跳过同步' "$OUT/nokey-gen.log" || true); $(requests_line "$M1_LOG" "$mark"); loader occurrences in index.html=$(occurrences "$SITE/public/index.html" loader.v1.js)" \
    eq "$RC:$(grep -c '未设置 MOMOBIRD_KEY，跳过同步' "$OUT/nokey-gen.log" || true):$(lines_of "$M1_LOG"):$(occurrences "$SITE/public/index.html" loader.v1.js)" "0:1:$mark:0"

  # --- 2, 5: status and dry run (hexo.load() has to render the posts) --------
  hexo_run status key momobird status
  verdict 2 "momobird status reports the syncable posts (content rendered by hexo.load)" \
    "exit $RC; $(grep -h '文章：' "$OUT/status.log")" \
    has "$OUT/status.log" "文章：本地 $expected_local 篇，MomoBird 上 0 篇"
  verdict 2 "momobird status: address check and plan lines" \
    "$(grep -h -E '站点地址|套餐|问答助手' "$OUT/status.log" | sed 's/^[A-Z]* *//' | paste -sd'|' - | sed 's/|/ | /g')" \
    has "$OUT/status.log" "站点地址：一致（$SITE_URL）"
  mark="$(lines_of "$M1_LOG")"
  hexo_run dryrun1 key momobird sync --dry-run
  verdict 2 "momobird sync --dry-run lists the expected pushes" \
    "exit $RC; $(grep -h '将推送：' "$OUT/dryrun1.log" | sed 's/^[A-Z]* *//' | paste -sd'|' - | sed 's/|/ | /g')" \
    eq "$(grep -c -e "将推送：$hello_src" -e "将推送：$nested_src" "$OUT/dryrun1.log" || true)/$(grep -c '将推送：' "$OUT/dryrun1.log" || true)" "2/2"
  verdict 5 "--dry-run sends no PUT and no POST /posts/delete (pushes planned)" \
    "$(requests_line "$M1_LOG" "$mark")" \
    eq "$(count_requests "$M1_LOG" "$mark" '^(PUT|POST /posts/delete)')" 0

  # --- X9: --prune and --dry-run with a value are usage errors ----------------
  # hexo-cli parses these with minimist; the values below must stop the
  # command before anything is loaded or sent.
  local spelling label
  for spelling in --prune=no --prune=false --prune=0 --no-prune --dry-run=no --dry-run=false; do
    label="badflag${spelling//[^a-z0-9]/-}"
    mark="$(lines_of "$M1_LOG")"
    hexo_run "$label" key momobird sync "$spelling"
    verdict X9 "momobird sync $spelling is a usage error: non-zero exit, the usage line, no request" \
      "exit $RC; $(grep -h '参数 --' "$OUT/$label.log" | sed 's/^[A-Z]* *//' | head -1); requests: $(requests_line "$M1_LOG" "$mark")" \
      eq "$([ "$RC" -ne 0 ] && echo nonzero || echo zero):$(grep -c '的值无法识别.*用法：hexo momobird' "$OUT/$label.log" || true):$(lines_of "$M1_LOG")" "nonzero:1:$mark"
  done
  mark="$(lines_of "$M1_LOG")"
  hexo_run goodflag key momobird sync --dry-run= --prune=true
  verdict X9 "momobird sync --dry-run= --prune=true is accepted (a dry run, nothing sent)" \
    "exit $RC; $(grep -h '试运行' "$OUT/goodflag.log" | sed 's/^[A-Z]* *//' | head -1); $(requests_line "$M1_LOG" "$mark")" \
    eq "$RC:$(grep -c '试运行' "$OUT/goodflag.log" || true):$(count_requests "$M1_LOG" "$mark" '^(PUT|POST)')" "0:1:0"

  # --- main generate: B4, B5, 1, 3, 6, 7, 8, 10, T -----------------------------
  hexo_run clean0 none clean
  mark="$(lines_of "$M1_LOG")"
  hexo_run gen1 key generate
  local gen1_log="$OUT/gen1.log" gen1_requests
  gen1_requests="$(requests_line "$M1_LOG" "$mark")"
  verdict 1 "hexo g syncs" "exit $RC; $gen1_requests" \
    eq "$RC:$(count_requests "$M1_LOG" "$mark" '^PUT /posts')" "0:1"

  public_leak_scan "after gen1 (first sync)"
  # The scan has to find a key where there is one: a copy of a plugin page with
  # the key appended, kept in a scratch directory outside public/.
  mkdir -p "$VDIR/scan-selftest/planted" "$VDIR/scan-selftest/clean"
  cp "$(page 2026/10/20/hello-world)" "$VDIR/scan-selftest/clean/index.html"
  cp "$(page 2026/10/20/hello-world)" "$VDIR/scan-selftest/planted/index.html"
  printf '<!-- %s -->\n' "$KEY" >> "$VDIR/scan-selftest/planted/index.html"
  verdict B9 "scan self-test: a plugin page with the key appended is flagged, the untouched copy is not" \
    "planted copy flagged: $(key_hits "$VDIR/scan-selftest/planted" | wc -l | tr -d ' ') file; untouched copy flagged: $(key_hits "$VDIR/scan-selftest/clean" | wc -l | tr -d ' ') files" \
    eq "$(key_hits "$VDIR/scan-selftest/planted" | wc -l | tr -d ' '):$(key_hits "$VDIR/scan-selftest/clean" | wc -l | tr -d ' ')" "1:0"

  local pushed
  pushed="$(tail -n +"$((mark + 1))" "$M1_LOG" | h pushed)"
  verdict B4 "pushes exactly the normal and the two-level-category post, no draft or encrypted post" \
    "$(echo "$pushed" | awk -F'\t' '{printf "%s \"%s\" category=%s; ", $1, $2, $3}')" \
    eq "$(echo "$pushed" | cut -f1 | sort | paste -sd, -)" "$(printf '%s\n%s\n' "$hello_id" "$nested_id" | sort | paste -sd, -)"
  verdict B4 "the two-level-category post is sent with its top-level category" \
    "category of $nested_src = $(echo "$pushed" | awk -F'\t' -v id="$nested_id" '$1 == id {print $3}'); front-matter chain: 技术 > Hexo" \
    eq "$(echo "$pushed" | awk -F'\t' -v id="$nested_id" '$1 == id {print $3}')" "技术"
  verdict B4 "the uncategorised post is sent without a category" \
    "category of $hello_src = $(echo "$pushed" | awk -F'\t' -v id="$hello_id" '$1 == id {print $3}') ('-' means none)" \
    eq "$(echo "$pushed" | awk -F'\t' -v id="$hello_id" '$1 == id {print $3}')" "-"

  local hello_page nested_page secret_page home_page
  hello_page="$(page 2026/10/20/hello-world)"
  nested_page="$(page 2026/10/22/categories-nested)"
  secret_page="$(page 2026/10/23/secret-post)"
  home_page="$SITE/public/index.html"

  local content
  content="$(tail -n +"$((mark + 1))" "$M1_LOG" | h pushed-content "$hello_id")"
  verdict X5 "highlighted code: gutter line numbers are in the HTML but not in the pushed text" \
    "gutter in html=$(occurrences "$hello_page" 'class="gutter"'); pushed text keeps the code line=$(echo "$content" | grep -c 'const answer = 42;' || true); digit-only lines=$(echo "$content" | grep -c -E '^[0-9]+$' || true)" \
    eq "$(occurrences "$hello_page" 'class="gutter"'):$(echo "$content" | grep -c 'const answer = 42;' || true):$(echo "$content" | grep -c -E '^[0-9]+$' || true)" "1:1:0"

  verdict B5 "post pages carry data-project and momobird-podcast, the home page has no momobird-podcast" \
    "post data-project=$(occurrences "$hello_page" 'data-project="pub_hexo_local"') momobird-podcast=$(occurrences "$hello_page" 'class="momobird-podcast"'); home momobird-podcast=$(occurrences "$home_page" momobird-podcast)" \
    eq "$(occurrences "$hello_page" 'data-project="pub_hexo_local"'):$(occurrences "$hello_page" 'class="momobird-podcast"'):$(occurrences "$home_page" momobird-podcast)" "1:1:0"

  verdict 3 "generated HTML has the widget on every page and the placeholder on syncable post pages only" \
    "widget script: home=$(occurrences "$home_page" loader.v1.js) hello=$(occurrences "$hello_page" loader.v1.js) nested=$(occurrences "$nested_page" loader.v1.js) secret=$(occurrences "$secret_page" loader.v1.js); placeholder: home=$(occurrences "$home_page" momobird-podcast) hello=$(occurrences "$hello_page" momobird-podcast) nested=$(occurrences "$nested_page" momobird-podcast) secret=$(occurrences "$secret_page" momobird-podcast)" \
    eq "$(occurrences "$home_page" loader.v1.js)$(occurrences "$hello_page" loader.v1.js)$(occurrences "$nested_page" loader.v1.js)$(occurrences "$secret_page" loader.v1.js)/$(occurrences "$home_page" momobird-podcast)$(occurrences "$hello_page" momobird-podcast)$(occurrences "$nested_page" momobird-podcast)$(occurrences "$secret_page" momobird-podcast)" "1111/0110"
  verdict 3 "state survives after_generate: the widget is enabled after the sync, in the same build" \
    "$gen1_requests" \
    eq "$(requests_since "$M1_LOG" "$mark" | grep -E '^(PUT /posts|POST /widget/enable)' | cut -d' ' -f1-2 | paste -sd, -)" "PUT /posts,POST /widget/enable"

  verdict 6 "injector: widget script exactly once per page; podcast script once per post page, never on the home page" \
    "widget (home/hello/nested/secret)=$(occurrences "$home_page" loader.v1.js)/$(occurrences "$hello_page" loader.v1.js)/$(occurrences "$nested_page" loader.v1.js)/$(occurrences "$secret_page" loader.v1.js); podcast.v1.js (home/hello/nested/secret)=$(occurrences "$home_page" podcast.v1.js)/$(occurrences "$hello_page" podcast.v1.js)/$(occurrences "$nested_page" podcast.v1.js)/$(occurrences "$secret_page" podcast.v1.js)" \
    eq "$(occurrences "$home_page" podcast.v1.js)$(occurrences "$hello_page" podcast.v1.js)$(occurrences "$nested_page" podcast.v1.js)$(occurrences "$secret_page" podcast.v1.js)" "0111"

  local hello_ph nested_ph
  hello_ph="data-source=\"$SOURCE_ID\" data-post=\"$hello_id\" data-api=\"http://127.0.0.1:$M1_PORT\""
  nested_ph="data-source=\"$SOURCE_ID\" data-post=\"$nested_id\" data-api=\"http://127.0.0.1:$M1_PORT\""
  verdict 8 "template_locals: post pages get the placeholder with data-post = externalId(post.source)" \
    "hello data-post=$hello_id; nested data-post=$nested_id; $(grep -o 'class="momobird-podcast"[^>]*>' "$hello_page" | head -1)" \
    eq "$(occurrences "$hello_page" "$hello_ph"):$(occurrences "$nested_page" "$nested_ph")" "1:1"
  verdict 8 "template_locals: no placeholder on the home page and its excerpts, nor on the encrypted post" \
    "home=$(occurrences "$home_page" momobird-podcast) (excerpts shown: $(occurrences "$home_page" 'class="entry-excerpt"')), secret=$(occurrences "$secret_page" momobird-podcast)" \
    eq "$(occurrences "$home_page" momobird-podcast):$(occurrences "$secret_page" momobird-podcast)" "0:0"

  verdict T "theme layout reads page.title, page.permalink, page.date and page.content on a decorated post page" \
    "$(grep -o '<title>[^<]*</title>' "$hello_page"); $(grep -o 'data-permalink="[^"]*" data-date="[^"]*"' "$hello_page"); content starts: $(grep -o '<div class="post-content">.\{0,40\}' "$hello_page" | head -1)... then $(grep -o '</div><p>这是一篇普通文章' "$hello_page" | head -1)" \
    eq "$(occurrences "$hello_page" '<title>你好，MomoBird - MomoBird Hexo 测试站</title>'):$(occurrences "$hello_page" 'data-permalink="https://hexo.example.com/2026/10/20/hello-world/" data-date="2026-10-20 09:30:00"'):$(occurrences "$hello_page" '<h1 class="post-title">你好，MomoBird</h1>'):$(occurrences "$hello_page" "$hello_ph></div><p>这是一篇普通文章，会被同步到 MomoBird。")" "1:1:1:1"
  verdict T "an encrypted post page keeps its untouched page.content" \
    "secret page body: $(grep -o '<div class="post-content">.\{0,30\}' "$secret_page" | head -1)" \
    has "$secret_page" '<div class="post-content"><p>这篇文章设了 password'

  verdict 7 "plugin loaded through Hexo's loadPlugin wrapper from node_modules (hexo-momobird-ai, installed from the packed tarball)" \
    "node_modules/hexo-momobird-ai is a real directory=$([ -d "$SITE/node_modules/hexo-momobird-ai" ] && [ ! -L "$SITE/node_modules/hexo-momobird-ai" ] && echo yes || echo no); [MomoBird] lines in hexo g=$(grep -c '\[MomoBird\]' "$gen1_log" || true); momobird command ran=$([ -s "$OUT/status.log" ] && echo yes || echo no)" \
    eq "$([ -d "$SITE/node_modules/hexo-momobird-ai" ] && [ ! -L "$SITE/node_modules/hexo-momobird-ai" ] && echo yes || echo no):$([ "$(grep -c '\[MomoBird\]' "$gen1_log" || true)" -gt 0 ] && echo yes || echo no)" "yes:yes"

  # --- B6: second generate hits the cache ---------------------------------------
  mark="$(lines_of "$M1_LOG")"
  hexo_run gen2 key generate
  verdict B6 "second hexo g sends no PUT (cache hit) and no delete" "exit $RC; $(requests_line "$M1_LOG" "$mark")" \
    eq "$RC:$(count_requests "$M1_LOG" "$mark" '^(PUT|POST /posts/delete|POST /widget/enable)')" "0:0"
  verdict 6 "second build: still exactly one widget script (home) and no podcast script on the home page" \
    "loader.v1.js in index.html=$(occurrences "$home_page" loader.v1.js), podcast.v1.js=$(occurrences "$home_page" podcast.v1.js)" \
    eq "$(occurrences "$home_page" loader.v1.js):$(occurrences "$home_page" podcast.v1.js)" "1:0"

  # --- 5, B7: a push and a delete are planned -----------------------------------
  cat > "$SITE/source/_posts/extra-post.md" <<'EOF'
---
title: 临时加的文章
date: 2026-10-24 08:00:00
updated: 2026-10-24 08:30:00
---

这篇文章是集成测试里临时加的，用来看新增推送。
EOF
  rm "$SITE/source/_posts/hello-world.md"
  mark="$(lines_of "$M1_LOG")"
  hexo_run dryrun2 key momobird sync --dry-run
  verdict 5 "--dry-run with a push and a delete planned: lists both, sends no PUT and no delete" \
    "exit $RC; $(grep -h -E '将推送：|将下线：' "$OUT/dryrun2.log" | sed 's/^[A-Z]* *//' | paste -sd'|' - | sed 's/|/ | /g'); $(requests_line "$M1_LOG" "$mark")" \
    eq "$(count_requests "$M1_LOG" "$mark" '^(PUT|POST /posts/delete)'):$(grep -c -e "将推送：$extra_src" -e "将下线：编号 $hello_id" "$OUT/dryrun2.log" || true)" "0:2"

  mark="$(lines_of "$M1_LOG")"
  hexo_run gen3 key generate
  verdict B7 "removing a post sends one delete request for that post" \
    "exit $RC; $(requests_line "$M1_LOG" "$mark"); deleted ids: $(tail -n +"$((mark + 1))" "$M1_LOG" | h deleted | paste -sd, -) (hello-world=$hello_id)" \
    eq "$RC:$(count_requests "$M1_LOG" "$mark" '^POST /posts/delete'):$(tail -n +"$((mark + 1))" "$M1_LOG" | h deleted | paste -sd, -)" "0:1:$hello_id"

  # --- 1, X4, X6: `hexo gen`, `hexo G`, `hexo d -g`, first build without a cache --
  rm -rf "$SITE/node_modules/.cache"
  mark="$(lines_of "$M1_LOG")"
  hexo_run sync1 key momobird sync
  verdict 2 "momobird sync (real run, no cache) pushes the syncable posts" \
    "exit $RC; $(requests_line "$M1_LOG" "$mark"); $(grep -h '同步完成' "$OUT/sync1.log" | sed 's/^[A-Z]* *//')" \
    eq "$RC:$(count_requests "$M1_LOG" "$mark" '^PUT /posts -> 200 posts=2'):$(count_requests "$M1_LOG" "$mark" '^POST /posts/delete')" "0:1:0"

  rm -rf "$SITE/node_modules/.cache"
  mark="$(lines_of "$M1_LOG")"
  hexo_run gen4 key gen
  verdict 1 "hexo gen (prefix alias of generate) syncs" "exit $RC; $(requests_line "$M1_LOG" "$mark")" \
    eq "$RC:$(count_requests "$M1_LOG" "$mark" '^PUT /posts')" "0:1"
  verdict X4 "first build without a cache while MomoBird already holds the posts: everything is pushed again, nothing is removed" \
    "$(grep -h '同步完成' "$OUT/gen4.log" | sed 's/^[A-Z]* *//'); deletes=$(count_requests "$M1_LOG" "$mark" '^POST /posts/delete')" \
    eq "$(grep -c '同步完成：新增或更新 0 篇，未变 2 篇，下线 0 篇，失败 0 篇' "$OUT/gen4.log" || true):$(count_requests "$M1_LOG" "$mark" '^POST /posts/delete')" "1:0"

  rm -rf "$SITE/node_modules/.cache"
  mark="$(lines_of "$M1_LOG")"
  hexo_run gen5 key G
  verdict 1 "hexo G (upper case) syncs, as Hexo lower-cases the command name" "exit $RC; $(requests_line "$M1_LOG" "$mark")" \
    eq "$RC:$(count_requests "$M1_LOG" "$mark" '^PUT /posts')" "0:1"

  rm -rf "$SITE/node_modules/.cache"
  rm -f "$SITE/deployed.marker"
  mark="$(lines_of "$M1_LOG")"
  CFG="_config.yml,_mock.yml,_deploy.yml"
  hexo_run deploy1 key d -g
  verdict 1 "hexo d -g (deploy alias plus --generate) syncs and deploys" "exit $RC; $(requests_line "$M1_LOG" "$mark"); deploy marker=$([ -f "$SITE/deployed.marker" ] && echo yes || echo no)" \
    eq "$RC:$(count_requests "$M1_LOG" "$mark" '^PUT /posts'):$([ -f "$SITE/deployed.marker" ] && echo yes || echo no)" "0:1:yes"
  CFG="_config.yml,_mock.yml"

  # --- 1, B8: hexo server and watch mode send nothing -----------------------------
  local port spid i
  port="$(h free-port)"
  mark="$(lines_of "$M1_LOG")"
  env "MOMOBIRD_KEY=$KEY" node "$HELPERS" run --cwd "$SITE" --stop-after 8 -- "$HEXO" s -p "$port" -i 127.0.0.1 --config "$CFG" \
    < /dev/null > "$OUT/server.log" 2>&1 &
  spid=$!
  HELPER_PIDS="$HELPER_PIDS $spid"
  i=0
  until curl -sf -m 2 -o "$OUT/server-home.html" "http://127.0.0.1:$port/"; do
    i=$((i + 1))
    [ "$i" -gt 40 ] && break
    sleep 0.25
  done
  curl -sf -m 5 -o "$OUT/server-post.html" "http://127.0.0.1:$port/2026/10/22/categories-nested/" || true
  wait "$spid" || true
  HELPER_PIDS="${HELPER_PIDS/ $spid/}"
  [ -f "$OUT/server-home.html" ] || : > "$OUT/server-home.html"
  [ -f "$OUT/server-post.html" ] || : > "$OUT/server-post.html"
  local served_home served_post
  served_home="$(occurrences "$OUT/server-home.html" 'MomoBird Hexo 测试站')"
  served_post="$(occurrences "$OUT/server-post.html" '带两级分类的文章')"
  verdict 1 "hexo s (8 seconds, key set) sends 0 requests" \
    "$(requests_line "$M1_LOG" "$mark"); the server did answer (site title on home x$served_home, post title on the post page x$served_post)" \
    eq "$(lines_of "$M1_LOG"):$([ "$served_home" -ge 1 ] && echo up || echo down):$([ "$served_post" -ge 1 ] && echo up || echo down)" "$mark:up:up"
  verdict B8 "pages served by hexo s carry no widget, no podcast script and no placeholder" \
    "loader.v1.js=$(occurrences "$OUT/server-home.html" loader.v1.js)+$(occurrences "$OUT/server-post.html" loader.v1.js), podcast.v1.js=$(occurrences "$OUT/server-post.html" podcast.v1.js), placeholder=$(occurrences "$OUT/server-post.html" momobird-podcast)" \
    eq "$(occurrences "$OUT/server-home.html" loader.v1.js)$(occurrences "$OUT/server-post.html" loader.v1.js)$(occurrences "$OUT/server-post.html" podcast.v1.js)$(occurrences "$OUT/server-post.html" momobird-podcast)" "0000"

  hexo_run clean1 none clean
  mark="$(lines_of "$M1_LOG")"
  hexo_for 8 watch g -w || true
  verdict 1 "hexo g -w (8 seconds, key set) sends 0 requests but does generate" \
    "$(requests_line "$M1_LOG" "$mark"); public/index.html exists=$([ -f "$home_page" ] && echo yes || echo no); loader.v1.js in it=$([ -f "$home_page" ] && occurrences "$home_page" loader.v1.js || echo n/a)" \
    eq "$(lines_of "$M1_LOG"):$([ -f "$home_page" ] && occurrences "$home_page" loader.v1.js || echo n/a)" "$mark:0"

  # --- C: category order ------------------------------------------------------------
  cat > "$SITE/source/_posts/multi-root-probe.md" <<'EOF'
---
title: 多个顶层分类的文章
date: 2026-10-25 08:00:00
updated: 2026-10-25 08:30:00
categories:
  - [Zeta, Inner]
  - [Alpha]
  - [技术]
---

这篇文章有三个顶层分类，front-matter 里最先写的是 Zeta。
EOF
  local probe_id sent probe_rows nested_rows fresh_rows
  probe_id="$(h external-id _posts/multi-root-probe.md)"
  mark="$(lines_of "$M1_LOG")"
  hexo_run gen6 key generate
  sent="$(tail -n +"$((mark + 1))" "$M1_LOG" | h pushed | awk -F'\t' -v id="$probe_id" '$1 == id {print $3}')"
  probe_rows="$(h hexo-categories "$SITE" 2>/dev/null | awk -F'\t' '$1 == "_posts/multi-root-probe.md"')"
  nested_rows="$(h hexo-categories "$SITE" 2>/dev/null | awk -F'\t' '$1 == "_posts/categories-nested.md"')"
  record C "category order (two-level post)" INFO \
    "front-matter: 技术 > Hexo; post.categories order: $(echo "$nested_rows" | cut -f2) (join table: $(echo "$nested_rows" | cut -f3); '^' marks a child); plugin sent: $(echo "$pushed" | awk -F'\t' -v id="$nested_id" '$1 == id {print $3}')"

  # post.categories is in site-wide creation order (技术 was created by another
  # post first); the post's own PostCategory rows keep the front-matter order.
  # The plugin has to send the front-matter-first top-level category: Zeta.
  verdict C "a post with three top-level categories is sent with the front-matter-first one" \
    "front-matter roots in order: Zeta, Alpha, 技术; post.categories order: $(echo "$probe_rows" | cut -f2); PostCategory order: $(echo "$probe_rows" | cut -f3); plugin sent: $sent" \
    eq "$sent" "Zeta"

  # A fresh load (no db.json) creates the categories in file-processing order,
  # which is not the same on every Hexo version (Hexo 8 puts Zeta before 技术).
  hexo_run clean3 none clean
  fresh_rows="$(h hexo-categories "$SITE" 2>/dev/null | awk -F'\t' '$1 == "_posts/multi-root-probe.md"')"
  record C "category order after a fresh load (information)" INFO \
    "post.categories order: $(echo "$fresh_rows" | cut -f2); PostCategory order: $(echo "$fresh_rows" | cut -f3)"

  # hexo clean && hexo g, plugin cache kept: the digest must be the same as
  # before the clean, so nothing is pushed again.
  hexo_run clean4 none clean
  mark="$(lines_of "$M1_LOG")"
  hexo_run gen7 key generate
  verdict C "after hexo clean && hexo g the category is unchanged: nothing is pushed again" \
    "exit $RC; $(requests_line "$M1_LOG" "$mark")" \
    eq "$RC:$(count_requests "$M1_LOG" "$mark" '^PUT /posts')" "0:0"

  # hexo clean && hexo g, plugin cache wiped: everything is pushed again and
  # the probe still carries Zeta.
  hexo_run clean5 none clean
  rm -rf "$SITE/node_modules/.cache"
  mark="$(lines_of "$M1_LOG")"
  hexo_run gen8 key generate
  local sent_again
  sent_again="$(tail -n +"$((mark + 1))" "$M1_LOG" | h pushed | awk -F'\t' -v id="$probe_id" '$1 == id {print $3}')"
  verdict C "after hexo clean && hexo g (no cache) the three-category post is still sent with Zeta" \
    "exit $RC; plugin sent: ${sent_again:-(nothing)}; $(requests_line "$M1_LOG" "$mark")" \
    eq "$RC:$sent_again" "0:Zeta"
  public_leak_scan "after gen8 (hexo clean && hexo g)"

  # --- 9: strict mode with a failing PUT ----------------------------------------------
  start_mock M2 "$SITE_URL" --put-status 500
  printf 'momobird:\n  api: http://127.0.0.1:%s\n' "$M2_PORT" > "$SITE/_m2.yml"
  printf 'momobird:\n  strict: true\n' > "$SITE/_strict.yml"
  rm -rf "$SITE/node_modules/.cache"

  CFG="_config.yml,_m2.yml,_strict.yml"
  mark="$(lines_of "$M2_LOG")"
  hexo_run strict-g key generate
  verdict 9 "strict: true and PUT answering 500: hexo g exits non-zero" \
    "exit $RC; $(requests_line "$M2_LOG" "$mark"); $(grep -h -E 'MomoBirdError|同步失败' "$OUT/strict-g.log" | head -2 | tr '\n' ' ')" \
    test "$RC" -ne 0
  CFG="_config.yml,_m2.yml,_strict.yml,_deploy.yml"
  rm -f "$SITE/deployed.marker"
  hexo_run strict-gd key g -d
  verdict 9 "strict: hexo g -d exits non-zero and does not deploy" \
    "exit $RC; deploy marker=$([ -f "$SITE/deployed.marker" ] && echo yes || echo no)" \
    eq "$([ "$RC" -ne 0 ] && echo nonzero || echo zero):$([ -f "$SITE/deployed.marker" ] && echo yes || echo no)" "nonzero:no"
  CFG="_config.yml,_m2.yml"
  hexo_run lenient-g key generate
  verdict 9 "without strict, the same failing PUT leaves hexo g at exit 0 with a warning" \
    "exit $RC; $(grep -h '同步失败' "$OUT/lenient-g.log" | head -1 | sed 's/^[A-Z]* *//')" \
    eq "$RC:$(grep -c '同步失败' "$OUT/lenient-g.log" || true)" "0:1"
  CFG="_config.yml,_m2.yml,_deploy.yml"
  rm -f "$SITE/deployed.marker"
  hexo_run lenient-gd key g -d
  verdict 9 "without strict, hexo g -d deploys despite the failed sync" \
    "exit $RC; deploy marker=$([ -f "$SITE/deployed.marker" ] && echo yes || echo no)" \
    eq "$RC:$([ -f "$SITE/deployed.marker" ] && echo yes || echo no)" "0:yes"

  # --- X1: the site url does not match the source ----------------------------------------
  start_mock M3 "https://other.example.com"
  printf 'momobird:\n  api: http://127.0.0.1:%s\n' "$M3_PORT" > "$SITE/_m3.yml"
  CFG="_config.yml,_m3.yml"
  hexo_run clean2 none clean
  hexo_run origin key generate
  verdict X1 "origin mismatch: both addresses are printed, nothing is pushed, no widget in the pages" \
    "exit $RC; $(grep -h '站点地址不一致' "$OUT/origin.log" | head -1 | sed 's/^[A-Z]* *//'); $(requests_line "$M3_LOG" 0); loader.v1.js in index.html=$(occurrences "$home_page" loader.v1.js)" \
    eq "$RC:$(grep -c 'url 是 https://hexo.example.com，MomoBird 来源的网址是 https://other.example.com' "$OUT/origin.log" || true):$(count_requests "$M3_LOG" 0 '^(PUT|POST)'):$(occurrences "$home_page" loader.v1.js)" "0:1:0:0"

  # --- X3: a wrong key -----------------------------------------------------------------------
  CFG="_config.yml,_mock.yml"
  hexo_run badkey bad generate
  verdict X3 "wrong key: build succeeds with the 401 explanation, the key is not printed" \
    "exit $RC; $(grep -h '连接密钥无效' "$OUT/badkey.log" | head -1 | sed 's/^[A-Z]* *//')" \
    eq "$RC:$(grep -c '连接密钥无效' "$OUT/badkey.log" || true):$(grep -c -F -e "$BAD_KEY" -e WRONGKEY "$OUT/badkey.log" || true)" "0:1:0"

  # --- X7: the plan expired: pushes stop, removals still go out ------------------------------
  # MomoBird already holds the three syncable posts and hello-world, which the
  # site deleted earlier. With the plan expired it refuses PUT /posts (402) but
  # still lists and deletes, so hello-world must come down anyway. The mock
  # leaves the widget at not_published: an enable request after the 402 would
  # show up in its log.
  local expired_seed probe_id_now cache_file
  probe_id_now="$(h external-id _posts/multi-root-probe.md)"
  expired_seed="$nested_id,$extra_id,$probe_id_now,$hello_id"
  cache_file="$SITE/node_modules/.cache/hexo-momobird-ai/$SOURCE_ID.json"
  start_mock M4 "$SITE_URL" --plan expired --seed "$expired_seed"
  printf 'momobird:\n  api: http://127.0.0.1:%s\n' "$M4_PORT" > "$SITE/_m4.yml"
  CFG="_config.yml,_m4.yml"
  rm -rf "$SITE/node_modules/.cache"
  hexo_run expired-g key generate
  verdict X7 "expired plan: one PUT answered 402, then the delete of the removed post, no widget enable, exit 0" \
    "exit $RC; $(requests_line "$M4_LOG" 0); deleted: $(h deleted < "$M4_LOG" | paste -sd, -) (hello-world=$hello_id)" \
    eq "$RC:$(count_requests "$M4_LOG" 0 '^PUT /posts -> 402'):$(count_requests "$M4_LOG" 0 '^PUT'):$(h deleted < "$M4_LOG" | paste -sd, -):$(count_requests "$M4_LOG" 0 '^POST /widget/enable')" "0:1:1:$hello_id:0"
  verdict X7 "expired plan: the log says new and changed posts were not synced and how many were taken down" \
    "$(grep -h '套餐已到期' "$OUT/expired-g.log" | sed 's/^[A-Z]* *//' | paste -sd'|' - | sed 's/|/ | /g')" \
    eq "$(grep -c '同步未完成：套餐已到期，新增或修改的 3 篇文章没有同步' "$OUT/expired-g.log" || true):$(grep -c '本次下线 1 篇' "$OUT/expired-g.log" || true):$(grep -c '同步完成' "$OUT/expired-g.log" || true)" "1:1:0"
  verdict X7 "expired plan: the cache records none of the posts the server did not take" \
    "cache: $(cat "$cache_file" 2>/dev/null || echo '(missing)')" \
    eq "$(cat "$cache_file" 2>/dev/null)" "{}"

  start_mock M5 "$SITE_URL" --plan expired --seed "$expired_seed"
  printf 'momobird:\n  api: http://127.0.0.1:%s\n' "$M5_PORT" > "$SITE/_m5.yml"
  CFG="_config.yml,_m5.yml,_strict.yml"
  hexo_run expired-strict key generate
  verdict X7 "expired plan with strict: true: the delete still goes out and hexo g exits non-zero" \
    "exit $RC; $(requests_line "$M5_LOG" 0); $(grep -h -E 'MomoBirdError|套餐已到期' "$OUT/expired-strict.log" | head -2 | tr '\n' ' ')" \
    eq "$([ "$RC" -ne 0 ] && echo nonzero || echo zero):$(h deleted < "$M5_LOG" | paste -sd, -):$(count_requests "$M5_LOG" 0 '^POST /widget/enable')" "nonzero:$hello_id:0"
  CFG="_config.yml,_mock.yml"

  # --- X8: a post Hexo cannot read is not taken down ---------------------------------------
  # A front-matter Hexo cannot parse makes it log "Process failed" and go on
  # without the post. After a clean, the post is missing from Hexo's model
  # although its file is there; MomoBird still holds it and must keep it. The
  # front-matter is ASCII because Hexo prints it with the error, and the log
  # check above wants every Chinese line to carry [MomoBird].
  local broken_src="_posts/broken-front-matter.md" broken_id
  broken_id="$(h external-id "$broken_src")"
  printf -- '---\ntitle: Broken front-matter\ndate: 2026-10-26 08:00:00\ntags: [one, two\n---\n\nThis post has a front-matter typo.\n' \
    > "$SITE/source/$broken_src"
  start_mock M6 "$SITE_URL" --seed "$nested_id,$extra_id,$probe_id_now,$broken_id,$hello_id"
  printf 'momobird:\n  api: http://127.0.0.1:%s\n' "$M6_PORT" > "$SITE/_m6.yml"
  CFG="_config.yml,_m6.yml"
  hexo_run clean6 none clean
  rm -rf "$SITE/node_modules/.cache"
  hexo_run unreadable-g key generate
  verdict X8 "unreadable post: Hexo reports it, the plugin names it and keeps it, the deleted post still goes" \
    "exit $RC; hexo: $(grep -v -F '[MomoBird]' "$OUT/unreadable-g.log" | grep -o 'Process failed.*' | head -1); plugin: $(grep -h 'Hexo 没能读取' "$OUT/unreadable-g.log" | sed 's/^[A-Z]* *//' | head -1); deleted: $(h deleted < "$M6_LOG" | paste -sd, -) (broken=$broken_id, hello-world=$hello_id)" \
    eq "$RC:$(grep -v -F '[MomoBird]' "$OUT/unreadable-g.log" | grep -c "Process failed.*$broken_src" || true):$(grep -c "Hexo 没能读取这篇文章，暂不下线：$broken_src" "$OUT/unreadable-g.log" || true):$(h deleted < "$M6_LOG" | paste -sd, -)" "0:1:1:$hello_id"
  mark="$(lines_of "$M6_LOG")"
  hexo_run unreadable-dry key momobird sync --dry-run --prune
  verdict X8 "unreadable post: momobird sync --dry-run --prune names it and does not list it for removal" \
    "exit $RC; $(grep -h -E 'Hexo 没能读取|将下线' "$OUT/unreadable-dry.log" | sed 's/^[A-Z]* *//' | paste -sd'|' - | sed 's/|/ | /g')" \
    eq "$RC:$(grep -c "暂不下线：$broken_src" "$OUT/unreadable-dry.log" || true):$(grep -c '将下线' "$OUT/unreadable-dry.log" || true):$(count_requests "$M6_LOG" "$mark" '^(PUT|POST)')" "0:1:0:0"
  rm -f "$SITE/source/$broken_src"

  # --- 10, B9: logs and secrets --------------------------------------------------------------------
  local lint
  lint="$(h log-lint $(ls "$OUT"/*.log | grep -v npm-install) 2>&1 || true)"
  verdict 10 "all Chinese log lines carry the [MomoBird] prefix and the text is intact (no U+FFFD)" \
    "$(echo "$lint" | tail -1)" \
    h log-lint $(ls "$OUT"/*.log | grep -v npm-install)
  local leaked
  leaked="$(key_hits "$OUT" "$SITE/db.json" "$SITE/_multiconfig.yml" "$SITE/node_modules/.cache" "$VDIR"/*.jsonl "$VDIR"/*.out)"
  verdict B9 "no key (not even the mbk_ prefix) in any stdout/stderr, db.json, the cache or the mock logs" \
    "scanned $(ls "$OUT"/*.log | wc -l | tr -d ' ') command logs; files with a match: ${leaked:-none}" \
    test -z "$leaked"

  record N "Node warnings in Hexo's output" INFO \
    "lines with DeprecationWarning / (node:PID): $(cat "$OUT"/*.log | grep -c -E 'DeprecationWarning|\(node:[0-9]+\)' || true) of $(cat "$OUT"/*.log | wc -l | tr -d ' ') output lines"

  stop_mocks
}

# ----- main --------------------------------------------------------------------------------------

command -v node > /dev/null || die "node is required"
command -v npm > /dev/null || die "npm is required"
command -v curl > /dev/null || die "curl is required"

echo "work dir: $WORK"
TARBALL_DIR="$WORK/tarball"
mkdir -p "$TARBALL_DIR"
# `npm pack <dir>` writes into the current directory on every npm version
# (--pack-destination does not exist before npm 7, and Node 14 ships npm 6).
(cd "$TARBALL_DIR" && npm pack "$ROOT" --loglevel=error > /dev/null)
TARBALL="$(ls "$TARBALL_DIR"/*.tgz)"
echo "plugin tarball: $(basename "$TARBALL")"

for version in $HEXO_VERSIONS; do
  run_version "$version"
done

echo
echo "=== summary ==="
printf '%-7s %-5s %-6s %s\n' HEXO CHECK STATUS NAME
while IFS="$(printf '\t')" read -r v num name status evidence; do
  printf '%-7s %-5s %-6s %s\n' "$v" "$num" "$status" "$name"
done < "$RESULTS"

failed="$(awk -F'\t' '$4 == "FAIL"' "$RESULTS" | wc -l | tr -d ' ')"
total="$(awk -F'\t' '$4 == "PASS" || $4 == "FAIL"' "$RESULTS" | wc -l | tr -d ' ')"
echo
if [ "$failed" -ne 0 ]; then
  echo "FAIL: $failed of $total checks failed"
  exit 1
fi
echo "PASS: all $total checks passed on Hexo $HEXO_VERSIONS"
