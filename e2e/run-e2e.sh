#!/usr/bin/env bash
# e2e/run-e2e.sh — runs the hermetic opencode-mcp e2e suite in Docker on a remote host (never
# locally). Default host is the maintainer's SSH alias `gram`; override with OCMCP_REMOTE_HOST.
# Mirrors scripts/remote.sh's rsync/ssh/quoting conventions but
# drives several docker steps (bundle build, image build, scenario run, node:20 bundle smoke,
# optional claude stretch run) instead of one.
#
# Usage:
#   e2e/run-e2e.sh [--only <substring>] [--keep] [--with-claude]
#
# Steps (default remote dir/image tag; override both with OCMCP_E2E_LABEL, see below):
#   1. rsync -a --delete this repo to gram:/tmp/ocmcp/e2e (excludes .git, node_modules, dist,
#      .worktrees, .npmrc, .env, .env.*; any stale copy of those last three left by a sync made
#      before these excludes existed is removed explicitly with a direct `rm`, not rsync's
#      --delete-excluded — see that command's own comment for why). The shared parent /tmp/ocmcp is
#      kept mode 700 (owned by this ssh user) for the whole transfer, not chmod'd only afterwards
#      — r3-r-security-2, mid-review finding 13. Registry config still flows through
#      NPM_CONFIG_REGISTRY, forwarded into the build container below.
#   2. Build dist/opencode-mcp.mjs on gram in a plain node:22 container
#      (`npm ci && npm run build && npm run bundle`), writing it back into the synced dir.
#   3. `docker build -f e2e/Dockerfile -t ocmcp-e2e:local .` (context = the synced repo root),
#      with --build-arg WITH_CLAUDE=1 when --with-claude is given.
#   4. `docker run --rm --network none --name ocmcp-e2e-main-<pid> ocmcp-e2e:local
#      node --test e2e/scenarios.test.mjs [--test-name-pattern=<only>]`.
#   5. Feature scenarios (F9): `docker run --rm --network none --name ocmcp-e2e-features-<pid>
#      ocmcp-e2e:local node --test e2e/features.test.mjs [--test-name-pattern=<only>]` — the v0.3
#      delegation features already merged at any given base (see e2e/features.test.mjs's own header
#      comment for the current list: output paging/retention, per-turn diff, bridge-side structured
#      output, request-id deduplication, opencode-info discovery, batch status), a separate
#      step/file from the main a-i scenarios so it gets its own PASS/FAIL/SKIP line and TAP
#      accounting (never re-run by, or re-running, the main scenarios).
#   6. Overload scenarios (unit 5b): `docker run --rm --network none --name ocmcp-e2e-overload-<pid>
#      ocmcp-e2e:local node --test e2e/overload.test.mjs [--test-name-pattern=<only>]` — the
#      overload-robustness scenarios (unit 5b): the
#      response-loop watchdog (runaway empty/HTML/bad-tool-JSON), recovery before the watchdog trips,
#      20+ legitimate tool steps never tripping it, empty/whitespace/truncated/malformed-SSE
#      classification, bounded 429/529 provider retries, and a slow-first-token non-trip — its own
#      step/file so it gets its own PASS/FAIL/SKIP line and TAP accounting (never re-run by, or
#      re-running, the main or feature scenarios).
#   7. Context-concurrency scenarios: `docker run --rm --network none
#      --name ocmcp-e2e-ctxconc-<pid> ocmcp-e2e:local
#      node --test e2e/ctx-concurrency.test.mjs [--test-name-pattern=<only>]` — the context-aware
#      model sizing + run-slot cap scenarios (docs/design.md §13):
#      per-model limit/usableInputTokens/limitSource/maxRunning and server concurrency/capabilities
#      via opencode-info, the PROMPT_TOO_LARGE pre-check, per-turn context usage and CONTEXT_HIGH,
#      the run-slot cap queueing extra starts, cancelling a queued turn, a per-model cap, and the
#      large-catalog (no enabled_providers) regression — its own step/file so it gets its own
#      PASS/FAIL/SKIP line and TAP accounting (never re-run by, or re-running, the main/feature/
#      overload scenarios).
#   8. Node 20 bundle smoke: `docker run --rm --network none -v <dir>:/w -w /w node:20
#      node e2e/bundle-smoke.mjs` (skipped if --only was given and does not match "bundle"/"j").
#   9. npm packaging check: `npm pack` on gram (node:22, same npm cache volume as step 2), then in
#      a separate, otherwise-clean node:22 container (`--network none`, no e2e Docker image),
#      `npm install -g --offline <tarball>` and run e2e/packaging-check.mjs, which spawns the
#      installed `opencode-mcp` command (the real npm bin symlink, not `node dist/index.js`) and
#      does an initialize + tools/list handshake, asserting exactly 5 tools (skipped if --only was
#      given and does not match "pack"/"packaging"). `--offline` needs no network for this step:
#      the tarball is a local file, and its only runtime deps (@modelcontextprotocol/server, zod)
#      were already fetched into the shared ocmcp-npm-cache volume by step 2's `npm ci` moments
#      earlier at the exact pinned versions.
#   10. If --with-claude: `docker run ... node --test e2e/claude-stretch.test.mjs` with
#      E2E_WITH_CLAUDE=1 (skipped if --only was given and does not match "claude"/"k").
#   11. Prints a compact summary; exits non-zero if anything failed.
#
# Options:
#   --only <substring>   only run scenarios whose node:test name contains <substring>
#                         (passed as --test-name-pattern to `node --test`); also narrows which of
#                         the bundle-smoke / packaging-check / claude-stretch steps run (see above).
#                         A step --only does not select (its file/name cannot match) is reported
#                         SKIP, not FAIL, and never affects the exit status by itself — e.g.
#                         `--only bundle` succeeds whenever the bundle smoke passes, even though
#                         no scenario name in e2e/scenarios.test.mjs contains "bundle". The overall
#                         run still fails if --only matches NOTHING anywhere across every step
#                         (main scenarios, bundle smoke, packaging check, and claude stretch when
#                         --with-claude is also given) — a plain typo, not a successful narrow run.
#   --keep                don't delete temp repos/dirs inside the container (sets E2E_KEEP_TMP=1;
#                         useful for inspecting a failure — the container itself is still removed
#                         on exit since these are ephemeral by design, but its /work stays on gram
#                         if you additionally add `--keep-container`, not implemented here: use
#                         `docker run` by hand with the printed image tag to debug interactively).
#   --with-claude         also install @anthropic-ai/claude-code@2.1.284 in the image and run the
#                         stretch scenario (k).
#
# Env:
#   OCMCP_E2E_LABEL       default "e2e" (giving the documented /tmp/ocmcp/e2e and ocmcp-e2e:local
#                         defaults). Set to something else (e.g. a unit name) so a parallel/manual
#                         run uses its own remote dir, image tag and container-name prefix instead
#                         of colliding with another run on the shared host.
#
# Containers/images/dirs created here are always prefixed ocmcp-$OCMCP_E2E_LABEL /
# /tmp/ocmcp/$OCMCP_E2E_LABEL, and only ever removed with --rm; no other container on gram is
# touched.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REMOTE_HOST="${OCMCP_REMOTE_HOST:-gram}"
# Fixed defaults (dir /tmp/ocmcp/e2e, image ocmcp-e2e:local) unless overridden: set
# OCMCP_E2E_LABEL so a parallel run (e.g. another unit's own e2e iteration) uses its own remote
# dir/image tag/container-name prefix instead of colliding with this one on the shared host.
E2E_LABEL="${OCMCP_E2E_LABEL:-e2e}"
if ! printf '%s' "$E2E_LABEL" | grep -Eq '^[a-z0-9-]+$'; then
  echo "error: OCMCP_E2E_LABEL='$E2E_LABEL' must match ^[a-z0-9-]+\$" >&2
  exit 64
