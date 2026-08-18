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
| 교차검증 | 1차 수집 후 **선별 반박 패스**. 기본 `--verify selective`, 삭제는 `rollout-shadow`에서 시작 |

## 오케스트레이션
1. 변경 집합만 기준으로 리뷰 범위를 결정한다.
    - 범위 결정은 `workflow-contract.md` C-4를 따른다. **사용자가 범위를 지정했으면 그것이 최우선**이고, 지정이 없을 때만 `main` → `master` → `origin/HEAD` 순으로 base를 찾는다. 후보가 모두 없으면 사용자에게 묻고 임의로 정하지 않는다.
    - 그 기준 이후 변경된 파일만 리뷰한다.
    - lint는 C-6(`00-rule.md` 00-9)을 따른다: **수정 옵션 없이 실행**하고 자동 수정은 사용자가 명시적으로 요청했을 때만 한다. 자동 수정 가능한 항목은 실행하지 않고 개수와 성격만 `도구 실행 결과` 섹션에 기록한다.
2. 패스 순서는 일반 → Props → 수학 → 예외 → 요약/리포팅이다.
3. 일반 패스 규칙.
    - 일반 패스는 단일 general review가 아니다. 숫자 prefix 모듈별 리뷰를 유지하되, 큐 포화와 timeout을 피하기 위해 in-flight 개수를 제한해 실행한다.
    - `RULES_DIR`의 `[0-9]*.md`를 반드시 스캔하고(C-1, C-2), 발견된 숫자 prefix 파일 중 `00-rule.md`와 **`catalog.json`의 `phaseByWorkflow.full`이 `post-verification-synthesis`인 모듈**을 제외한 전부를 **후보 모듈**로 삼는다. 모듈 목록을 파일명으로 하드코딩하지 않는다.
    - `phaseByWorkflow.full`이 `post-verification-synthesis`인 모듈(현재 `10-principles.md`)은 **일반 패스의 후보가 아니다.** 다른 모듈의 결과를 입력으로 받아야 자기 역할을 할 수 있으므로 검증 이후 synthesis 단계에서 한 번만 실행한다. 일반 패스에서 함께 띄우면 같은 모듈이 두 번 실행된다.
    - `00-rule.md`는 **공통 컨텍스트 전용**이다. 모든 일반 모듈보다 먼저 읽고 각 모듈 sub-agent의 prompt에 공통 규칙으로 함께 전달하되, **`00-rule.md`를 위한 독립 module pass나 별도 sub-agent를 실행하지 않는다.** 기본 `/code-review`와 같은 처리다.
    - 따라서 모듈 수 계산은 **numbered non-00 중 `post-verification-synthesis`가 아닌 모듈**만으로 한다. `00-rule.md`와 synthesis 단계 모듈이 독립 pass로 실행되지 않았다는 사실은 누락이나 `FAILED orchestration`이 아니다.
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

  **관측 (2026-08-18, 교차검증 패스 도입 후 첫 실행)** — 이 조건이 실제로 발동했다. 한 실행에서 skill-injection validation 4건, inactivity timeout 4건, task-not-found 4건이 나와 in-flight를 4에서 2로 내렸고, fresh retry 1회로 전부 회복해 적용 모듈 19개를 모두 수집했다. **되돌리기 장치는 설계대로 동작했다.** 다만 관측이 1회뿐이므로 기본값 4는 그대로 둔다 — 71초/모듈 실측으로 정한 값을 표본 하나로 뒤집지 않는다. 같은 발동이 반복되면 그때 기본값을 다시 본다.
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

**출력 형식 지시 — 각 모듈/특수 패스 producer prompt에 반드시 포함한다.**

