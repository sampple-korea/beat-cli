# Direct Line 전송과 BeAT Codex 검증

2.2는 브라우저 입력창 조작을 기본 전송 경로에서 제거합니다.
`playwright-core`의 HTTP request 기능만 사용하며 로그인·모델 조회·CLI·API·Codex 실행에는 Chromium 바이너리가 필요하지 않습니다.
기존 브라우저 함수는 웹 동작 비교 진단용으로 남아 있습니다.

## 요청 경로

1. 교육디지털원패스의 정상 로그인 HTTP 흐름으로 인증하고 BeAT 세션 쿠키만 저장합니다.
2. 인증된 채팅 페이지에서 모델 메타데이터를 읽고 활성 모델 설정으로 필터링합니다.
3. 웹 클라이언트와 같은 사용량 검증 및 대화 생성 액션을 호출합니다.
4. 대화 세션을 준비하고 페이지의 Direct Line 연결 정보를 읽습니다.
5. Direct Line에 메시지를 전송하고 완료 응답을 수신합니다.
6. API 요청의 도구 정의에 맞춰 응답을 검증한 뒤 Responses/Chat Completions 형식으로 반환합니다.

세션 쿠키와 Direct Line 토큰은 서로 다른 HTTP context에서 처리합니다.
토큰·비밀번호를 로그에 남기지 않습니다. 쿠키·계정 파일은 기존 600 권한 정책을 유지합니다.
기존 로그인 세션을 그대로 읽으며 만료 시 저장된 계정으로 HTTP 갱신합니다.
서버 액션 식별자는 현재 페이지에서 발견한 값을 사용합니다. 초기 페이지에 없는 4개 지연 로딩 액션은 웹 클라이언트 요청과 대조한 식별자를 사용하므로 사이트 업데이트 때 유지보수가 필요할 수 있습니다.

## Codex 도구와 시스템 지침

API 모드는 `new_assistant_enabled=false`를 요청합니다. 호출자의 시스템·개발자·사용자 역할, 도구 정의, 실제 호출 ID와 결과를 텍스트 프로토콜로 전달합니다.
BeAT 내장 코드 실행 대신 클라이언트 도구만 요청하도록 지시합니다.
BeAT의 대화 세션 생성 자체는 필수입니다. 생략하면 정상 답변 대신 “이전 대화 내용을 불러오지 못했습니다”라는 응답이 발생하는 것을 실서비스에서 확인했습니다.

함수 도구 인자는 JSON Schema로 검증하며 custom 도구의 원시 문자열과 줄바꿈을 보존합니다.
namespace, 지정 도구, 필수 호출, 병렬 호출 여부를 처리합니다.
이미지를 포함한 도구 결과도 콘텐츠 배열로 보존하여 `view_image` 응답이 텍스트 JSON으로 변하는 문제를 수정했습니다.
SSE 도구 응답은 전체 JSON을 검증한 뒤 typed add/delta/done 이벤트로 전송합니다.
실제 파일 수정·명령 실행·실행 승인·샌드박스는 Codex 클라이언트가 담당합니다.

네이티브 OpenAI system/tools 파라미터를 BeAT 모델 제공자까지 그대로 전달하는 API는 확인되지 않았습니다.
따라서 이 변경은 텍스트 기반 호환 계층이며 BeAT 서버 지침이나 내장 기능의 완전한 제거를 보장하지 않습니다.
`x_beat.warnings`에 `system_messages_emulated_from_text`, 도구 사용 시 `tool_calls_emulated_from_text`를 표시합니다.
호스팅 web search, 원격 compaction, 오디오, 모든 최신 Codex 도구 형식의 완전한 지원은 주장하지 않습니다.
지원하지 않는 도구 형식과 잘못된 인자는 오류로 반환합니다.

## 검증

2026-09-13 KST, Linux x64, Node.js 22, Codex 0.153.4, BeAT GPT-5.6 Sol / low:

- 웹사이트 정상 로그인과 웹 채팅, HTTP 로그인 및 직접 채팅 응답.
- 같은 대화의 이전 답변을 기억하는 CLI 이어가기.
- 실제 Codex가 임시 Git 프로젝트를 읽고 계산 → apply_patch 파일 생성 → exec_command 재검증.
- 실제 비동기 exec_command 실행과 write_stdin 세션 결과 수신.
- OpenAI SDK의 시스템 지침 우선 적용, tool_choice none/required/지정 함수.
- 한글·줄바꿈·따옴표가 포함된 함수 인자.
- Responses SSE, namespace 함수와 custom patch의 병렬 호출.
- previous_response_id 및 실제 call_id를 사용한 도구 결과 후속 처리.
- 설치기의 공백·따옴표 경로, 반복 설치, 계정 보존, 설치 실패 후 이전 런처 유지.

재현 명령:

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run test:codex
npm run test:install
beat login <아이디>
BEAT_LIVE_TEST=1 npm run test:live-api
BEAT_LIVE_TEST=1 npm run test:live-codex
```

실서비스 시험은 기존 로그인으로 모델 요청을 보냅니다. 계정 사용량과 BeAT 대화 기록이 발생합니다.
테스트 계정의 아이디·비밀번호는 소스에 포함하지 않습니다.
Android 저장소는 코드 참고만 했으며 앱·에뮬레이터 실행이나 수정은 하지 않았습니다.