fi
REMOTE_BASE="/tmp/ocmcp"
REMOTE_DIR="$REMOTE_BASE/$E2E_LABEL"
IMAGE_TAG="ocmcp-$E2E_LABEL:local"

ONLY=""
KEEP=0
WITH_CLAUDE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --only)
      [ "$#" -ge 2 ] || { echo "error: --only requires an argument" >&2; exit 64; }
      ONLY="$2"
      shift 2
      ;;
    --keep)
      KEEP=1
      shift
      ;;
    --with-claude)
      WITH_CLAUDE=1
      shift
      ;;
    -h|--help)
      sed -n '2,66p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      exit 64
      ;;
  esac
done

sq() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

# Mirrors scripts/remote.sh: with .npmrc now excluded from the rsync below (r3-r-security-2), this
# is the one supported channel for a private registry during `npm ci` on gram.
REGISTRY_ENV=""
if [ -n "${NPM_CONFIG_REGISTRY:-}" ]; then
  REGISTRY_ENV="-e NPM_CONFIG_REGISTRY='$(sq "$NPM_CONFIG_REGISTRY")'"
fi

echo "==> syncing repo to $REMOTE_HOST:$REMOTE_DIR"
# Mid-review finding 13: a chmod 700 issued only AFTER rsync (the previous fix) left the
# destination exposed for the whole transfer — `rsync -a` (its -p) sets the destination's own
# top-level directory mode to match the SOURCE directory's mode (this repo root, typically 755)
# partway through, so a chmod only at the end still leaves a real window (and an interrupted run
# would never reach it at all). Two independent, complementary layers close this instead of
# chasing rsync's own per-directory permission timing:
#   1. The shared parent /tmp/ocmcp itself is mode 700, owned by this ssh user. Unix permission
#      checks require the EXECUTE bit on every ancestor directory for another user to reach
#      anything inside, so once /tmp/ocmcp is 700, no per-label directory's own mode — 755 mid-sync
#      or otherwise — can ever be reached by another user, for the whole lifetime of the transfer,
#      regardless of rsync's own timing or a script interruption. (All units use this same ssh
#      user, so this is fully backward compatible with everything else already under /tmp/ocmcp.)
#   2. The label directory itself still gets umask 077 + chmod 700 before AND after rsync too, as
#      defense in depth.
# Stale secrets from BEFORE the .npmrc/.env excludes existed are removed explicitly with a direct
# `rm -f` — never via rsync's own --delete-excluded, which (verified on gram, both against a real
# rsync-to-rsync sync AND, decisively, against this exact client/server pairing) also deletes
# node_modules/dist/.pack-out: those get populated as root inside a docker container by the build/
# pack steps below (no --user given), and this non-root ssh user cannot then re-delete them, so
# --delete-excluded made every second sync fail outright with a wall of "Permission denied"
# unlinks. rsync's `P` (protect) filter rule is documented to exempt a pattern from any delete pass
# even under --delete-excluded, but it was verified NOT to work through the actual client here:
# macOS ships `openrsync` (a BSD/protocol-only reimplementation, not GNU rsync) as `rsync`, and
# it silently fails to honor `P` when driving the remote host's real rsync over `-e ssh`, even
# though a same-version rsync-to-rsync test on the remote host alone (misleadingly) suggested it
# should work. Given
# that platform trap, avoid --delete-excluded entirely: plain --exclude (no --delete-excluded) has
# always correctly left excluded destination content alone, and .npmrc/.env/.env.* are handled
# directly by the explicit rm below instead.
ssh "$REMOTE_HOST" "mkdir -p '$(sq "$REMOTE_BASE")' && chmod 700 '$(sq "$REMOTE_BASE")' && \
  rm -f '$(sq "$REMOTE_DIR")/.npmrc' '$(sq "$REMOTE_DIR")/.env' '$(sq "$REMOTE_DIR")'/.env.* 2>/dev/null; \
  umask 077 && mkdir -p '$(sq "$REMOTE_DIR")' && chmod 700 '$(sq "$REMOTE_DIR")'"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.worktrees' \
  --exclude 'e2e/.cache' \
  --exclude '.pack-out' \
  --exclude '.npmrc' \
  --exclude '.env' \
  --exclude '.env.*' \
  -e ssh \
  "$REPO_DIR/" "$REMOTE_HOST:$REMOTE_DIR/"
