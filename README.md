# BeAT CLI 2.1

부산교육청 **BeAT** 웹 채팅을 터미널에서 사용하고, 필요하면 **OpenAI Codex CLI 자체를 BeAT 모델 백엔드로 실행**할 수 있게 연결하는 비공식 개인용 CLI입니다.

`beat codex`는 시스템에 `codex`가 없어도 BeAT 전용 Codex를 자동으로 설치합니다. OpenAI 로그인이나 `OPENAI_API_KEY`를 요구하지 않고, BeAT에 실제로 표시되는 모델과 해당 모델의 추론 단계를 읽어 Codex 모델 선택에 사용합니다. 일반 `codex`의 로그인, 설정, 세션, 실행 파일은 건드리지 않습니다.

> 이 프로젝트는 BeAT의 공식 API가 아니라 웹 UI 어댑터입니다. BeAT 화면 구조, 로그인 정책, 모델 제공 범위 또는 사용량 제한이 바뀌면 일부 기능도 영향을 받을 수 있습니다.

## 가장 빠른 시작

### macOS / Linux 자동 설치

`install.sh`는 **Node.js 22가 없어도** 가능한 환경에서는 사용자 전용 Node를 함께 준비하고, BeAT 자체·전용 Codex·Chromium을 사용자 디렉터리에 설치합니다. 일반 `codex`는 덮어쓰지 않습니다.

안전하게 스크립트를 먼저 내려받아 확인한 뒤 실행하는 방법:

```bash
curl -fL https://raw.githubusercontent.com/sampple-korea/beat-cli/main/install.sh -o install-beat.sh
sed -n '1,260p' install-beat.sh
sh install-beat.sh

# 현재 셸에 PATH 즉시 반영
. "$HOME/.local/share/beat-cli/env"

beat login <아이디>
beat codex
```

Linux에서 Chromium 시스템 패키지/공유 라이브러리까지 설치를 허용하려면:

```bash
sh install-beat.sh --with-deps
```

`--with-deps`는 필요할 때 `sudo`를 사용할 수 있습니다. Alpine은 `apk`, Fedora/RHEL 계열은 `dnf`/`yum`, Arch 계열은 `pacman`, openSUSE는 `zypper`, Void는 `xbps-install`, Debian/Ubuntu 계열은 Playwright의 의존성 설치 경로를 사용하도록 대비되어 있습니다. 저장소 추가나 전체 시스템 업데이트는 자동으로 하지 않습니다.

설치 스크립트는 기본적으로 `~/.local/bin/beat` 런처를 만들고 `.profile`, `.bashrc`, `.zshrc` 및 fish `conf.d`에 중복 없는 PATH 설정을 추가합니다. 없는 프로필은 생성하며, `--no-path`로 이 변경을 생략할 수 있습니다. 설치 경로에 공백·작은따옴표가 있어도 처리합니다. `XDG_DATA_HOME` 또는 `BEAT_DATA_HOME`을 바꿨다면 기본 경로 대신 설치 마지막에 출력된 `env` 경로를 사용하세요. **기존의 관리 대상이 아닌 `beat` 명령은 자동 덮어쓰지 않습니다.**

주요 설치 옵션:

```text
--with-deps   Linux 브라우저 시스템 의존성 설치 허용
--no-setup    BeAT만 설치하고 Codex/Chromium 준비는 나중으로 미룸
--no-path     셸 프로필을 수정하지 않음
--force       기존의 비-BeAT beat 런처 교체를 명시적으로 허용
```

이미 이 저장소를 clone한 상태에서 네트워크로 소스를 다시 받지 않고 설치하려면:

```bash
BEAT_SOURCE_DIR="$PWD" sh install.sh
```

### 수동 설치

이미 Node.js 22 이상과 npm이 있다면 저장소를 직접 사용할 수도 있습니다.

```bash
git clone https://github.com/sampple-korea/beat-cli.git
cd beat-cli
npm ci --omit=dev --ignore-scripts

# PATH나 기존 명령을 바꾸지 않고 체크아웃에서 바로 실행
node beat.js setup
node beat.js login <아이디>
node beat.js codex
```

