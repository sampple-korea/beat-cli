# BeAT CLI 및 OpenAI 호환 게이트웨이

부산교육청 BeAT 웹 서비스를 터미널과 OpenAI SDK에서 사용할 수 있게 연결하는
개인용 도구입니다. 교육디지털원패스 학생 로그인을 자동화하고, BeAT 웹 채팅을
헤드리스 Chromium으로 제어합니다.

이 프로그램은 BeAT의 공식 API가 아니라 웹 UI 어댑터입니다. BeAT 화면 구조가
바뀌거나 계정 정책·사용량 제한이 적용되면 동작이 달라질 수 있습니다.

## 설치

현재 서버에서는 `/root/beat-cli`에 설치되어 있고 `/usr/local/bin/beat`가
실행 파일을 가리킵니다. Rocky Linux 계열 서버에서 새로 설치할 때는 Node.js
18 이상을 준비한 뒤 다음을 실행합니다.

```bash
dnf install -y chromium poppler-utils unzip
cd /root/beat-cli
npm ci --omit=dev
chmod 755 beat.js server.js
ln -sfn /root/beat-cli/beat.js /usr/local/bin/beat
beat --version
```

호환성 자체를 공식 Node OpenAI SDK로 시험하려면 개발 의존성까지 설치합니다.

```bash
npm ci
npm run check
```

## 빠른 시작

```bash
# 비밀번호는 화면에 표시되지 않으며 세션과 함께 저장됩니다.
beat login <아이디>

# 매번 새 BeAT 대화가 만들어집니다.
beat chat 안녕

# 모델과 추론 강도 선택
beat chat -m sol -r xhigh "이 코드를 검토해줘"

# 최근 대화 이어가기 또는 특정 UUID 이어가기
beat chat -c last "아까 답을 표로 바꿔줘"
beat chat -c <conversation-uuid> "계속해줘"

# 한 프로세스에서 계속 대화
beat repl -m terra -r high
```

비밀번호를 명령 인자로도 줄 수 있지만 셸 기록과 프로세스 목록에 노출될 수
있으므로 프롬프트 입력을 권장합니다.

```bash
beat login <아이디> <비밀번호>
```

## 주요 CLI 명령

```text
beat login <아이디> [비밀번호]     학생 계정 로그인 및 세션 저장
beat refresh                       저장된 자격 증명으로 세션 강제 갱신
beat chat [옵션] <메시지>          질문할 때마다 기본적으로 새 대화
beat repl [옵션]                   이어지는 대화형 셸
beat models [--json]               현재 계정에서 보이는 모델 실시간 조회
beat history [--limit N]           최근 BeAT 대화 UUID 조회
beat files upload|list|info|delete 로컬 호환 API 파일 관리
beat status [--no-refresh]         로그인 확인, 기본값은 필요 시 자동 갱신
beat logout                        세션만 삭제하고 자동 갱신 정보는 유지
beat logout --forget               세션과 저장된 아이디·비밀번호 모두 삭제
beat config show|set|reset          기본 채팅 설정 관리
beat doctor                        설치·권한·로그인·서비스 진단
```

`beat chat` 옵션:

```text
-m, --model <모델>                 sol, terra, luna 또는 chat_gpt... 키
-r, --reasoning <강도>             none|minimal|low|medium|high|xhigh
-c, --continue <UUID|last>         기존 대화 이어가기
-a, --attach <경로>                파일 첨부, 여러 번 지정 가능
-s, --stream                       답변을 생성되는 대로 출력
-j, --json                         답변·대화 ID·모델 등의 JSON 출력
--plain                            Markdown 변환 없이 일반 텍스트
--meta                             대화 ID와 실행 정보를 stderr에 표시
--timeout <초>                     응답 제한 시간
--no-refresh                       이번 호출에서 자동 로그인 갱신 금지
--quiet                            진행 메시지 숨김
```

기본 설정은 다음처럼 변경합니다.

```bash
beat config set model chat_gpt5_6_sol
beat config set reasoning_effort xhigh
beat config set timeout_seconds 600
beat config set auto_refresh true
beat config show
```

