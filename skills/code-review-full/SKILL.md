---
name: code-review-full
description: Use when the user invokes /code-review-full or asks for a full code review orchestrator that combines general, props, math, and exception review coverage while preserving existing review modes.
---

# 전체 코드 리뷰 오케스트레이터

## 개요
일반, Props, 수학, 예외 리뷰 모드를 아우르는 전체 리뷰 오케스트레이션이다. 이 skill은 `code-review`, `code-review-props`, `code-review-math`, `code-review-exception`을 대체하지 않으며, 각 모드는 계속 독립적으로 사용할 수 있다.

## 추가 보존
- `code-review`는 기본 일반 리뷰 skill로 유지한다.
- `code-review-props`는 독립 Props/인자 전달 리뷰 skill로 유지한다.
- `code-review-math`는 독립 선형대수 리뷰 skill로 유지한다.
- `code-review-exception`는 독립 예외/에러 처리 리뷰 skill로 유지한다.
- 이 skill은 더 넓은 오케스트레이션만 추가한다.

## 공통 계약

`RULES_DIR` 해석, 모듈 탐색, 적용 조건 판정, 범위 결정, 제외 경로, 실행 안전, 리포트 저장, 실패 보고는 **`$RULES_DIR/workflow-contract.md`** 를 따른다. 이 문서는 그 계약을 복제하지 않고 아래 차이만 선언한다.

| 항목 | 이 워크플로우 |
|------|---------------|
| `workflow-name` | `full` |
| 모듈 집합 | 적용 대상 numbered non-00 + props + math + exception |
| 분할 방식 | 모듈별 sub-agent, **in-flight 최대 4개의 sliding window** (배리어 없음) |
| 완료 판정 | 적용 대상 모듈 전부 수집 성공. 하나라도 실패하면 `FAILED orchestration` |

## 오케스트레이션
1. 변경 집합만 기준으로 리뷰 범위를 결정한다.
    - 범위 결정은 `workflow-contract.md` C-4를 따른다. **사용자가 범위를 지정했으면 그것이 최우선**이고, 지정이 없을 때만 `dev` → `main` → `master` → `origin/HEAD` 순으로 base를 찾는다. 후보가 모두 없으면 사용자에게 묻고 임의로 정하지 않는다.
    - 그 기준 이후 변경된 파일만 리뷰한다.
    - lint는 C-6(`00-rule.md` 00-9)을 따른다: **수정 옵션 없이 실행**하고 자동 수정은 사용자가 명시적으로 요청했을 때만 한다. 자동 수정 가능한 항목은 실행하지 않고 개수와 성격만 `도구 실행 결과` 섹션에 기록한다.
2. 패스 순서는 일반 → Props → 수학 → 예외 → 요약/리포팅이다.
3. 일반 패스 규칙.
    - 일반 패스는 단일 general review가 아니다. 숫자 prefix 모듈별 리뷰를 유지하되, 큐 포화와 timeout을 피하기 위해 in-flight 개수를 제한해 실행한다.
    - `RULES_DIR`의 `[0-9]*.md`를 반드시 스캔하고(C-1, C-2), 발견된 숫자 prefix 파일 중 `00-rule.md`를 제외한 전부를 **후보 모듈**로 삼는다. 모듈 목록을 파일명으로 하드코딩하지 않는다.
    - `00-rule.md`는 **공통 컨텍스트 전용**이다. 모든 일반 모듈보다 먼저 읽고 각 모듈 sub-agent의 prompt에 공통 규칙으로 함께 전달하되, **`00-rule.md`를 위한 독립 module pass나 별도 sub-agent를 실행하지 않는다.** 기본 `/code-review`와 같은 처리다.
    - 따라서 모듈 수 계산은 numbered non-00 모듈만으로 한다. `00-rule.md`가 독립 pass로 실행되지 않았다는 사실은 누락이나 `FAILED orchestration`이 아니다.
    - 일반 패스를 하나의 summary/general agent로 대체하거나 Props/수학/예외만 실행해서 일반 패스를 생략해서는 안 된다.