> `REVIEW_RESULT_CONTRACT_V1_MANIFEST`는 `workflow-contract.md`의 manifest sentinel JSON block 전문을 그대로 주입한 런타임 placeholder입니다. partial token 목록이나 요약본으로 대체하지 말고, 이 manifest 전체를 계약으로 사용하세요.
>
> `{REVIEW_RESULT_CONTRACT_V1_MANIFEST}`
>
> `REVIEW_RESULT_CONTRACT_V1_PRODUCER_OUTPUT` marker를 따르는 producer라고 생각하고, 응답은 Markdown/코드펜스/서문 없이 `REVIEW_RESULT_CONTRACT_V1` raw JSON 객체 하나만 반환하세요.
> report heading/table/raw HTML/link를 직접 만들려고 하지 마세요. `title`, `body`, `recommendation`, `reason`, `evidence`는 최종 리포트의 신뢰된 Markdown이 아니라 untrusted content 입니다.
> top-level에는 `schemaVersion`, `findings`, `openQuestions`를 **항상** 포함하고, `schemaVersion`은 반드시 `1`이어야 합니다. `findings`와 `openQuestions`는 빈 결과여도 생략하지 말고 배열로 반환하세요.
> `severity`는 어떤 depth에도 넣지 마세요. producer는 `impact`와 `confidence`만 판정하고 severity와 Markdown은 오케스트레이터가 만듭니다.
> `00-rule.md` 00-11에 걸리는 unresolved absence/possibility claim, search scope 미완료, 추가 탐색 요청만 `openQuestions`로 보내세요. 결함은 성립하지만 exact location만 확인하지 못했으면 finding을 유지하고 `location.kind="unverified"`와 `reason`만 사용하세요. producer가 공개 문자열 토큰 `위치 미확인`을 직접 출력하지는 않습니다.
> 규칙이 요구하던 도메인별 정보(실패 시나리오, 규모/시나리오, contract 표면, 복구 방향 등)는 새 schema field를 만들지 말고 `body`, `recommendation`, `evidence`, `reason` 안에 녹여 쓰세요.

위 지시는 이 skill이 structured-v1 owner로서 보유한다. numbered rule modules와 specialist rule docs는 workflow-neutral domain judgment docs일 뿐이며, producer schema나 lifecycle을 직접 소유하지 않는다. shared manifest와 retry/fail-closed 정책의 정본은 `workflow-contract.md` C-6A와 `REVIEW_RESULT_CONTRACT_V1`이다.

#### Numbered module review producer prompt template

- 입력: `{REVIEW_RESULT_CONTRACT_V1_MANIFEST}` + `00-rule.md` 전문 + 담당 numbered module 전문 + diff/context/profile 정보
- 출력: 위 structured producer instruction을 따르는 `REVIEW_RESULT_CONTRACT_V1` JSON 하나
- 목적: numbered module 하나의 domain judgment를 structured finding/openQuestion으로 반환

#### Props & Arguments Code Review producer prompt template

- 입력: `{REVIEW_RESULT_CONTRACT_V1_MANIFEST}` + `00-rule.md` 공통 규칙 + `props.md` 전문 + diff/context
- 출력: 위 structured producer instruction을 따르는 `REVIEW_RESULT_CONTRACT_V1` JSON 하나
- 목적: props drilling, pass-through, argument 구조 이슈를 standalone/full specialist pass 모두 같은 contract로 반환

#### Math Code Review (linear algebra) producer prompt template

- 입력: `{REVIEW_RESULT_CONTRACT_V1_MANIFEST}` + `00-rule.md` 공통 규칙 + `math.md` 전문 + diff/context
- 출력: 위 structured producer instruction을 따르는 `REVIEW_RESULT_CONTRACT_V1` JSON 하나
- 목적: shape/차원, storage order, 수학 전제 위반을 standalone/full specialist pass 모두 같은 contract로 반환

#### Exception Handling Code Review producer prompt template

- 입력: `{REVIEW_RESULT_CONTRACT_V1_MANIFEST}` + `00-rule.md` 공통 규칙 + `exception.md` 전문 + diff/context
- 출력: 위 structured producer instruction을 따르는 `REVIEW_RESULT_CONTRACT_V1` JSON 하나
- 목적: 예외 전파, fallback, recovery 이슈를 standalone/full specialist pass 모두 같은 contract로 반환