ssh "$REMOTE_HOST" "chmod 700 '$(sq "$REMOTE_DIR")'"

echo "==> building dist/opencode-mcp.mjs on $REMOTE_HOST (node:22, npm ci && build && bundle)"
ssh "$REMOTE_HOST" "docker run --rm --name 'ocmcp-$E2E_LABEL-build-$$' \
  -v '$(sq "$REMOTE_DIR"):/w' -v ocmcp-npm-cache:/root/.npm $REGISTRY_ENV -w /w node:22 \
  bash -lc 'npm ci --no-audit --no-fund && npm run build && npm run bundle'"

echo "==> docker build -f e2e/Dockerfile -t $IMAGE_TAG (WITH_CLAUDE=$WITH_CLAUDE)"
ssh "$REMOTE_HOST" "docker build -f '$(sq "$REMOTE_DIR")/e2e/Dockerfile' \
  -t '$IMAGE_TAG' --build-arg WITH_CLAUDE=$WITH_CLAUDE '$(sq "$REMOTE_DIR")'"

PATTERN_FLAG=""
if [ -n "$ONLY" ]; then
  PATTERN_FLAG="--test-name-pattern='$(sq "$ONLY")'"
fi

KEEP_ENV=""
if [ "$KEEP" -eq 1 ]; then
  KEEP_ENV="-e E2E_KEEP_TMP=1"
