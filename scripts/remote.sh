#!/usr/bin/env bash
# scripts/remote.sh — runs a command for this repo in Docker (node:22) on a remote host, so
# builds/tests don't run locally. Default host is the maintainer's SSH alias `gram`; override
# with OCMCP_REMOTE_HOST.
#
# Usage:
#   scripts/remote.sh <label> [--no-install] [--pull <relative-path>] <command...>
#
# Examples:
#   scripts/remote.sh u1 npm test
#   scripts/remote.sh u0 --pull package-lock.json npm install
#   scripts/remote.sh u1 --no-install node --test test/
#
# What it does:
#   1. rsync -a --delete this repo to gram:/tmp/ocmcp/<label>/ (excludes .git, node_modules, dist,
#      .worktrees, e2e/.cache, .pack-out, .npmrc, .env, .env.*; any stale copy of those last three
#      left by a sync made before these excludes existed is removed explicitly with a direct `rm`,
#      not rsync's --delete-excluded — see that command's own comment for why). The shared parent
#      /tmp/ocmcp is kept mode 700 (owned by this ssh user) for the whole transfer, not chmod'd
#      only afterwards — an untracked .npmrc/.env must never be
#      reachable by another user on this shared host, even mid-sync or if the script is
#      interrupted. NPM_CONFIG_REGISTRY (below) is the supported channel for a private registry.
#   2. Runs <command...> inside `docker run node:22`, mounted read-write at /w,
#      with a shared /root/.npm cache volume (ocmcp-npm-cache), named
#      ocmcp-<label>-<pid> so concurrent labels never collide.
#   3. Unless --no-install, first runs `npm ci` (if package-lock.json exists)
#      or `npm install`, both with --no-audit --no-fund.
#   4. If NPM_CONFIG_REGISTRY is set locally, it is passed into the container.
#   5. If --pull <relative-path> is given, that file is copied back from
#      gram:/tmp/ocmcp/<label>/<relative-path> into this repo after the command.
#   6. Exits with the remote command's exit code.
#
# <label> must match ^[a-z0-9-]+$ and gets its own directory/container/namespace;
# this script never touches other containers or directories on gram.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REMOTE_HOST="${OCMCP_REMOTE_HOST:-gram}"
REMOTE_BASE="/tmp/ocmcp"

usage() {
  echo "Usage: $0 <label> [--no-install] [--pull <relative-path>] <command...>" >&2
  exit 64
}

# POSIX-safe single-quote escaping: wrap the result in '...' to get one literal
# shell word, valid for both bash and dash on the remote side.
sq() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

[ "$#" -ge 1 ] || usage
LABEL="$1"
shift

if ! printf '%s' "$LABEL" | grep -Eq '^[a-z0-9-]+$'; then
  echo "error: label '$LABEL' must match ^[a-z0-9-]+\$" >&2
  exit 64
fi

NO_INSTALL=0
PULL_PATH=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-install)
      NO_INSTALL=1
      shift
      ;;
    --pull)
      [ "$#" -ge 2 ] || usage
      PULL_PATH="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

[ "$#" -ge 1 ] || usage

REMOTE_DIR="$REMOTE_BASE/$LABEL"
CONTAINER_NAME="ocmcp-${LABEL}-$$"

# Mid-review finding 13: a chmod 700 issued only AFTER rsync (the previous fix) left the
# destination exposed for the whole transfer — `rsync -a` (its -p) sets the destination's own
# top-level directory mode to match the SOURCE directory's mode (this repo root, typically 755)
# partway through, so a chmod only at the end still leaves a real window (and an interrupted run
# would never reach it at all). Two independent, complementary layers close this instead of
# chasing rsync's own per-directory permission timing:
#   1. The shared parent $REMOTE_BASE itself is mode 700, owned by this ssh user. Unix permission
#      checks require the EXECUTE bit on every ancestor directory for another user to reach
#      anything inside, so once $REMOTE_BASE is 700, no per-label directory's own mode — 755
#      mid-sync or otherwise — can ever be reached by another user, for the whole lifetime of the
#      transfer, regardless of rsync's own timing or a script interruption. (All labels use this
#      same ssh user, so this is fully backward compatible with everything else under
#      $REMOTE_BASE.)
#   2. The label directory itself still gets umask 077 + chmod 700 before AND after rsync too, as
#      defense in depth.
# Stale secrets from BEFORE the .npmrc/.env excludes existed are removed explicitly with a direct
# `rm -f` — never via rsync's own --delete-excluded, which (verified on gram, both against a real
# rsync-to-rsync sync AND, decisively, against this exact client/server pairing) also deletes
# node_modules/dist/.pack-out: those get populated as root inside a docker container by the
# caller's own command (npm ci, npm pack, etc.; no --user given), and this non-root ssh user
# cannot then re-delete them, so --delete-excluded made every second sync fail outright with a
# wall of "Permission denied" unlinks. rsync's `P` (protect) filter rule is documented to exempt a
# pattern from any delete pass even under --delete-excluded, but it was verified NOT to work
# through the actual client here: macOS ships `openrsync` (a BSD/protocol-only reimplementation,
# not GNU rsync) as `rsync`, and it silently fails to honor `P` when driving the remote host's real
# rsync over `-e ssh`, even though a same-version rsync-to-rsync test on the remote host alone
# (misleadingly) suggested it should work. Given that platform trap, avoid --delete-excluded
# entirely: plain --exclude (no --delete-excluded) has always correctly left excluded destination
# content alone, and
# .npmrc/.env/.env.* are handled directly by the explicit rm below instead.
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

if [ "$NO_INSTALL" -eq 1 ]; then
  SETUP="true"
else
  SETUP='if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi'
fi

# Rebuild the user command as individually single-quoted words so argument
# boundaries survive the round trip through ssh and docker's bash -lc, even if
# an argument happens to contain spaces or other shell metacharacters.
CMD_STR=""
for arg in "$@"; do
  CMD_STR="$CMD_STR '$(sq "$arg")'"
done

INNER="$SETUP &&$CMD_STR"
INNER_Q="'$(sq "$INNER")'"

ENV_FLAG=""
if [ -n "${NPM_CONFIG_REGISTRY:-}" ]; then
  ENV_FLAG="-e NPM_CONFIG_REGISTRY='$(sq "$NPM_CONFIG_REGISTRY")'"
fi

DOCKER_CMD="docker run --rm --name '$(sq "$CONTAINER_NAME")' -v '$(sq "$REMOTE_DIR"):/w' -v ocmcp-npm-cache:/root/.npm $ENV_FLAG -w /w node:22 bash -lc $INNER_Q"

set +e
ssh "$REMOTE_HOST" "$DOCKER_CMD"
STATUS=$?
set -e

if [ -n "$PULL_PATH" ]; then
  scp "$REMOTE_HOST:$REMOTE_DIR/$PULL_PATH" "$REPO_DIR/$PULL_PATH" \
    || echo "warning: --pull failed to fetch $PULL_PATH" >&2
fi

exit "$STATUS"
