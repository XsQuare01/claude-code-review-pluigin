---
name: code-review-fast
description: Use when the user wants a faster, shorter code review that reports only the defects that break users, data, security, builds or contracts. One read-only sub-agent applies a compressed rule document, the common severity rules and the correctness criteria in a single pass.
---

# Fast Code Review

짧고 빠른 코드 리뷰 모드. `/code-review`와 달리 숫자 prefix 상세 모듈을 로드하지 않고, **압축 규칙(`fast.md`)·공통 규칙(`00-rule.md`)·정확성 기준(`correctness.md`)** 을 **단일 sub-agent** 가 한 번에 적용한다. 모듈별 fan-out·교차검증·도구 실행이 없어 지연이 짧고, 큐 포화(queue saturation)·tail latency·timeout이 우려될 때 적합하다.

빠른 이유는 **덜 넓게 보는 것**이지 **덜 정확하게 보는 것**이 아니다. 등급은 다른 워크플로우와 같은 두 축(영향도 × 확신도)으로 정하고, 출력은 영향이 낮은 지적을 생략해서 줄인다.

## 핵심 원칙

1. **영향이 높은 결함은 빠짐없이 낸다.** 같은 파일에 독립적인 결함이 둘이면 둘 다 낸다. 개수 상한 때문에 확인된 결함을 버리지 않는다
2. **영향이 낮은 지적은 내지 않는다.** 이름·길이·스타일·일관성처럼 `00-rule.md`의 닫힌 다섯 항목(사용자 오동작·데이터 손상·보안 노출·빌드/테스트 실패·계약/복구 경로 파손) 중 어느 것도 지목하지 못하는 지적은 사실이어도 생략한다. 지적이 적다고 그런 지적으로 빈자리를 채우지 않는다
3. **규칙 위반만 보지 않는다.** 변경이 의도한 동작을 관련 경로에서 실제로 하는지(`correctness.md`)를 같은 패스에서 본다
4. **확인하지 못한 것은 확인하지 못했다고 쓴다.** 영향이 높을 수 있지만 확인하지 못한 것은 `확인 필요`로, 이 리뷰가 보지 않은 범위는 `판정`에 남긴다. 지적이 0개라는 사실로 승인을 암시하지 않는다

**왜 이렇게 바뀌었나.** 2.27.0까지의 fast는 리뷰어에게 `fast.md` 하나만 넘겼다. 등급을 정하는 규칙(`00-rule.md`)이 없으니 리뷰어는 규칙 옆의 고정 이모지를 그대로 썼고, 모호한 이름·20줄 넘는 함수·매직 넘버가 권한 우회와 같은 🔴이 됐다. 파일마다 하나만 내게 해서 같은 파일의 두 번째 결함은 버려졌다. 규칙 목록과 맞춰 볼 뿐 변경이 의도대로 동작하는지는 묻지 않아, 잘못된 조건·뒤집힌 분기·틀린 필드 매핑처럼 들어갈 규칙이 없는 버그가 빠졌다. 리뷰 전에 lint를 기다리게 하고는 그 결과를 리뷰어에게도 리포트에도 넘기지 않았고, 지적이 0개면 판정에 승인 문구를 적었다. 이 넷은 `validate-rules.mjs`의 `fast-review` 검사가 막는다.

## 공통 계약

`RULES_DIR` 해석, 범위 결정, 제외 경로, 실행 안전, 리포트 저장, 실패 보고는 **`$RULES_DIR/workflow-contract.md`** 를 따른다. 아래는 이 워크플로우의 차이다.

