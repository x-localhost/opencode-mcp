# opencode-mcp

이 프로젝트는 Anthropic이나 OpenCode 프로젝트와 관련이 없으며 보증을 받지 않았습니다. Claude Code와 OpenCode는 각 소유자의 상표입니다.

**기업용 Claude Code가 내부 OpenCode에 코딩 작업을 위임하고 결과를 이어서 확인하도록 하는 stdio MCP 서버입니다.** OpenAI Codex의 `codex` / `codex-reply` MCP 흐름과 비슷한 인터페이스를 제공합니다. Codex의 `codex mcp-server` 진입점은 Codex 0.154.0에서 제거됐습니다.

## 무엇을 해결하는가

인터넷 제한 환경에서 Claude Code의 작업을 사내 LLM gateway에 연결된 OpenCode에 전달하고, 결과 확인·추가 지시·취소·정리를 한 MCP 세션에서 처리합니다.

## 동작 구조

```text
Claude Code ⇄ stdio ⇄ opencode-mcp ⇄ HTTP ⇄ opencode serve ⇄ internal LLM gateway
                              │
                    managed 또는 attach
```

- **managed**(기본): opencode-mcp가 로컬 `opencode serve`를 시작하고 관리합니다. `OPENCODE_MCP_AIRGAP=1`이면 미설정된 일부 OpenCode 네트워크 기본값을 제한합니다.
- **attach**: 기존 OpenCode 서버에 연결합니다. `OPENCODE_MCP_SERVER_URL`을 설정하면 기본 모드도 `attach`입니다.

## 설치와 사용 (단계별)

처음 설치한다면 아래 순서로 준비하고 연결합니다. 인터넷 제한 환경의 패키지 미러링, TLS 및 조직 배포는 [에어갭 배포 체크리스트](docs/deployment-airgap.md)를 참고하세요.

### 0) 준비물