## 파일 입력

이미지는 BeAT에 원본 첨부하고, 문서는 로컬에서 텍스트를 추출하여 질문에
포함합니다.

```bash
beat chat -a screenshot.png "이 오류를 설명해줘"
beat chat -a report.pdf -a data.xlsx "두 파일의 핵심을 비교해줘"
```

지원 경로:

- PNG, JPEG, GIF, WebP, BMP, TIFF, AVIF: BeAT 원본 이미지 첨부
- TXT, Markdown, CSV, JSON, XML, YAML, 소스 코드: UTF-8 텍스트 입력
- PDF: `pdftotext`로 텍스트 추출
- DOCX, XLSX/XLSM, PPTX: Open XML 내용 추출
- ODT, ODS, ODP, EPUB, RTF: 텍스트 변환

스캔만 들어 있는 PDF에는 OCR이 필요하며, 오래된 바이너리 DOC/XLS/PPT와
오디오 입력은 지원하지 않습니다. API로 업로드한 원본 파일은 변환 여부와
무관하게 그대로 보관·조회·삭제할 수 있습니다.

## OpenAI 호환 백그라운드 서비스

```bash
beat service start
beat service status
beat service logs
beat service restart
beat service stop
```

기본 주소는 `http://127.0.0.1:12124/v1`입니다. 서비스는 systemd에서
백그라운드 실행되고 실패 시 재시작됩니다. 부팅 때 자동 시작하려면 별도로
활성화합니다.

```bash
beat service enable
beat service disable
```

API 키와 기본 URL:

```bash
beat service key
beat service url

export OPENAI_BASE_URL=http://127.0.0.1:12124/v1
export OPENAI_API_KEY="$(beat service key)"
```

키가 노출됐으면 교체합니다. 실행 중이면 자동으로 재시작됩니다.

```bash
beat service key --rotate
```

바인드 주소, 포트, 동시 Chromium 작업 수와 파일 제한을 바꿀 수 있습니다.

```bash
beat service restart --host 127.0.0.1 --port 12124 --concurrency 2
beat service restart --max-upload-mb 100 --max-input-chars 200000
```

`--host 0.0.0.0`은 모든 인터페이스에 공개합니다. 이 경우 API 키, 서버
방화벽, NAVER Cloud 인바운드 규칙, TLS 프록시를 반드시 별도로 구성해야
합니다. 기본 설정은 외부에 공개하지 않습니다.

## SDK 사용 예

Node.js:

```js
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: 'http://127.0.0.1:12124/v1',
});

const response = await client.responses.create({
  model: 'chat_gpt5_6_sol',
  reasoning: { effort: 'xhigh' },
  input: '안녕',
});

console.log(response.output_text);
```

Python:

```python
from openai import OpenAI

client = OpenAI(
    api_key="발급된 beat 서비스 키",
    base_url="http://127.0.0.1:12124/v1",
)

completion = client.chat.completions.create(
    model="chat_gpt5_6_sol",
    messages=[{"role": "user", "content": "안녕"}],
)
print(completion.choices[0].message.content)
```

스트리밍도 OpenAI SDK의 일반적인 `stream: true` 방식으로 사용할 수 있습니다.

## 구현된 호환 엔드포인트

| 메서드 | 경로 | 기능 |
|---|---|---|
| GET | `/health`, `/v1/health` | 인증 없는 상태 확인 |
| GET | `/v1/models`, `/v1/models/{id}` | 실시간 BeAT 모델 목록·조회 |
| POST | `/v1/chat/completions` | 일반 및 SSE 채팅 완료 |
| GET/DELETE | `/v1/chat/completions/{id}` | 로컬 완료 기록 조회·삭제 |
| POST | `/v1/responses` | 일반 및 Responses SSE |
| GET/DELETE | `/v1/responses/{id}` | 로컬 응답 조회·삭제 |
| GET | `/v1/responses/{id}/input_items` | 응답 입력 항목 조회 |
| POST | `/v1/responses/input_tokens` | 근사 입력 토큰 수 |
| POST | `/v1/completions` | 레거시 텍스트 완료 어댑터 |
| POST/GET | `/v1/files` | multipart 파일 업로드·목록 |
| GET/DELETE | `/v1/files/{id}` | 파일 정보 조회·삭제 |
| GET | `/v1/files/{id}/content` | 원본 파일 내려받기 |
| POST/GET/DELETE | `/v1/conversations...` | 대화와 항목 생성·조회·수정·삭제 |