에이전트가 자기 문서 구조를 만들어 반환하면 오케스트레이터가 그것을 이어붙일 때 **헤딩 레벨이 깨지고**(모듈 래퍼보다 상위 레벨이 안쪽에 들어옴), 모듈마다 다른 하위 구조와 언어가 섞인다. structured result로 고정하면 하위 에이전트는 판단 결과만 반환하고, 최종 골격과 severity 표기는 오케스트레이터가 일관되게 만든다.

**단 하나의 예외: 위치 확인.** 지적을 만들 때는 그 줄을 실제로 읽어 번호를 확인하고 코드를 인용한다 (`00-rule.md` 00-10). 이건 diff만으로 대체할 수 없다 — hunk 헤더로 계산한 번호는 어긋나고, 어긋난 번호는 결과를 받은 뒤 정정하는 왕복을 만든다. 지적 한 건을 확인하는 비용이 리포트를 다시 고치는 비용보다 훨씬 싸다.
- `00-rule.md`, `props.md`, `math.md`, `exception.md`, `fast.md`, 숫자 prefix가 없는 모든 파일, 그리고 **`phaseByWorkflow.full`이 `post-verification-synthesis`인 모듈**은 일반 패스의 **독립 모듈 대상에서 제외**한다. (`00-rule.md`는 제외되지만 공통 규칙으로는 모든 모듈에 전달된다. synthesis 모듈은 뒤에서 한 번 실행된다.)
- **적용 대상 모듈(3a에서 확정된 M개) 결과를 전부 수집해야** 일반 패스가 완료된다. 누락, 실패, timeout, inactivity timeout, queue expiry가 발생한 모듈이 있으면 완료된 리뷰가 아니라 `FAILED orchestration`으로 처리한다.
- `SKIPPED`와 `FAILED`를 구분한다 (C-8). 3a에서 전제 미성립으로 제외한 모듈과 `post-verification-synthesis` 모듈은 `FAILED orchestration`이 아니다. 반대로 **적용 대상인데 결과가 없는 것**은 언제나 실패다.
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

## 교차검증 패스

1차 모듈 결과를 곧바로 사실로 확정하지 않는다. 규칙 축으로 찾은 것을 **anchor-file 중심 컨텍스트 축**으로 한 번 더 본다. 같은 규칙 문서로 같은 diff를 다시 리뷰하는 전면 교차검증은 하지 않는다 — 같은 모델·같은 입력은 오류가 상관되고, 다수결은 사실성을 증명하지 못한다.

### 불변식

1. **검증은 1차와 다른 축으로 본다.** 검증자는 처음부터 다시 리뷰하지 않고 이미 발견된 주장을 반증한다.
2. **truth disposition과 severity는 분리된 축이다.** verifier는 참·거짓만 판정하고 `impact`·`confidence`·severity를 바꾸지 않는다.
3. **verifier는 active finding을 추가하지 않는다.** 이 패스의 출력 효과는 제거·이동·표시뿐이다.

### 실행 순서

1차 모듈 fan-out과 특수 패스가 끝난 뒤, `workflow-contract.md` C-6A validation을 통과한 결과만 아래로 흘린다.

```
instanceId 부여
  → scripts/prepare-verification.mjs        추가 sub-agent 호출 0회
      위치 대조 · exact dedup + candidateId · ownerCollision
      eligibility 판정 · bundle/isolated 라우팅 · context bundle 구성
  → bundle verifier      (in-flight 상한 공유)
  → isolated verifier    (승격분 + bundle이 needs-context로 돌린 것)
  → disposition 적용
  → 10-principles synthesis
  → rendering
```

**위치 대조와 eligibility는 모델이 아니라 `scripts/prepare-verification.mjs`가 판정한다.** Markdown 지시로는 결정성을 주장할 수 없다. **판단으로 대체하지 말고 실제로 실행한다.**