fi

# r1-tests-quality-3: `node --test`'s own exit code is 0 for a run that passed zero tests (an
# --only pattern matching nothing) or that only skipped (a stretch scenario self-skipping despite
# being explicitly requested), so exit code alone cannot tell "everything passed" from "nothing
# ran". Capture each node:test step's TAP output (Node's default reporter when stdout isn't a
# TTY, which it never is under `docker run` here) and read its own `# pass`/`# skipped` summary
# counters, in addition to the exit code.
tap_field() {
  # $1 = TAP log file, $2 = field name (pass|skipped|tests|fail). Prints 0 if the field never
  # appeared (e.g. the process crashed before printing a summary at all — the exit-code check
  # below already fails that case regardless). NF==3 and a numeric 3rd field guard against a
  # `t.diagnostic()` line (also TAP comments, "# ...") coincidentally starting with one of these
  # words; the real summary line is always exactly "# <field> <N>".
  awk -v f="$2" '$1 == "#" && $2 == f && NF == 3 && $3 ~ /^[0-9]+$/ { v = $3 } END { print (v == "" ? 0 : v) }' "$1"
}

# A step's node:test run reported pass==0 or skipped>0 despite exiting 0: never PASS that (a
# skipped or empty requested step must never be reported PASS).
tap_check() {
  local label="$1" logfile="$2" status_var="$3" testfile="$4"
  local status pass skipped
  status="${!status_var}"
  [ "$status" -eq 0 ] || return 0
  # Verified against real `node --test` output (not assumed): a --test-name-pattern that matches
  # NOTHING inside the file does not report `# pass 0`. Node instead treats the whole file as one
  # passing top-level test (TAP: `# Subtest: <file>` / `ok 1 - <file>`, with its own empty `1..0`
  # plan for zero matched children), so the outer `# pass` is 1, not 0. Detect that wrapper
  # directly instead of trusting the summary counters alone.
  if [ -n "$testfile" ] && grep -qF "# Subtest: $testfile" "$logfile"; then
    echo "error: $label matched zero tests inside $testfile (reported as the file itself passing, not as pass=0) — treating as FAIL" >&2
    printf -v "$status_var" '%s' 1
    return 0
  fi
  pass="$(tap_field "$logfile" pass)"
  skipped="$(tap_field "$logfile" skipped)"
  if [ "$pass" -eq 0 ] || [ "$skipped" -gt 0 ]; then
    echo "error: $label reported pass=$pass skipped=$skipped despite exit 0 — treating as FAIL" >&2
    printf -v "$status_var" '%s' 1
  fi
}