### 3a. 디스패치 전 준비 (에이전트를 띄우기 전에 한 번만 수행)

**적용 대상 선별과 컨텍스트 수집을 오케스트레이터가 먼저 끝낸다.** 이 두 가지를 각 sub-agent 안에서 하면 같은 일이 모듈 수만큼 반복되고, 적용도 되지 않을 모듈에 에이전트를 띄우게 된다.

**(1) 프로파일 판정 — 1회**

C-3에 따라 프로젝트 프로파일(FSD, Electron, Tailwind, RSC, SSR, Three.js, TanStack Query, server-code, contract-provider)과 React/TypeScript 버전을 **한 번만** 판정한다. 결과를 모든 sub-agent prompt에 함께 넘겨, 각 에이전트가 다시 조사하지 않게 한다.

**(2) 후보 모듈 → 적용 대상 모듈**

`$RULES_DIR/catalog.json`의 `requires`와 (1)의 판정 결과를 대조해, 전제가 성립하지 않는 모듈은 **sub-agent를 띄우지 않고** `SKIPPED` + 사유로 기록한다. 판정할 수 없으면 `UNKNOWN`으로 두고 역시 띄우지 않는다.

Trigger 섹션이 있는 모듈(`12`, `14`, `16`, `17`, `18`, `21`)은 diff에 해당 트리거가 전혀 없으면 `SKIPPED`로 둘 수 있다. 단 **판단이 애매하면 반드시 띄운다.** 여기서의 오판은 지적이 하나 늘어나는 게 아니라 검사 자체가 사라지는 것이므로, 비용이 비대칭이다. 트리거 부재를 근거로 skip할 때는 사유에 "diff에 X가 없음"처럼 확인한 내용을 적는다.

**(3) diff 1회 수집**

오케스트레이터가 `git diff {MERGE_BASE}..HEAD`와 변경 파일 목록을 한 번 읽어 **prompt에 담아 전달**한다. 각 sub-agent가 개별적으로 `git diff`를 다시 돌리지 않는다. 에이전트는 diff만으로 판단이 안 되는 경우에 한해 해당 파일을 추가로 읽는다.

**(4) 실행 계획 기록**

후보 N개 중 적용 대상 M개, `SKIPPED` 목록과 사유를 리포트에 남긴다. **M이 N보다 작다는 사실이 리포트에서 보여야 한다.** 보이지 않으면 전부 검토된 것으로 읽힌다.

### 3b. 실행

- 적용 대상 모듈마다 별도의 sub-agent 하나를 사용한다.
- **in-flight sub-agent는 최대 4개**로 제한한다 (max concurrency 4). 큐 포화와 timeout을 피하기 위한 상한이며, 아래 근거 없이 올리지 않는다.

  **왜 4인가** — 이 값은 실측으로 정한 것이지 임의로 고른 것이 아니다. 처음에는 2였고, 그때는 모듈 하나가 2~5분씩 걸려 동시에 많이 띄우면 timeout과 큐 포화 위험이 컸다. 디스패치 전 준비(3a)로 각 에이전트가 diff와 프로파일을 다시 조사하지 않게 된 뒤 모듈당 평균 약 71초로 내려갔고(20개 모듈 실측, 합 23분 33초), 개별 에이전트가 짧아진 만큼 동시에 띄워도 한 세션이 오래 붙잡히지 않는다.

  **되돌리는 조건** — timeout, inactivity timeout, queue expiry가 한 실행에서 두 건 이상 나오면 4가 이 런타임에 과했다는 신호다. 2로 내리고, 어떤 실패 클래스가 몇 번 나왔는지 기록한다. 실패 없이 느리기만 한 것은 되돌릴 근거가 아니다.
