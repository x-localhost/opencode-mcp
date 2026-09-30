# Hermetic e2e image for opencode-mcp (docs/design.md §9; docs/research/opencode-offline.md).
#
# Build context MUST be the repo root (not e2e/), and dist/opencode-mcp.mjs must already exist
# there (built beforehand by e2e/run-e2e.sh via `npm ci && npm run build && npm run bundle` in a
# plain node:22 container) — this Dockerfile only *copies* the bundle, it never runs npm install
# for the opencode-mcp package itself.
#
# Network is used ONLY at `docker build` time (apt + `npm install -g`), never at `docker run`
# time: the resulting image is designed to run with `--network none` (docs/research/
# opencode-offline.md §7-8: air-gap env defaults, ripgrep on PATH, a bundled-only provider).
#
#   docker build -f e2e/Dockerfile -t ocmcp-e2e:local .
#   docker build -f e2e/Dockerfile -t ocmcp-e2e:local --build-arg WITH_CLAUDE=1 .   # + scenario k
#   docker run --rm --network none ocmcp-e2e:local                                  # scenarios a-i
#   docker run --rm --network none ocmcp-e2e:local node --test e2e/claude-stretch.test.mjs  # k

FROM node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7

# Node 22.23.3 (pinned by digest, see the header comment).

ARG WITH_CLAUDE=0

# git: e2e/lib/harness.mjs inits a throwaway git repo per scenario (OpenCode expects a project
# directory). ripgrep: OpenCode's grep/glob tools shell out to `rg`; without it on PATH they try to
# download it from GitHub on first use and fail under --network none (opencode-offline.md §7 O15).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pinned exactly (the version the e2e suite is verified against).
RUN npm install -g opencode-ai@1.18.33

# Optional, only for the stretch scenario (k): headless Claude Code driving opencode-mcp for real.
RUN if [ "$WITH_CLAUDE" = "1" ]; then npm install -g @anthropic-ai/claude-code@2.1.284; fi

WORKDIR /work

# Only e2e/** and the pre-built bundle are needed at runtime; src/**, test/** etc. are not copied
# in (the e2e harness only owns e2e/**, and this keeps the image small).
COPY e2e/ /work/e2e/
COPY dist/ /work/dist/
COPY package.json /work/package.json

# Air-gap defaults belt-and-braces (harness also sets these per-scenario; see e2e/lib/harness.mjs)
# so any direct `opencode`/`opencode serve` invocation in this image is safe under --network none.
ENV OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_SHARE=1 \
    OPENCODE_DISABLE_LSP_DOWNLOAD=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
    NPM_CONFIG_FETCH_RETRIES=0 \
    E2E_WORKDIR=/work

# Default: run the main scenario suite. run-e2e.sh overrides this command for --only filtering,
# the node:20 bundle smoke (which uses a different base image entirely) and the claude stretch run.
CMD ["node", "--test", "e2e/scenarios.test.mjs"]
