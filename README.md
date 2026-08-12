# mcp-local-editor

ChatGPT 같은 MCP 클라이언트가 **사용자가 지정한 단일 로컬 저장소** 안에서 제한된 코딩 작업을 수행하도록 만드는 최소 MCP 서버입니다.

현재 버전은 별도 코딩 에이전트나 모델을 실행하지 않습니다. 판단과 반복은 MCP 클라이언트가 담당하고, 이 서버는 다음 다섯 가지 결정론적 도구만 제공합니다.

| 도구 | 기능 | 변경 여부 |
|---|---|---:|
| `repo_search` | `ripgrep`으로 저장소 검색 | 읽기 전용 |
| `file_read` | 파일 일부와 전체 파일 SHA-256 읽기 | 읽기 전용 |
| `file_edit` | SHA-256 확인 후 정확한 텍스트 교체 | 파일 변경 |
| `command_run` | 운영자가 등록한 명령만 실행 | 프로세스 실행 |
| `git_diff` | Git 상태와 staged/unstaged diff 확인 | 읽기 전용 |

## 범위

### 포함

- 서버 시작 시 고정한 저장소 하나
- 저장소 밖 경로 및 symlink escape 차단
- 파일 변경 전 SHA-256 precondition 검사
- 정확히 한 번 일치하는 텍스트만 교체
- 사람이 JSON 설정에 등록한 `argv`만 실행
- shell 없이 subprocess 직접 실행
- timeout 시 자식 process group 종료
- stdout/stderr 크기 제한
- staged 및 unstaged Git diff 조회
- stdio MCP

### 제외

- Codex 또는 OpenCodex 실행
- 외부 LLM/API 호출
- 임의 shell command
- 파일 생성, 삭제, 이동
- Git commit, push, PR 생성
- 여러 저장소 전환
- Docker/VM/process sandbox
- HTTP MCP, tunnel, 데스크톱 UI
- 장기 agent state와 autonomous loop

이 서버는 **workspace guard**이지 완전한 sandbox가 아닙니다. 허용된 명령은 사용자의 권한으로 실행되므로 신뢰할 수 있는 저장소와 명령만 등록해야 합니다.

## 요구 사항

- Node.js 20 이상
- Git
- ripgrep (`rg`)

macOS에서는 다음처럼 설치할 수 있습니다.

```bash
brew install node ripgrep git
```

npm dependency는 없습니다.

## 실행

```bash
git clone https://github.com/junjunjunbong/mcp-local-editor.git
cd mcp-local-editor

cp commands.example.json commands.local.json
node src/cli.js \
  --root /absolute/path/to/target-repository \
  --config ./commands.local.json
```

환경 변수도 지원합니다.

```bash
export MCP_LOCAL_EDITOR_ROOT=/absolute/path/to/target-repository
export MCP_LOCAL_EDITOR_CONFIG=/absolute/path/to/commands.local.json
node src/cli.js
```

stdout은 MCP JSON-RPC 전용입니다. 상태 로그는 stderr로 출력됩니다.

## MCP 클라이언트 설정 예시

stdio MCP를 지원하는 클라이언트에서 다음과 같이 등록합니다.

```json
{
  "mcpServers": {
    "local-editor": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-local-editor/src/cli.js",
        "--root",
        "/absolute/path/to/target-repository",
        "--config",
        "/absolute/path/to/mcp-local-editor/commands.local.json"
      ]
    }
  }
}
```

현재 구현은 stdio 전용입니다. ChatGPT 웹에서 원격 MCP로 연결하기 위한 HTTP endpoint와 tunnel은 후속 범위입니다.

## 명령 allowlist

클라이언트는 shell 문자열을 전달할 수 없습니다. `command_run`은 아래 설정에서 사람이 등록한 `command_id`만 받습니다.

```json
{
  "commands": {
    "test": {
      "description": "Run the repository test suite",
      "argv": ["npm", "test"],
      "timeoutSec": 300,
      "maxOutputBytes": 262144
    },
    "typecheck": {
      "description": "Run the type checker",
      "argv": ["npm", "run", "typecheck"],
      "timeoutSec": 180,
      "maxOutputBytes": 262144
    }
  }
}
```