MAIN_STATUS=0
FEATURES_STATUS=0
OVERLOAD_STATUS=0
CTXCONC_STATUS=0
BUNDLE_STATUS=0
PACKAGING_STATUS=0
CLAUDE_STATUS=0
# Mid-review finding 14: previously, main scenarios always ran and always counted toward the exit
# status, so `--only bundle` (meant only for the bundle-smoke step) forced MAIN_STATUS=1 (zero
# scenario names contain "bundle") and the overall run could never succeed no matter what the
# targeted step actually did. MAIN_APPLICABLE (like RUN_BUNDLE/RUN_PACKAGING/RUN_CLAUDE below)
# tracks whether this --only pattern actually applies to the main scenarios file at all; when it
# doesn't, that step is reported SKIP and excluded from the exit-status computation — a step whose
# file/name cannot match is skipped, not failed. The run still fails overall if the pattern
# matched NOTHING anywhere across the whole selection (see ANY_APPLICABLE at the end).
MAIN_APPLICABLE=1
# Same idea as MAIN_APPLICABLE, for the F9 v0.3-features scenarios (e2e/features.test.mjs): a
# separate step/file so it gets its own PASS/FAIL/SKIP line and never re-runs (or is re-run by)
# the main a-i scenarios.
FEATURES_APPLICABLE=1
# Same idea, for the overload-robustness scenarios (unit 5b, e2e/overload.test.mjs): its own
# step/file so it gets its own PASS/FAIL/SKIP line and never re-runs (or is re-run by) the main or
# feature scenarios.
OVERLOAD_APPLICABLE=1
# Same idea, for the context-concurrency scenarios (docs/design.md §13, e2e/ctx-concurrency.test.mjs):
# its own step/file so it gets its own PASS/FAIL/SKIP line and never re-runs (or is re-run by) the
# main/feature/overload scenarios.
CTXCONC_APPLICABLE=1

MAIN_LOG="$(mktemp)"
FEATURES_LOG="$(mktemp)"
OVERLOAD_LOG="$(mktemp)"
CTXCONC_LOG="$(mktemp)"
CLAUDE_LOG="$(mktemp)"
trap 'rm -f "$MAIN_LOG" "$FEATURES_LOG" "$OVERLOAD_LOG" "$CTXCONC_LOG" "$CLAUDE_LOG"' EXIT

echo "==> running main scenarios (a-i) in $IMAGE_TAG, --network none"
set +e
ssh "$REMOTE_HOST" "docker run --rm --network none --name 'ocmcp-$E2E_LABEL-main-$$' $KEEP_ENV '$IMAGE_TAG' \
  node --test $PATTERN_FLAG e2e/scenarios.test.mjs" 2>&1 | tee "$MAIN_LOG"
MAIN_STATUS=${PIPESTATUS[0]}
set -e
if [ -n "$ONLY" ] && grep -qF "# Subtest: e2e/scenarios.test.mjs" "$MAIN_LOG"; then
  # This --only pattern matched no scenario NAME at all (e.g. it targets a different step
  # entirely, like "bundle"/"pack"/"claude") — not a failure of the main scenarios step, it simply
  # does not apply to it.
  MAIN_APPLICABLE=0
  MAIN_STATUS=0
  echo "==> main scenarios: --only '$ONLY' matches no scenario name in e2e/scenarios.test.mjs — SKIP"
else
  tap_check "main scenarios" "$MAIN_LOG" MAIN_STATUS "e2e/scenarios.test.mjs"
fi

echo "==> running feature scenarios (F9: v0.3 output paging/diff/structured-output/request-id/info/batch) in $IMAGE_TAG, --network none"
set +e
ssh "$REMOTE_HOST" "docker run --rm --network none --name 'ocmcp-$E2E_LABEL-features-$$' $KEEP_ENV '$IMAGE_TAG' \
  node --test $PATTERN_FLAG e2e/features.test.mjs" 2>&1 | tee "$FEATURES_LOG"