- Node.js 20 이상 (`package.json`의 `engines` 기준)
- OpenCode 1.18.33 (`opencode-ai`): [배포 체크리스트 §2](docs/deployment-airgap.md#2-opencode-설치-및-검증)의 설치·버전 확인 절차를 따릅니다.
- `rg`(ripgrep)가 서비스 계정 `PATH`에 있어야 합니다. `rg`가 없으면 OpenCode가 ripgrep을 내려받으려 할 수 있습니다(인터넷 제한 환경에서는 실패).
- Claude Code. git은 작업 저장소와 변경 확인에 권장합니다.

### 1) OpenCode 모델 설정

OpenCode가 사용할 모델 provider를 설정합니다. 설정하지 않으면 OpenCode 기본 provider가 외부 클라우드일 수 있으므로, 사내 gateway 사용 시 먼저 provider를 구성하세요. [배포 체크리스트 §3](docs/deployment-airgap.md#3-내부-openai-compatible-gateway)의 OpenAI-compatible 설정은 다음 형태입니다(실제 gateway URL, model ID, key 환경 변수로 바꾸세요).

```json
{
  "enabled_providers": ["corp"],
  "provider": {
    "corp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Internal LLM Gateway",
      "options": {
        "baseURL": "https://llm-gateway.example.corp/v1",
        "apiKey": "{env:INTERNAL_LLM_API_KEY}"
      },
      "models": {"coding-model": {"name": "Internal Coding Model", "tool_call": true}}
    }
  },
  "model": "corp/coding-model",
  "small_model": "corp/coding-model"
}
```

Linux managed config 경로는 `/etc/opencode/opencode.json`, macOS는 `/Library/Application Support/opencode` 또는 MDM profile `ai.opencode.managed`입니다. custom 파일은 `OPENCODE_CONFIG`, inline 설정은 `OPENCODE_CONFIG_CONTENT`를 쓸 수 있습니다. 이 모델 ID를 아래 MCP 서버의 `OPENCODE_MCP_DEFAULT_MODEL=corp/coding-model`로 지정하면 기본 모델로 연결됩니다.

### 2) opencode-mcp 빌드

저장소를 받은 뒤 저장소 루트에서 빌드합니다.

```sh
npm ci && npm run build && npm run bundle
```

단일 번들 `dist/opencode-mcp.mjs`가 생성됩니다(Node.js 20 이상). 예를 들어 `/opt/opencode-mcp/opencode-mcp.mjs`에 두고 실행할 수 있습니다. 조직 registry 게시본을 설치할 수도 있습니다(공개 unscoped `opencode-mcp`는 사용하지 않습니다).

```sh
npm install -g @internal/opencode-mcp
```

`@internal`은 placeholder이므로 사내 scope로 바꿉니다. 설치본의 실행 파일은 `opencode-mcp`입니다. 패키지 게시·미러링은 [배포 체크리스트 §1](docs/deployment-airgap.md#1-패키지와-아티팩트-미러링)을 참고하세요.

### 3) Claude Code 등록

`claude mcp add`에서는 `--env KEY=value` 옵션을 서버 실행 명령보다 먼저 두고, `--` 뒤에 실행 파일과 인자를 둡니다. 환경 변수가 여러 개면 `--env`를 반복합니다. 예시는 번들 실행 기준입니다.

```sh
claude mcp add --transport stdio opencode \
  --env OPENCODE_MCP_OPENCODE_BIN=/usr/local/bin/opencode \
  --env OPENCODE_MCP_ALLOWED_ROOTS=/workspace/project \
  -- node /opt/opencode-mcp/opencode-mcp.mjs
```

프로젝트 `.mcp.json`으로 등록하는 예:

```json
{
  "mcpServers": {
    "opencode": {
      "type": "stdio",
      "command": "node",
      "args": ["/opt/opencode-mcp/opencode-mcp.mjs"],
      "env": {
        "OPENCODE_MCP_OPENCODE_BIN": "/usr/local/bin/opencode",
        "OPENCODE_MCP_ALLOWED_ROOTS": "/workspace/project"
      }
    }
  }
}
```

조직 단위 배포는 [Claude Code 관리 등록 및 allowlist 절](#설치-claude-code-등록)을 참고하세요.

### 4) 동작 확인

`claude mcp list` 결과에 `opencode`가 있는지 확인하고, Claude Code에서 `/mcp`(Claude Code 문서 확인)로 연결 상태를 봅니다. 이어 Claude에게 “opencode-info로 서버 상태를 보여줘”라고 요청해 `connectionState`와 defaults를 확인합니다. 첫 `opencode-info` 호출 전에는 managed OpenCode 프로세스가 아직 시작되지 않습니다. 첫 호출의 `not_started` 확인은 [e2e 검증 기록](e2e/README.md#f9-v03-feature-scenarios-featurestestmjs-own-run-e2esh-step)에 있습니다.

### 5) 사용 예

Claude Code에 자연어로 요청할 수 있습니다.

- 단일 위임: “opencode에게 README 오탈자 수정을 맡기고 결과를 요약해줘.” 순서는 `opencode` → `opencode-reply` → `opencode-end`입니다.
- 검토 전용: “이 변경을 수정하지 말고 검토만 해줘.” 기본 샌드박스를 `read-only`로 설정합니다.
- 병렬 위임: “두 모듈을 각각 검토하고 모두 끝나면 비교해줘.” 각 `opencode` 호출에 `wait-seconds: 0`을 사용하고 `opencode-status`에 `ids`와 `wait-for: "all"`을 전달합니다.
- 긴 결과와 변경 확인: “완료되면 전체 답변과 변경 diff를 확인해줘.” `opencode-output`의 `answer`와 `diff` section을 사용합니다.

입력 예와 병렬 처리·결과 확인의 상세 레시피는 [서브에이전트 위임 레시피](#서브에이전트-위임-레시피)를 참고하세요.

### 6) 자주 쓰는 설정

- `OPENCODE_MCP_DEFAULT_SANDBOX`: 기본 `workspace-write`; 검토 전용이면 `read-only`를 권장합니다.
- `OPENCODE_MCP_ALLOWED_ROOTS`: 허용 작업 루트. 경로는 절대 경로이며 여러 경로는 플랫폼 경로 구분자로 나눕니다.
- `OPENCODE_MCP_DEFAULT_MODEL`: 기본 모델, `provider/model` 형식.
- `OPENCODE_MCP_DEFAULT_APPROVAL_POLICY`: `never`(기본값) 또는 `on-request`.
- `OPENCODE_MCP_MAX_SESSIONS`: 추적 가능한 세션 수, 기본값 256, 최댓값 10000.
- `OPENCODE_MCP_SERVER_URL`: 기존 OpenCode 서버에 붙이는 attach 모드 URL. 지정하면 기본 모드도 `attach`가 됩니다.

전체 값과 검증 규칙은 [환경 변수 표](#설정-환경-변수)를 참고하세요.

### 7) 제거

Claude Code에서 `claude mcp remove opencode`를 실행합니다(Claude Code 문서 확인). 프로젝트 `.mcp.json`으로 등록했다면 해당 `mcpServers.opencode` 항목도 제거하고, 직접 배치한 `/opt/opencode-mcp/opencode-mcp.mjs` 번들을 삭제합니다. 조직 등록 제거 및 세션 데이터 보존은 [배포 체크리스트 §9](docs/deployment-airgap.md#9-롤백-및-제거)에 따르세요.

## 빠른 시작

`opencode`로 시작하고 응답에서 `structuredContent.content`를 읽습니다. 같은 세션으로 `opencode-reply`를 보내고, 마지막에 `opencode-end`를 호출합니다. `wait-seconds`를 생략하면(Codex의 `codex`/`codex-reply`와 동일하게) turn이 끝날 때까지 블로킹하는 것이 기본 동작입니다.

1. `opencode`: `{"prompt":"README.md의 오탈자를 수정해 주세요.","cwd":"/workspace/project"}`
2. 응답 예시(축약, 종료 상태까지 블로킹한 뒤 반환됨):

   ```json
   {"structuredContent":{"kind":"turn","sessionId":"ses_a81f…","threadId":"ses_a81f…","turnId":"ses_a81f…#1","turn":1,"status":"completed","executionState":"stopped","cleanup":"complete","content":"오탈자를 수정했습니다.","filesChanged":["README.md"],"toolCalls":[{"tool":"edit","status":"completed"}],"toolCallCount":1}}
   ```

3. `opencode-reply`: `{"sessionId":"ses_a81f…","prompt":"변경 내용을 설명해 주세요."}`
4. `opencode-end`: `{"sessionId":"ses_a81f…"}`

텍스트 응답도 `structuredContent.content`를 반영합니다.

### 서브에이전트 위임 레시피

- **fan-out/fan-in:** 각 작업은 `wait-seconds:0`으로 시작해 admission 직후 ID를 받습니다. `opencode-status`의 `ids`는 1–16개의 서로 다른 ID(각 1–200자)를 받으며 `wait-for:"any"`는 하나, `"all"`은 전체가 준비될 때까지 기다립니다. 끝난 ID는 다음 `ids`에서 제거하고 `detail:"compact"`으로 문맥을 아낍니다.

  ```json
  {"prompt":"모듈 A 검토","cwd":"/workspace/project","wait-seconds":0}
  {"prompt":"모듈 B 검토","cwd":"/workspace/project","wait-seconds":0}
  {"ids":["ses_a81f…","ses_b72e…"],"wait-for":"any","wait-seconds":30,"detail":"compact"}
  ```

- **안전한 재시도:** 같은 논리 호출을 재시도할 때 같은 `request-id`를 사용합니다. 동일 입력은 prompt를 재전송하지 않고 원 작업에 합류하며, 입력이 다르면 `REQUEST_ID_CONFLICT`입니다. 최대 4096개, 종료 항목 24시간 보관의 프로세스 내 dedup이며 재시작 후 exactly-once를 보장하지 않습니다. 같은 request-id의 원 호출이 아직 admission되지 않은 상태에서 재시도가 도착하면, 그 재시도의 대기가 끝날 때 `REQUEST_PENDING`이 반환됩니다(같은 키로 다시 재시도하거나 `opencode-status`로 확인하세요).

  ```json
  {"prompt":"테스트를 실행해 주세요","request-id":"run-tests-42","wait-seconds":0}
  ```

- **구조화 보고서:** `output-schema`는 현재 turn에만 적용됩니다. 아래 호출처럼 `summary`, `files[{path,status}]`, `testsPassed`를 요청하고 완료 후 `structuredOutputStatus`가 `valid`/`missing`/`invalid`인지 확인합니다. 유효한 구조도 신뢰할 수 없는 모델 출력입니다.

  ```json
  {"prompt":"변경 사항을 JSON 보고서로 요약해 주세요.","output-schema":{"type":"object","properties":{"summary":{"type":"string"},"files":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"status":{"type":"string","enum":["added","modified","deleted"]}},"required":["path","status"],"additionalProperties":false}},"testsPassed":{"type":"boolean"}},"required":["summary","files","testsPassed"],"additionalProperties":false}}
  ```

- **답변 페이지와 diff:** `opencode-output`의 `section:"answer"`에서 이전 페이지의 `nextOffset`을 사용합니다. 변경은 `section:"diff", diff-view:"stat"`으로 찾은 뒤 `snapshot-id`와 `file-index`로 `patch`를 읽습니다. diff는 해당 turn의 사용자 메시지 기준 OpenCode snapshot이며 완전성이 보장되지 않습니다. 빈 결과는 무변경의 증거가 아닙니다.

  ```json
  {"sessionId":"ses_a81f…","turn":1,"section":"answer","offset":0,"limit":4000}
  {"sessionId":"ses_a81f…","turn":1,"section":"diff","diff-view":"stat"}
  {"sessionId":"ses_a81f…","turn":1,"section":"diff","diff-view":"patch","file-index":0,"snapshot-id":"diff-…"}
  ```

- **같은 저장소 병렬 편집:** 호출자가 각 작업용 git worktree를 만들고 `cwd`로 전달합니다. 각 경로는 `OPENCODE_MCP_ALLOWED_ROOTS` 아래여야 하며 서버는 worktree를 관리하지 않습니다.

  ```sh
  git worktree add ../wt-a -b task-a
  ```

- **모델/agent 찾기:** `opencode-info`의 `models`와 `agents` section이 광고하는 값을 선택해 `model`(`provider/model`)과 `agent`에 전달합니다.

  ```json
  {"section":"models","cwd":"/workspace/project"}
  {"section":"agents","cwd":"/workspace/project"}
  ```

### 비동기(폴링) 예시

즉시 반환받고 나중에 직접 상태를 확인하려면 `wait-seconds: 0`으로 시작한 뒤 `opencode-status`로 폴링합니다.

1. `opencode`: `{"prompt":"대규모 리팩터링을 진행해 주세요.","cwd":"/workspace/project","wait-seconds":0}` → 즉시 `status:"running"`과 `sessionId`를 반환합니다.
2. `opencode-status`: `{"sessionId":"ses_a81f…","wait-seconds":30}` → 최대 30초까지 관찰하고(`status` 최대값은 600), 완료 전이면 다시 호출합니다. 대기 중 발생한 승인 요청도 함께 전달됩니다.
3. `status`가 `completed`/`failed`/`cancelled`/`timeout`이 되면 `structuredContent.content`를 읽습니다.

## 도구 레퍼런스

입력은 strict schema이며 알 수 없는 속성은 거부됩니다. `sessionId`, `threadId`, `conversationId`는 별칭입니다. ID를 받는 도구는 정확히 하나를 요구하며 `opencode-status`만 ID 없이 목록을 조회할 수 있습니다.

| 도구 | 속성 | 타입 · 기본값 | 의미 |
|---|---|---|---|
| `opencode` | `prompt` | string · 필수 | 첫 요청 |
| | `cwd` | string · 서버 기본 경로 | 작업 디렉터리; `%` 문자가 있으면 `INVALID_ARGUMENT`로 거부됩니다 |
| | `model`, `agent` | string · 설정 기본값 | 모델(`provider/model`) 및 agent |
| | `sandbox` | enum · `workspace-write` | `read-only`, `workspace-write`, `danger-full-access` |
| | `approval-policy` | enum · `never` | `never` 또는 `on-request` |
| | `base-instructions`, `developer-instructions`, `title` | string · 미설정 | 지침 및 제목 |
| | `timeout-seconds` | 양의 정수 · 서버 설정 | turn 제한 시간 |
| | `wait-seconds` | 0 이상 정수 · 미설정(=turn 종료까지 블로킹) | 반환 전 관찰 시간. 스키마 자체에는 상한이 없지만, 엔진이 `OPENCODE_MCP_MAX_TURN_TIMEOUT_SECONDS`(기본 21600)보다 큰 값을 거부하지 않고 그 값으로 **클램프**합니다 |
| | `request-id` | string · 선택 | 영숫자로 시작하는 1–128자 `[A-Za-z0-9._:-]`; opencode/reply 간 공유 |
| | `output-schema` | object · 선택 | turn-local JSON Schema subset; 잘못된 subset은 mutation 전에 `INVALID_OUTPUT_SCHEMA` |
| | `detail` | `standard` \| `compact` · `standard` | compact는 toolCalls/filesChanged를 생략하고 counts를 표시 |
| | `max-output-chars` | 정수 0–44000 · standard 44000 / compact 2000 | 서버 cap 이하의 이번 content 상한; 0은 빈 content |
| `opencode-reply` | `prompt` | string · 필수 | 후속 요청 |
| | ID 별칭 3종 | string · 정확히 하나 필수 | 이어갈 세션 |
| | `model`, `agent`, `developer-instructions` | string · 기존 값 유지 | 다음 turn 설정. sandbox와 approval-policy는 세션 고정 |
| | `timeout-seconds`, `wait-seconds` | 양의 정수 / 0 이상 · 미설정(=turn 종료까지 블로킹) | turn 제한 / 대기(마찬가지로 최대 turn timeout으로 클램프) |
| | `request-id`, `output-schema`, `detail`, `max-output-chars` | 위와 같음 | `opencode`와 같은 규칙; schema는 다음 turn에 상속되지 않음 |
| `opencode-status` | ID 별칭 3종 | string · 생략 시 목록 | 상태 확인 또는 추적 세션 목록 |
| | `wait-seconds` | 0–600 정수 · `0` | 상태 관찰(최대 600초); 대기 중 승인 요청을 전달할 수 있음. turn이 아직 admission(연결/warm-up 등) 단계여도 이 시간 안에 반환됩니다 |
| | `ids` | string[] · 1–16개, 각 1–200자, unique | batch 모드; ID 별칭과 상호 배타 |
| | `wait-for` | `any` \| `all` · `any` | ids 전용; 하나 또는 전체 항목이 준비되기를 기다림 |
| | `detail`, `max-output-chars` | 위와 같음 · batch는 compact | max-output-chars는 응답 전체의 aggregate answer budget, 기본 min(서버 cap, 8000) |
| `opencode-output` | ID 별칭, `turn` | ID 하나; turn 정수 ≥1 · 필수 | 보존된 turn 결과 읽기 |
| | `section` | `answer` \| `tool-calls` \| `structured-output` \| `diff` · `answer` | 읽을 artifact |
| | `offset` | 정수 ≥0 · `0` | 텍스트는 UTF-16 offset, 목록은 항목 offset; total과 같으면 빈 마지막 page, 초과면 `INVALID_ARGUMENT` |
| | `limit` | section별 · 기본 answer/structured-output/patch 4000자, tool-calls 20개, diff stat 50개 | text는 256–20000자; tool-calls/diff stat은 1–100개; 서버 cap 이하 |
| | `diff-view`, `file-index`, `snapshot-id` | `stat` \| `patch` · `stat`; 정수 ≥0; string 1–200자 | diff 전용; patch는 index와 snapshot 필수, stat offset>0 continuation은 snapshot 필수 |
| `opencode-info` | `section` | `server` \| `models` \| `agents` \| `roots` · `server` | 서버, advertised model/agent 또는 허용 루트 조회 |
| | `cwd`, `provider` | string · 선택 | cwd는 models/agents용, provider는 models용 |
| | `offset`, `limit` | offset 0–10000 · 0; limit 1–100 · 50 | models/agents/roots pagination |
| | `snapshot-id` | string 1–200자 · offset>0에서 필수 | pagination snapshot 계속 읽기; server section에는 pagination 불가 |

| `opencode-cancel` | ID 별칭 3종 | string · 정확히 하나 필수 | 실행 turn 취소, 세션 유지 |
| `opencode-end` | ID 별칭 3종 | string · 정확히 하나 필수 | turn 중지와 세션 정리 |
| | `action` | enum · `delete` | `delete` 또는 `archive` |

`output-schema`는 직렬화 16 KiB 이하, 깊이 12 이하, 노드 512개 이하이며 root는 `type:"object"`이어야 합니다. 허용 keyword는 `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `description`, `maxLength`, `maxItems`뿐입니다. 타입은 object/array/string/number/integer/boolean/null(단일 타입 문자열)입니다. object는 `additionalProperties:false`, 최대 64개 property, 선언된 이름만 포함하는 중복 없는 `required`를 사용합니다. array는 단일 `items`; enum은 타입 호환 scalar 최대 64개; description 최대 1000자; maxLength 0–20000; maxItems 0–1000입니다. `$ref`, URL, union, pattern 및 알 수 없는 keyword는 허용되지 않습니다.

`opencode-end`는 이미 끝난 ID에도 멱등적으로 응답합니다(`not_found`). `opencode-cancel`은 turn만 취소하므로 세션으로 다시 reply할 수 있습니다. `opencode-end` 자체가 실패하면(삭제/보관 요청 실패 또는 정리 확인 실패) 세션은 `quarantined` 상태로 유지되며 `CLEANUP_UNCONFIRMED`가 반환됩니다 — 같은 `action`으로 `opencode-end`를 다시 호출해 재시도하세요(다른 action으로 바꾸면 다시 거부됩니다). `OPENCODE_MCP_ON_EXIT=end`로 종료할 때도 이런 세션을 재시도합니다.

## 결과 형식과 상태

`structuredContent.kind`는 `turn`, `sessions`, `end`, `error`, `output`, `info`, `batch` 중 하나입니다. 공통 필드는 `status`, `content`입니다.

- **turn**: `sessionId`, `threadId`, `turnId`, `turn`, `executionState`, `cleanup`, `directory`, `filesChanged`, `toolCalls`, `toolCallCount`, `pendingApprovals`, `elapsedMs`, `truncated`, `hint`; 가능하면 모델·agent·error·tokens(`input/output/reasoning`)·cost 포함.
- **turn 확장 필드**: `output`은 보존 상태(`pending|retained|unavailable`), 사유(`expired|evicted|too_large`), `answerChars`, `toolCallCount`, `structuredChars`, `partial`, `expiresAt`를 담습니다. `structuredOutputStatus`는 `valid|missing|invalid`; 유효할 때만 완전한 `structuredOutput`, 오류면 `{code,message}`인 `structuredOutputError`가 올 수 있습니다. 추출 오류 코드는 `JSON_MISSING`, `JSON_AMBIGUOUS`, `JSON_PARSE_ERROR`, `OUTPUT_TOO_LARGE`, `SCHEMA_MISMATCH`입니다. `request` receipt는 `{id,serverInstanceId,replayed,scope:"process",expiresAt?}`입니다. 이 메타데이터와 출력 형식은 실행 완료 판정을 바꾸지 않습니다.
- **과부하·답변 판정 필드**: `finish`는 OpenCode의 종료 사유, `warnings`는 `EMPTY_RESPONSE`, `TRUNCATED`, `NONSTANDARD_FINISH` 진단 목록입니다. `resendSafety`는 재전송 판단의 증거 수준입니다: `not_submitted`는 요청을 보내지 않았거나 미실행이 확인됨, `no_observed_effects`는 완전하고 정리된 기록에서 도구·patch 효과가 관찰되지 않음(“안전함”보다 약함), `inspect_effects`는 도구/patch 효과가 관찰됨, `unknown`은 기록·실행·정리가 불확실함을 뜻합니다. `upstreamRetry`는 `{attempt,message,nextAt?,observedAt}` provider 재시도 정보, `upstreamRead`는 `{state:"degraded",reason,statusCode?,since,nextAt}` 읽기 지연 정보, `responseLoop`는 `{count,windowMs,pattern}` 반복 응답 증거입니다. provider `error`에는 확인 가능한 `statusCode`, `retryable`, `retryAfterSeconds`와 `condition:"MODEL_OVERLOADED"`가 포함될 수 있습니다. batch turn 항목에도 같은 필드가 적용됩니다.
- 단일 turn의 `status`가 `failed` 또는 `timeout`이면 MCP 결과는 이제 `isError:true`입니다. `structuredContent`는 그대로 함께 제공됩니다. `completed`(경고 포함), `cancelled`, `running`은 `isError:true`가 아닙니다.
- **compact/축약**: compact turn은 `toolCalls`, `filesChanged`를 생략하고 `toolCallCount`, `filesChangedCount`, `pendingApprovalCount`를 유지합니다. `omittedFields`는 생략된 필드 이름을, `truncated`는 잘림을 표시합니다. batch compact 항목에도 `toolCallCount`, `filesChangedCount`, `pendingApprovalCount`가 있을 수 있습니다. 직렬화 객체는 45,000자 미만이어야 합니다.
- **output**: `opencode-output`는 `turnId`, `turn`, `section`, `offset`, `nextOffset`, `total`, `hasMore`, `partial`, `truncated` 및 해당 페이지의 `toolCalls`/`diff`를 반환합니다. diff metadata는 `source:"opencode-snapshot"`, `scope:"user-message"`, `sourceMessageId`, `snapshotId`, `observedAt`, `completeness:"not-guaranteed"`, `compacted`, `view`를 포함합니다. 텍스트 `content`는 페이지 텍스트이며 tool-call/diff-stat은 요약 content와 구조화 항목을 반환합니다.
- **info**: `opencode-info` 결과는 `section`, `truncated`와 선택적 `server`, `models`, `agents`, `roots`, pagination metadata를 반환합니다. server는 버전/모드/defaults/limits/capabilities, models는 `model`, `providerId`, `modelId`, `defaultForProvider`, 선택적 `toolcall`, agents는 `name`/`mode`를 투영합니다.
- **batch**: `{status:"ready"|"waiting",waitFor,reason:"condition"|"deadline",results,readyIds,pendingIds,truncated}`. `results`에는 입력 순서대로 각 ID의 turn snapshot 또는 `{sessionId,status:"error",error:{name,message}}`가 들어갑니다. 관찰 target은 호출 시작 시 캡처되며 알 수 없는 ID도 batch 전체 실패를 일으키지 않습니다.
- **sessions**: 세션 항목은 `sessionId`, `title`, `directory`, `status`, `turns`, `updatedAt`; 목록 결과에 `opencodeVersion`이 있을 수 있습니다.
- **end**: `status`는 `ended` 또는 `not_found`; `action`, `abortedRunningTurn`, `cleanup` 포함.
- **error**: `status: "failed"`, `error: {name,message}`; 세션 ID가 있을 수 있습니다.

Turn 상태는 `running`, `waiting_for_approval`, `completed`, `failed`, `cancelled`, `timeout`입니다. 세션 목록에는 `idle`, `ending`, `quarantined`도 있습니다(`quarantined`: 실행 결과가 아직 확인되지 않았거나 `opencode-end`가 실패해 재시도가 필요한 상태). `executionState`는 `active`/`stopped`/`unknown`, `cleanup`은 `complete`/`unconfirmed`입니다. `filesChanged`는 OpenCode patch에서 얻은 최선의 추정이며 빈 배열은 무변경의 증명이 아닙니다.

| 오류 코드 | 대응 |
|---|---|
| `INVALID_ARGUMENT` | 입력과 ID 별칭을 확인합니다. |
| `PATH_NOT_ALLOWED` | 허용 루트 아래의 `cwd`를 선택하거나 관리자가 허용 루트를 조정합니다. |
| `SESSION_NOT_FOUND` | 새 `opencode` 호출로 시작합니다. v0.1은 재시작 후 세션을 다시 채택하지 않습니다. |
| `SESSION_BUSY` | 상태를 확인하거나 대기하고 필요하면 취소합니다. |
| `OPENCODE_UNAVAILABLE` | 실행 파일, 서버 URL·상태, 네트워크를 점검합니다. |
| `UPSTREAM_ERROR` | OpenCode 응답과 내부 gateway 로그를 확인합니다. |
| `OPENCODE_OVERLOADED` | admission/read에서 HTTP `429`/`503`/`529`, 또는 세션 생성/prompt에서 HTTP `429`를 받았습니다. prompt는 제출되지 않았습니다. `retryAfterSeconds`까지 기다린 뒤 한 번 재시도합니다. |
| `SUBMISSION_UNCONFIRMED` | 재전송하지 말고 `opencode-status`로 기존 세션을 관찰합니다. |
| `CLEANUP_UNCONFIRMED` | 취소/정리가 확인되지 않았습니다. 세션은 `quarantined`로 표시됩니다; 같은 action으로 `opencode-end`를 재시도하세요. |
| `TURN_INCOMPLETE` | 최종 응답 없이 idle이 됐습니다. 상태를 확인하고 새 지시로 재시도합니다. |
| `SHUTTING_DOWN`, `INTERNAL` | 재연결하거나 서버 로그를 확인합니다. |
| `TURN_NOT_FOUND` | turn 번호가 기록되지 않았거나 세션이 끝났습니다. `opencode-status`로 현재 turn을 확인합니다. |
| `OUTPUT_NOT_READY` | turn이 아직 실행 중입니다. `opencode-status`로 기다린 뒤 다시 읽습니다. |
| `OUTPUT_UNAVAILABLE` | 출력이 만료·퇴거·초과 크기로 사용할 수 없습니다. 복구되지 않습니다. |
| `OUTPUT_LIMIT_TOO_SMALL` | 서버 출력 cap이 section의 최소 256자보다 작습니다. 관리자가 `OPENCODE_MCP_MAX_OUTPUT_CHARS`를 올려야 합니다. |
| `SNAPSHOT_EXPIRED` | offset 0, snapshot-id 없이 새 snapshot을 요청합니다. |
| `UPSTREAM_RESPONSE_TOO_LARGE` | OpenCode 응답이 허용 크기를 넘었습니다. 범위를 좁히거나 나중에 재시도합니다. |
| `EMPTY_RESPONSE` | 텍스트 없이 끝났고 도구/patch 효과도 관찰되지 않았습니다. gateway 응답을 확인한 뒤 재시도 여부를 판단합니다. |
| `UPSTREAM_RESPONSE_LOOP` | 반복되는 비정상 provider 응답으로 turn이 중지됐습니다. `responseLoop`와 부분 효과를 확인합니다. |
| `ContentFilterError` | provider가 답변을 필터링했습니다. 입력 정책과 gateway 응답을 확인합니다. |
| `INVALID_OUTPUT_SCHEMA` | 지원 subset에 맞게 `output-schema`를 수정합니다. |
| `REQUEST_ID_CONFLICT` | 다른 입력에 이미 사용된 키입니다. 새 request-id를 사용하거나 생략합니다. |
| `REQUEST_UNCONFIRMED` | 도달 여부가 불명확합니다. 재시도하지 말고 `opencode-status`로 먼저 확인합니다. |
| `REQUEST_ENDED` | 해당 키의 turn이 종료됐습니다. 새 요청에는 새 키를 사용합니다. |
| `REQUEST_CAPACITY` | request-id 테이블이 찼습니다. 키 없이 재시도하거나 만료를 기다립니다. |
| `REQUEST_PENDING` | 같은 request-id의 원 호출이 아직 admission 중입니다. 같은 키로 잠시 후 재시도하거나 `opencode-status`로 확인합니다. |
| `SESSION_CAPACITY` | 추적 중인 세션이 너무 많습니다. `opencode-end`로 끝난 세션을 정리하거나 관리자가 `OPENCODE_MCP_MAX_SESSIONS`를 올려야 합니다. |

다른 모델 오류는 turn의 `error.name`으로 반환될 수 있습니다.

`error.retryable`은 일시적 장애라는 뜻이지 prompt를 다시 보내도 된다는 허가가 아니다 — `executionState`, `cleanup`, `resendSafety`를 먼저 확인합니다.

기본 `OPENCODE_MCP_MAX_OUTPUT_CHARS=20000`은 content 제한입니다. 모든 가변 길이 필드(제목/디렉터리/상태 문자열, 패턴, 배열 크기 등)를 먼저 개별적으로 제한한 뒤에도 직렬화 결과가 45,000자 이상이면 toolCalls 제거, filesChanged 축소, sessions 축소, pendingApprovals 축소, content 축소 순서로 추가 축약해 항상 45,000자 미만을 보장합니다. 오류 메시지 2,000자, 짧은 문자열 필드(파일 경로·패턴·세션 title/directory/status 등) 300자, filesChanged 200개, toolCalls 20개, 승인 10개(승인당 패턴 20개), 세션 100개가 개별 상한이며 축약 여부는 `truncated`로 나타납니다.

## 설치: Claude Code 등록

### 내부 npm registry

공개 unscoped npm 이름 `opencode-mcp`는 다른 게시자 소유입니다. 프록시에서 이 패키지를 설치하지 마세요. `@internal/opencode-mcp`의 `@internal`은 placeholder이며 사내 scope와 registry로 바꿉니다.

`package.json`은 실수로 공개 registry에 게시되는 것을 막기 위해 기본적으로 `"private": true`입니다. 사내 게시 파이프라인은 실제 scope로 이름을 바꿀 때 이 값도 함께 `false`로 바꿔야 합니다(그렇지 않으면 `npm publish`가 거부합니다). 게시 대상은 다음 중 하나로 지정합니다.

- `package.json`에 `"publishConfig": {"registry": "https://npm.internal.example/"}`를 추가한 사내 포크를 유지하거나,
- 공유 설정을 건드리지 않고 `npm publish --registry https://npm.internal.example/`을 그때그때 지정합니다.

`npm pack`/`npm publish` 전에는 `prepack` 스크립트가 `npm run build && npm run bundle`을 실행해 `dist/`(gitignore 대상)를 채웁니다.

```sh
npm install -g @internal/opencode-mcp
claude mcp add --transport stdio opencode --env OPENCODE_MCP_OPENCODE_BIN=/usr/local/bin/opencode -- opencode-mcp
```

`claude mcp add` 인자 순서: `--env KEY=value`는 서버 명령 앞에 두고 `--` 뒤에 실행 파일과 인자를 둡니다. 환경 변수가 여럿이면 `--env`를 반복합니다.

### 단일 파일 번들

`npm run bundle` 산출물 `dist/opencode-mcp.mjs`를 `/opt/opencode-mcp/` 같은 경로에 복사합니다. Node.js 20 이상이 필요합니다. 번들은 MCP/Zod 의존성만 포함하고 OpenCode 실행 파일은 별도입니다.

아래 형식은 프로젝트 `.mcp.json` 예시입니다.

```json
{
  "mcpServers": {
    "opencode": {
      "type": "stdio",
      "command": "node",
      "args": ["/opt/opencode-mcp/opencode-mcp.mjs"],
      "env": {"OPENCODE_MCP_OPENCODE_BIN": "/usr/local/bin/opencode"}
    }
  }
}
```

조직 관리 설정은 Linux에서 `/etc/claude-code/managed-mcp.json`에 둘 수 있습니다(같은 `mcpServers` 형식). 정책 allowlist의 argv는 `command`와 `args`를 합친 정확한 배열이어야 합니다.

```json
{
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": [
    {"serverCommand": ["node", "/opt/opencode-mcp/opencode-mcp.mjs"]}
  ]
}
```

Claude Code의 기본 tool 호출 hard limit은 100,000,000ms(약 27.8시간)이며, 서버별 `timeout`은 이 값을 대체하므로 더 낮게 설정하면 호출이 먼저 취소될 수 있습니다. 지정한다면 최대 turn 시간에 시작·정리 여유를 더한 값(기본 최대 기준 약 21,700,000ms 이상)으로 설정하세요. 30분 idle timeout은 진행 heartbeat로 처리하므로 이를 이유로 더 짧은 hard limit을 지정할 필요는 없습니다. `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`은 환경 제한 스위치입니다. 설정하면 `HOME`, `PATH`, `CLAUDE*`와 서버 `env`에 적은 값만 MCP 서버에 전달되므로 proxy(`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`), CA(`NODE_EXTRA_CA_CERTS`), attach 및 gateway 변수를 서버 `env`에 넣습니다. 비밀값을 저장소에 기록하지 마세요. (Claude Code 동작은 [검증 조사](docs/research/mcp-client.md) §3.9 참고.)

이 서버 `env`와는 별도로, opencode-mcp가 자신이 띄우는 `opencode serve` 자식에게 전달할 환경도 `OPENCODE_MCP_CHILD_ENV_ALLOWLIST`로 제한하길 권장합니다 — 아래 [보안 모델과 한계](#보안-모델과-한계)를 참고하세요.

## 설정: 환경 변수

빈 문자열은 미설정으로 처리됩니다. boolean은 대소문자 무관 `1/0`, `true/false`, `yes/no`; 정수/초 값은 양의 정수여야 하며, 초 값은 ms 환산 시 2,147,483,647(2^31-1)을 넘지 않도록 2,147,483초를 초과할 수 없습니다(Node `setTimeout` overflow로 더 큰 값은 타임아웃을 사실상 즉시 발동시키기 때문). enum은 열거된 값만 받으며 설정 오류는 변수명을 표시합니다.

| 환경 변수 | 기본값 | 의미와 검증 |
|---|---|---|
| `OPENCODE_MCP_MODE` | URL 설정 시 `attach`, 아니면 `managed` | `managed` 또는 `attach` |
| `OPENCODE_MCP_SERVER_URL` | 없음 | attach 필수; 유효 http(s), userinfo 금지, 비-loopback은 HTTPS 기본 |
| `OPENCODE_MCP_ALLOW_INSECURE_HTTP` | `false` | loopback 외 HTTP 허용 |
| `OPENCODE_SERVER_USERNAME` | `opencode` | OpenCode server 사용자명 |
| `OPENCODE_SERVER_PASSWORD` | 없음 | attach 암호; managed 자식에는 임의 암호 생성 |
| `OPENCODE_MCP_OPENCODE_BIN` | `opencode` | 실행 파일 경로/이름 |
| `OPENCODE_MCP_SERVE_ARGS` | 빈 값 | 공백 구분 인자; `--hostname`, `--port`, `--mdns*`, `--cors` 금지 |
| `OPENCODE_MCP_AIRGAP` | `true` | managed 자식에 air-gap 기본값 적용 |
| `OPENCODE_MCP_CHILD_ENV_ALLOWLIST` | 빈 값 | 쉼표 구분 이름/`PREFIX_*`; 비면 환경 상속 후 scrub |
| `OPENCODE_MCP_DEFAULT_CWD` | `CLAUDE_PROJECT_DIR`, 아니면 프로세스 cwd | 절대 경로 |
| `CLAUDE_PROJECT_DIR` | 미설정 | 기본 cwd fallback, 지정 시 절대 경로 |
| `OPENCODE_MCP_ALLOWED_ROOTS` | 기본 cwd | `path.delimiter` 구분 허용 루트; 각 항목은 trim되며 절대 경로여야 함; 명시적으로 설정했는데 유효 항목이 0개면 시작 실패 |
| `OPENCODE_MCP_REMOTE_PATHS` | `false` | 원격 경로의 local realpath 검사 생략 |
| `OPENCODE_MCP_DEFAULT_MODEL` | 없음 | 기본 `provider/model`; 설정 시 반드시 `provider/model` 형식이어야 함(아니면 시작 실패) |
| `OPENCODE_MCP_DEFAULT_AGENT` | 없음 | 기본 agent |
| `OPENCODE_MCP_DEFAULT_SANDBOX` | `workspace-write` | `read-only`, `workspace-write`, `danger-full-access` |
| `OPENCODE_MCP_DEFAULT_APPROVAL_POLICY` | `never` | `never`, `on-request` |
| `OPENCODE_MCP_TURN_TIMEOUT_SECONDS` | `3600` | 기본 turn 제한 초 |
| `OPENCODE_MCP_MAX_TURN_TIMEOUT_SECONDS` | `21600` | 최대 turn 제한 초; 기본값 이상 |
| `OPENCODE_MCP_APPROVAL_TIMEOUT_SECONDS` | `600` | 승인 대기 제한 초 |
| `OPENCODE_MCP_STARTUP_TIMEOUT_SECONDS` | `60` | 시작 제한 초. Node fetch/undici의 headers/body timeout으로 실제 HTTP 대기는 최대 300초 |
| `OPENCODE_MCP_REQUEST_TIMEOUT_SECONDS` | `30` | HTTP 요청 제한 초. Node fetch/undici의 headers/body timeout으로 실제 HTTP 대기는 최대 300초 |
| `OPENCODE_MCP_CLEANUP_TIMEOUT_SECONDS` | `15` | 취소/정리 제한 초 |
| `OPENCODE_MCP_HEARTBEAT_SECONDS` | `15` | 진행 heartbeat 간격 초; 최대 `600`(Claude Code의 30분 idle 중단을 이 heartbeat로 막으므로 더 큰 값은 거부됩니다) |
| `OPENCODE_MCP_STATUS_POLL_SECONDS` | `30` | 상태 polling 간격 초 |
| `OPENCODE_MCP_SSE_STALL_SECONDS` | `35` | SSE 무응답 제한 초 |
| `OPENCODE_MCP_READ_RETRY_ATTEMPTS` | `3` | admission GET 시도 횟수(최초 포함), 1–3 정수; 오류: `must be an integer between 1 and 3, got "<값>"` |
| `OPENCODE_MCP_RESPONSE_LOOP_LIMIT` | `6` | 10초 안의 연속 응답 루프 임계값, 3–20 정수; `0`은 비활성화. 오류: `must be 0 (disabled) or an integer between 3 and 20, got "<값>"` |
| `OPENCODE_MCP_MAX_OUTPUT_CHARS` | `20000` | 양의 정수 content 제한 |
| `OPENCODE_MCP_MAX_SESSIONS` | `256` | 동시 추적 세션(활성+quarantined) 상한, 양의 정수 ≤ 10000; 초과 시 새 `opencode` 시작은 어떤 upstream 변경도 없이 `SESSION_CAPACITY`로 거부되며 기존 세션은 절대 evict되지 않음 |
| `OPENCODE_MCP_END_ACTION` | `delete` | `delete` 또는 `archive` |
| `OPENCODE_MCP_ON_EXIT` | `abort` | `abort` 또는 `end` |
| `OPENCODE_MCP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## opencode-mcp가 하는 일과 하지 않는 일

### 네트워크

- opencode-mcp는 OpenCode 서버에만 HTTP로 접속합니다. managed 모드에서는 직접 시작한 `http://127.0.0.1:<임의 포트>`, attach 모드에서는 `OPENCODE_MCP_SERVER_URL`을 사용합니다. 텔레메트리, 업데이트 확인, npm 호출, 원격 스키마 다운로드는 없습니다.
- 요청은 리다이렉트를 따라가지 않으며(`redirect: 'error'`), 고정 경로에 기본 URL을 붙여 구성하므로 다른 호스트로 새지 않습니다.
- attach URL은 http 또는 https만 허용하고 userinfo를 금지합니다. 루프백이 아닌 주소는 기본적으로 https여야 합니다. 평문 http는 `OPENCODE_MCP_ALLOW_INSECURE_HTTP=1`로 명시 허용할 수 있습니다.
- managed OpenCode는 `127.0.0.1`에만 바인딩되고 mDNS가 꺼져 있으며, 실행마다 32바이트 임의 비밀번호를 사용합니다. `OPENCODE_MCP_SERVE_ARGS`로 `--hostname`, `--port`, `--mdns`, `--cors`를 바꿀 수 없습니다.
- 기본 에어갭 설정(`OPENCODE_MCP_AIRGAP=1`)은 managed OpenCode의 자동 업데이트, 공유, LSP 다운로드, 모델 목록 조회를 끄고 npm 재시도를 0으로 둡니다. 이미 설정된 환경 변수는 덮어쓰지 않으며 네트워크를 차단하는 장치는 아닙니다.

### 파일과 세션

- opencode-mcp 자체는 파일을 만들거나 수정·삭제하거나 이름·권한을 바꾸지 않습니다. 파일 시스템 접근은 경로 확인용 `realpath`와 `stat`뿐이며, 로그는 stderr로만 출력하고 로그 파일을 만들지 않습니다.
- opencode-mcp는 OpenCode의 revert, shell, vcs, worktree, 설정 변경 API를 호출하지 않습니다. 호출자 프롬프트에 파일 수정 지시를 덧붙이지 않으며, 구조화 출력을 요청했을 때 JSON 형식 안내만 덧붙입니다.
- 중단·삭제·아카이브·권한 거부는 opencode-mcp가 직접 만든 세션에만 적용됩니다. 권한 요청에는 거부 또는 사람이 승인한 1회 허용으로만 답하고 항상 허용으로 답하지 않습니다.
- `opencode-end`를 action 없이 호출하면 기본 동작은 `delete`입니다. 해당 OpenCode 세션의 메시지와 기록을 영구 삭제하지만 작업 파일은 지우지 않습니다. 기본 종료 동작(`OPENCODE_MCP_ON_EXIT=abort`)은 실행 중인 턴만 중단하고 세션은 남겨 둡니다.
- managed 모드에서만 OpenCode의 `All fibers interrupted` 오류가 나면 해당 디렉터리의 OpenCode 인스턴스를 재시작(dispose)합니다. 파일과 세션 기록은 지워지지 않으며 attach 공유 서버에는 적용하지 않습니다.

### 프로세스

- opencode-mcp가 실행하는 프로그램은 고정된 작은 POSIX sh 감시 스크립트를 거치는 `opencode serve`와 프로세스 그룹 확인용 `ps`뿐입니다. 사용자 입력을 셸 문자열로 조합하지 않고 인자는 위치 인자로만 전달합니다. 종료할 때 자신이 띄운 OpenCode 프로세스 그룹에만 SIGTERM을 보내며, 5초 뒤에도 남아 있으면 SIGKILL을 보냅니다. attach 모드에서는 프로세스를 종료하지 않습니다.
- opencode-mcp가 SIGKILL·크래시로 강제 종료되어도 감시 스크립트가 부모 종료를 5초 간격으로 확인해 OpenCode에 SIGTERM을 보내고, 3초 뒤에도 남아 있으면 SIGKILL을 보냅니다. 따라서 약 5–8초 안에 `opencode serve`가 정리됩니다(부모 PID가 그 사이 다른 프로세스에 재사용되는 극히 드문 경우는 예외). 확인 명령: `ps -A -o pid,pgid,command | grep "opencode serve"`.
- 정상 종료(기본 `OPENCODE_MCP_ON_EXIT=abort`, managed 모드)에서는 종료 시작과 동시에 OpenCode 프로세스 그룹을 종료합니다. 실행 중인 턴은 프로세스 종료를 정지 증거로 삼아 `stopped`로 기록되며 완료로 보고되지 않습니다.

### 자원

- managed OpenCode는 OpenCode가 필요한 첫 호출(예: `opencode`) 때 시작하고(`opencode-info`의 server 조회는 시작하지 않음), 시작 후 opencode-mcp가 끝날 때까지 유지됩니다(idle 자동 종료 없음). 실행 중인 작업이 없으면 폴링, SSE, 타이머가 돌지 않습니다.
- 재연결 백오프(0.5–5초), 응답 크기(JSON 8MiB, 이벤트 1MiB 등), 메모리 캐시(출력 32MiB/1시간, 추적 세션 기본 256개)에 상한이 있습니다. turn은 기본 1시간, 최대 6시간의 timeout 뒤 자동 중단됩니다.

### OpenCode 자체가 하는 일

- OpenCode는 opencode-mcp와 별개로 LLM 제공자와 통신합니다. provider를 설정하지 않으면 OpenCode 기본 설정에 따라 외부 클라우드 provider(OpenCode Zen 등)를 쓸 수 있습니다. 첫 부팅 때 npm registry에서 `~/.config/opencode`에 plugin을 설치할 수 있고, `rg`가 없으면 ripgrep을 내려받을 수 있습니다. `~/.local/share/opencode`에는 세션 DB와 snapshot을 저장합니다.
- 기본 `workspace-write` sandbox에서는 요청에 따라 OpenCode가 bash, 파일 편집, webfetch/websearch를 쓸 수 있습니다. 파일 삭제나 `curl` 실행도 가능할 수 있습니다. sandbox는 OS 격리가 아니라 OpenCode 권한 프로필입니다. 검토 전용이면 `OPENCODE_MCP_DEFAULT_SANDBOX=read-only`를 쓰세요. 이 모드는 edit, bash, webfetch, websearch, external_directory를 차단합니다.
- managed OpenCode는 기본적으로 부모 환경 변수를 상속하지만 `ANTHROPIC_*`, `CLAUDE_*`, `OPENCODE_MCP_*`, `OPENCODE_SERVER_*` 등은 제거됩니다(감시 스크립트용 `OPENCODE_MCP_WATCHDOG_PPID`=opencode-mcp PID만 추가됨). 외부 통신 변수를 제한하려면 `OPENCODE_MCP_CHILD_ENV_ALLOWLIST`로 전달할 이름을 제한하세요.

## 과부하·비정상 응답 대응

opencode-mcp는 prompt를 자동 재전송하지 않습니다. admission GET 오류는 `OPENCODE_MCP_READ_RETRY_ATTEMPTS` 횟수(최초 포함) 안에서 startup deadline까지 제한 재시도합니다. 서버의 `Retry-After`는 최대 3600초까지 하한으로 존중하며, admission/cleanup deadline이 더 짧으면 기다렸다가 조기 재시도하지 않고 operation을 종료합니다. 세션 생성/prompt의 HTTP 429는 prompt 제출 전 `OPENCODE_OVERLOADED`로 반환됩니다.

실행 중 turn은 OpenCode 읽기가 느리거나 5xx여도 backoff 후 계속 진행하며 `upstreamRead`와 `OpenCode reads are delayed …` 진행 메시지를 표시할 수 있습니다. attach 모드는 health probe 세 번이 hard-fail된 뒤 서버 unreachable로 선언합니다. managed child는 느린/5xx 읽기 때문에 재시작하지 않습니다. OpenCode 1.18.33은 provider 자체에서 첫 시도 후 최대 5회(명목상 2/4/8/16/30초, `Retry-After` 존중) 재시도한 뒤 `APIError`를 낼 수 있으며 이 과정은 `upstreamRetry`로 표시됩니다.

| 답변 분류 | 결과 |
|---|---|
| `stop` + 빈/공백 응답, 효과 없음 | `failed`, `EMPTY_RESPONSE`, `retryable:true` |
| 텍스트 없이 tool/patch 활동 | `completed` + `EMPTY_RESPONSE` warning |
| `length` 종료 | `completed` + `TRUNCATED`, `output.partial:true`; 답변이 비면 `failed` + `EMPTY_RESPONSE` |
| `content-filter` 종료 | `failed`, `ContentFilterError` |
| 비표준 finish | `failed`, `TURN_INCOMPLETE` + `NONSTANDARD_FINISH` |
| 잘못된 streaming 응답 | `failed`, `UnknownError`와 고정된 정제 메시지 `The model provider returned a malformed streaming response.` |

OpenCode 1.18.33은 빈 stream, HTML 응답 또는 잘못된 tool JSON에서 초당 약 7–8회 재요청을 무한 반복할 수 있습니다. watchdog은 이 관찰된 서명만 인식하며, 10초 안에 `OPENCODE_MCP_RESPONSE_LOOP_LIMIT`회 연속 unusable response가 나오면 `failed`/`UPSTREAM_RESPONSE_LOOP`로 turn을 중지합니다. 실제 OpenCode 1.18.33 e2e에서 세 경우 모두 첫 모델 요청 후 약 1.5–4.5초, 모델 요청 9–30회 안에 중지됐습니다(최종 전체 실행: 각각 약 2.5초, 14–15회). 텍스트/추론이 스트리밍되는 동안(최근 10초 안에 delta 수신)은 watchdog 검사를 하지 않습니다.

재전송 판단: `not_submitted`는 제출되지 않았으므로 다시 보낼 수 있습니다. `no_observed_effects`는 “안전함” 보장이 아니므로 기록을 확인합니다. `inspect_effects`는 도구/patch 효과를 점검한 뒤 이어서 진행합니다. `unknown`이면 재전송하지 말고 `opencode-status`로 기존 세션을 관찰합니다.


## 보안 모델과 한계

v0.3 기능 한계: 보존 출력은 메모리에서 1시간, 최대 128 turns/32 MiB(각 turn 최대 4 MiB)이며 성공한 `opencode-end`와 프로세스 종료 시 사라집니다. `request-id`는 프로세스 내, 최대 4096개 기록의 24시간 dedup이며 crash-safe exactly-once가 아닙니다. diff는 해당 turn의 사용자 메시지 기준 OpenCode snapshot이라 완전성이 보장되지 않고, 빈 diff도 변경 없음의 증거가 아닙니다. `opencode-info`는 allowlist로 투영한 정보만 반환하고 provider key/options를 노출하지 않습니다. OpenCode `opencode-ai@1.18.33`에서는 prompt `format`이 message 읽기를 영구히 깨뜨리므로 사용하지 않습니다. 세션 수는 `OPENCODE_MCP_MAX_SESSIONS`(기본 256)로 제한되며 초과 시 `opencode-end`로 정리해야 새 세션을 시작할 수 있습니다.

**지연된 abort 한계**: abort 응답이 유실되거나 잘못된 형식이면 모호성 표식을 유지하고 두 번째 abort를 보내지 않습니다. 세션은 최대 `max(2 × request timeout, 60초)` 동안 격리됩니다. 그 뒤 idle/terminal 증거를 확인해 해제하며, 늦게 도착한 abort는 다음 turn을 중단시킬 수 있습니다. abort 이전의 도구 효과는 되돌리지 않으며, 해당 turn은 정상 완료로 보고되지 않습니다. `abort`/`delete`/`archive` 응답은 확정적인 4xx에서만 모호성 표식을 지우며 `408`/`429`는 제외됩니다.

응답 루프 watchdog은 관찰된 빈 응답, HTML 본문, 잘못된 tool JSON 패턴만 감지하며 `OPENCODE_MCP_RESPONSE_LOOP_LIMIT=0`이면 비활성화됩니다. 느린/실패한 OpenCode 읽기는 결과를 지연할 수 있고, 서버가 요청한 `Retry-After` 대기는 최대 3600초까지 하한으로 존중됩니다. 이미 관찰한 메시지가 OpenCode 기록에서 사라지면(예: 외부에서 revert) 읽기를 불일치로 보고 판정을 보류하므로 세션이 `quarantined`로 남을 수 있습니다. 이때는 `opencode-end`로 정리합니다.
`sandbox`는 OpenCode permission profile이지 OS 격리가 아닙니다. 모든 profile에서 `task`, `question`, `plan_enter`, `plan_exit`를 deny합니다. `read-only`는 `edit`, `bash`, `external_directory`, `webfetch`, `websearch`도 deny하고 `workspace-write`는 `external_directory`를 deny합니다. 규칙은 deny-only이며 `always` 승인은 하지 않습니다. `approval-policy=never`는 승인 요청을 거절합니다. `on-request`는 legacy elicitation만 사용하며 headless `claude -p` 또는 legacy UI가 없는 클라이언트에서는 요청을 거절합니다. elicitation 기능 자체를 전혀 선언하지 않는 연결은 승인 대기 없이 즉시 거절되고, 선언하는 연결은 SDK 기본값 60초가 아니라 남은 `OPENCODE_MCP_APPROVAL_TIMEOUT_SECONDS` 시간만큼 대기합니다.

managed child 환경은 `ANTHROPIC_*`, `CLAUDE_*`, `CLAUDECODE`, `AI_AGENT`, `OPENCODE_MCP_*`, `OPENCODE_SERVER_*`를 scrub합니다. `OPENCODE_MCP_CHILD_ENV_ALLOWLIST`가 비면 나머지 환경을 상속한 뒤 scrub하고, 설정하면 필수 `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR`, `SHELL`, `TERM`과 허용 이름/접두사만 선택한 뒤 scrub합니다. attach URL은 loopback 외 HTTPS가 기본이며 `OPENCODE_MCP_ALLOW_INSECURE_HTTP=1`로 예외를 허용합니다. 허용 루트는 cwd 선택만 제한하고 전체 파일 접근을 가두지 않습니다. 강한 격리는 OS 사용자, 컨테이너/VM, 파일·네트워크 정책으로 구성하세요.

최소 권한 배포에서는 `OPENCODE_MCP_CHILD_ENV_ALLOWLIST`를 명시적으로 설정하길 권장합니다. 예: `OPENCODE_MCP_CHILD_ENV_ALLOWLIST=INTERNAL_LLM_API_KEY,NPM_CONFIG_*,NODE_EXTRA_CA_CERTS,HTTP_PROXY,HTTPS_PROXY,NO_PROXY,OPENCODE_*` (OpenCode가 실제로 필요로 하는 이름에 맞게 조정; 자세한 설명은 [docs/deployment-airgap.md](docs/deployment-airgap.md) §5 참고).

**한계를 명시**: `OPENCODE_SERVER_PASSWORD`는 managed 자식의 환경 변수로 전달됩니다. 허용 루트 아래 checkout의 `.opencode/` plugin과 프로젝트 `opencode.json`은 sandbox 설정과 무관하게 shared `opencode serve` 안에서 실행될 수 있으며, server 환경의 비밀번호에도 접근할 수 있습니다. 또한 `sandbox`가 `workspace-write` 또는 `danger-full-access`이면 OpenCode 자신의 `bash` 도구가 이 환경을 읽거나(`env`, `printenv`) 그 비밀번호로 loopback API(`127.0.0.1:<port>`)를 호출할 수 있습니다(`read-only`는 `bash`를 deny). 프로젝트 설정/로컬 plugin을 쓰지 않을 운영자는 `OPENCODE_MCP_SERVE_ARGS=--pure` 또는 OpenCode 설정 `OPENCODE_DISABLE_PROJECT_CONFIG=1`을 선택할 수 있습니다. `--pure`는 외부 plugin을 건너뛰며 로컬 plugin을 로드하지 않는 것으로 검증됐고, `OPENCODE_DISABLE_PROJECT_CONFIG`는 프로젝트 설정을 무시하는 용도입니다([OpenCode 오프라인 조사](docs/research/opencode-offline.md) §6 "Switches and where each was verified"). `--pure`가 기본 적용되지는 않습니다. 프로젝트 설정을 허용하는 경우 OpenCode 프로세스 자체를 신뢰 경계 안에 두어야 합니다.

입력 schema 위반은 MCP SDK 단계에서 거부되어 `isError`와 `Input validation error: …` 텍스트로 반환되며 `structuredContent`가 없습니다. `INVALID_ARGUMENT`는 handler의 의미 검사(예: ID 별칭 개수) 오류에만 해당합니다.


## 문제 해결

- **긴 작업/Claude Code timeout:** 약 15초 간격 heartbeat를 보내므로 30분 idle timeout을 처리합니다. 대화형 Claude Code는 약 120초 뒤 호출을 background로 옮길 수 있고 `TaskStop`으로 중단할 수 있습니다. per-server hard `timeout`을 지정한다면 최대 turn 시간과 시작·정리 여유보다 길게 둡니다. heartbeat는 전체 wall-clock 제한을 늘리지 않습니다.
- **세션 격리 또는 busy:** 상태/정리가 확인되지 않으면 새 turn이 차단될 수 있습니다. `opencode-status`, OpenCode 프로세스와 로그를 확인합니다.
- **권한 거절 뒤 `TURN_INCOMPLETE`:** terminal assistant 답 없이 idle일 수 있습니다. 결과를 확인하고 `opencode-reply`로 새 지시를 보냅니다.
- **ripgrep 누락:** OpenCode 프로세스의 `PATH`에 `rg`를 설치하고 server를 재시작합니다(실패 경로가 캐시될 수 있음).
- **느린 첫 시작:** OpenCode가 config-dir에 `@opencode-ai/plugin` 및 dependency를 npm 설치할 수 있습니다. 내부 registry와 CA를 제공하거나 사전 준비하세요.
- **`EMPTY_RESPONSE`:** provider가 텍스트 없이 끝났습니다. warning과 `toolCalls`/`filesChanged`를 확인합니다.
- **`TRUNCATED` warning:** provider가 `length`로 끝냈습니다. `output.partial`을 확인하고 작업을 나누거나 provider 출력 제한을 점검합니다.
- **`UPSTREAM_RESPONSE_LOOP`:** `responseLoop.pattern`을 보고 빈 stream, HTML 또는 tool JSON 형식을 조사합니다. gateway 복구 후 같은 세션에 새 지시를 보낼 수 있습니다.
- **`OPENCODE_OVERLOADED`:** `retryAfterSeconds`까지 기다린 뒤 한 번 재시도합니다. prompt는 제출되지 않았습니다.
- **`OpenCode reads are delayed` 진행 메시지:** OpenCode 상태 읽기가 느리거나 실패 중입니다. `upstreamRead.nextAt` 이후 상태를 확인합니다.
- **`SUBMISSION_UNCONFIRMED`:** 재전송하지 말고 `opencode-status`로 기존 세션을 관찰합니다.
- **오프라인 모델 목록:** 내장 catalog snapshot이 표시될 수 있습니다. 내부 gateway provider/model을 직접 구성합니다.
- **MCP 재시작 후 `Session not found`:** v0.1은 세션 adopt가 없으므로 `opencode`로 새 세션을 시작합니다.
- **보존 출력 만료/누락:** 1시간/용량 제한으로 artifact가 없으면 `OUTPUT_UNAVAILABLE`이 반환됩니다. 다시 얻으려면 새 turn이 필요합니다.
- **페이지 이어 읽기 실패:** `SNAPSHOT_EXPIRED`면 offset 0에서 snapshot-id를 빼고 다시 시작합니다. patch 조회는 `stat`에서 얻은 snapshot-id와 file-index를 사용합니다.
- **request-id 재사용 오류:** `REQUEST_ID_CONFLICT`는 같은 키에 다른 인자를 보낸 경우입니다. 새 논리 호출에는 새 키를 사용합니다. `REQUEST_UNCONFIRMED`에서는 먼저 상태를 확인하고 prompt를 재전송하지 않습니다.
- **구조화 출력 누락/오류:** `structuredOutputStatus`와 `structuredOutputError.code`를 읽습니다. 이 결과는 turn 실패나 재시도를 뜻하지 않습니다.

## 개발

Node runtime은 20 이상, 테스트는 Node 22.18 이상(type stripping)입니다.

| 명령 | 기능 |
|---|---|
| `npm run typecheck` | TypeScript 검사 |
| `npm run build` | 컴파일 |
| `npm run bundle` | `dist/opencode-mcp.mjs` 생성 |
| `npm test` | 테스트 |
| `npm run check` | typecheck 후 test |

`scripts/remote.sh <label> [--no-install] [--pull <path>] <command...>`는 원격 Docker 호스트의 `node:22`에서 실행합니다(기본은 npm install). 원격 호스트 기본값은 관리자 환경의 SSH 별칭 `gram`이며 `OCMCP_REMOTE_HOST`로 바꿀 수 있습니다(`e2e/run-e2e.sh`도 같음). 주요 경로: `src/config.ts`, `src/mcp/`, `src/core/`, `src/opencode/`, `test/`, `e2e/`, `docs/`.

### End-to-end 검증

`e2e/`는 실제 OpenCode 바이너리와 가짜(fake) LLM 서버를 붙여 stdio MCP 왕복 전체를 검증하는 hermetic 하네스입니다(네트워크 접근 없이 컨테이너 안에서 실행). 진입점은 `e2e/run-e2e.sh`이며 사용법과 시나리오 목록은 `e2e/README.md`를 참고하세요. 단위/통합 테스트(`npm test`)와 별개로, 실제 Claude Code 클라이언트/유사 SDK 클라이언트가 관찰하는 JSON-RPC 왕복까지 재현합니다.

## 라이선스와 버전

버전 **v0.3.0** (design v0.3 + 과부하 대응), 라이선스 MIT([LICENSE](LICENSE); OpenCode에서 캡처한 조사 자료의 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). 조사에서 검증한 조합은 OpenCode `opencode-ai@1.18.33`, `@modelcontextprotocol/server@2.2.0`, Claude Code `2.1.284`, Node.js 20 이상(테스트 Node.js 22.18 이상), TypeScript `7.0.2`, `zod@4.6.5`, `esbuild@0.28.2`입니다.