- **배리어를 두지 않는다.** 어느 한 모듈이 terminal 상태(`COMPLETED` 또는 `FAILED_ORCHESTRATION`)가 되면 **즉시** 다음 대기 모듈을 그 슬롯에 넣는다. 두 모듈이 모두 끝나기를 기다리지 않는다 — 기다리면 빨리 끝난 슬롯이 느린 모듈이 끝날 때까지 놀고, 그 유휴 시간이 모듈 수만큼 누적된다.
- 대기열 순서는 모듈 번호 순으로 하되, 순서 자체가 정확성 요건은 아니다. 결과는 리포팅 시점에 모듈 번호로 정렬한다.

**각 모듈 sub-agent prompt에 담을 것** — 3a에서 이미 확보했으므로 에이전트가 다시 조사하지 않는다.

| 항목 | 내용 |
|------|------|
| 리뷰 범위 | `{MERGE_BASE}`, HEAD, 변경 파일 목록 (제외 경로 적용 후) |
| diff | 3a(3)에서 수집한 diff 본문 |
| 프로젝트 프로파일 | 3a(1)의 판정 결과와 React/TypeScript 버전 |
| 공통 규칙 | `00-rule.md` 전문 |
| 담당 모듈 규칙 | 그 모듈 `.md` 전문 (하나만) |

에이전트에게는 **diff로 판단이 서지 않을 때만** 해당 파일을 추가로 읽으라고 지시한다. 모든 에이전트가 습관적으로 변경 파일 전체를 다시 읽으면 3a(3)에서 없앤 중복이 그대로 돌아온다.
- `00-rule.md`, `props.md`, `math.md`, `exception.md`, `fast.md`, 그리고 숫자 prefix가 없는 모든 파일은 일반 패스의 **독립 모듈 대상에서 제외**한다. (`00-rule.md`는 제외되지만 공통 규칙으로는 모든 모듈에 전달된다.)
- **적용 대상 모듈(3a에서 확정된 M개) 결과를 전부 수집해야** 일반 패스가 완료된다. 누락, 실패, timeout, inactivity timeout, queue expiry가 발생한 모듈이 있으면 완료된 리뷰가 아니라 `FAILED orchestration`으로 처리한다.
- `SKIPPED`와 `FAILED`를 구분한다 (C-8). 3a에서 전제 미성립으로 제외한 모듈은 `FAILED orchestration`이 아니다. 반대로 **적용 대상인데 결과가 없는 것**은 언제나 실패다.
- 일부 모듈이 실패해도 이미 완료된 모듈 결과는 수집해 partial result로 보존한다. 단, 실패/누락/timeout 모듈 목록을 명시하고 전체 리뷰를 fully complete로 요약하지 않는다.
- `01-fsd.md`와 `20-deletion-regression.md`가 **적용 대상인데** 실행/수집되지 않으면 architecture/deletion-regression coverage 누락으로 보고 `FAILED orchestration` 처리한다. (`01-fsd.md`는 FSD 프로젝트가 아니면 3a에서 `SKIPPED`가 되며, 그건 실패가 아니다.)
- 별도 architecture 또는 deletion-regression summary agent로 `01-fsd.md`/`20-deletion-regression.md` 결과를 대체하지 않는다. 해당 지적은 반드시 숫자 모듈 결과로 유지한다.
- 변경된 파일만 평가하고 diff 밖 저장소 전체는 스캔하지 않는다.
    - 일반 코드 리뷰 패스에서 테스트/목 전용 경로를 제외한다: `__test__/**`, `__tests__/**`, `*.test.*`, `*.spec.*`, `__mocks__/**`, `mock/**`, `mocks/**`, `*.mock.*`, 전용 fixture/mock-data 자산.

