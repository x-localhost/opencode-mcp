# 인터넷 제한 환경 배포 체크리스트

예시 URL, scope, 모델명, CA 경로와 비밀 이름은 조직 값으로 바꿉니다. 토큰은 저장소나 설정 파일에 기록하지 않습니다.

## 1. 패키지와 아티팩트 미러링

`package-lock.json` 기준 opencode-mcp runtime packages:

- `@modelcontextprotocol/server@2.2.0` 및 전이 runtime dependency `@modelcontextprotocol/core@2.2.0`
- `zod@4.6.5`

빌드에는 `@types/node@22.20.4`, 전이 dependency `undici-types@6.21.0`, `esbuild@0.28.2`, `typescript@7.0.2`, 그리고 빌드 호스트의 `@esbuild/<os>-<cpu>@0.28.2` 및 `@typescript/typescript-<os>-<cpu>@7.0.2` optional platform packages도 필요합니다. 일반적으로 빌드 호스트에서 `package-lock.json`의 모든 package를 미러하세요. 빌드 뒤 `npm run bundle`의 `dist/opencode-mcp.mjs`는 MCP/Zod 의존성을 포함하므로, 번들 runtime 전용 설치에는 앞의 runtime package 세 개만 필요합니다. 공개 unscoped 이름 `opencode-mcp`는 다른 게시자 소유이므로 설치하지 말고 내부 scope를 사용하세요(`@internal`은 예시 placeholder).

OpenCode 설치와 runtime config-dir 설치를 위해 아래 및 해당 버전의 모든 전이 dependency와 플랫폼 tarball을 내부 npm proxy에 허용합니다.

- `opencode-ai@1.18.33`
- 대상 OS/CPU optional package (예: `opencode-linux-x64`, `opencode-linux-x64-musl`, `opencode-linux-arm64`, `opencode-darwin-arm64`, `opencode-darwin-x64`; 대상 릴리스 metadata로 확정)
- `@opencode-ai/plugin@1.18.33`과 dependency 전체

선택적으로 Claude Code를 npm으로 배포한다면 `@anthropic-ai/claude-code` 및 대상 OS/CPU platform package와 dependency도 미러합니다. 실제 배포판의 package metadata/lockfile로 패키지 이름을 검증하고 metadata와 tarball 모두 제공되도록 합니다.

## 2. OpenCode 설치 및 검증

내부 registry 또는 승인된 아티팩트에서 OpenCode를 설치합니다. 서비스 계정 `PATH`에 `opencode`와 ripgrep `rg`를 둡니다.

```sh
opencode --version
command -v rg
rg --version
```

`rg`가 없으면 OpenCode가 외부 다운로드를 시도할 수 있으므로 내부 OS package mirror에서 설치합니다.

## 3. 내부 OpenAI-compatible gateway

OpenCode 1.18.33에 포함된 `@ai-sdk/openai-compatible` provider로 gateway를 설정합니다. 실제 URL, model ID, key 변수로 바꿉니다. Linux managed config는 `/etc/opencode/opencode.json`, macOS는 `/Library/Application Support/opencode` 또는 MDM profile `ai.opencode.managed`를 사용합니다. `OPENCODE_CONFIG`는 custom config file, `OPENCODE_CONFIG_CONTENT`는 inline JSON 설정 대안입니다([OpenCode 설정 조사](research/opencode-offline.md) §6 "Switches and where each was verified").

```json
{
  "$schema": "https://opencode.ai/config.json",
  "enabled_providers": ["corp"],
  "provider": {
    "corp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Internal LLM Gateway",
      "options": {
        "baseURL": "https://llm-gateway.example.corp/v1",
        "apiKey": "{env:INTERNAL_LLM_API_KEY}"
      },
      "models": {
        "coding-model": {"name": "Internal Coding Model", "tool_call": true, "limit": {"context": 128000, "output": 4096}}
      }
    }
  },
  "model": "corp/coding-model",
  "small_model": "corp/coding-model",
  "share": "disabled",
  "autoupdate": false
}
```

`{env:INTERNAL_LLM_API_KEY}`는 OpenCode 프로세스 환경에서 읽습니다. key를 config에 직접 저장하지 말고 gateway의 streaming 및 tool calling을 확인합니다. `$schema`는 편집기 도움말용이며 외부 연결 허용을 뜻하지 않습니다.