FEATURES_STATUS=${PIPESTATUS[0]}
set -e
if [ -n "$ONLY" ] && grep -qF "# Subtest: e2e/features.test.mjs" "$FEATURES_LOG"; then
  FEATURES_APPLICABLE=0
  FEATURES_STATUS=0
  echo "==> feature scenarios: --only '$ONLY' matches no scenario name in e2e/features.test.mjs — SKIP"
else
  tap_check "feature scenarios" "$FEATURES_LOG" FEATURES_STATUS "e2e/features.test.mjs"
fi

echo "==> running overload scenarios (unit 5b: response-loop watchdog, classification, bounded provider retries) in $IMAGE_TAG, --network none"
set +e
ssh "$REMOTE_HOST" "docker run --rm --network none --name 'ocmcp-$E2E_LABEL-overload-$$' $KEEP_ENV '$IMAGE_TAG' \
  node --test $PATTERN_FLAG e2e/overload.test.mjs" 2>&1 | tee "$OVERLOAD_LOG"
OVERLOAD_STATUS=${PIPESTATUS[0]}
set -e
if [ -n "$ONLY" ] && grep -qF "# Subtest: e2e/overload.test.mjs" "$OVERLOAD_LOG"; then
  OVERLOAD_APPLICABLE=0
  OVERLOAD_STATUS=0
  echo "==> overload scenarios: --only '$ONLY' matches no scenario name in e2e/overload.test.mjs — SKIP"
else
  tap_check "overload scenarios" "$OVERLOAD_LOG" OVERLOAD_STATUS "e2e/overload.test.mjs"
fi

echo "==> running context-concurrency scenarios (model sizing, PROMPT_TOO_LARGE, context usage, run-slot cap, queue cancel, per-model cap, large-catalog regression) in $IMAGE_TAG, --network none"
set +e
ssh "$REMOTE_HOST" "docker run --rm --network none --name 'ocmcp-$E2E_LABEL-ctxconc-$$' $KEEP_ENV '$IMAGE_TAG' \
  node --test $PATTERN_FLAG e2e/ctx-concurrency.test.mjs" 2>&1 | tee "$CTXCONC_LOG"
CTXCONC_STATUS=${PIPESTATUS[0]}
set -e
if [ -n "$ONLY" ] && grep -qF "# Subtest: e2e/ctx-concurrency.test.mjs" "$CTXCONC_LOG"; then
  CTXCONC_APPLICABLE=0
  CTXCONC_STATUS=0
  echo "==> context-concurrency scenarios: --only '$ONLY' matches no scenario name in e2e/ctx-concurrency.test.mjs — SKIP"
else
  tap_check "context-concurrency scenarios" "$CTXCONC_LOG" CTXCONC_STATUS "e2e/ctx-concurrency.test.mjs"
fi

RUN_BUNDLE=1
if [ -n "$ONLY" ]; then
  case "$ONLY" in
    *bundle*|*Bundle*|*j*) RUN_BUNDLE=1 ;;
    *) RUN_BUNDLE=0 ;;
  esac
fi
if [ "$RUN_BUNDLE" -eq 1 ]; then
  echo "==> node:20 bundle smoke (scenario j), --network none"
  set +e
  ssh "$REMOTE_HOST" "docker run --rm --network none --name 'ocmcp-$E2E_LABEL-bundle20-$$' \
    -v '$(sq "$REMOTE_DIR"):/w' -w /w node:20 node e2e/bundle-smoke.mjs"
  BUNDLE_STATUS=$?
  set -e
else
  echo "==> skipping node:20 bundle smoke (--only '$ONLY' does not match)"
fi

RUN_PACKAGING=1
if [ -n "$ONLY" ]; then
  case "$ONLY" in
    *pack*|*Pack*) RUN_PACKAGING=1 ;;
    *) RUN_PACKAGING=0 ;;
  esac