```bash
echo '{"candidates":[…]}' | node "$RULES_DIR/../scripts/prepare-verification.mjs" --merge-base "$MERGE_BASE"
```

- 입력 `candidates[]`의 각 항목은 `candidateId`, `ruleId`, `impact`, `confidence`, `category`(있을 때), `location`을 담는다
- 출력은 candidate별 `locationCheck`·`eligibility`·`route`와 `bundles`, 그리고 `counts`다
- **coverage 숫자는 이 `counts`를 그대로 옮긴다.** 직접 세지 않는다 — 손으로 센 수치는 `verify + skipVerify = total`을 깨뜨린다
- 플러그인으로 설치된 경우 스크립트는 `RULES_DIR`의 상위에 있다. 경로를 찾지 못하면 그 사실을 `실행 계획`에 적고, **결정적으로 판정했다고 서술하지 않는다**

### `--verify` 모드

| 모드 | 동작 |
|------|------|
| `selective` (기본) | eligibility 판정을 적용해 대상만 검증 |
| `exhaustive` | 모든 candidate를 검증 대상으로. audit sidecar를 **기본 저장**한다 |
| `off` | 위치 대조까지만 수행하고 verifier를 띄우지 않는다 |

`off`를 두는 이유는 위치 대조가 추가 sub-agent 호출 없이 값이 크기 때문이다. 검증을 전부 꺼도 위치 대조는 남긴다.

### verifier producer prompt

bundle verifier와 isolated verifier는 **같은 prompt 계약**을 쓴다. 단계마다 다른 enum을 두면 호출자가 verifier 종류를 알아야 결과를 해석하게 된다.

에이전트에 주는 것과 주지 않는 것을 구분한다. **1차의 `impact`·`confidence`·`recommendation`·모듈 라벨은 주지 않는다** — "확신: 높음"을 보면 검증자가 그쪽으로 기운다. 규칙은 모듈 전문이 아니라 해당 `## NN-x` 조항 본문만 준다.

> `REVIEW_VERDICT_CONTRACT_V1_MANIFEST`는 `workflow-contract.md`의 verdict manifest sentinel JSON block 전문을 그대로 주입한 런타임 placeholder입니다. partial token 목록이나 요약본으로 대체하지 마세요.
>
> `{REVIEW_VERDICT_CONTRACT_V1_MANIFEST}`
>
> 이 finding을 **기각할 반례나 방어 장치를 찾으세요. 찾지 못했을 때만 유지하세요.** 기본 입장은 반박입니다.
> 다른 문제를 새로 찾지 마세요. 이 패스에 신규 finding 보고 경로는 없습니다.
> 응답은 Markdown/코드펜스/서문 없이 `REVIEW_VERDICT_CONTRACT_V1` raw JSON 객체 하나만 반환하세요.
> 요청받은 `candidateId` **전부에 대해 각각** verdict를 반환하세요. 파일이나 cluster 단위로 한꺼번에 판정하지 마세요.
> `severity`는 어떤 depth에도 넣지 마세요. 등급은 판정하지 않습니다.
> `disposition`이 `rejected`면 `rebuttal`이 필수입니다. 무엇이 이 주장을 막는지와 **그 코드의 위치**를 대세요. 위치를 댈 수 없으면 반박이 아니라 의견이며, 그때는 `rebuttal.kind`를 `other`로 두고 `note`에 사유를 적으세요.
> `rebuttal.location`은 `verified` 또는 `deleted`만 허용합니다. `unverified`는 허용하지 않습니다.
> location은 두 형태뿐입니다. `verified`는 `path`·`line`·`quote`(선택 `endLine`)를 HEAD 기준으로, `deleted`는 `path`·`lineBefore`·`quote`(선택 `endLine`)를 merge-base 기준으로 씁니다. `line`과 `lineBefore`를 섞지 말고, 허용되지 않은 key를 넣지 마세요.
> 이 파일 안에서 닫아 말할 수 없으면 `needs-context`와 `reason`을 쓰세요.
> isolated verifier는 anchor file 밖을 실제로 봐야 했는지 `usedCrossFileContext`로 보고하세요. 판정에는 영향을 주지 않는 지표 전용 필드입니다.