**모델별 `limit` (권장)**: 각 모델에 `limit: {context, output}`(필요하면 `input`도)을 실제 gateway/모델의 한계에 맞춰 지정하세요. `limit`이 없으면 `GET /provider`가 그 모델을 `{"limit":{"context":0,"output":0}}`으로 보고하며, 이 상태에서 OpenCode는 그 모델에 선제적 compaction(요약)을 전혀 하지 않고 매 요청마다 `max_tokens`를 32000으로 보냅니다(gateway가 더 작은 상한만 허용하면 거부될 수 있습니다). `limit`을 지정하면 OpenCode 자신의 선제적 compaction이 켜지고 올바른 `max_tokens`가 전송됩니다. `limit`을 config에 넣을 수 없는 배포는 opencode-mcp 쪽 `OPENCODE_MCP_MODEL_PROFILES`로 같은 정보를 알려줄 수 있지만, 그 경우 OpenCode 자신은 여전히 compaction하지 않습니다(§7, README [모델별 컨텍스트에 맞춘 작업 배분](../README.md#모델별-컨텍스트에-맞춘-작업-배분) 참고).

**`enabled_providers` (권장)**: 위 예시처럼 지정하지 않으면 OpenCode 내장 models.dev catalog 전체(`GET /provider` 약 6.15 MiB, provider 226개)가 그대로 응답에 담겨 모든 turn과 `opencode-info section:"models"` 호출이 느려질 수 있습니다(opencode-mcp는 32 MiB까지 읽으므로 실패하지는 않습니다). `enabled_providers: ["corp"]`만 켜면 응답이 몇 KB로 줄어듭니다.

## 4. OpenCode runtime npm 및 TLS

OpenCode는 config-dir에 plugin 및 의존성을 npm 설치할 수 있습니다. 서비스 계정 환경 또는 그 계정의 `~/.npmrc`를 설정합니다.

```sh
export NPM_CONFIG_REGISTRY=https://nexus.example.corp/repository/npm-group/
export NPM_CONFIG_FETCH_RETRIES=0
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-ca-bundle.pem
```

또는 `~/.npmrc`:

```ini
registry=https://nexus.example.corp/repository/npm-group/
cafile=/etc/ssl/certs/corp-ca-bundle.pem
fetch-retries=0
```

OpenCode가 자체 config-dir에서 npm을 실행하면 프로젝트 `.npmrc`가 적용되지 않을 수 있으므로 실제 서비스 계정 설정을 확인합니다. TLS 검증을 비활성화하지 말고 내부 CA를 trust store 또는 `cafile`로 제공합니다. 별도 npm plugin/provider를 쓰면 그 package 및 dependency를 승인·미러합니다. plugin install이 늦으면 첫 세션 생성도 지연될 수 있습니다.

## 5. managed/attach 모드

기본 managed mode에서 opencode-mcp가 `opencode serve`를 시작하고 server 암호를 생성합니다. 기본 `OPENCODE_MCP_AIRGAP=1`은 미설정 값만 다음처럼 채웁니다.

- `OPENCODE_DISABLE_AUTOUPDATE=1`
- `OPENCODE_DISABLE_SHARE=1`
- `OPENCODE_DISABLE_LSP_DOWNLOAD=1`
- `NPM_CONFIG_FETCH_RETRIES=0`
- `OPENCODE_DISABLE_MODELS_FETCH=1` (`OPENCODE_MODELS_URL`을 쓰면 설정하지 않음)

이 설정은 자동 요청을 줄일 뿐 egress 통제는 아닙니다. 관리자는 gateway key 환경, `enabled_providers`, `model`, `small_model`, `share: "disabled"`, `autoupdate: false`, 내부 registry/CA, `rg`, OS 권한 및 네트워크 정책을 설정합니다. `OPENCODE_MCP_SERVE_ARGS`에서 `--hostname`, `--port`, `--mdns*`, `--cors`는 거부됩니다.

**`OPENCODE_MCP_CHILD_ENV_ALLOWLIST` 권장**: 비워두면(기본값) managed 자식은 `ANTHROPIC_*`/`CLAUDE_*`/`CLAUDECODE`/`AI_AGENT`/`OPENCODE_MCP_*`/`OPENCODE_SERVER_*`를 scrub한 나머지 전체 환경을 상속합니다. 최소 권한 배포에서는 OpenCode가 실제로 필요로 하는 이름만 명시적으로 허용하길 권장합니다(그 외 이름은 자동으로 제외됨; 이름/접두사가 일치해도 위 scrub 대상은 항상 제외됩니다). 예:

```sh
OPENCODE_MCP_CHILD_ENV_ALLOWLIST=INTERNAL_LLM_API_KEY,NPM_CONFIG_*,NODE_EXTRA_CA_CERTS,HTTP_PROXY,HTTPS_PROXY,NO_PROXY,OPENCODE_*
```

이 예시는 조직의 gateway key, npm/TLS 설정, 프록시, OpenCode 자체 설정(`OPENCODE_*`, 위 scrub 접두사와 무관한 것들)만 허용합니다. 실제 필요 목록은 사용 중인 OpenCode 버전과 provider 설정에 맞게 조정하세요. `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR`, `SHELL`, `TERM` 필수 변수는 allowlist 설정과 무관하게 opencode-mcp 자체 환경에 존재하는 경우 유지됩니다.

기존 서버 연결(attach) 시 `OPENCODE_MCP_MODE=attach`, `OPENCODE_MCP_SERVER_URL=https://opencode.example.corp`와 필요 시 `OPENCODE_SERVER_USERNAME` 및 `OPENCODE_SERVER_PASSWORD`를 지정합니다. URL에 userinfo를 포함하지 않습니다. loopback 이외의 HTTP는 기본 거부되며 `OPENCODE_MCP_ALLOW_INSECURE_HTTP=1`로 예외를 허용합니다. attach 서버의 TLS, 인증, egress 정책은 관리자가 책임집니다.

## 6. Claude Code 관리 등록

Linux 경로 `/etc/claude-code/managed-mcp.json` 예시:

```json
{
  "mcpServers": {
    "opencode": {
      "type": "stdio",
      "command": "node",
      "args": ["/opt/opencode-mcp/opencode-mcp.mjs"],
      "env": {
        "OPENCODE_MCP_OPENCODE_BIN": "/usr/local/bin/opencode",
        "NPM_CONFIG_REGISTRY": "https://nexus.example.corp/repository/npm-group/",
        "NPM_CONFIG_FETCH_RETRIES": "0",
        "NODE_EXTRA_CA_CERTS": "/etc/ssl/certs/corp-ca-bundle.pem",
        "INTERNAL_LLM_API_KEY": "${INTERNAL_LLM_API_KEY}"
      }
    }
  }
}
```

`"${INTERNAL_LLM_API_KEY}"`는 실행 시점에 서비스 환경에서 값을 확장해 채우는 참조이며, 리터럴 secret 값이 아닙니다. `managed-mcp.json`은 세계 읽기 가능(world-readable) 파일이므로 실제 secret 값을 파일에 직접 적지 마세요: secret manager나 서비스 실행 환경(systemd `EnvironmentFile`, 컨테이너 오케스트레이터의 secret 주입 등)에서 `INTERNAL_LLM_API_KEY`를 프로세스 환경에 주입하고, 이 파일은 그 이름만 참조하도록 유지합니다. Claude Code의 기본 tool hard limit은 100,000,000ms(약 27.8시간)이며 서버별 `timeout`은 이를 대체하므로 더 낮게 설정할 수 있습니다. 지정한다면 최대 turn 시간에 시작·정리 여유를 더한 값(기본 최대 기준 약 21,700,000ms 이상)으로 설정하세요. 30분 idle timeout은 heartbeat가 처리합니다.

관리 정책은 exact argv를 허용해야 합니다.

```json
{
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": [
    {"serverCommand": ["node", "/opt/opencode-mcp/opencode-mcp.mjs"]}
  ]
}
```

`serverCommand` 배열은 `command`와 `args`의 결합과 정확히 일치해야 합니다. `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`(Claude Code 공개 문서 [env-vars](https://code.claude.com/docs/en/env-vars): `1`이면 stdio MCP 서버를 안전한 기본 환경과 서버 `env`만으로 실행)을 켜면 HOME/PATH/CLAUDE* 및 서버 `env` 값만 MCP child에 전달됩니다. 따라서 `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, gateway key, attach 인증 변수를 서버 `env`에 넣습니다. 비밀은 조직의 secret 주입 절차로 관리합니다([Claude Code 환경 조사](research/mcp-client.md) §3.9).

`CLAUDE_CODE_MCP_ALLOWLIST_ENV`는 Claude Code가 opencode-mcp 프로세스 자체에 전달하는 환경을 제한하는 별도 설정이며, §5의 `OPENCODE_MCP_CHILD_ENV_ALLOWLIST`(opencode-mcp가 자신이 띄우는 `opencode serve` 자식에게 전달하는 환경)와는 계층이 다릅니다. 최소 권한 배포에서 `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`을 켜면 HOME/PATH/CLAUDE*와 위 `env` 블록만 MCP에 전달됩니다. opencode-mcp가 그 값을 `opencode serve`까지 다시 전달하려면 필요한 이름을 `OPENCODE_MCP_CHILD_ENV_ALLOWLIST`에도 넣습니다.

## 7. 과부하 대응 점검

1. Gateway가 HTTP `429`, `503`, `529`를 반환할 때 admission GET의 제한 재시도와 `Retry-After` 처리를 확인합니다. `OPENCODE_MCP_READ_RETRY_ATTEMPTS`는 최초 시도를 포함해 1–3회이며, prompt는 자동 재전송되지 않습니다.
2. 정상 provider 응답에서 반복 빈 stream/HTML/tool JSON이 발생하는지 확인하고 `OPENCODE_MCP_RESPONSE_LOOP_LIMIT`을 조정합니다. 기본값은 `6`, 허용값은 `3`–`20`, `0`은 watchdog 비활성화입니다.
3. 통합 환경에서 `e2e/run-e2e.sh --only runaway`를 실행해 `UPSTREAM_RESPONSE_LOOP`과 후속 turn 복구를 검증합니다. gateway 과부하 시에는 `upstreamRetry`, 읽기 지연 시에는 `upstreamRead` 및 `OpenCode reads are delayed` 진행 메시지를 확인합니다.
4. `Retry-After`가 길 때 admission/cleanup deadline의 operation 종료와 기존 세션 관찰 지침을 확인합니다. `SUBMISSION_UNCONFIRMED`에서는 prompt를 다시 보내지 않습니다.
5. 동시 실행 cap이 실제로 적용되는지 `opencode-info section:"server"`로 확인합니다. `limits.maxRunningTurns`/`maxQueuedTurns`/`queueTimeoutSeconds`가 설정값과 일치하는지, `concurrency.running`/`queued`/`heldUnknown`/`available`이 기대한 범위인지, `capabilities`에 `run-queue`가 있는지 봅니다. cap을 넘는 turn을 동시에 보내 `queue` 객체가 붙는지, 큐까지 채워 `RUN_QUEUE_CAPACITY`가 제출 전에(아무것도 보내지 않고) 반환되는지 확인합니다.
6. `OPENCODE_MCP_MODEL_PROFILES`를 설정했다면 `opencode-info section:"models"`로 각 모델의 `limit`, `usableInputTokens`, `limitSource`(`opencode`/`profile`/`mixed`), `maxRunning`, `serverDefault`가 기대값과 일치하는지 확인합니다. `limitSource`는 필드 단위 병합 결과입니다 — 같은 `limit` 필드(`context`/`input`/`output`)를 profile과 OpenCode config가 둘 다 정의하면 profile 쪽 값이 이기므로, 둘 다 설정했다고 해서 `limitSource`가 `opencode`가 되지는 않습니다. 현재 존재하는 `limit` 필드 전부가 profile에서 왔으면 `profile`, 전부 OpenCode에서만 왔으면 `opencode`, 일부만 profile에서 왔으면 `mixed`입니다(`maxRunning`만 설정한 profile은 `limitSource`를 바꾸지 않습니다). 의도적으로 큰 prompt를 보내 `OPENCODE_MCP_CONTEXT_GUARD=reject`(기본값)에서 제출 전 `PROMPT_TOO_LARGE`가 반환되는지(업스트림에 아무것도 보내지 않음) 확인합니다.

## 8. 설치 검증

1. Claude Code에서 MCP 서버가 로드되는지 확인합니다.
2. 짧은 작업을 위임하고 응답 `structuredContent.content`를 읽습니다.
3. 같은 ID로 `opencode-reply`를 실행한 뒤 `opencode-end`로 종료합니다.
4. ID 없이 `opencode-status`를 호출해 session list와 `opencodeVersion`을 확인합니다.
5. OpenCode 및 gateway 로그, 네트워크 정책에서 gateway 연결과 외부 egress를 확인합니다.

## 9. 롤백 및 제거

1. managed MCP 설정과 exact argv allowlist에서 `opencode` 항목을 제거합니다.
2. 작업을 `opencode-end`로 마치거나 운영자가 OpenCode 프로세스와 세션을 확인합니다.
3. `/opt/opencode-mcp` 번들 또는 내부 패키지 설치본을 제거합니다.
4. 서비스 계정의 설정·cache·session 데이터는 조직 보존 정책에 따라 정리합니다.
5. gateway key와 attach credential을 secret store/실행 환경에서 폐기 또는 회전합니다.