OpenAI Files API에서 받은 `file_id`는 Responses와 Chat Completions의
`input_file`/`file` 콘텐츠에서 사용할 수 있습니다. Base64 data URL과
HTTP(S) `file_url`/`image_url`도 지원합니다.

### 대화 상태

- `beat chat` 및 상태 지정 없는 API 호출은 매번 새 BeAT 대화입니다.
- Chat Completions는 표준처럼 `messages` 전체를 새 대화에 전달합니다.
- 비표준 확장 `conversation_id`에 BeAT UUID를 주면 이어갈 수 있습니다.
- Responses의 `previous_response_id`는 앞 응답의 BeAT 대화를 이어갑니다.
- Conversations API ID를 Responses의 `conversation`에 주면 해당 대화를
  이어갑니다.
- `previous_response_id`와 `conversation`은 동시에 사용할 수 없습니다.

### 호환성 한계

- BeAT 웹 화면이 제공하는 텍스트·이미지 채팅 기능을 어댑트합니다.
- 도구 정의(`tools`)는 모델에게 설명으로 전달하지만, 실제 함수 실행과
  구조화된 tool call 반환은 하지 않습니다. 강제 `tool_choice=required`는
  명시적 오류를 반환합니다.
- `temperature`, `top_p`, penalty, seed 등 BeAT 화면에 없는 샘플링 값은
  수락하지만 전달하지 않습니다.
- `n=1`만 지원합니다.
- 토큰 사용량은 UTF-8 바이트 길이로 계산한 근삿값이며 응답의
  `x_beat.usage_estimated`가 `true`입니다.
- 임베딩, 음성, 이미지 생성, 비디오, Batch, Fine-tuning 엔드포인트는
  구현하지 않았습니다.
- 어댑터 세부 정보와 실제 BeAT 대화 UUID는 `x_beat` 필드에 들어갑니다.

## 세션 자동 갱신과 보안

로그인 성공 시 다음 정보를 저장합니다.

```text
~/.config/beat-cli/session.json       BeAT 세션
~/.config/beat-cli/credentials.json   자동 갱신용 아이디·비밀번호
~/.config/beat-cli/config.json        CLI 기본 설정
~/.config/beat-cli/service.json       서비스 주소와 Bearer API 키
~/.config/beat-cli/api/state.json     API 파일·대화·응답 인덱스
~/.config/beat-cli/api/files/         업로드 원본
```

디렉터리는 권한 `700`, 비밀 정보와 상태 파일은 `600`으로 유지됩니다. 다만
`credentials.json`에는 사용자의 요청에 따라 아이디와 비밀번호가 암호화되지
않은 형태로 저장됩니다. 이 VM의 root 권한을 가진 주체는 읽을 수 있으므로
서버 접근 권한을 엄격히 관리해야 합니다. 완전히 삭제하려면 다음을 실행합니다.

```bash
beat logout --forget
```

각 CLI/API 요청 전에 세션을 확인합니다. 세션이 없거나 만료되면 프로세스 간
잠금으로 중복 로그인을 막고, 저장된 학생 계정 정보로 새 세션을 발급한 뒤
원래 작업을 계속합니다. 응답 도중 만료되거나 Chromium이 종료된 경우 한 번
복구하여 재시도합니다.

## 문제 해결

```bash
beat doctor
beat status
beat refresh
beat service status
beat service logs --lines 200
```

BeAT 화면 변경을 추적할 때만 상세 스택을 표시합니다.

```bash
BEAT_DEBUG=1 beat chat "시험 메시지"
```