| 항목 | 이 워크플로우 |
|------|---------------|
| `workflow-name` | `fast` |
| 모듈 집합 | `$RULES_DIR/fast.md` 단일 문서 + correctness (숫자 prefix 상세 모듈 미로드, 공통 규칙 `00-rule.md` 함께) |
| 분할 방식 | 단일 sub-agent |
| 출력 밀도 | 영향 높음 지적 전부와 `확인 필요` — 영향 낮음은 생략, 개수 상한 없음 |
| 도구 실행 | 기본으로 돌리지 않는다 — `도구 실행 결과`에 그 사실을 적는다 |
| 실행 타임라인 | C-9 — preflight가 시작을 남기고, 리뷰어 한 번의 시작·끝과 리포트 쓰기를 단계마다 남긴다. 리포트 `실행 타임라인`에 `--summary` 표를 싣는다 |

이 워크플로우는 **legacy producer workflow**다. `workflow-contract.md`의 ownership matrix에서 legacy로 유지되며, C-6A의 structured lifecycle은 여기 적용하지 않는다. 기존 producer 계약을 유지한다.

`fast.md` 안의 섹션별 적용 조건(RSC·Tailwind·SSR·React 19·서버 코드·contract 제공자 등)은 계약 C-3과 같은 기준으로 판정한다. 조건이 성립하지 않는 섹션은 적용하지 않는다.

상세/포괄적 리뷰가 필요하면 `/code-review-full`을 쓴다.

## 실행 절차

### Step 0: 리포트 자리와 기록 시작

**명령을 부르기 전에 리포트 자리(`$REPORT_DIR`)와 이름(`$REPORT_BASENAME`)부터 정한다(C-7).** 자리는 사용자가 이번 요청에서 정한 곳 → 사용자·프로젝트 지시 파일(전역 포함 `CLAUDE.md`·`AGENTS.md`)에 적힌 문서 저장 위치 → `./review-reports/` 순서로 정하고, 대상 저장소의 루트는 안 된다. 이름은 `code-review-fast-{브랜치}-{날짜}`다. 단계마다 남기는 기록(`.timing/`)이 이 자리 아래에 생기므로, 나중에 리포트만 다른 곳에 쓰면 기록과 리포트가 서로를 못 찾는다.

**리뷰의 첫 명령은 preflight다(C-9).** 이 스크립트가 시작 기록(`run.start`)과 범위 기록(`scope.done`)을 남기고, 리뷰 기준(`base`·`merge-base`)을 정한다.

```bash
node "$RULES_DIR/../scripts/review-preflight.mjs" --dir "$REPORT_DIR" --run "$REPORT_BASENAME" --rules "$RULES_DIR" --workflow fast [--base <사용자가 정한 base>] --host <harness 이름>
```

- `--base`는 사용자가 범위를 정했을 때만 준다. 주지 않으면 지금 브랜치의 열린 PR의 base가 기준이다 — 다른 PR 위에 쌓은 PR이면 아래 PR의 브랜치이고, 그 위에 더한 변경만 리뷰한다
- 출력의 `merge-base`가 `$MERGE_BASE`, `base` 줄(기준과 이유)이 리포트의 기준 줄이다. `base` 줄에 `PR #N`이 있으면 Step 2의 의도는 그 PR에서 읽는다. `실행 ID`는 리포트 `리뷰 기준`에 옮긴다. 작업 트리에 커밋하지 않은 변경이 있다고 나오면 그 사실도 `리뷰 기준`에 적는다
- 종료 코드 2면 아무것도 쓰지 않고 멈춘 것이다. 리뷰 대상이 없으면(변경이 전부 테스트·mock이거나 검토 안 함) 출력의 사유를 사용자에게 알리고 끝낸다 — 리뷰어를 띄우지 않고 리포트도 쓰지 않는다(C-5). PR의 base를 이 저장소에서 찾을 수 없으면 main으로 물러서지 않고 `git fetch origin <base>` 뒤 다시 돌리거나 사용자에게 범위를 묻는다
- 종료 코드 1은 기록을 남기지 못한 것이다. 리뷰는 계속하고 리포트 `실행 타임라인`에 그 사실을 적는다

**기록은 단계를 지날 때마다 바로 남긴다.** 시각과 경과는 스크립트가 만든다 — 시각을 문장으로 적지 않는다. 기록 명령은 모두 이 모양이다(값에 공백이 있으면 따옴표로 감싼다).