### disposition 적용

`disposition`은 verifier가 반환하고, `not-eligible`·`verification-disabled`·`verification-unavailable`은 **오케스트레이터가 부여**한다. verifier는 자기 부재를 보고할 수 없다.

상태별 active/synthesis/차단 처리는 `workflow-contract.md` C-6B 상태표가 정본이다. 이 문서에서 다시 정의하지 않는다.

**공개 리포트의 `교차검증:` 표기 값은 C-7의 `CROSS_VERIFICATION_RENDER_TOKENS`가 정본이다.** `upheld`·`rejected` 같은 producer enum을 리포트에 그대로 쓰지 않고, 검증 대상이 아니었던 finding에도 `대상 아님`을 적는다. 반박 사실을 heading 접미사로 덧붙이지 않는다 — 상태는 축 줄 한 곳에서만 표현한다.

### synthesis 단계 (`10-principles.md`)

`phaseByWorkflow.full`이 `post-verification-synthesis`인 모듈은 여기서 **한 번만** 실행한다. 일반 패스에서 제외한 모듈이 어디서 돌아가는지가 이 절이다 — 빼기만 하고 여기 적지 않으면 그 모듈은 그냥 사라진다.

- **입력**: disposition이 적용된 finding 전량 + openQuestions + 해당 모듈 전문 + `00-rule.md`. 포함·제외 기준은 C-6B 상태표를 따른다. `rejected`만 빠지고 `not-eligible`·`verification-disabled`·`verification-unavailable`은 들어간다
- 검증 이후에 두는 이유는 **반박당한 증상 여러 개를 묶어 근본 원인을 만들면 오탐이 증폭**되기 때문이다
- **출력**: 관계 클러스터와 근본 원인 가설, openQuestion. **새 active finding을 만들지 않는다** — 위치가 맞는다고 주장이 맞는 것은 아니며, 신규 finding을 그대로 편입하면 검증 gate를 통째로 우회한다
- 클러스터는 자체 severity를 갖지 않고 기존 finding을 참조만 한다. 존재하지 않는 candidate ID를 만들지 않는다
- 이 단계 실패는 `FAILED orchestration`이 아니다. 클러스터 없이 렌더링하고 `미해결 / 후속 확인`에 명시한다
- 리포트에서는 일반 패스 모듈 목록이 아니라 **synthesis 결과로 따로 표시**한다

### 실패 처리

- **검증 에이전트 실패는 `FAILED orchestration`이 아니다.** 해당 candidate에 `verification-unavailable`을 부여하고 coverage에 건수를 남긴다. 보조 단계의 실패가 전체 리뷰를 실패로 만들면, 새로 붙인 단계가 리뷰 전체의 신뢰성을 떨어뜨린다
- retry 1회 / in-flight 상한 공유 / 실패 클래스별 건수 기록 — 일반 모듈 정책을 그대로 재사용한다
- verdict `malformed-output` → C-6A와 동일 (교정 재시도 1회, 두 번째 실패 시 확정). 반환된 `candidateId` 집합이 요청과 다르면 그것도 `malformed-output`이다
- `exhaustive` release-gate 실행에서 **차단 후보(`impact = high`)의 검증이 실패하면 최종 판정은 `INCONCLUSIVE`** 다. 개별 finding의 차단 여부와 gate 전체의 완결성 판정은 다른 값이다