`argv[0]`은 실행 파일이고 나머지는 인자입니다. `shell: false`로 실행되므로 `|`, `&&`, 리다이렉션 같은 shell 문법은 해석되지 않습니다.

## 권장 편집 흐름

1. `repo_search`로 관련 코드를 찾습니다.
2. `file_read`로 파일을 읽고 `sha256`을 받습니다.
3. `file_edit`에 같은 `sha256`과 exact replacement를 전달합니다.
4. `command_run`으로 테스트를 실행합니다.
5. `git_diff`로 최종 변경을 검토합니다.

`file_edit` 예시:

```json
{
  "path": "src/example.js",
  "expected_sha256": "64-character-sha256",
  "replacements": [
    {
      "old_text": "return false;",
      "new_text": "return result.allowed;"
    }
  ]
}
```

다음 경우에는 파일을 수정하지 않고 실패합니다.

- 파일이 읽은 뒤 변경되어 SHA-256이 달라짐
- `old_text`가 없음
- `old_text`가 두 번 이상 나타남
- replacement 중 하나라도 유효하지 않음
- 경로가 저장소 밖으로 나감
- symlink가 저장소 밖을 가리킴
- binary 또는 지나치게 큰 파일

## 도구 입력

### `repo_search`

```json
{
  "query": "scope_delta",
  "glob": "**/*.js",
  "max_results": 30
}
```

`query`는 ripgrep 정규식입니다. `.gitignore` 규칙을 따릅니다.

### `file_read`

```json
{
  "path": "src/example.js",
  "start_line": 1,
  "end_line": 200
}
```

한 번에 최대 2,000줄, 최대 5 MiB UTF-8 파일을 읽습니다.

### `file_edit`

기존 UTF-8 파일 하나에서 최대 50개의 exact replacement를 적용합니다. 모든 replacement를 메모리에서 검증한 뒤 임시 파일과 rename을 사용해 한 번에 저장합니다.

### `command_run`

```json
{
  "command_id": "test"
}
```

추가 인자를 받을 수 없습니다. 실행 명령은 설정 파일이 전부 결정합니다.

### `git_diff`

입력은 빈 객체입니다.

```json
{}
```

다음을 반환합니다.

- `git status --short --untracked-files=all`
- unstaged diff와 stat
- staged diff와 stat

Git 상태를 변경하지 않습니다.

## MCP 프로토콜 범위

다음 stdio JSON-RPC method를 구현합니다.

- legacy `initialize` / `notifications/initialized`
- modern `server/discover`
- `tools/list`
- `tools/call`
- `ping`
- 비어 있는 `resources/list`, `resources/templates/list`, `prompts/list`

legacy `2025-11-25` 계열과 modern `2026-07-28` discovery/tool 호출에 필요한 좁은 범위를 지원합니다. 전체 MCP conformance를 주장하지 않습니다.

## 보안 경계

이 구현이 보장하려는 것:

- 설정된 저장소 밖의 파일을 읽거나 수정하지 않음
- 경로를 실제 경로로 canonicalize한 뒤 root 내부인지 재검사
- stale file overwrite 방지
- 모델이 임의 command나 추가 argument를 삽입하지 못함
- command timeout과 output limit 적용
- Codex, OpenCodex, 모델 provider, OpenAI API를 호출하지 않음

이 구현이 보장하지 않는 것:

- 등록된 명령 내부의 악성 동작 방지
- 네트워크 차단
- CPU, 메모리, 디스크 quota
- target repository code의 신뢰성
- 운영체제 수준 격리

더 강한 격리가 필요해진 뒤에만 `ExecutionBackend`를 Docker, SWE-ReX, Codex exec-server 같은 backend로 교체하는 것이 다음 단계입니다.

## 개발

```bash
npm test
npm run check
```

테스트는 다음을 포함합니다.

- lexical path escape 차단
- symlink escape 차단
- SHA-256 stale edit 차단
- ambiguous replacement 차단
- 다중 replacement의 all-or-nothing 검증
- command allowlist와 timeout
- ripgrep search
- staged/unstaged Git diff
- legacy initialize와 modern discover를 포함한 stdio MCP round trip