```bash
node "$RULES_DIR/../scripts/review-timeline.mjs" --dir "$REPORT_DIR" --run "$REPORT_BASENAME" --phase <단계> --set key=value
```

이 워크플로우가 남기는 단계는 `run.start`·`scope.done`(preflight) → `module.start`·`module.done`·`dispatch.end`(Step 3) → `render.start`·`render.wrote`·`run.end`(Step 5)다. 리뷰어가 쓴 시간이 `module.start`와 `module.done` 사이로, 범위 확인과 의도 수집에 쓴 시간이 `scope.done`과 `module.start` 사이로 나온다. 기록 실패는 리뷰 실패가 아니다 — 남기지 못했으면 그 사실을 리포트에 적고 계속한다.

### Step 1: Diff 범위 결정

범위 결정은 `workflow-contract.md` C-4를 따른다. 기준은 Step 0의 preflight가 정한 `$MERGE_BASE`다. 결정된 범위로 `git diff --stat $MERGE_BASE..HEAD`와 `git diff $MERGE_BASE..HEAD`를 확인한다. 제외 경로는 C-5를 따른다 — 범위는 `node "$RULES_DIR/../scripts/review-scope.mjs" --repo . --merge-base $MERGE_BASE`로 가른다. 출력의 `files`가 `{CHANGED_FILES}`, `outside`(React 규칙이 다루지 않는 언어)는 검토 안 함이다. 다시 세지 않고, `line`을 리포트 `리뷰 기준`의 `> **범위**:` 줄에 그대로 옮긴다(C-5). preflight와 같은 이름 규칙으로 세므로 수는 preflight의 `리뷰 파일` 줄과 같다. 변경이 있는데 `files`가 비는 범위는 preflight가 이미 멈췄다(Step 0).

**diff는 여기서 오케스트레이터가 한 번만 수집한다.** `git diff $MERGE_BASE..HEAD` 출력 전체가 Step 3 producer 프롬프트의 `{DIFF}`가 된다. producer는 git을 돌리지 않는다 — 셸이 없는 에이전트로 띄우기 때문이다(Step 3, C-6). 삭제된 파일의 옛 내용도 이 diff의 `-` 줄에 들어 있다. 제외 경로는 `{CHANGED_FILES}`와 지적 범위에서만 빼고, `{DIFF}`에는 테스트 파일 변경까지 그대로 담는다 — 테스트는 지적 대상에서 빠질 뿐 증거에서 빠지지 않는다(C-5).

### Step 2: 변경 의도 수집

정확성 판정의 근거인 의도를 오케스트레이터가 한 번 모아 `{INTENT}`로 넘긴다. 출처를 첫 줄에 적는다 — 리뷰어는 출처에 따라 의도를 정본으로 쓸지 추정으로 쓸지 정한다(`correctness.md` "무엇을 근거로 의도를 정하는가").

1. Step 0의 preflight `base` 줄에 `PR #N`이 있으면 `gh pr view <N> --json title,body`(읽기만 한다)의 제목과 설명. 출처는 `PR #<번호> 설명`
2. PR이 없거나 설명이 비었으면, 사용자가 이번 요청에서 변경의 목적을 적었을 때 그 문장. 출처는 `사용자 요구`
3. 둘 다 없으면 `git log --format='%s%n%n%b' $MERGE_BASE..HEAD`의 커밋 메시지. 출처는 `커밋 메시지(의도 추정)`
4. 셋 다 없으면 `없음`

### 도구 실행 (기본: 하지 않음)

fast는 lint·typecheck·test를 돌리지 않는다. 예전에는 리뷰 전에 lint를 돌렸지만, 그 결과가 리뷰어에게도 리포트에도 가지 않아 지연만 늘렸다. 리포트의 `도구 실행 결과`에는 실행하지 않았다고 적는다.