`beat codex` 자체도 전용 Codex가 없으면 자동 설치합니다. Chromium이 없으면 `beat setup`이 준비하고, Linux에서 실행 라이브러리까지 필요한 경우 `beat setup --with-deps`를 사용하면 됩니다.

---

## `beat codex`: BeAT 모델로 Codex 사용

### 동작 방식

`beat codex`를 실행하면 다음 순서로 동작합니다.

1. 현재 OS/CPU에 맞는 `@openai/codex`를 **BeAT 전용 데이터 디렉터리**에 확인합니다.
2. 없으면 검증 가능한 정확한 버전의 Codex를 npm에서 설치하고 실행 파일 버전을 다시 확인합니다.
3. 일반 `~/.codex` 대신 BeAT 전용 `CODEX_HOME`을 사용합니다.
4. `OPENAI_API_KEY`, `OPENAI_BASE_URL`, 일반 Codex 인증 환경변수를 자식 프로세스에 넘기지 않습니다.
5. BeAT 계정에서 현재 사용 가능한 모델과 각 모델의 추론 단계를 읽습니다.
6. 로컬 `127.0.0.1` 임시 포트에 실행마다 새로운 임의 키를 가진 게이트웨이를 엽니다.
7. Codex의 Responses API 요청을 BeAT 웹 채팅으로 전달하고, Codex가 보낸 도구 정의를 BeAT 모델이 사용할 수 있는 엄격한 텍스트 프로토콜로 변환합니다.
8. 모델이 도구 호출을 요청하면 게이트웨이가 이를 실제 Responses API `function_call`/`custom_tool_call`로 변환합니다. **실제 명령 실행·파일 수정은 Codex 클라이언트가 자신의 샌드박스와 승인 정책 안에서 수행**합니다.
9. 실제 도구 실행 결과가 다음 BeAT 요청에 다시 전달되고, 최종 답변이 나올 때까지 Codex의 정상적인 도구 루프가 이어집니다.

따라서 BeAT 모델이 파일을 직접 수정하는 것이 아니라, **BeAT 모델 → 구조화된 tool call → Codex 샌드박스 실행 → 실제 결과 → BeAT 모델** 순서입니다.

### OpenAI 로그인은 필요 없음

```text
beat login <아이디>     ← BeAT 계정 연결에는 필요
codex login             ← beat codex에서는 사용하지 않음
OPENAI_API_KEY          ← beat codex에서는 필요 없음
```

`beat codex login`과 `beat codex logout`은 실수로 일반 OpenAI 인증 상태를 만들지 않도록 차단됩니다.

### 첫 실행에서 모델/추론 단계 선택

TTY에서 저장된 BeAT Codex 설정이 아직 없으면 현재 BeAT 모델 목록을 보여주고 모델과 추론 단계를 선택할 수 있습니다.

```bash
beat codex
```

명시적으로 선택 창을 다시 열려면:

```bash
beat codex --choose
```

한 번만 모델과 추론 단계를 지정하려면:

```bash
beat codex --model sol --reasoning high
beat codex -m terra -r xhigh
```

사용 가능한 추론 단계는 고정값을 억지로 적용하지 않고 **그 모델이 BeAT에서 실제로 광고하는 목록**으로 검증합니다. 예를 들어 어떤 모델이 `low, medium, high`만 제공한다면 `xhigh`를 명시했을 때 오류를 냅니다.

### BeAT Codex 기본값 저장

대화형으로 설정:

```bash
beat codex config
```

자동화/스크립트용:

```bash
beat codex config --model sol --reasoning high --no-prompt
```

확인 및 초기화:

```bash
beat codex config show
beat codex config reset
```

`config reset`은 BeAT Codex의 모델/추론 기본값만 지웁니다. 일반 Codex 설정과 BeAT Codex의 기존 세션은 유지합니다.

### 현재 BeAT 모델 확인

```bash
beat codex models
beat codex models --json
```

마지막으로 정상 조회했던 모델 캐시를 네트워크 없이 보고 싶다면:

```bash
beat codex models --cached
```

캐시는 조회 편의를 위한 것이며, 실제 실행 시에는 현재 계정의 접근 가능 여부를 다시 확인합니다.