### 일반 모듈 실행 및 liveness failover 정책
- 일반 패스의 모든 적용 대상 모듈은 initial dispatch부터 `subagent_type=general`, `run_in_background=true`로 실행한다. 동기 실행으로 시작한 뒤 background로 전환하지 않는다.
- 적용 대상 모듈마다 별도의 sub-agent 하나를 반드시 유지한다. in-flight 상한은 정확히 4이며, fast review, generic summary, 또는 다른 모듈이 누락된 숫자 모듈을 대체할 수 없다. 특히 `01-fsd.md`와 `20-deletion-regression.md`는 다른 architecture/deletion-regression 요약으로 대체하지 않는다.
- 각 모듈 상태는 `PENDING → DISPATCHED → COMPLETED or fresh retry → FAILED_ORCHESTRATION` 순서로 기록한다.
- no-start, timeout, inactivity timeout, queue expiry, empty/missing result, `Task not found for session` 또는 session loss가 발생하면 해당 모듈은 죽은 세션으로 간주하고, fresh `general` background task로 최대 1회만 retry한다. dead/no-event/lost session은 `session_id`로 resume하지 않으며, synchronous task를 background task로 변환하지 않는다.
- 정상 완료된 응답이 clarification만 요구하는 경우에는 live session을 재사용할 수 있다. 단, no-start, timeout, inactivity timeout, queue expiry, empty/missing result, `Task not found for session`, session loss 클래스는 live session으로 보지 않으며 재사용하지 않는다.
- 런타임이 first-event 또는 heartbeat 관측을 지원하면 bounded startup window 안에서 첫 이벤트를 확인한다. 현재 task API처럼 completion/error notification만 노출되는 런타임에서는 첫 timeout, expiry, error에 반응하고 같은 session에 두 번째 long wait를 쓰지 않는다.
- 각 숫자 모듈마다 가능한 경우 task ID, session ID, attempt count, last observed event/result, failure class를 기록한다. **failure class별 건수를 리포트에 남긴다** — in-flight 상한이 이 런타임에 맞는지 판단할 유일한 근거다.
- 어느 모듈이든 terminal 상태가 되는 즉시 대기열의 다음 모듈을 그 슬롯에 투입한다. 다른 in-flight 모듈의 완료를 기다리지 않는다. retry도 슬롯 하나를 차지하며 같은 상한을 따른다.
- retry까지 실패한 모듈은 정확한 모듈명을 `FAILED_ORCHESTRATION`으로 표시하고, 이미 완료된 다른 모듈의 partial result는 보존한다. 필수 숫자 모듈 실패는 전체 리뷰의 `FAILED orchestration` 상태를 유지한다.
- `.claude/commands/review-pr.md`의 "skip errored/empty agent" 정책은 full review에 적용하지 않는다. full review는 빈 결과나 errored module을 건너뛰지 않고 실패한 필수 모듈로 보고한다.
 4. Props 패스 규칙.
    - props drilling, 과도한 props, handler tunneling, argument-passing 구조와 관련된 변경 파일만 본다.
    - `$RULES_DIR/props.md`만 읽고, 규칙 ID는 `P-x`로 표기한다.
    - 관련 범위가 없으면 `SKIPPED`로 기록한다.
    - 범위를 만들기 위해 repo-wide 스캔으로 되돌아가지 않는다.
 5. 수학 패스 규칙.
     - 행렬 또는 선형대수 작업이 있는 변경 파일만 본다.
     - `$RULES_DIR/math.md`만 읽고, 규칙 ID는 `A-x` / `C-x`로 표기한다.
     - 관련 범위가 없으면 `SKIPPED`로 기록한다.
     - 범위를 만들기 위해 repo-wide 스캔으로 되돌아가지 않는다.
 6. 예외 패스 규칙.
    - 예외 처리, 에러 전파, fallback, 복구, validation flow와 관련된 변경 파일만 본다.
    - `$RULES_DIR/exception.md`만 읽고, 규칙 ID는 `EX-x`로 표기한다.
    - 관련 범위가 없으면 `SKIPPED`로 기록한다.
    - 범위를 만들기 위해 repo-wide 스캔으로 되돌아가지 않는다.
 7. 요약/리포팅 규칙.
    - 네 패스가 모두 끝난 뒤에 패스 리포트를 출력한다.
    - 패스별 출처 라벨이 일반, Props, 수학, 예외로 구분되도록 유지한다.
    - 특수 범위 결정이 끝난 뒤에만 패스 출력물을 병합한다.

