[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md)

# Codex RouteSync

**저장된 Codex 계정과 Responses 호환 API 제공자를 매끄럽게 전환하고, 두 모드에서 로컬 대화 기록을 함께 사용하며, 선택 항목별 로컬 토큰 사용량을 확인할 수 있습니다.**

Codex RouteSync는 한 번의 보호된 전환 작업에서 자격 증명과 제공자 라우팅을 함께 업데이트합니다. 계정 모드와 호환 API 제공자 모드는 같은 로컬 기록 저장소를 사용하므로 Codex 인증 방식을 바꿔도 새 대화가 서로 다른 타임라인으로 나뉘지 않습니다.

VS Code 확장은 편집기 영역에 그래픽 대시보드를 열어 현재 모드, 공유 기록 상태, 계정 할당량 재설정 시각, 전체 로컬 토큰 사용량을 보여 줍니다. 저장된 계정과 API 제공자는 하나의 평면 라우트 목록에 함께 표시됩니다. 토큰 상세에는 소스별 도넛 차트가 있고, 주황색 기록 차트는 로컬 관측값을 일, 주, 월 단위로 묶습니다. 대시보드는 VS Code 표시 언어를 따르거나 영어와 중국어 간체를 즉시 전환할 수 있습니다.

## 사용 화면

활동 표시줄에서 **Codex RouteSync**를 열면 저장된 계정과 API 제공자가 같은 계층에 놓인 평면 **Accounts & API Routes** 목록이 표시되고 대시보드가 자동으로 열리거나 포커스를 받습니다. 계정과 API 관리는 라우트 목록에서 하고, 할당량, 재설정 시각, 자동 전환, 로컬 토큰 기록은 넓은 대시보드에서 확인합니다.

![영어 어두운 테마의 Codex RouteSync 대시보드](./assets/screenshots/dashboard-en-dark.png)

같은 대시보드를 중국어 간체로 즉시 전환할 수 있습니다.

![중국어 간체 밝은 테마의 Codex RouteSync 대시보드](./assets/screenshots/dashboard-zh-light.png)

Codex RouteSync는 Windows, macOS, Linux에서 실행되며 VS Code 또는 명령줄에서 사용할 수 있습니다.