## 리포팅
- 문서 골격(섹션 이름·순서·헤딩 레벨)은 `workflow-contract.md` C-7의 **문서 골격** 표를 따른다. 매 실행마다 다른 골격을 만들지 않는다.
- 네 패스의 결과를 각각 구분해 출력한다: 일반, Props, 수학, 예외.
- producer가 반환한 원본은 Markdown이 아니라 parsed JSON이다. 오케스트레이터는 producer heading/section/severity를 보존·정규화하는 대신, **검증을 통과한 구조화 필드만** 수집 대상으로 삼는다: finding/openQuestion의 내용, `impact`/`confidence`, `category`, `location`, 규칙 ID, 출처 패스 라벨.
- 일반 패스 리포트는 `RULES_DIR`의 `[0-9]*.md`에서 발견한 numbered non-00 모듈명을 나열하고, 모듈별 sub-agent 결과를 각각 표시한다. `00-rule.md`는 공통 규칙이므로, `post-verification-synthesis` 모듈은 일반 패스 소속이 아니므로 이 목록에 넣지 않는다. 후자는 synthesis 단계 결과로 따로 표시한다.
- numbered non-00 모듈 중 실행 또는 수집이 누락된 항목이 있으면 `FAILED orchestration`으로 표시하고, 완료된 리뷰처럼 요약하지 않는다.
- lint/typecheck/test를 실행했으면 `도구 실행 결과` 섹션으로 분리해 보고하고, 리뷰 지적과 섞지 않는다 (`00-rule.md` 00-9).
- 개별 패스의 구조화 결과는 출력 전에 임의 축약하거나 버리지 않는다. aggregation은 parsed field를 유지한 채 병합·정렬만 하고, 최종 헤딩/섹션/표현은 renderer가 새로 만든다.
- 같은 규칙 ID로 finding이 둘 이상이면 C-7에 따라 `17-3 (1/2)` 형태로 순번을 붙인다.
- 패스에 적용 범위가 없으면 패스 이름, 사유, 그리고 `SKIPPED`가 비차단임을 명시해 `SKIPPED`로 출력한다.
- 모든 패스가 끝난 뒤에는 사용자가 다른 언어를 명시하지 않은 한 한국어로 전체 요약 리포트를 출력한다.
- 요약 저장은 `workflow-contract.md` C-7을 따른다 (`workflow-name`은 `full`).
- 프로젝트가 이미 다른 문서 저장 관례를 따르고 있으면 절대 경로를 강제하지 않는다.
- 일반/Props/수학/예외 producer 결과는 수집 직후 `workflow-contract.md` C-6A validation 규칙으로 검사한다. JSON 파싱 실패, 필수 필드 누락, 금지 필드 `severity`, 허용되지 않은 enum/location 값은 `malformed-output`이다.
- `malformed-output`이면 **같은 producer에 교정 재시도는 한 번만** 한다. 재시도 prompt에는 잘못된 점만 짧게 적고 다시 `REVIEW_RESULT_CONTRACT_V1` raw JSON 하나만 요구한다.
- 두 번째도 `malformed-output`이면 그 패스는 `FAILED malformed-output`으로 기록하고, 부분 보정이나 Markdown 해석으로 통과시키지 않는다. dispatch/result handling과 실패 기록은 이 skill이 책임진다.
- aggregation은 **검증을 통과한 JSON만** 입력으로 받는다. 이 단계에서는 parsed finding/openQuestion을 패스 라벨과 함께 정렬·중복 제거·그룹화할 뿐, Markdown 헤딩이나 severity 문자열을 읽거나 재사용하지 않는다.
- renderer가 구조화 필드에서 최종 문서를 생성한다. `####` 헤딩, 섹션 이름, 상태 표, `미해결 / 후속 확인` 항목, severity 이모지는 모두 renderer가 만든다.
- severity는 renderer output 단계에서만 `impact × confidence`로 파생한다. producer나 aggregation 단계에는 severity source field가 없다.