## 리포팅
- 네 패스의 리포트를 각각 개별로 출력하고, 각 패스 출력은 생성된 그대로 유지한다: 일반, Props, 수학, 예외.
- 일반 패스 리포트는 `RULES_DIR`의 `[0-9]*.md`에서 발견한 numbered non-00 모듈명을 모두 나열하고, 모듈별 sub-agent 결과를 각각 표시한다. `00-rule.md`는 공통 규칙이므로 모듈 목록에 넣지 않는다.
- numbered non-00 모듈 중 실행 또는 수집이 누락된 항목이 있으면 `FAILED orchestration`으로 표시하고, 완료된 리뷰처럼 요약하지 않는다.
- lint/typecheck/test를 실행했으면 `도구 실행 결과` 섹션으로 분리해 보고하고, 리뷰 지적과 섞지 않는다 (`00-rule.md` 00-9).
- 개별 패스 리포트를 출력 전에 다시 쓰거나 압축하거나 합치지 않는다.
- 패스에 적용 범위가 없으면 패스 이름, 사유, 그리고 `SKIPPED`가 비차단임을 명시해 `SKIPPED`로 출력한다.
- 모든 패스가 끝난 뒤에는 사용자가 다른 언어를 명시하지 않은 한 한국어로 전체 요약 리포트를 출력한다.
- 요약 저장은 `workflow-contract.md` C-7을 따른다 (`workflow-name`은 `full`).
- 프로젝트가 이미 다른 문서 저장 관례를 따르고 있으면 절대 경로를 강제하지 않는다.

### 상세 지적 작성 규칙
- 사용자가 다른 언어를 명시하지 않은 한 모든 패스의 상세 지적과 최종 저장 문서는 한국어로 작성한다.
- 각 이슈는 일반 `code-review`와 같은 상세 스타일로 `문제 → 의도/현재 선택 → 왜 부족한지 → 개선 방향` 순서가 드러나게 쓴다.
- 동작 여부만 확인하지 말고 문제 정의, 의도, 선택 근거, 장기 변경 비용까지 함께 검토해 지적에 반영한다.
- 전체 요약은 추가 정보일 뿐이며, 패스별 상세 지적을 대체하거나 압축하지 않는다.
- 최종 저장 문서 `./review-reports/code-review-full-{branch-name}-{date}.md`에는 일반, Props, 수학, 예외 패스의 상세 리포트를 먼저 포함하고, 그 뒤에 전체 요약을 둔다.

### 요약 내용
- 일반, Props, 수학, 예외 패스 상태 표를 포함한다.
- SKIPPED 사유를 요약 안에 함께 넣는다.
- 심각도는 🔴 오류, 🟡 경고, 🔵 정보 순으로 묶는다.
- 중복 제거된 지적, 출처 패스 라벨, `미해결 / 후속 확인 필요` 섹션을 포함한다.
- 특수 패스의 세부사항을 요약 안에 유지하고, 일반/Props/수학/예외 관찰을 하나의 일반 노트로 뭉개지 않는다.

### 중복 제거 규칙
- 다음이 모두 같을 때만 지적을 병합한다: 같은 파일, 같은/가까운 라인, 같은 근본 원인.
- 병합된 지적에는 모든 출처 패스 라벨을 유지한다.
- 지적을 병합할 때는 가장 높은 심각도를 유지한다.
- 관련된 일반 지적이 이미 있다는 이유로 특수 세부사항을 버리지 않는다.
- 근본 원인, 범위, 특수 의미가 다르면 같은 파일을 건드려도 분리해서 둔다.

### 출처 라벨링
- 모든 지적은 출처 패스 라벨 `일반`, `Props`, `수학`, `예외` 중 하나를 유지해야 한다.
- 중복 제거된 지적이 여러 출처를 합치면 기여한 라벨을 모두 적는다.
- `SKIPPED` 항목도 패스 라벨을 유지해 어떤 패스가 실행되지 않았는지 요약에서 보이게 한다.

## 참고
- 이 스킬은 기존 리뷰 스킬에 덧붙이는 오케스트레이션 레이어다.
- 기존 리뷰 스킬의 의미를 바꾸지 않는다.
