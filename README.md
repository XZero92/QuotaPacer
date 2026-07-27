# QuotaPacer

QuotaPacer는 Codex CLI가 보고하는 현재 계정의 남은 사용량을 작은 데스크톱 오버레이로 보여주는 비공식 크로스 플랫폼 앱입니다. Windows, macOS, Linux를 대상으로 하며, 현재 MVP는 사용량 표시와 수동 새로고침에 집중합니다.

> 이 프로젝트는 OpenAI의 공식 제품이 아닙니다. Codex 인증 정보나 토큰을 직접 읽지 않고, 사용자가 설치하고 로그인한 Codex CLI의 app-server 인터페이스만 사용합니다.

제품 원칙, 확정된 기술·UX 결정과 후속 계획은 [프로젝트 방향성](docs/PROJECT_DIRECTION.md)에 정리되어 있습니다.

## 현재 기능

- `small` 152×56 캡슐 안의 원형 게이지, `middle` 280×72 바 게이지, `large` 360px 폭의 계획 비교·소진 예측 카드
- 오버레이 우클릭과 트레이 메뉴에서 크기 모드 전환
- app-server가 반환한 제한 창을 개수나 슬롯 의미를 가정하지 않고 표시
- 300분은 `5시간`, 10080분은 `주간`, 나머지는 실제 지속시간으로 동적 표기
- 남은 비율이 가장 낮은 창을 대표 창으로 선택
- 모든 실제 제한 창의 최근 최대 24시간 속도 또는 기간 평균에 기반한 예상 소진 시각 표시
- 7일 제한 창의 균등·요일별 배분 계획과 실제 사용률·현재 권장선을 비교하는 bullet gauge
- 현재부터 초기화까지 예상 소진 위치를 보여주는 forecast timeline
- 계획 초과와 초기화 전 소진 위험의 인라인 경고, 사용자가 켠 경우에만 OS 알림
- 60초 주기 갱신 및 `account/rateLimits/updated` 이벤트 후 500ms 디바운스 갱신
- 오류나 연결 끊김 시 마지막 성공 값을 유지하고 업데이트 지연을 표시하며 재연결
- 크기·창 위치·페이스 설정 저장, 모니터 작업 영역 보정, 트레이 표시/숨기기·새로고침·CLI 경로 선택·종료
- 트레이·우클릭 메뉴의 `페이스 설정`에서 계획, 알림 권한, 최근 이력 삭제 관리

현재 범위에는 자동 시작, 캐릭터 애니메이션, 장기 사용량 기록·차트, 앱 내부 로그인, CLI 번들링이 포함되지 않습니다.

## 요구 사항

- Node.js 20 이상과 npm
- Rust stable 1.77.2 이상
- Codex CLI 0.144.6 이상 권장
- ChatGPT 계정으로 로그인된 Codex CLI

Codex CLI가 없거나 로그인하지 않았다면 먼저 설치 및 로그인을 완료합니다.

```sh
codex --version
codex login
```

CLI 0.144.6보다 낮아도 app-server 초기화와 필수 메서드가 정상 동작하면 앱은 계속 사용합니다. 버전 번호는 안내 기준이며, 실제 호환성은 `initialize`, `account/read`, `account/rateLimits/read` 호출 결과로 판정합니다.

## 개발 실행

```sh
npm install
npm run tauri dev
```

플랫폼별 Tauri 개발 의존성은 [Tauri 사전 준비 문서](https://v2.tauri.app/start/prerequisites/)를 참고하세요. Linux에서는 WebKitGTK와 AppIndicator 개발 패키지가 추가로 필요합니다.

## 검사와 빌드

```sh
npm run typecheck
npm run lint
npm test
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri build
```

실제 로그인된 로컬 CLI에 대한 수동 통합 검사는 다음 명령으로 실행합니다.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib connects_to_installed_codex_cli -- --ignored --nocapture --test-threads=1
```

## 구조

```text
src/                  React 오버레이 UI, 표시 규칙, 프런트 테스트
src-tauri/src/codex.rs
                      CLI 탐지, JSONL app-server 클라이언트, 재연결
src-tauri/src/usage.rs
                      rate-limit 응답 정규화와 대표 창 선택
src-tauri/src/pace.rs
                      단기 이력, 소진 예측, 계획선과 경고 판정
src-tauri/src/settings.rs
                      CLI 경로, 창 위치와 페이스 설정
src-tauri/fixtures/   실제 응답 형태를 보존한 회귀 fixture
```

백엔드는 다음 순서로 app-server를 시작합니다.

1. `initialize` 요청 (`clientInfo.name = quota_pacer`)
2. `initialized` 알림
3. `account/read`
4. `account/rateLimits/read`

`rateLimitsByLimitId`가 비어 있지 않으면 이를 우선하고, 아니면 단일 `rateLimits`를 사용합니다. 각 bucket의 `primary`와 `secondary`는 서로 독립된 창이며 null은 생략합니다. 따라서 주간 창 하나만 반환되면 주간 행 하나만 표시하며, 존재하지 않는 5시간 placeholder를 만들지 않습니다.

## CLI 탐지 순서

1. 사용자가 선택해 저장한 경로
2. `CODEX_CLI_PATH`
3. 현재 프로세스의 `PATH`
4. Windows의 `where.exe` 또는 Unix 로그인 셸의 `command -v`

Windows에서는 npm `.cmd`·`.bat`, PowerShell `.ps1`, 네이티브 `.exe`를 실행할 수 있습니다. 접근이 제한될 수 있는 WindowsApps 별칭이나 extensionless POSIX shim보다 실행 가능한 npm `.cmd`를 우선합니다.

## 데이터와 개인정보

앱은 Codex 인증 토큰과 계정 이메일을 읽거나 저장하지 않습니다. 소진 속도 예측을 위해 제한 창 식별자·리셋 시각·사용률·관측 시각과 알림 중복 방지 상태만 `pace-history.json`에 최대 25시간 보존합니다. `페이스 설정`에서 언제든 최근 이력을 삭제할 수 있습니다. 그 밖에는 사용자가 지정한 CLI 경로, 오버레이 크기·위치와 페이스 설정을 저장합니다. API Key나 지원하지 않는 인증 방식은 별도 상태로 안내하며 앱 내부 로그인은 제공하지 않습니다.

## 플랫폼 참고 사항

- Windows와 macOS에서는 투명한 프레임리스 창 및 트레이 동작을 지원합니다. macOS 투명 창에는 Tauri의 private API 옵션을 사용하므로 현재 구성 그대로는 Mac App Store 배포 대상이 아닙니다.
- Linux X11과 Wayland는 데스크톱 환경에 따라 항상 위, 포커스, 투명도, 전역 창 위치 동작이 다를 수 있으므로 배포 전에 수동 검증이 필요합니다.
- 다중 모니터 또는 DPI 구성이 바뀌면 저장된 위치를 현재 모니터 작업 영역 안으로 보정합니다.
- OS 알림 권한과 표시 방식은 플랫폼별로 다릅니다. 현재 Windows에서 구현하며 macOS·Linux의 실제 권한 요청과 알림 중복 억제는 배포 전에 수동 검증해야 합니다.