### Codex 명령 그대로 전달

BeAT 전용 옵션을 처리한 뒤 나머지는 실제 Codex CLI에 전달합니다.

```bash
beat codex exec "이 저장소의 버그를 찾아 고치고 테스트해줘"
beat codex exec --sandbox workspace-write "테스트를 실행하고 실패를 고쳐줘"
beat codex resume --last
```

`-m/--model`, `-r/--reasoning` 같은 BeAT 래퍼 옵션은 Codex 인자와 함께 써도 자동으로 분리됩니다.

```bash
beat codex -m sol -r high exec --sandbox workspace-write "README를 검토해줘"
```

Codex 자체의 `--` 구분자는 그대로 전달됩니다. 프롬프트가 `-`로 시작할 때도 안전하게 사용할 수 있습니다.

```bash
beat codex exec -- "--search는 여기서는 옵션이 아니라 프롬프트 문자열"
```

다음 종류는 BeAT 전용 경계를 우회할 수 있으므로 차단합니다.

```text
codex login / logout
codex cloud / app
--oss
--local-provider
--search
--remote / --remote-auth-token-env
-c model=...
-c model_provider=...
-c model_providers....=...
-c model_catalog_json=...
-c model_reasoning_effort=...
-c web_search=...
```

다른 공급자나 일반 OpenAI Codex를 사용하려면 평소의 `codex` 명령을 별도로 사용하면 됩니다.

### Codex 설치·업데이트·복구

현재 프로젝트가 검증한 기본 Codex 버전은 `0.153.4`입니다. `beat-cli` 업데이트가 임의로 Codex 버전을 바꾸지 않도록 기본 버전은 고정되어 있습니다.

설치 또는 손상된 전용 설치 복구:

```bash
beat codex install
```

npm에 게시된 최신 Codex를 **사용자가 명시적으로 선택**하여 업데이트:

```bash
beat codex update
```

특정 버전으로 설치/전환:

```bash
beat codex update --codex-version 0.153.4
```

새 버전은 먼저 별도 임시 디렉터리에 설치하고 버전을 검증한 후에만 현재 전용 버전으로 전환합니다. 기존 정상 버전을 먼저 지우지 않습니다.

### Codex 진단

```bash
beat codex doctor
beat codex doctor --json
```

Node 버전, 지원 플랫폼, BeAT 전용 홈 분리 여부, Chromium, 전용 Codex 설치, BeAT 인증 파일 존재 여부를 확인합니다. 실제 BeAT 세션 유효성은 다음으로 확인합니다.

```bash
beat status
```

---

## 일반 `codex`와 설정·인증·세션 분리

기본 경로는 다음과 같습니다.

```text
일반 Codex
  ~/.codex/...

BeAT Codex
  ~/.config/beat-cli/codex/                  전용 CODEX_HOME
  ~/.config/beat-cli/codex/config.toml      전용 Codex 설정
  ~/.config/beat-cli/codex/beat-preferences.json
  ~/.config/beat-cli/codex/beat-models.json
  ~/.config/beat-cli/codex/catalogs/...

BeAT 전용 Codex 실행 파일
  ~/.local/share/beat-cli/codex-runtime/...
```

`XDG_CONFIG_HOME`/`XDG_DATA_HOME`이 있으면 해당 XDG 경로를 따릅니다. 별도 위치가 필요하면 다음 환경변수를 사용할 수 있습니다.

```bash
export BEAT_CODEX_HOME="$HOME/.config/my-beat-codex"
export BEAT_DATA_HOME="$HOME/.local/share/my-beat-cli"
```

안전장치 때문에 `BEAT_CODEX_HOME`을 일반 `~/.codex` 또는 현재 `CODEX_HOME`과 같은 위치로 지정하면 실행을 거부합니다.

`beat codex`가 실행하는 자식 프로세스에서는 일반 OpenAI/Codex 인증 환경변수를 제거하고, 로컬 임시 게이트웨이용 `BEAT_CODEX_API_KEY`만 넣습니다. 일반 Codex의 `auth.json`, `config.toml`, 세션 파일을 읽거나 수정할 필요가 없습니다.