fi
if [ "$RUN_PACKAGING" -eq 1 ]; then
  echo "==> npm pack (prepack rebuilds dist/ automatically)"
  ssh "$REMOTE_HOST" "docker run --rm --name 'ocmcp-$E2E_LABEL-pack-$$' \
    -v '$(sq "$REMOTE_DIR"):/w' -v ocmcp-npm-cache:/root/.npm -w /w node:22 \
    bash -lc 'rm -rf /w/.pack-out && mkdir -p /w/.pack-out && npm pack --silent --pack-destination /w/.pack-out'"

  echo "==> packaging check: npm install -g the tarball in a clean node:22 container (--network none, --offline), then run opencode-mcp with an initialize + tools/list handshake"
  set +e
  ssh "$REMOTE_HOST" "docker run --rm --network none --name 'ocmcp-$E2E_LABEL-packaging-$$' \
    -v '$(sq "$REMOTE_DIR"):/w:ro' -v ocmcp-npm-cache:/root/.npm -w /w node:22 \
    bash -lc 'npm install -g --offline --no-audit --no-fund /w/.pack-out/*.tgz && node /w/e2e/packaging-check.mjs'"
  PACKAGING_STATUS=$?
  set -e
else
  echo "==> skipping npm packaging check (--only '$ONLY' does not match)"
fi

if [ "$WITH_CLAUDE" -eq 1 ]; then
  RUN_CLAUDE=1
  if [ -n "$ONLY" ]; then
    case "$ONLY" in
      *claude*|*Claude*|*k*) RUN_CLAUDE=1 ;;
      *) RUN_CLAUDE=0 ;;
    esac
  fi
  if [ "$RUN_CLAUDE" -eq 1 ]; then
    echo "==> stretch scenario (k): headless Claude Code, --network none"
    set +e
    ssh "$REMOTE_HOST" "docker run --rm --network none --name 'ocmcp-$E2E_LABEL-claude-$$' $KEEP_ENV -e E2E_WITH_CLAUDE=1 '$IMAGE_TAG' \
      node --test $PATTERN_FLAG e2e/claude-stretch.test.mjs" 2>&1 | tee "$CLAUDE_LOG"
    CLAUDE_STATUS=${PIPESTATUS[0]}
    set -e
    # --with-claude explicitly requests this step, so a skip (broken `claude` binary — now a
    # thrown error, not a skip; see e2e/claude-stretch.test.mjs) or a 0-test --only match must
    # FAIL here too.
    tap_check "claude stretch" "$CLAUDE_LOG" CLAUDE_STATUS "e2e/claude-stretch.test.mjs"
  else
    echo "==> skipping claude stretch scenario (--only '$ONLY' does not match)"
  fi
else
  echo "==> skipping claude stretch scenario (pass --with-claude to enable)"
fi

echo ""
echo "==================== e2e summary ===================="
if [ "$MAIN_APPLICABLE" -eq 1 ]; then
  printf 'main scenarios (a-i):    %s\n' "$([ "$MAIN_STATUS" -eq 0 ] && echo PASS || echo "FAIL ($MAIN_STATUS)")"
else
  printf 'main scenarios (a-i):    SKIP (--only does not match)\n'
fi
if [ "$FEATURES_APPLICABLE" -eq 1 ]; then
  printf 'feature scenarios (F9):  %s\n' "$([ "$FEATURES_STATUS" -eq 0 ] && echo PASS || echo "FAIL ($FEATURES_STATUS)")"
else
  printf 'feature scenarios (F9):  SKIP (--only does not match)\n'
fi
if [ "$OVERLOAD_APPLICABLE" -eq 1 ]; then
  printf 'overload scenarios:      %s\n' "$([ "$OVERLOAD_STATUS" -eq 0 ] && echo PASS || echo "FAIL ($OVERLOAD_STATUS)")"
else
  printf 'overload scenarios:      SKIP (--only does not match)\n'
fi
if [ "$CTXCONC_APPLICABLE" -eq 1 ]; then
  printf 'ctx-concurrency scenarios: %s\n' "$([ "$CTXCONC_STATUS" -eq 0 ] && echo PASS || echo "FAIL ($CTXCONC_STATUS)")"
