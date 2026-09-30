# Third-party notices

opencode-mcp's own code is licensed under the MIT License (see `LICENSE`). The research material
under `docs/research/` includes content captured from OpenCode (`opencode-ai@1.18.33`), which is
distributed under the license below:

- `docs/research/opencode-openapi-1.18.33.json` — the OpenAPI document served by `opencode serve`
  (`GET /doc`), unmodified.
- `docs/research/samples/` — mostly captured OpenCode HTTP/SSE traffic and message histories from
  local test runs against a fake model (the `opencode-sample-*` files other than
  `opencode-sample-config.opencode.json`, which is this project's own fake-provider config),
  alongside a couple of project-authored helper scripts (`drive-session.mjs`,
  `fake-llm-server.mjs`) used to produce them. `opencode-sample-llm-request-after-tool.json` keeps the request structure but
  elides OpenCode's built-in system prompt and each tool's top-level `description` (11 tools) to a
  short excerpt; the short per-parameter descriptions (including nested item fields) are kept
  verbatim.
- `docs/research/probe-overload/samples.json` — captured OpenCode message/event data from the
  overload probe runs. The other files under `docs/research/probe-overload/` and
  `docs/research/probe-features/` are project-authored scripts, not OpenCode content.

The e2e harness installs `opencode-ai` from npm at test time; it is not vendored in this repository.

## OpenCode

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