### 상세 지적 작성 규칙
- 사용자가 다른 언어를 명시하지 않은 한 모든 패스의 상세 지적과 최종 저장 문서는 한국어로 작성한다.
- 각 이슈는 일반 `code-review`와 같은 상세 스타일로 `문제 → 의도/현재 선택 → 왜 부족한지 → 개선 방향` 순서가 드러나게 쓴다.
- 동작 여부만 확인하지 말고 문제 정의, 의도, 선택 근거, 장기 변경 비용까지 함께 검토해 지적에 반영한다.
- 전체 요약은 추가 정보일 뿐이며, 패스별 상세 지적을 대체하거나 압축하지 않는다.
- 최종 저장 문서의 섹션 구성과 순서는 `workflow-contract.md` C-7 **문서 골격**을 그대로 따른다. `상세 지적`이 `요약`보다 앞이고, `판정`은 문서 앞쪽에 둔다.
- 문서 H1은 **`# {브랜치} 전체 코드 리뷰 리포트`** 다 (C-7). 쓰기 시작할 때 정하고, 다 쓴 뒤에 고치지 않는다.
- 골격 표에 없는 섹션을 새로 만들지 않는다. 남길 내용이 있으면 `미해결 / 후속 확인`에 넣는다.
- 모든 지적의 위치 표기는 `00-rule.md` 00-10을 따른다. **줄 번호는 diff hunk 헤더에서 계산하지 말고 파일을 읽어 확인하고, 그 줄의 코드를 한 줄 인용한다.** 각 모듈 sub-agent prompt에 이 요구를 명시해, 결과를 받은 뒤 번호를 정정하는 왕복이 생기지 않게 한다.

### 요약 내용
- 일반, Props, 수학, 예외 패스 상태 표를 포함한다.
- SKIPPED 사유를 요약 안에 함께 넣는다.
- 심각도는 🔴 오류, 🟡 경고, 🔵 정보 순으로 묶는다.
- 중복 제거된 지적, 출처 패스 라벨, `미해결 / 후속 확인 필요` 섹션을 포함한다.
- 특수 패스의 세부사항을 요약 안에 유지하고, 일반/Props/수학/예외 관찰을 하나의 일반 노트로 뭉개지 않는다.

### 중복 제거 규칙
- 이 워크플로우의 dedup 기준은 **`workflow-contract.md` C-6A aggregation** 이 정본이다. 여기서 더 약한 nearby-line 규칙을 만들지 않는다.
- 즉, 같은 `ruleId`, 같은 verified/deleted 정규화 위치, 같은 핵심 주장/근본 원인/깨지는 조건, 같은 `impact`/`category`, 같은 `confidence`일 때만 병합한다.
- `location.kind=unverified` finding과 `openQuestions`는 자동 병합하지 않는다. 각 항목을 자기 출처 패스 라벨과 함께 남긴다.
- 병합된 지적에는 모든 출처 패스 라벨을 유지한다.
- **병합이 성립한 지적은 두 축이 정의상 같으므로 severity도 그 두 축에서 그대로 파생한다** (`00-rule.md`의 **Severity 기준**). 심각도를 따로 고르거나 더 높은 쪽을 취하지 않는다 — severity는 독립 값이 아니라 계산값이다.
- 관련된 일반 지적이 이미 있다는 이유로 특수 세부사항을 버리지 않는다.
- 근본 원인, 범위, 특수 의미가 다르면 같은 파일을 건드려도 분리해서 둔다.

### 출처 라벨링
- 모든 지적은 출처 패스 라벨 `일반`, `Props`, `수학`, `예외` 중 하나를 유지해야 한다.
- 중복 제거된 지적이 여러 출처를 합치면 기여한 라벨을 모두 적는다.
- `SKIPPED` 항목도 패스 라벨을 유지해 어떤 패스가 실행되지 않았는지 요약에서 보이게 한다.

## 참고
- 이 스킬은 기존 리뷰 스킬에 덧붙이는 오케스트레이션 레이어다.
- 기존 리뷰 스킬의 의미를 바꾸지 않는다.