else
  printf 'ctx-concurrency scenarios: SKIP (--only does not match)\n'
fi
if [ "$RUN_BUNDLE" -eq 1 ]; then
  printf 'bundle smoke (j, node20): %s\n' "$([ "$BUNDLE_STATUS" -eq 0 ] && echo PASS || echo "FAIL ($BUNDLE_STATUS)")"
elif [ -n "$ONLY" ]; then
  printf 'bundle smoke (j, node20): SKIP (--only does not match)\n'
fi
if [ "$RUN_PACKAGING" -eq 1 ]; then
  printf 'npm packaging check:     %s\n' "$([ "$PACKAGING_STATUS" -eq 0 ] && echo PASS || echo "FAIL ($PACKAGING_STATUS)")"
elif [ -n "$ONLY" ]; then
  printf 'npm packaging check:     SKIP (--only does not match)\n'
fi
if [ "$WITH_CLAUDE" -eq 1 ]; then
  if [ "${RUN_CLAUDE:-0}" -eq 1 ]; then
    printf 'claude stretch (k):      %s\n' "$([ "$CLAUDE_STATUS" -eq 0 ] && echo PASS || echo "FAIL ($CLAUDE_STATUS)")"
  else
    printf 'claude stretch (k):      SKIP (--only does not match)\n'
  fi
fi
echo "======================================================="

# Mid-review finding 14: select applicable steps/files first (RUN_BUNDLE/RUN_PACKAGING/RUN_CLAUDE
# and now MAIN_APPLICABLE above already do this); a step whose file/name cannot match --only is
# SKIP, not FAIL, and does not affect EXIT_STATUS below. The whole run fails only if --only
# matched NOTHING anywhere across the whole selection (every step skipped) — a plain typo, not a
# targeted, successful run.
ANY_APPLICABLE=0
[ "$MAIN_APPLICABLE" -eq 1 ] && ANY_APPLICABLE=1
[ "$FEATURES_APPLICABLE" -eq 1 ] && ANY_APPLICABLE=1
[ "$OVERLOAD_APPLICABLE" -eq 1 ] && ANY_APPLICABLE=1
[ "$CTXCONC_APPLICABLE" -eq 1 ] && ANY_APPLICABLE=1
[ "$RUN_BUNDLE" -eq 1 ] && ANY_APPLICABLE=1
[ "$RUN_PACKAGING" -eq 1 ] && ANY_APPLICABLE=1
{ [ "$WITH_CLAUDE" -eq 1 ] && [ "${RUN_CLAUDE:-0}" -eq 1 ]; } && ANY_APPLICABLE=1

EXIT_STATUS=0
if [ -n "$ONLY" ] && [ "$ANY_APPLICABLE" -eq 0 ]; then
  echo "error: --only '$ONLY' matched nothing across the whole step selection (main scenarios, feature scenarios, overload scenarios, ctx-concurrency scenarios, bundle smoke, packaging check$([ "$WITH_CLAUDE" -eq 1 ] && printf '%s' ', claude stretch'))" >&2
  EXIT_STATUS=1
fi
[ "$MAIN_APPLICABLE" -eq 0 ] || [ "$MAIN_STATUS" -eq 0 ] || EXIT_STATUS=1
[ "$FEATURES_APPLICABLE" -eq 0 ] || [ "$FEATURES_STATUS" -eq 0 ] || EXIT_STATUS=1
[ "$OVERLOAD_APPLICABLE" -eq 0 ] || [ "$OVERLOAD_STATUS" -eq 0 ] || EXIT_STATUS=1
[ "$CTXCONC_APPLICABLE" -eq 0 ] || [ "$CTXCONC_STATUS" -eq 0 ] || EXIT_STATUS=1
[ "$BUNDLE_STATUS" -eq 0 ] || EXIT_STATUS=1
[ "$PACKAGING_STATUS" -eq 0 ] || EXIT_STATUS=1
[ "$CLAUDE_STATUS" -eq 0 ] || EXIT_STATUS=1
exit "$EXIT_STATUS"