---

## macOS / Linux 호환성

| 환경 | BeAT Codex 자동 설치 | Chromium 준비 | 자동 시작 서비스 |
|---|---|---|---|
| macOS Apple Silicon (arm64) | 지원 | Chrome/Chromium/Edge 또는 Playwright Chromium | LaunchAgent |
| macOS Intel (x64) | 지원 | Chrome/Chromium/Edge 또는 Playwright Chromium | LaunchAgent |
| Linux glibc arm64 | 지원 | Playwright Chromium 또는 시스템 Chromium/Chrome | systemd `--user`가 있으면 지원 |
| Linux glibc x64 | 지원 | Playwright Chromium 또는 시스템 Chromium/Chrome | systemd `--user`가 있으면 지원 |
| Alpine Linux arm64/x64 | Codex 설치 지원 | `beat setup --with-deps`가 `apk`로 Chromium 의존성 준비 | 환경에 따라 `beat service start/run` 사용 |
| Windows arm64/x64 | 지원 | Chrome/Edge/Chromium 또는 Playwright Chromium | 로그인 자동 시작은 미지원, `start/run` 사용 |

Codex 공식 npm 패키지가 현재 제공하는 플랫폼 조합에 맞춰 `darwin/linux/win32`의 `x64/arm64`를 지원합니다.

### “모든 Linux”에 대한 현실적인 범위

일반적인 glibc 기반 배포판과 Alpine을 별도 처리하지만, 임의의 libc/CPU/컨테이너 정책까지 포함한 모든 Linux에서 무조건 실행된다고 보장할 수는 없습니다. 최소 이미지나 특수 배포판에서 Playwright 시스템 라이브러리를 설치할 수 없다면 이미 설치된 Chromium 계열 브라우저를 지정할 수 있습니다.

```bash
export BEAT_CHROMIUM_PATH=/absolute/path/to/chromium
beat codex doctor
```

Linux root 환경에서는 Chromium 자체 제약 때문에 브라우저 샌드박스를 비활성화합니다. 일반 사용자 환경에서는 `chromiumSandbox: true`를 명시합니다. 컨테이너나 사용자 네임스페이스 제한 때문에 Chromium 샌드박스를 시작할 수 없을 때에만 `BEAT_CHROMIUM_NO_SANDBOX=1`을 명시적으로 선택할 수 있습니다. 이 선택은 브라우저 격리를 약화하므로 신뢰할 수 있는 전용 환경에서만 사용하세요. **이 변수는 Codex의 파일/명령 실행 샌드박스를 끄지 않습니다.**