[![GitHub 릴리스](https://img.shields.io/github/v/release/ShawBob001/codex-routesync)](https://github.com/ShawBob001/codex-routesync/releases)
[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-install-007ACC)](https://marketplace.visualstudio.com/items?itemName=ShawBob001.codex-routesync)
[![라이선스: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## 두 가지 모드, 하나의 로컬 대화 기록

```text
Codex 계정 모드  <->  Codex RouteSync  <->  Responses API 제공자 모드
                               |
                       CODEX_HOME의 공유 기록
```

| 기능 | RouteSync의 동작 |
| --- | --- |
| 계정과 API 전환 | 선택한 계정 자격 증명 또는 API 제공자 프로필을 해당 Codex 설정과 함께 적용합니다 |
| 공유 대화 기록 | 하나의 Codex 기록 저장소를 사용해 새 로컬 스레드를 두 모드에서 모두 볼 수 있게 합니다 |
| 로컬 토큰 사용량 | Codex rollout 카운터를 로컬에서 색인하고 일별, 주별, 월별 활동을 차트로 표시하며 저장된 계정 또는 API 제공자별 사용량을 집계합니다 |
| 상태 보존 | 다음 모드를 적용하기 전에 현재 계정 또는 제공자의 자격 증명을 저장합니다 |
| 안전한 전환 | 동시에 요청된 전환을 순서대로 처리하고 인증 데이터를 원자적으로 기록하며 롤백용 백업을 보관합니다 |
| 다시 로드 처리 | Codex 확장이 새 인증 상태를 읽어야 할 때 기본적으로 작업을 방해하지 않는 다시 로드 동작을 표시합니다 |

> 공유 대화 기록은 하나의 `CODEX_HOME` 안에서만 적용됩니다. ChatGPT 웹 기록, Codex Cloud 작업, 커넥터, 할당량 또는 기기 간 대화 기록을 복사하거나 병합하지 않습니다.

## 빠른 시작

### VS Code 확장

[Visual Studio Marketplace 페이지](https://marketplace.visualstudio.com/items?itemName=ShawBob001.codex-routesync)에서 확장을 설치하거나 VS Code의 확장 보기에서 `Codex RouteSync`를 검색하세요.

오프라인으로 설치하려면 [GitHub Releases](https://github.com/ShawBob001/codex-routesync/releases)에서 최신 `.vsix`를 내려받은 다음 **Extensions: Install from VSIX...**를 실행합니다. 터미널에서는 아래 명령을 사용할 수 있습니다. VERSION을 내려받은 파일 이름의 버전으로 바꾸세요.

```bash
code --install-extension codex-routesync-VERSION.vsix
```

#### 이전 Marketplace 버전에서 이전하기

이전 Marketplace 버전에서 Codex SwitchBridge를 설치했다면 먼저 이전 설치를 열고 동기화 또는 클라우드에 있는 모든 계정과 API 제공자를 **Local**로 이동하세요. 그런 다음 이전 설치를 비활성화하거나 제거하고 **Developer: Reload Window**를 실행한 뒤 위 링크에서 Codex RouteSync를 설치하고 저장소 암호를 다시 입력하세요.

설정된 `CODEX_HOME`의 계정, API 제공자, 구성 파일, 백업, 공유 기록은 그대로 사용할 수 있고 기존 `codex-switchbridge.*` 설정도 계속 적용됩니다. 두 버전은 확장 ID가 다르므로 이전 설치의 `globalState`, `SecretStorage`, 저장된 라우트별 사용량 귀속 정보는 자동으로 이전되지 않습니다.

활동 표시줄에서 **Codex RouteSync** 보기를 엽니다. 평면 **Accounts & API Routes** 목록은 저장된 계정과 API 제공자를 사이드바의 같은 디렉터리에 배치합니다. 대시보드는 중앙 편집기 영역에서 자동으로 열리거나 다시 앞으로 이동합니다. 제목 표시줄의 **Open Dashboard** 동작도 예비 진입점으로 남아 있습니다.

### CLI

GitHub 릴리스의 CLI tarball을 설치합니다.

```bash
npm install --global ./codex-switchbridge-cli-0.3.0.tgz
codex-switchbridge --version
```

npm에 게시된 뒤에는 같은 패키지를 레지스트리에서 설치할 수 있습니다.

```bash
npm install --global codex-switchbridge-cli
```

## 계정과 API 제공자 전환

VS Code에서는 **Switch Account** 또는 **Switch API Provider**를 사용합니다. RouteSync가 현재 선택을 저장하고 `auth.json`과 `config.toml`을 업데이트한 뒤 계정 및 제공자 보기를 새로 고칩니다.

CLI 사용 예:

```bash
# 저장된 Codex 계정으로 전환
codex-switchbridge use work

# 저장된 Responses 호환 API 제공자로 전환
# 공유 로컬 기록은 기본으로 활성화됨
codex-switchbridge mode team-api

# 호환성을 위해 필요한 경우 제공자별 기록 유지
codex-switchbridge mode team-api --separate-history
```

이름이 지정된 계정으로 돌아가려면 `codex-switchbridge use <name>`을 사용합니다. `mode account`가 저장된 계정을 정확히 하나 찾으면 해당 계정을 복원합니다. 저장된 계정이 여러 개라면 CLI는 임의로 선택하지 않고 `use <name>`으로 선택하라고 안내합니다.

API 제공자 프로필은 `auth.json`에 쓸 인증 페이로드와 `config.toml`에 쓸 제공자 설정을 저장합니다. 공유 기록에는 `wire_api = "responses"`와 올바른 제공자 `base_url`이 필요합니다.

## 편집기 대시보드, 할당량 재설정 시각, 로컬 토큰 사용량

VS Code 대시보드는 현재 `CODEX_HOME` 아래의 로컬 Codex rollout 파일에서 계정 할당량 메타데이터와 누적 `token_count` 이벤트를 읽습니다. 다음 정보를 표시합니다.

- 계정 서비스가 반환한 모든 할당량 창의 남은 비율. 5시간, 7일, 이름이 지정된 제한을 포함합니다.
- 사용 가능한 각 할당량 재설정의 초 단위 실시간 카운트다운
- 초와 시간대 오프셋을 포함한 같은 재설정 시각의 현지 시간
- 제공된 경우 밀리초까지 포함하는 정확한 원본 UTC 타임스탬프
- 계정 서비스가 제공하는 경우 사용 가능한 적립형 속도 제한 재설정 횟수
- 현재 계정에 적립된 재설정이 있을 때 확인 후 실행하는 **Use one reset** 동작
- 기록된 전체, 입력, 출력, 캐시 입력, 추론 출력 토큰
- 귀속된 합계와 귀속되지 않은 합계
- 계정 및 API 제공자별 사용량과 세션 수
- 서로 겹치지 않는 계정, API 제공자, 미귀속 합계를 비교하는 소스별 도넛 차트
- 소스와 날짜로 필터링할 수 있는 주황색 일별, 주별, 월별 사용량 차트
- 선택 범위의 합계, 평균, 최고값, 예상 사용량
- 색인 범위, 세션 수, 추적 시작 시각, 마지막 새로 고침 시각

재설정 시계는 할당량 서비스가 반환한 절대 타임스탬프를 우선 사용합니다. 상대 카운트다운만 제공되면 RouteSync가 조회 시점에 해당 타임스탬프를 계산합니다. 누락되었거나 잘못되었거나 이미 지난 재설정 메타데이터는 명확히 표시됩니다. 카운트다운은 시스템 시계에서 다시 계산되며 대시보드 전체를 새로 고치지 않아도 갱신됩니다. 계정 할당량 요청과 OAuth 토큰 새로 고침은 먼저 `codex-switchbridge.proxy`, 다음으로 VS Code의 `http.proxy`, 마지막으로 확장 호스트의 `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` 환경 변수를 사용합니다. 환경 변수 해석은 계속 `NO_PROXY`를 따릅니다. 전용 설정은 기기 범위이며 Settings Sync에서 제외됩니다. VS Code가 이 값을 로컬 설정에 저장하므로 인증이 필요 없는 로컬 프록시를 사용하거나 URL에 자격 증명이 있다면 기기 설정 파일을 보호하세요.

대시보드 머리글의 언어 선택기에서 **Auto**, **English**, **简体中文**을 선택할 수 있습니다. Auto는 VS Code 표시 언어를 따릅니다. 명시적으로 선택한 값은 창 설정에 저장되며 VS Code를 다시 로드하지 않아도 적용됩니다.

재설정 동작은 공식 Codex App Server 메서드를 사용합니다. 같은 저장 계정이 여전히 활성 상태인지 확인하고 사용자에게 승인을 요청한 뒤, 멱등성 키를 사용해 적립된 재설정을 최대 한 번만 소모하고 할당량을 새로 고칩니다. 설치된 Codex 버전이 재설정 소모를 지원하지 않으면 RouteSync가 공식 Usage 페이지를 대신 엽니다.

기록된 합계는 입력과 출력으로 구성됩니다. 캐시 입력은 이미 입력에, 추론 출력은 이미 출력에 포함되어 있으므로 이 두 값은 다시 더하지 않습니다. 도넛 차트는 서로 겹치지 않는 귀속 소스 합계만 사용하므로 캐시 입력이나 추론 출력을 두 번 계산하지 않습니다.

선택 항목별 귀속은 RouteSync가 로컬 추적을 시작한 뒤부터 적용됩니다. 이후 색인은 Codex가 토큰 증가분을 기록했을 때 활성 상태였던 계정 또는 API 제공자에 그 증가분을 귀속합니다. 하나의 대화가 모드 전환을 거쳐 이어지는 경우도 같습니다. 이전의 공유 `openai` 세션은 특정 저장 항목에 안전하게 귀속할 수 없으므로 **Earlier or unattributed** 아래에 남습니다. 이전 제공자 태그 세션은 제공자 ID가 저장된 프로필 하나에만 대응할 때만 귀속됩니다.

계정 서비스는 남은 비율을 제공하며 절대적인 남은 토큰 수는 제공하지 않습니다. 기록 차트는 기기의 로컬 활동 카운터이며 청구, 비용 또는 원격 잔액 데이터가 아닙니다. 날짜를 정확히 정할 수 없는 이전 색인 활동은 예상치로 표시되고 신뢰할 수 있는 날짜가 없는 활동은 차트에서 제외됩니다. API 제공자 프로필은 해당 제공자가 호환 할당량 API를 제공하지 않는 한 로컬 카운터만 표시합니다. RouteSync는 rollout 내용을 업로드하지 않습니다. 로컬 색인은 카운터, 타임스탬프, 파일 지문, 불투명 ID만 저장하며 대화 텍스트, 경로, 계정 레이블, 제공자 이름, 자격 증명은 저장하지 않습니다. 즉시 다시 색인하려면 **Refresh Local Token Usage**를 사용하세요. 그렇지 않으면 일반적인 백그라운드 유지 관리 중에 새로 고칩니다.

## 대화 기록을 계속 볼 수 있는 원리

Codex는 일반적으로 모델 제공자별로 로컬 스레드를 묶습니다. 사용자 지정 제공자 ID를 사용하면 파일이 그대로 있어도 계정 모드로 돌아왔을 때 스레드가 사라진 것처럼 보일 수 있습니다.

RouteSync는 새 스레드가 분리되지 않도록 합니다.

1. 계정 모드는 Codex에 내장된 `openai` 제공자를 사용합니다.
2. Responses 호환 API 제공자는 같은 기록 ID를 유지하고 RouteSync가 해당 API 키와 기본 URL을 적용합니다.
3. 계정으로 돌아가면 계정 자격 증명과 원래 OpenAI 라우트를 복원합니다.

따라서 두 모드는 같은 `CODEX_HOME`에서 같은 로컬 대화 기록을 읽습니다. RouteSync는 기록 색인에 쓰는 라우트를 동기화하며 전환할 때마다 대화 텍스트를 복사하지 않습니다.

VS Code 확장과 호환 CLI 제공자 전환에서는 공유 기록이 기본으로 활성화됩니다. VS Code에서는 `codex-switchbridge.shareHistoryAcrossProviders`로 제어할 수 있습니다.

### 이전 제공자 태그 스레드 복구

공유 라우팅 전에 만든 스레드는 제공자별 ID를 계속 사용할 수 있습니다. 이를 공유 로컬 기록에 포함하려면 다음과 같이 진행합니다.

1. 진행 중인 Codex 출력을 중지합니다.
2. **Codex RouteSync: Repair Shared Conversation History**를 실행합니다.
3. 복구가 끝나면 상태 표시줄의 **Reload recommended** 동작을 사용합니다.

복구 명령은 백업을 만들고 제공자 ID 필드만 변경하며 JSONL 및 SQLite 레코드를 검증합니다. 검사 중 rollout이 바뀌면 중단합니다. 확장 활성화 과정에서는 기록을 다시 쓰지 않습니다. Python 3은 이 유지 관리 명령에만 필요합니다.

정확한 범위와 안전 검사는 [모드 간 대화 기록](./docs/shared-history.md)을 참고하세요.

## 기능

- VS Code에서 로컬 또는 동기화된 Codex 계정과 API 제공자 원클릭 전환
- 저장된 계정과 API 제공자가 같은 계층에 놓이는 평면 사이드바 라우트 목록
- CLI 명령 하나로 계정과 API 제공자 전환
- Responses 호환 제공자 라우트의 로컬 대화 기록 공유
- 그래픽 할당량, 정확한 재설정 시계, 적립형 재설정 사용, 소스별 도넛 차트, 필터링 가능한 일별, 주별, 월별 로컬 토큰 기록을 갖춘 넓은 편집기 대시보드
- 실행 중 영어와 중국어 간체 대시보드 전환, 현지화된 VS Code 명령 및 설정
- 계정 할당량 표시, 토큰 새로 고침, 순환 백그라운드 유지 관리
- 저장된 계정과 제공자의 로컬 저장 또는 VS Code Settings Sync 저장
- 저장된 인증 데이터의 선택적 암호화
- 저장된 계정 가져오기 및 내보내기
- 백업을 먼저 수행하는 이전 제공자 태그 로컬 스레드 복구
- 창 간 전환 잠금과 롤백 스냅샷

## CLI 명령

| 명령 | 설명 |
| --- | --- |
| `codex-switchbridge add <name>` | `codex login`을 실행하고 결과를 이름이 지정된 계정으로 저장합니다 |
| `codex-switchbridge list` | 저장된 계정과 API 제공자를 나열합니다 |
| `codex-switchbridge use <name>` | 저장된 계정으로 전환하고 계정 모드를 복원합니다 |
| `codex-switchbridge mode [name]` | 현재 모드를 표시하거나 기본적으로 공유 기록을 사용하는 API 제공자로 전환합니다 |
| `codex-switchbridge mode <name> --separate-history` | 제공자별 로컬 기록을 사용하는 API 제공자로 전환합니다 |
| `codex-switchbridge remove <name>` | 저장된 계정을 제거합니다 |
| `codex-switchbridge quota [name]` | 계정 할당량 사용량을 표시합니다 |
| `codex-switchbridge current` | 현재 계정 또는 API 제공자 모드를 표시합니다 |
| `codex-switchbridge refresh [name]` | 계정 액세스 토큰을 새로 고칩니다 |
| `codex-switchbridge export [file]` | 저장된 계정을 JSON으로 내보냅니다 |
| `codex-switchbridge import <file>` | JSON 파일에서 저장된 계정을 가져옵니다 |

저장 항목을 기본 Codex 디렉터리 밖에 두려면 `--auth-dir <path>` 또는 `CODEX_SWITCHBRIDGE_AUTH_DIR`을 사용합니다. 암호화된 항목을 잠금 해제하려면 `--password` 또는 `CODEX_SWITCHBRIDGE_PASSWORD`를 사용합니다.

## VS Code 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `codex-switchbridge.language` | `auto` | VS Code를 따르거나 대시보드에서 영어 또는 중국어 간체를 사용합니다 |
| `codex-switchbridge.proxy` | `""` | 계정 할당량 요청과 OAuth 토큰 새로 고침을 위한 기기 전용 HTTP(S) 프록시입니다. Settings Sync에서 제외됩니다. 빈 값은 VS Code와 확장 호스트의 프록시 설정을 사용합니다 |
| `codex-switchbridge.shareHistoryAcrossProviders` | `true` | 계정 모드와 호환 API 제공자 모드에서 새 로컬 대화 기록을 함께 사용할 수 있게 합니다 |
| `codex-switchbridge.reloadWindowAfterSwitch` | `statusBar` | 전환 뒤 다시 로드 동작을 표시하거나, 알림을 보내지 않거나, 자동으로 다시 로드합니다 |
| `codex-switchbridge.quotaRefreshInterval` | `30` | 각 간격마다 저장된 계정 하나를 확인해 토큰 유지 관리와 할당량 새로 고침을 수행합니다 |
| `codex-switchbridge.tokenAutoUpdate` | `true` | 저장된 계정 토큰이 만료되었거나 곧 만료될 때 백그라운드 유지 관리 중 새로 고칩니다 |
| `codex-switchbridge.showStatusBar` | `true` | 현재 선택, 할당량, 토큰 사용량, 다시 로드 권장을 상태 표시줄에 표시합니다 |
| `codex-switchbridge.authDirectory` | `""` | 로컬 저장 항목을 이 디렉터리에 보관합니다. 빈 값은 기본 Codex 디렉터리를 사용합니다 |

## 데이터 및 전환 안전성

로컬 계정은 `auth_{name}.json`, 로컬 API 제공자는 `provider_{name}.json`을 사용합니다. VS Code는 암호화된 항목을 동기화된 확장 저장소에 보관할 수도 있습니다.

전환이 활성 `auth.json`을 덮어쓰기 전에 RouteSync는 전환 전 계정 또는 제공자의 최신 자격 증명을 해당 저장 항목에 다시 기록합니다. 그런 다음 하나의 프로세스 간 잠금 안에서 인증, 제공자 라우팅, 공유 기록 라우트 상태를 업데이트합니다. 인증 파일은 원자적으로 교체되며 전환에 실패하면 스냅샷을 복원합니다.

할당량 조회와 로컬 토큰 색인은 읽기 전용입니다. 토큰을 교체하거나 저장된 인증을 다시 쓰거나 대화 파일을 수정하지 않습니다. 토큰 유지 관리는 별도 작업입니다.

일부 Codex 도구는 시작할 때 인증을 캐시합니다. RouteSync는 다른 확장 프로세스에 이 캐시를 버리도록 강제할 수 없습니다. 따라서 파일 전환에 성공한 후에도 VS Code 창을 다시 로드해야 할 수 있습니다. 기본 동작은 팝업을 반복해서 표시하는 대신 상태 표시줄에 권장 사항을 남깁니다.

**Codex Account Switch**와 Codex RouteSync를 동시에 실행하지 마세요. 두 확장 모두 같은 로컬 Codex 파일을 씁니다.

## 개발

```bash
npm install
npm run build
npm run verify
```

대시보드 시각 테스트에는 Playwright Chromium과 Linux 시스템 종속 항목도 필요합니다.

```bash
npx playwright install --with-deps chromium
npm run test:visual -w packages/vscode
```

`/etc/fonts/fonts.conf`가 없는 최소 Linux 이미지에서는 `FONTCONFIG_FILE`과 `FONTCONFIG_PATH`로 올바른 Fontconfig 구성을 제공해야 합니다. 그렇지 않으면 Chromium이 텍스트를 측정하거나 렌더링할 수 없습니다.

프로젝트 구조:

```text
packages/
  core/     공유 인증, 제공자 및 기록 라우팅, 할당량, 저장소 로직
  cli/      명령줄 인터페이스
  vscode/   VS Code 확장
scripts/    기록 유지 관리 및 릴리스 도우미
docs/       아키텍처, 동작, 배포 문서
```

릴리스 절차는 [배포](./docs/deployment.md)에 설명되어 있습니다.

## 출처 및 라이선스

Codex RouteSync는 [jqknono/codex-account-switch](https://github.com/jqknono/codex-account-switch)에서 파생된 독립 오픈 소스 프로젝트이며 `ShawBob001`가 상당 부분을 수정했습니다.

[MIT License](./LICENSE)에 따라 배포됩니다. 원본 프로젝트의 저작권 고지와 라이선스 본문은 유지됩니다.