사용자가 도구 결과를 원하면 리뷰와 별개로 돌린다. `00-rule.md` 00-9대로 수정 옵션 없이(`--fix`·`--write` 금지) 변경 파일 범위로 돌리고, 모노레포면 `review-scope.mjs`의 `packageRoots` 폴더에서 돌린다 — 저장소 루트에 `package.json`이 없으면 루트에서 돈 명령은 코드와 무관하게 실패한다. 결과는 지적과 섞지 않고 `도구 실행 결과`에만 적는다.

### Step 3: 단일 Sub-Agent Dispatch

**단 하나의 sub-agent**만 dispatch한다. `run_in_background=false`로 즉시 실행.

**producer는 `subagent_type="react-code-review-plugin:rule-module-reviewer"`로 띄운다(C-6).** 이 에이전트는 `Read`·`Grep`·`Glob`만 가진다 — 쓰기 도구도 셸도 없어서 실제로 고칠 수 없다. diff와 의도는 오케스트레이터가 이미 모았으므로 producer에게 셸이 필요 없다. `general` 같은 만능 에이전트나 셸을 가진 `correctness-reviewer`로 띄우지 않는다. **리뷰 에이전트가 없으면 멈춘다(C-6).** 호스트에 이 에이전트가 없거나(작업 도구의 에이전트 목록에 없다, 띄우면 알 수 없는 에이전트로 실패한다) 런타임이 그 도구를 제한하지 못하면 리뷰하지 않는다 — 오케스트레이터가 직접 리뷰하거나 다른 에이전트(`explore`·`general`·`build` 등)로 대신하지 않고, 결과를 직접 쓰지 않는다. 기록을 `--phase dispatch.halt --set reason=agent-unavailable --set stage=module`, 이어서 `--phase run.end --set verdict=not-reviewed`로 닫는다. 리포트를 쓰지 않고, 무엇을 띄울 수 없었는지와 확인할 곳(호스트의 플러그인·에이전트 설정)을 사용자에게 알린다. 리뷰하지 않은 실행의 리포트는 지적 없음으로 읽힌다.

**리뷰어를 띄우는 앞뒤로 기록을 남긴다(C-9).** 리뷰어는 결과를 돌려줄 때까지 돌아오지 않으므로 시작은 띄우기 **직전**에 남긴다. `module`에는 압축 규칙의 이름 `fast`를 쓴다.

1. 띄우기 직전: `--phase module.start --set module=fast --set attempt=1`
2. 결과를 받은 직후: `--phase module.done --set module=fast --set attempt=1 --set status=ok --set findings=<받은 지적 표의 행 수>`. 리뷰어가 실패했거나(시간 초과, 빈 결과) 세 블록을 읽을 수 없으면 `--set status=failed --set failureClass=<inactivity-timeout|empty-result|malformed-output|unknown>`이다. 다시 띄우면 `attempt=2`로 시작과 끝을 다시 남긴다 — 앞 줄을 고치지 않는다
3. 이어서 `--phase dispatch.end` — 수치는 넘기지 않는다. 스크립트가 `module.done`에서 센다

사용자가 영향이 낮은 지적도 보자고 했으면 프롬프트 `## 무엇을 내는가` 표의 영향 낮음 행을 `상세 지적에 냅니다`로 바꿔 넘긴다. 그 밖에는 아래 프롬프트를 그대로 쓴다.

