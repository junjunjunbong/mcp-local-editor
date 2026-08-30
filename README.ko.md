# MCP Local Editor

<p align="center">
  <a href="https://github.com/junjunjunbong/mcp-local-editor#readme">English</a> · <strong>한국어</strong>
</p>

<p align="center">
  <img src="docs/assets/mcp-local-editor-hero.png" alt="MCP Local Editor가 ChatGPT 웹을 보호된 로컬 개발 워크스페이스에 안전하게 연결하는 모습" width="1200">
</p>

**ChatGPT 웹을 로컬 코딩 에이전트처럼 사용하세요.** 판단은 ChatGPT가 하고, MCP Local Editor는 컴퓨터의 파일을 안전한 범위 안에서 검색하고 읽고 수정하고 테스트하고 검토할 수 있게 연결합니다.

[![npm](https://img.shields.io/npm/v/mcp-local-editor)](https://www.npmjs.com/package/mcp-local-editor)
[![CI](https://github.com/junjunjunbong/mcp-local-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/junjunjunbong/mcp-local-editor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

OpenAI API 키도, 별도의 모델도 필요하지 않습니다. 이 패키지가 모델을 호출하지도 않습니다. 평소처럼 ChatGPT 계정으로 웹 대화를 이어가면, 로컬 브리지가 사용자가 허용한 작업만 수행합니다.

> MCP Local Editor는 ChatGPT의 사용량 제한을 우회하지 않습니다. ChatGPT 요금제, 모델 제공 여부, 사용량 제한, 워크스페이스 정책은 그대로 적용됩니다. 이 프로젝트는 독립적인 오픈 소스이며 OpenAI와 제휴하거나 OpenAI의 보증을 받은 제품이 아닙니다.

## 한 번의 명령으로 ChatGPT 연결하기

Node.js 20 이상, `cloudflared`, Git, [ripgrep](https://github.com/BurntSushi/ripgrep)이 필요합니다. macOS에서 Homebrew를 사용한다면 다음과 같이 설치합니다.

```bash
brew install node cloudflared ripgrep
```

그다음 MCP Local Editor가 사용할 폴더를 지정합니다.

```bash
npx mcp-local-editor@latest setup-chatgpt /절대/경로/프로젝트
```

이 명령은 폴더를 등록하고, 비공개 소유자 토큰을 만들고, OAuth MCP 서버와 임시 HTTPS 터널을 시작한 뒤 하나의 `MCP URL`을 출력합니다.

ChatGPT 웹에서 다음 순서로 연결합니다.

1. **설정 → 보안 및 로그인**에서 **개발자 모드**를 켭니다.
2. [ChatGPT Plugins](https://chatgpt.com/plugins)를 열고 **+**를 눌러 개발자 모드 앱을 만듭니다.
3. 터미널에 출력된 MCP URL을 붙여 넣고 인증 방식으로 **OAuth**를 선택합니다.
4. 로컬 승인 페이지가 열리면 터미널에 표시된 소유자 토큰 파일의 값을 붙여 넣습니다.
5. 일반 채팅의 더하기 메뉴에서 **개발자 모드**를 선택하고 만든 앱을 활성화합니다.

앱을 사용하는 동안 터미널 명령을 계속 실행해 두어야 합니다. Quick Tunnel 주소는 임시 주소이므로 프로세스를 다시 시작하면 새로 출력된 URL로 앱을 다시 연결해야 합니다. 고정 주소와 수동 설정 방법은 [ChatGPT 연결 상세 안내](docs/chatgpt-mcp.md)를 참고하세요.

OpenAI의 현재 문서에 따르면 자격이 되는 웹 계정의 ChatGPT 개발자 모드는 원격 Streaming HTTP MCP 서버, OAuth, 읽기·쓰기 도구를 지원합니다. 쓰기 작업은 일반적으로 실행 전 확인을 요구합니다. 쓰기 권한을 켜기 전에 [공식 개발자 모드 안내](https://developers.openai.com/api/docs/guides/developer-mode)를 확인하세요.

## 무엇이 다른가요?

```text
일반 ChatGPT 웹 대화
        │ 판단 + 도구 호출
        ▼
 HTTPS를 통한 OAuth MCP
        │
        ▼
내 컴퓨터의 MCP Local Editor
        │ 등록된 워크스페이스만 허용
        ▼
검색 · 읽기 · 수정 · 테스트 · Git diff
```

- **에이전트는 ChatGPT입니다.** 이 패키지는 또 하나의 LLM 래퍼가 아니라 로컬 도구를 연결하는 브리지입니다.
- **별도의 API 과금 계층이 없습니다.** 브리지는 AI API를 호출하지 않고 사용자가 열어 둔 ChatGPT 대화를 이용합니다.
- **로컬 파일이 실제로 바뀝니다.** 현재 파일 해시와 정확한 텍스트를 기준으로 수정하고, 테스트는 셸 문자열이 아닌 argv 배열로 실행합니다.
- **디스크 전체를 노출하지 않습니다.** ChatGPT에는 임의의 절대 경로가 아니라 사용자가 등록한 워크스페이스 ID만 보입니다.
- **읽기 전용 모드는 서버에서 강제됩니다.** 쓰기 도구가 도구 목록에서 사라지며 인자를 바꿔도 활성화할 수 없습니다.
- **ChatGPT 외의 MCP 클라이언트에서도 쓸 수 있습니다.** 같은 코어를 stdio MCP와 인증된 Actions 어댑터로도 제공합니다.

## 사용 예시

ChatGPT에 다음과 같이 요청할 수 있습니다.

```text
MCP Local Editor만 사용해. my-project 워크스페이스를 쓰기 권한으로 열어.
홈페이지 버튼 문구가 정의된 곳을 찾아 "Start"를 "Ship it"으로 바꾸고,
사용 가능한 테스트 명령을 실행한 다음 Git diff를 검토해.
```

도구는 다음 순서로 사용됩니다.

```text
workspace_list
→ workspace_open({ workspace_id: "my-project", access: "write" })
→ repo_search / file_read
→ expected_sha256를 포함한 file_edit
→ command_run
→ git_diff
```

화면 녹화에 바로 사용할 수 있는 작은 예제와 프롬프트는 [examples/demo-project](examples/demo-project)에 있습니다.

## 도구와 권한 프로필

| 도구 | `read` | `full` | 역할 |
| --- | :---: | :---: | --- |
| `workspace_list` | 가능 | 가능 | 등록된 워크스페이스 ID와 사용 가능 여부 확인 |
| `workspace_open` | 읽기만 | 읽기 또는 쓰기 | 짧은 수명의 워크스페이스 세션 생성 |
| `repo_search` | 가능 | 가능 | 워크스페이스 내부를 ripgrep으로 검색 |
| `file_read` | 가능 | 가능 | 범위가 제한된 UTF-8 텍스트와 SHA-256 반환 |
| `git_diff` | 가능 | 가능 | Git을 변경하지 않고 상태와 diff 확인 |
| `file_edit` | — | 쓰기 세션 | 파일 해시를 확인한 뒤 정확한 텍스트 치환 수행 |
| `command_run` | — | 쓰기 세션 | 등록된 argv 또는 명시적으로 허용한 비등록 argv 실행 |

`setup-chatgpt`는 처음부터 파일 수정과 검증을 체험할 수 있도록 기본값이 `full`입니다. 먼저 읽기 전용으로 평가하려면 다음 옵션을 사용하세요.

```bash
npx mcp-local-editor@latest setup-chatgpt /absolute/path/to/project --profile read
```

## 워크스페이스와 명령 정책

새로 설치하면 등록 정보가 기본적으로 사용자 설정 디렉터리에 저장됩니다.

```text
~/.config/mcp-local-editor/workspaces.json
```

`--registry`, `MCP_LOCAL_EDITOR_REGISTRY`, `MCP_LOCAL_EDITOR_HOME`, `XDG_CONFIG_HOME`으로 위치를 바꿀 수 있습니다. 기존 소스 체크아웃에 `workspaces.local.json`이 있다면 하위 호환을 위해 해당 파일을 계속 사용합니다.

워크스페이스를 직접 등록하고 확인하는 명령은 다음과 같습니다.

```bash
mcp-local-editor workspace add \
  my-project \
  /absolute/path/to/my-project \
  --display-name "My Project" \
  --commands commands.local.json

mcp-local-editor workspace list
mcp-local-editor workspace remove my-project
```

실행 가능한 명령은 워크스페이스마다 설정합니다. 프로세스는 워크스페이스 루트에서 시작되며 `shell: false`로 실행됩니다.

```json
{
  "allowUnlistedArgv": false,
  "commands": {
    "test": {
      "description": "Run the project test suite",
      "argv": ["npm", "test"],
      "timeoutSec": 300,
      "maxOutputBytes": 262144
    }
  }
}
```

[commands.example.json](commands.example.json)에서 전체 예시를 볼 수 있습니다. `allowUnlistedArgv`를 `true`로 설정하면 클라이언트가 argv 배열을 직접 전달할 수 있지만, 단일 셸 명령 문자열은 항상 거부됩니다.

## 다른 연결 방식

| 전송 방식 | 명령 | 일반적인 클라이언트 |
| --- | --- | --- |
| ChatGPT 빠른 설정 | `mcp-local-editor setup-chatgpt <root>` | 일반 ChatGPT 웹 대화 |
| stdio MCP | `mcp-local-editor serve` | 로컬 MCP 호스트 |
| Streamable HTTP MCP | `mcp-local-editor-mcp` | 고정 주소를 사용하는 원격 ChatGPT 앱 |
| 인증된 Actions | `mcp-local-editor-actions` | 기존 Custom GPT Actions |

### 로컬 stdio MCP

```bash
mcp-local-editor serve --profile full
```

패키지를 전역 설치한 뒤 사용할 수 있는 클라이언트 설정 예시입니다.

```json
{
  "mcpServers": {
    "local-editor": {
      "command": "mcp-local-editor",
      "args": ["serve", "--profile", "full"]
    }
  }
}
```

### 고정 주소를 사용하는 HTTPS MCP

Named Tunnel이나 별도의 HTTPS 리버스 프록시를 사용하려면 `mcp-local-editor-mcp`를 직접 실행하세요. OAuth authorization code와 PKCE S256, 동적 클라이언트 등록, refresh token 교체, 해시로 저장되는 토큰, 소유자 토큰 승인, Host/Origin 검사를 구현합니다. 자세한 내용은 [docs/chatgpt-mcp.md](docs/chatgpt-mcp.md)를 참고하세요.

### Custom GPT Actions 대체 경로

Actions 어댑터는 같은 서비스를 생성된 OpenAPI 문서와 bearer 인증을 통해 제공합니다. 자세한 내용은 [docs/chatgpt-actions.md](docs/chatgpt-actions.md)를 참고하세요.

### macOS 메뉴 막대

저장소에는 OpenAI Secure MCP Tunnel과 로컬 대시보드를 위한 한국어 메뉴 막대 도우미도 들어 있습니다. 이 방법은 소스 체크아웃 사용자를 대상으로 합니다.

```bash
git clone https://github.com/junjunjunbong/mcp-local-editor.git
cd mcp-local-editor
chmod +x macos/keep-tunnel.sh macos/install-gui.sh
./macos/install-gui.sh
```

## 안전 범위

MCP Local Editor는 워크스페이스 접근을 통제하는 도구이며 운영체제 수준의 샌드박스는 아닙니다.

다음 사항을 강제합니다.

- 등록된 워크스페이스 ID만 사용
- 절대 경로, 상위 경로 탈출, 심볼릭 링크 탈출 거부
- 수명이 짧고 워크스페이스에 귀속된 읽기 또는 쓰기 세션
- 현재 SHA-256과 모호하지 않은 정확한 텍스트가 모두 맞아야 파일 수정
- 임시 파일에 쓴 뒤 원자적으로 이름을 바꾸는 파일 저장
- 읽기 전용 Git 검사만 제공하며 commit과 push 도구는 없음
- 명령 argv 정책, 시간 제한, 출력 제한, 프로세스 종료 처리
- 원격 MCP에서 기본적으로 OAuth 요구
- OAuth 토큰은 해시로 저장하고 로컬 상태 파일은 비공개 권한으로 관리

Docker/VM 격리, 네트워크 격리, 임의의 셸 문자열, 파일 생성·삭제·이동 도구, Git commit/push, 완전 자율 백그라운드 루프는 제공하지 않습니다. 신뢰할 수 있는 폴더와 명령만 등록하세요. ChatGPT의 쓰기 확인 화면과 실행 후 Git diff를 검토해야 합니다.

## 개발

```bash
git clone https://github.com/junjunjunbong/mcp-local-editor.git
cd mcp-local-editor
npm install
npm run check
npm link
```

런타임 의존성은 없습니다. CI는 Node.js 20과 22에서 실행됩니다. 테스트는 경로 제한, 레지스트리 잠금, 세션 격리, 읽기·쓰기 권한, 오래된 해시를 사용한 수정 거부, 명령 실행, stdio MCP, Streamable HTTP MCP, OAuth PKCE, 토큰 교체와 폐기, Actions, 대시보드, 터널 복구, 한 번의 명령으로 수행하는 ChatGPT 설정을 검증합니다.

## 라이선스

[MIT](LICENSE) © 2026 [junjunjunbong](https://github.com/junjunjunbong)