Linux에서는 Codex의 bubblewrap 샌드박스에 필요한 사용자 네임스페이스를 호스트가 허용해야 합니다. Ubuntu의 AppArmor 정책이나 컨테이너 보안 정책이 이를 막으면 모델 연결은 되어도 파일 쓰기/명령 실행은 실패할 수 있습니다. 설치기는 이 문제를 숨기려고 Codex 샌드박스를 끄거나 커널·AppArmor 설정을 자동 변경하지 않습니다. 관리자가 해당 환경에서 Codex 샌드박스를 실행할 수 있도록 호스트 정책을 준비해야 합니다. 이 저장소의 일회용 GitHub Ubuntu CI는 [OpenAI 공식 codex-action의 호스트 준비 방식](https://github.com/openai/codex-action/blob/main/action.yml)을 적용한 환경에서 검증합니다.

Linux에서 소스 체크아웃의 `npm run test:sandbox`를 실행하면 실제 Codex 샌드박스가 **시험 작업 폴더 안의 쓰기는 허용하고 밖의 쓰기는 거부하는지** 확인합니다. 실제 프로젝트나 사용자 설정은 수정하지 않으며, 임시 시험 파일은 종료 시 정리합니다. 호스트 제한으로 실패하면 샌드박스 없는 재시도를 하지 않습니다.

Windows 네이티브 Codex의 파일 쓰기는 Codex 자체의 Windows 샌드박스 설정 상태에도 영향을 받습니다. 이 프로젝트의 Windows 통합 시험은 읽기 전용 도구 왕복을 검증하고, macOS/Linux 시험은 실제 파일 패치를 검증합니다. 같은 결과를 모든 OS/CPU/배포판에서 실행해 확인했다는 의미는 아닙니다.

---

## BeAT 로그인과 세션 자동 갱신

비밀번호 인자를 생략하면 화면에 표시하지 않고 입력받습니다.

```bash
beat login <아이디>
```

로그인 성공 시 기본적으로 세션과 자동 갱신용 계정 정보를 저장합니다.

세션 강제 갱신:

```bash
beat refresh
```

상태 확인:

```bash
beat status
beat status --no-refresh
beat status --json
```

로그아웃:

```bash
# 현재 BeAT 세션만 제거
beat logout

# 세션 + 저장된 자동 갱신용 아이디/비밀번호 제거
beat logout --forget
```

비밀번호를 명령 인자로 직접 넣을 수도 있지만 셸 기록이나 프로세스 목록에 보일 수 있으므로 권장하지 않습니다.

```bash
beat login <아이디> <비밀번호>
```

---

## BeAT 자체 채팅 CLI

Codex 없이 단순 채팅만 사용할 수도 있습니다.

```bash
beat chat "안녕"
beat chat -m sol -r high "이 코드를 설명해줘"
beat chat -c last "방금 답변을 이어서 설명해줘"
beat repl -m sol -r high
```

주요 옵션:

```text
-m, --model <모델>                 sol, terra, luna 또는 실제 chat_* 키
-r, --reasoning <강도>             현재 모델이 지원하는 추론 단계
-c, --continue <UUID|last>         기존 BeAT 대화 이어가기
-a, --attach <경로>                파일 첨부, 반복 가능
-s, --stream                       실시간 출력
-j, --json                         결과 + 메타데이터 JSON
--plain                            Markdown 변환 없이 텍스트
--meta                             대화 ID/모델/추론/시간을 stderr에 표시
--timeout <초>                     응답 제한 시간
--no-refresh                       이번 호출에서 세션 자동 갱신 끄기
--quiet                            진행 메시지 숨기기
```

현재 모델 목록:

```bash
beat models
beat models --json
```

기본 채팅 설정:

```bash
beat config set model chat_gpt5_6_sol
beat config set reasoning_effort xhigh
beat config set timeout_seconds 600
beat config set auto_refresh true
beat config show
beat config reset
```

---

## 파일 입력

이미지는 BeAT 웹 채팅에 원본으로 첨부합니다. 텍스트 문서는 로컬에서 내용을 추출해 프롬프트에 포함합니다.

```bash
beat chat -a screenshot.png "이 오류를 분석해줘"
beat chat -a report.pdf -a data.xlsx "두 파일을 비교해줘"
```

지원 범위:

- PNG/JPEG/GIF/WebP/BMP/TIFF/AVIF: 이미지 원본 첨부
- TXT/Markdown/CSV/JSON/XML/YAML/소스 코드: 텍스트 읽기
- PDF: `pdftotext`를 사용할 수 있으면 텍스트 추출
- DOCX/XLSX/XLSM/PPTX 및 ODT/ODS/ODP/EPUB/RTF: 지원 가능한 로컬 변환 경로 사용

스캔 이미지뿐인 PDF는 별도 OCR이 필요합니다. 오래된 바이너리 DOC/XLS/PPT와 오디오 입력은 지원하지 않습니다.

---

## OpenAI 호환 로컬 게이트웨이

BeAT를 OpenAI SDK와 연결해야 할 때 별도 로컬 서비스를 실행할 수 있습니다.

```bash
beat service start
beat service status
beat service test
beat service logs --lines 200
beat service stop
```

기본 주소:

```text
http://127.0.0.1:12124/v1
```

API 키와 URL 확인:

```bash
beat service key
beat service url
```

키 교체:

```bash
beat service key --rotate
```

설정 변경은 재시작과 함께 적용하는 것을 권장합니다.

```bash
beat service restart --host 127.0.0.1 --port 12124 --concurrency 2
beat service restart --max-upload-mb 100 --max-input-chars 200000
```

`beat service start/stop/restart`는 root systemd에 의존하지 않고 사용자 프로세스로 동작합니다. 포그라운드 실행은:

```bash
beat service run
```

### 로그인 시 자동 시작

macOS:

```bash
beat service enable
# ~/Library/LaunchAgents/net.sampple.beat-cli.plist 사용

beat service disable
```

Linux에서 systemd user session이 있는 경우:

```bash
beat service enable
# ~/.config/systemd/user/beat-openai.service 사용

beat service disable
```

파일만 생성하려면:

```bash
beat service install
```

systemd user session이 없는 Linux/컨테이너에서는 자동 시작 대신 `beat service start` 또는 프로세스 관리자의 `beat service run`을 사용하면 됩니다.

### 외부 바인딩 주의

기본값은 loopback 전용입니다. 다음처럼 `0.0.0.0` 등에 바인딩하면 Bearer API 키만으로 접근 가능한 HTTP 서비스가 네트워크에 노출됩니다.

```bash
beat service restart --host 0.0.0.0
```

외부 공개 시에는 TLS 리버스 프록시, 방화벽/보안그룹, API 키 보호를 반드시 별도로 구성하세요.

---

## SDK 예시

환경변수:

```bash
export OPENAI_BASE_URL="$(beat service url)"
export OPENAI_API_KEY="$(beat service key)"
```

Node.js:

```js
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const response = await client.responses.create({
  model: 'chat_gpt5_6_sol',
  reasoning: { effort: 'high' },
  input: '안녕',
});

console.log(response.output_text);
```

Python:

```python
from openai import OpenAI

client = OpenAI()
response = client.responses.create(
    model="chat_gpt5_6_sol",
    reasoning={"effort": "high"},
    input="안녕",
)
print(response.output_text)
```

### 구현된 주요 엔드포인트

| 메서드 | 경로 | 기능 |
|---|---|---|
| GET | `/health`, `/v1/health` | 인증 없는 상태 확인 |
| GET | `/v1/models`, `/v1/models/{id}` | BeAT 모델 목록/조회 |
| POST | `/v1/responses` | 일반/스트리밍 Responses |
| GET/DELETE | `/v1/responses/{id}` | 저장된 응답 조회/삭제 |
| GET | `/v1/responses/{id}/input_items` | 응답 입력 항목 조회 |
| POST | `/v1/responses/input_tokens` | 근사 입력 토큰 수 |
| POST | `/v1/chat/completions` | Chat Completions 어댑터 |
| POST | `/v1/completions` | 레거시 텍스트 완료 어댑터 |
| POST/GET | `/v1/files` | 파일 업로드/목록 |
| GET/DELETE | `/v1/files/{id}` | 파일 정보/삭제 |
| GET | `/v1/files/{id}/content` | 파일 원본 읽기 |
| POST/GET/DELETE | `/v1/conversations...` | 로컬 대화/항목 관리 |

### 도구 호출 호환성

`Responses API`의 `function`/`custom` 도구와 Codex가 사용하는 namespace 도구를 받아 BeAT 모델에 엄격한 텍스트 호출 프로토콜로 전달합니다. 모델 응답은 다음 단계에서 검증합니다.

- 요청에 실제로 등록된 도구인지 확인
- 함수 인자를 JSON Schema로 검증
- `tool_choice=required`/지정 도구/병렬 호출 정책 확인
- 불완전하거나 잘못된 제어 JSON이면 아무 도구도 실행하지 않고 오류 반환
- 실제 도구 결과의 `call_id`와 내용을 다음 모델 요청에 보존
- SSE에서는 제어 JSON 원문을 일반 텍스트처럼 흘리지 않고 typed tool-call 이벤트로 변환

중요한 한계가 있습니다. BeAT 자체가 네이티브 OpenAI tool-calling API를 제공하는 것이 아니므로, **도구 호출 결정은 모델이 텍스트 프로토콜을 정확히 따를 때만 성공**합니다. 프로토콜을 따르지 않거나 잘못된 인자를 생성하면 게이트웨이가 실행을 거부합니다.

Codex의 호스팅 `web_search`는 이 어댑터에서 지원하지 않으므로 `beat codex`에서는 비활성화합니다. 로컬 셸/파일 도구 등 Codex 클라이언트가 실제로 광고하는 도구는 위 브리지로 왕복할 수 있습니다.

샘플링 파라미터처럼 BeAT 웹 UI에 전달할 수 없는 값은 일부 호환 요청에서 수락하더라도 실제 생성에 반영되지 않을 수 있으며 `x_beat.warnings`에 표시합니다. 토큰 사용량은 근삿값이며 `x_beat.usage_estimated=true`입니다.

게이트웨이의 SSE는 연결 유지 이벤트를 먼저 보내고, 모델 답변을 완성·검증한 뒤 텍스트 또는 도구 이벤트를 보냅니다. 현재 게이트웨이는 답변 토큰을 생성 즉시 전달하는 네이티브 스트리밍을 제공하지 않습니다. `beat chat --stream`의 웹 화면 부분 답변 출력과는 구분됩니다.

입력이 설정한 문자 수 제한을 넘으면 최신 요청이나 도구 스키마를 잘라내지 않고 HTTP 413을 반환합니다. Codex 모델 목록의 32,768 토큰 컨텍스트 값은 어댑터의 보수적 운영 예산이며, BeAT 기저 모델의 실제 컨텍스트 한도를 측정한 값이 아닙니다. 호스팅 웹 검색, 서버 측 background 작업, 원격 compaction 등 모든 OpenAI 기능을 대체하지는 않습니다.

`store: false`는 **이 게이트웨이의 응답/완료 기록** 저장을 생략합니다. 이미 업로드한 파일, 명시적으로 지정한 로컬 conversation, Codex 자체 세션 또는 BeAT 웹 서비스에 생성되는 대화까지 삭제한다는 의미는 아닙니다. 소스 코드와 도구 출력은 BeAT로 전송되므로 비밀 키·학생 개인정보·비공개 자료는 전송 허용 범위를 먼저 확인하세요.

---

## 저장 경로와 보안

기본 설정/상태:

```text
~/.config/beat-cli/session.json             BeAT 세션
~/.config/beat-cli/credentials.json         자동 갱신용 BeAT 아이디/비밀번호
~/.config/beat-cli/config.json              일반 beat chat 기본값
~/.config/beat-cli/service.json             서비스 주소와 Bearer 키
~/.config/beat-cli/service-process.json     실행 중 서비스 신원 확인 정보
~/.config/beat-cli/service.log              서비스 로그
~/.config/beat-cli/api/state.json           API 상태 인덱스
~/.config/beat-cli/api/files/                업로드 파일
~/.config/beat-cli/codex/                    BeAT 전용 Codex HOME
```

POSIX 환경에서는 민감 파일을 `600`, 디렉터리를 `700`으로 작성합니다. 상태 파일은 원자적으로 교체하고, API 상태 변경은 프로세스 간 잠금을 사용합니다.

`credentials.json`의 BeAT 비밀번호는 자동 갱신을 위해 로컬 파일에 저장되며 별도 암호화 저장소를 사용하지 않습니다. 해당 사용자 계정의 파일에 접근할 수 있는 프로세스/관리자는 읽을 수 있으므로 OS 계정과 홈 디렉터리 권한을 보호하세요. 필요 없으면:

```bash
beat logout --forget
```

`beat codex`의 임시 API 키는 실행할 때마다 새로 만들며 loopback 게이트웨이에만 사용합니다. 일반 OpenAI API 키는 요구하거나 저장하지 않습니다.

---

## 문제 해결

전체 진단:

```bash
beat doctor
beat codex doctor
beat status
```

Chromium 문제:

```bash
beat setup
beat setup --with-deps        # Linux 시스템 라이브러리까지 필요한 경우
```

직접 브라우저 지정:

```bash
BEAT_CHROMIUM_PATH=/absolute/path/to/chromium beat codex
```

BeAT 모델이 바뀌었는지 확인:

```bash
beat models
beat codex models
```

Codex 전용 설치 복구:

```bash
beat codex install
```

상세 오류 스택이 필요한 개발/디버깅 상황:

```bash
BEAT_DEBUG=1 beat chat "시험"
BEAT_DEBUG=1 beat codex exec "현재 저장소를 확인해줘"
```

---

## 개발 및 검증

개발 의존성까지 설치:

```bash
npm ci
```

정적 구문 검사와 단위/회귀 테스트:

```bash
npm run check
npm test
```

macOS/Linux 사용자 설치기의 경로 quoting·반복 설치·실패 롤백·자격 증명 보존을 검증하는 스모크 테스트:

```bash
npm run test:install
```

실제 Codex 바이너리 + 실제 HTTP/SSE + 가짜 BeAT 런타임을 연결해 도구 왕복을 검증하는 스모크 테스트:

```bash
npm run test:codex
```

이 테스트는 학교 계정이나 OpenAI 계정을 사용하지 않고도 다음을 확인합니다.

- BeAT 전용 Codex 자동 설치/버전 확인
- 일반 Codex `config.toml`/`auth.json`이 변경되지 않음
- BeAT 모델명과 추론 단계가 실제 Codex 요청까지 유지됨
- Codex가 광고한 실제 도구가 BeAT 브리지를 거쳐 호출됨
- 실제 도구 실행 결과가 다음 모델 턴에 다시 전달됨
- macOS/Linux에서는 실제 `apply_patch` 파일 수정까지 검증
- Windows에서는 안전한 read-only 실제 Codex 도구 왕복 검증

POSIX 설치기 검증:

```bash
npm run test:install
# Node가 없는 상황도 공식 배포판 다운로드/체크섬 검증으로 시험
BEAT_SMOKE_BOOTSTRAP_NODE=1 npm run test:install
```

설치 시험은 격리한 HOME과 공백/따옴표가 포함된 경로를 사용합니다. 반복 설치, 기존 계정 파일 보존, 설치 실패 시 이전 런처 유지, 다른 프로그램의 `beat` 명령 덮어쓰기 방지도 확인합니다.

GitHub Actions는 **Ubuntu, macOS, Windows**에서 구문·회귀·실제 Codex 도구 루프를 검사하고, Ubuntu/macOS에서는 브라우저 준비와 POSIX 설치기도 시험합니다. 실제 실행된 OS/Node 조합과 성공 여부는 저장소 Actions 실행 결과에서 확인하세요.

통합 시험의 BeAT 응답은 결정적인 가짜 백엔드를 사용합니다. 실제 BeAT 계정으로 로그인하고 모델이 도구 프로토콜을 따르는지까지 확인하려면 `beat status`, `beat codex models`, `beat codex exec`를 실제 계정에서 실행해야 합니다. 자동 시험 통과만으로 BeAT의 현재 웹 UI/계정별 모델 접근까지 검증되었다고 간주하지 않습니다.

의존성 보안 확인:

```bash
npm audit --omit=dev
```

---

## 주요 명령 빠른 참고

```text
beat setup [--with-deps]                Codex/Chromium 준비 및 실행 점검
beat login <아이디>                     BeAT 로그인
beat status                             BeAT 세션 확인

beat codex                              BeAT 모델 기반 Codex 실행/자동 설치
beat codex --choose                     모델/추론 다시 선택
beat codex -m sol -r high               모델/추론 즉시 지정
beat codex config                       전용 기본값 설정
beat codex models                       모델/추론 목록
beat codex doctor                       전용 환경 진단
beat codex install                      전용 Codex 설치/복구
beat codex update                       최신 Codex 명시적 업데이트

beat chat ...                           간단한 단발 BeAT 채팅
beat repl ...                           이어지는 BeAT 대화형 셸
beat models                             BeAT 모델 목록
beat history                            최근 BeAT 대화
beat files ...                          로컬 호환 API 파일 관리

beat service start|run|stop|restart     OpenAI 호환 게이트웨이 실행 관리
beat service status|logs|test           게이트웨이 진단
beat service key|url                    SDK 연결 정보
beat service enable|disable|install     로그인 자동 시작 설정

beat logout                             BeAT 세션 삭제
beat logout --forget                    저장된 BeAT 계정 정보까지 삭제
```