```
task(
  subagent_type="react-code-review-plugin:rule-module-reviewer",
  load_skills=[],
  run_in_background=false,
  description="Fast Code Review (single pass)",
  prompt="아래 지시에 따라 빠른 코드 리뷰를 수행하세요.

## 리뷰 대상
- 기준: {MERGE_BASE}
- 대상: HEAD
- 변경 파일: {CHANGED_FILES}
- 제외 파일(지적하지 않을 경로): `__test__/**`, `__tests__/**`, `*.test.*`, `*.spec.*`, `__mocks__/**`, `mock/**`, `mocks/**`, `*.mock.*`, 테스트/목 전용 fixture/mock data
- 검토 안 함(지적하지 않을 경로 — React 규칙이 다루지 않는 언어): {OUTSIDE_FILES — `review-scope.mjs`의 `outside`. 다른 언어 앱(`otherApps`) 아래 파일은 `<root>/**`로 줄여 적는다. 없으면 `없음`}

## 변경 의도
{INTENT — Step 2에서 모은 의도. 첫 줄에 출처(`PR #N 설명`·`사용자 요구`·`커밋 메시지(의도 추정)`·`없음`)}

## Diff
{DIFF — Step 1에서 오케스트레이터가 수집한 git diff {MERGE_BASE}..HEAD 본문 전체. 테스트·검토 안 함 파일 변경 포함}

## 리뷰 규칙
아래 세 파일을 먼저 Read 한 뒤 리뷰하세요:
- `{RULES_DIR}/00-rule.md` — 등급(영향도 × 확신도 파생), 부재 주장의 근거(00-11), 위치 표기(00-10), 언어(00-6). 아래 두 문서와 충돌하면 이 문서가 우선합니다
- `{RULES_DIR}/fast.md` — 무엇이 규칙 위반인가(숫자 모듈의 압축본)
- `{RULES_DIR}/correctness.md` — 변경이 의도대로 동작하는가

숫자 prefix 상세 모듈(`01-fsd.md` 등)은 읽지 마세요 — fast는 그 압축본만 씁니다.

## 리뷰 수행 방법
1. 위 `## Diff`가 리뷰 대상의 전부입니다. git을 직접 실행하지 마세요 — 삭제된 파일의 옛 내용도 그 diff의 `-` 줄에 있습니다
2. diff만으로 판단이 서지 않을 때만 그 diff가 가리키는 파일과 직접 호출자·소비자를 Read로 더 읽으세요. 변경과 관련 없는 저장소 전체를 훑지 마세요
3. 먼저 diff에서 **동작을 바꾸는 변경**을 고르세요 — 조건·분기, 상태 갱신, 비동기 흐름, 저장·삭제, 권한, API·IPC·이벤트 계약, 삭제된 코드. 깊게 볼 순서는 `fast.md` 선별 규칙을 따르되, 위험 신호가 없다는 이유로 동작을 바꾸는 변경을 건너뛰지 마세요
4. 그 변경마다 두 질문을 하세요:
   - **의도대로 동작하는가** — `## 변경 의도`와 `correctness.md`대로 입력 → 상태 변경 → 소비자·출력을 따라가고, 정상·실패·취소·재시도·순서 역전 경로 중 이 변경과 관련 있는 것을 봅니다. 변경되지 않은 호출자가 바뀐 동작에 기대고 있는지도 봅니다
   - **규칙을 어기는가** — `fast.md`에서 적용 조건이 성립하는 섹션만 적용합니다
5. 지적 후보마다 `00-rule.md` Severity 기준의 두 축을 판정하고 등급은 파생표로만 정하세요. `fast.md` 규칙 옆 이모지는 참고값이지 등급이 아닙니다 — 이름·길이 규칙 옆 🔴도 닫힌 다섯 항목 중 하나를 지목하지 못하면 영향 낮음입니다
6. 영향 높음 후보는 확정 전에 반례를 찾으세요 — 그 경로를 막는 가드·검사가 있는가, 실제 호출 구조에서 그 경로에 도달하는가, 바뀐 상태를 읽는 쪽이 이미 처리하는가. 같은 에이전트가 한 반례 확인은 교차검증이 아니므로 그렇게 부르지 마세요
7. 지적은 **diff에 포함된 변경 라인** 또는 그 변경 때문에 직접 깨진 **인접 라인/구조**로 한정하세요. diff가 삭제하거나 바꾼 export·함수·타입·상수·prop을 diff 밖 코드가 아직 참조하면, 그 참조는 이 변경 때문에 깨진 구조입니다(`fast.md` 20. 삭제 회귀). 확인은 삭제·변경된 심볼 이름을 Grep으로 찾는 targeted reference check로 한정하고, 무엇을 어디까지 찾았는지 적으세요
8. 제외 파일과 검토 안 함 파일은 지적하지 마세요 — 영향 범위를 읽는 증거로만 쓰세요. 다른 언어 앱의 변경 때문에 React 코드가 깨지면 위치는 React 쪽 줄입니다
9. 추측하지 마세요 — 실제 코드를 읽고 확인하세요

## 무엇을 내는가

| 판정 | 출력 |
|------|------|
| 영향 높음 · 확신 높음 (🔴) | 상세 지적에 냅니다 |
| 영향 높음 · 확신 낮음 (🟡) | 상세 지적에 냅니다 — 확인하지 못한 것을 `확신` 칸에 적습니다 |
| 영향이 높을 수 있지만 부재·가능성 주장을 확인하지 못함 | 지적이 아니라 `확인 필요`에 냅니다(00-11) |
| 영향 낮음 | 내지 않습니다 |

- 개수 상한은 없습니다. 같은 파일의 독립적인 결함은 각각 냅니다
- 같은 원인이 여러 위치에 드러나면 한 지적으로 묶고 위치를 모두 적습니다. 위치가 가깝다는 이유만으로 다른 결함을 묶지 마세요
- 규칙에서 나온 지적은 `fast.md`가 가리키는 규칙 ID(`03-1`, `16-2`, `10-SSOT`)를, 의도 대비 동작 결함은 `CR-{순번}`을 씁니다(`correctness.md`). 두 근거가 같은 자리를 짚었으면 둘 다 남깁니다
- 사용자가 다른 언어를 명시하지 않은 한 한국어로 쓰세요. 코드 인용과 식별자는 번역하지 마세요

## 출력 형식
아래 세 블록만 출력하세요. 해당하는 항목이 없는 블록은 `없음`이라고 쓰세요.

### 지적

| 심각도 | 규칙 | 위치 | 영향 · 확신 | 이슈 | 개선 방향 |
|--------|------|------|-------------|------|-----------|
| 🔴/🟡 | 03-1 또는 CR-1 | 파일:라인 + 그 줄 코드 한 줄 인용 | 영향: 높음 (닫힌 항목) · 확신: 높음 또는 낮음 (확인 못 한 것) | 발생 조건 → 지금 있는 호출·소비 경로 → 잘못되는 결과 | 수정 방향 |

- 위치는 해당 파일을 읽어 확인한 **변경 후 줄 번호**입니다. diff hunk 헤더(`@@`)에서 계산하지 마세요. 확인하지 못하면 `위치 미확인`(00-10)
- 이슈 칸에는 미래의 수정이나 아직 없는 호출자를 가정하지 말고, 지금 코드에 있는 경로로 결과를 보이세요

### 확인 필요
- `파일:라인` — 무엇이 의심되는가 · 무엇을 확인했고 무엇을 확인하지 못했는가

### 따라가지 못한 변경
- `파일` — 동작을 바꾸는 변경인데 끝까지 따라가지 못한 것과 그 이유"
)
```

### Step 4: 결과 확인과 리포트 틀

리뷰어의 세 블록을 받아 아래 리포트의 틀을 쓴다. **다시 리뷰하지 않는다** — 지적을 더하거나 내용을 바꾸지 않는다. 다만 다음은 고친다.

- 등급이 두 축과 어긋난 행(`영향: 높음 · 확신: 낮음`인데 🔴 등)은 `00-rule.md` 파생표대로 등급만 고친다
- `영향: 낮음` 행이 섞여 오면 빼고, `미해결 / 후속 확인`에 "영향 낮음으로 판정돼 생략한 지적 N건"을 한 줄 적는다(사용자가 낮은 영향도 보자고 한 실행은 빼지 않는다)
- 리뷰어가 블록을 내지 못했거나 출력이 형식을 벗어나 지적을 읽을 수 없으면, 읽은 척 요약하지 않고 그 사실을 `판정`에 적는다

틀은 **파일 쓰기 도구로** `$REPORT_DIR/.timing/$REPORT_BASENAME.template.md`에 쓴다 — 쓰는 시점은 Step 5의 4번(`render.start`와 기록 검사 뒤)이다. `실행 타임라인` 섹션의 표 자리에는 `{{timeline}}` 한 줄만 둔다 — 그 줄에 다른 글자를 두지 않는다. 표는 Step 5에서 스크립트가 끼운다. 그 밖의 `{…}` 칸은 모두 채운다. 남은 자리표시자가 있으면 조립이 거부한다.

```markdown
# `{대상}` 빠른 코드 리뷰 리포트

## 리뷰 기준

> **기준**: {MERGE_BASE} | **대상**: HEAD | **리뷰 시각**: {TIMESTAMP}
> **변경 파일**: {N}개 | **규칙**: `fast.md` · `00-rule.md` · `correctness.md` | **플러그인 버전**: {`$RULES_DIR/../.claude-plugin/plugin.json`의 version}
> **범위**: {`review-scope.mjs`의 `line` 그대로 — 예: 리뷰 대상 110개 · 테스트·mock 제외 25개 · 검토 안 함 96개 — React 규칙이 다루지 않는 언어: apps/backend(pyproject.toml) 94개}
> **변경 의도**: {Step 2의 출처 — `PR #N 설명` / `사용자 요구` / `커밋 메시지(의도 추정)` / `없음`}
> **실행 ID**: {preflight의 `실행 ID`} | **기록**: `.timing/{REPORT_BASENAME}.jsonl`{ | 작업 트리에 커밋하지 않은 변경 N개 — preflight가 알렸을 때만}

## 판정

{🔴이 있으면 `🔴 N건 · 🟡 M건 — 🔴은 머지 전에 고친다.` 🔴이 없고 🟡만 있으면 `🟡 M건 — 영향은 높지만 확인하지 못한 경로가 남은 지적이다.` 둘 다 없으면 `확인한 범위에서 영향이 높은 결함을 찾지 못했다.`}

이 리뷰가 보지 않은 것: 영향이 낮은 지적(생략), lint·typecheck·test(실행하지 않음), Props·수학·예외 패스, 교차검증{, 검토 안 함 N개}{, 리뷰어가 따라가지 못한 변경 N개}

## 상세 지적

{리뷰어의 `### 지적` 표를 그대로. 없으면 `영향이 높은 지적 없음.`}

## 도구 실행 결과

{기본: `실행하지 않음 — fast는 lint·typecheck·test를 돌리지 않는다.` 사용자가 요청해 돌렸으면 명령·폴더·종료 코드·실패 요약을 표로}

## 실행 타임라인

{{timeline}}

{`--check --before-end`가 종료 코드 1이었으면 짚은 빈 곳을 여기 적는다. 기록을 남기지 못했으면 그 사실을 적는다}

## 미해결 / 후속 확인

{리뷰어의 `### 확인 필요`와 `### 따라가지 못한 변경`. 생략한 영향 낮음 지적 수. 더 넓은 확인이 필요하면 `/code-review-full`을 제안한다 — 자동으로 돌리지 않는다}
```

### Step 5: 문서 저장과 기록 닫기

리포트 저장은 `workflow-contract.md` C-7을 따른다 (`workflow-name`은 `fast`). 자리와 이름은 Step 0에서 정한 `$REPORT_DIR`·`$REPORT_BASENAME`이다. 섹션 이름·순서·헤딩 레벨은 C-7 **문서 골격**을 따르되, fast에는 실행 계획·모듈 섹션·특수 패스·요약이 없으므로 그 섹션들은 생략한다. 문서 내용은 **이번 브랜치에서 바뀐 동작의 결함** 중심으로 유지하고, 일반 설명은 최소화한다.

순서대로 한다. 기록 명령의 `--dir`·`--run`은 Step 0과 같은 값이다.

1. 틀을 쓰기 전에 `--phase render.start --set findings=<상세 지적 행 수>`
2. `review-timeline.mjs --summary --out "$REPORT_DIR/.timing/$REPORT_BASENAME.timeline.md"` — 표를 파일로 받는다. 셸 출력으로 받아 옮기지 않는다(PowerShell 5.1이 한글을 깨뜨린다)
3. `review-timeline.mjs --check --before-end` — 종료 코드 1은 리뷰 실패가 아니다. 짚은 빈 곳을 틀의 `실행 타임라인` 섹션에 적는다
4. Step 4의 틀을 파일 쓰기 도구로 쓴다
5. 조립한다. 스크립트가 틀의 `{{timeline}}` 자리에 2의 표를 끼워 `$REPORT_DIR/$REPORT_BASENAME.md`를 쓰고 `path`·`lines`를 낸다. 표가 이 실행의 기록이 아니거나 그 뒤로 기록이 늘었으면 쓰지 않는다 — 2부터 다시 한다

   ```bash
   node "$RULES_DIR/../scripts/assemble-report.mjs" --dir "$REPORT_DIR" --run "$REPORT_BASENAME" --template "$REPORT_DIR/.timing/$REPORT_BASENAME.template.md"
   ```

6. `--phase render.wrote --set path=<조립이 낸 path> --set lines=<조립이 낸 lines>`
7. `--phase run.end --set verdict=<blocking|unconfirmed|no-high-impact>` — 판정 첫 줄과 같은 것: 🔴이 있으면 `blocking`, 🟡만 있으면 `unconfirmed`, 둘 다 없으면 `no-high-impact`. **`run.end`가 마지막 줄이다.** 그 뒤에 기록을 덧붙이지 않는다

리포트를 옮기라는 요청을 받으면 `.timing/`도 함께 옮긴다.

## 사용법

```
/code-review-fast                    — 현재 브랜치 전체 빠른 리뷰
/code-review-fast main..feature/x    — 특정 범위 빠른 리뷰
```

모듈 단위 축소(`--module ...`)는 이 모드에서 지원하지 않는다. 특정 주제만 보고 싶다면 사용자가 프롬프트로 지시한다 (예: "타입 안전성만 집중해서 봐줘"). 영향이 낮은 지적까지 보고 싶으면 그렇게 말하면 된다(Step 3).

## 주의사항

- 이 모드는 완전한 리뷰 대신 **영향이 높은 결함만 빠르게 보는 저지연/timeout-safe 경로**다. 영향 낮은 지적·도구 실행·특수 패스·교차검증은 하지 않으며, 리포트 `판정`이 그 사실을 적는다
- 큐 포화(queue saturation), tail latency, timeout 위험이 우려될 때 이 모드를 사용한다
- 상세/포괄적 리뷰가 필요하면 `/code-review-full`을 사용한다
- fast 룰 문서(`fast.md`)는 숫자 prefix 상세 모듈 전체의 압축본이며, 모듈이 추가·삭제·재배치되거나 **조항이 고쳐지면** fast.md의 해당 섹션도 같은 변경에서 갱신해야 한다. 압축하면서 원본의 예외 조항이나 담당 이동을 빠뜨리면 오탐이 생긴다. 2026-08-13부터 11-10까지 조항이 고쳐지는 동안 fast.md는 따라가지 않았고, 검사(`fast-sync`)는 그것을 잡지 못했다
- 빈 diff면 리뷰를 수행하지 않는다
- 도구는 기본으로 돌리지 않고, 사용자가 요청해 돌릴 때도 수정 옵션 없이 돌린다 (`00-rule.md` 00-9)
- diff·의도 수집은 오케스트레이터가 하고, producer는 받은 것을 읽기만 하는 `rule-module-reviewer`로 띄운다 (C-6)
- 단계별 시간은 `.timing/<리포트 이름>.jsonl`에 남는다. 리포트의 `실행 타임라인` 표가 그 요약이고, 정본은 기록 파일이다 (C-9)
