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

## 오케스트레이션
1. 변경 집합만 기준으로 리뷰 범위를 결정한다.
    - `dev` 브랜치가 있으면 그 merge-base를 우선 사용한다.
    - 그 기준 이후 변경된 파일만 리뷰한다.
    - lint/autofix는 기존 리뷰 skill들과 같은 방향으로 맞춘다: 판단 전에 자동 수정 가능한 노이즈는 정리하되, 그 때문에 범위를 넓히지는 않는다.
2. 패스 순서는 일반 → Props → 수학 → 예외 → 요약/리포팅이다.
3. 일반 패스 규칙.
    - 일반 패스는 단일 general review가 아니다. 숫자 prefix 모듈별 리뷰를 유지하되, 큐 포화와 timeout을 피하기 위해 bounded wave 방식으로 실행한다.
    - `RULES_DIR`(`${CLAUDE_PLUGIN_ROOT}/review-rules/` → `./review-rules/` → `~/.claude/review-rules/` 순으로 존재하는 첫 번째)의 `[0-9]*.md`를 반드시 스캔하고, 발견된 숫자 prefix 파일 각각을 필수 일반 리뷰 모듈로 간주한다. 모듈 목록을 파일명으로 하드코딩하지 않는다.
    - `00-rule.md`는 모든 일반 모듈보다 먼저 읽고, 모든 일반 모듈에 우선 적용하는 공통 규칙으로 전달한다.
    - 각 숫자 prefix 모듈마다 별도의 sub-agent 하나를 사용하되, 한 wave에서 실행하는 일반 모듈은 **최대 2개(max concurrency 2)** 로 제한한다. 다음 wave는 직전 wave의 결과 수집이 끝난 뒤 시작한다.
    - `props.md`, `math.md`, `exception.md`, `fast.md`, 그리고 숫자 prefix가 없는 모든 파일은 일반 패스에서 명시적으로 제외한다.
    - 모든 숫자 prefix 모듈 결과를 수집해야 일반 패스가 완료된다. 누락, 실패, timeout, inactivity timeout, queue expiry가 발생한 숫자 prefix 모듈이 있으면 완료된 리뷰가 아니라 `FAILED orchestration`으로 처리한다.
    - 일부 wave 또는 모듈이 실패해도 이미 완료된 모듈 결과는 수집해 partial result로 보존한다. 단, 실패/누락/timeout 모듈 목록을 명시하고 전체 리뷰를 fully complete로 요약하지 않는다.
    - 숫자 prefix 모듈 중 `01-fsd.md` 또는 `20-deletion-regression.md`가 존재하는데 실행/수집되지 않으면 architecture/deletion-regression coverage 누락으로 보고 `FAILED orchestration` 처리한다.
    - 별도 architecture 또는 deletion-regression summary agent로 `01-fsd.md`/`20-deletion-regression.md` 결과를 대체하지 않는다. 해당 지적은 반드시 숫자 모듈 결과로 유지한다.
    - 일반 패스를 하나의 summary/general agent로 대체하거나 Props/수학/예외만 실행해서 일반 패스를 생략해서는 안 된다.
    - 변경된 파일만 평가하고 diff 밖 저장소 전체는 스캔하지 않는다.
    - 일반 코드 리뷰 패스에서 테스트/목 전용 경로를 제외한다: `__test__/**`, `__tests__/**`, `*.test.*`, `*.spec.*`, `__mocks__/**`, `mock/**`, `mocks/**`, `*.mock.*`, 전용 fixture/mock-data 자산.

### 일반 모듈 실행 및 liveness failover 정책
- 일반 패스의 모든 숫자 prefix 모듈은 initial dispatch부터 `subagent_type=general`, `run_in_background=true`로 실행한다. 동기 실행으로 시작한 뒤 background로 전환하지 않는다.
- 숫자 prefix 모듈마다 별도의 sub-agent 하나를 반드시 유지한다. max concurrency는 정확히 2이며, fast review, generic summary, 또는 다른 모듈이 누락된 숫자 모듈을 대체할 수 없다. 특히 `01-fsd.md`와 `20-deletion-regression.md`는 다른 architecture/deletion-regression 요약으로 대체하지 않는다.
- 각 모듈 상태는 `PENDING → DISPATCHED → COMPLETED or fresh retry → FAILED_ORCHESTRATION` 순서로 기록한다.
- no-start, timeout, inactivity timeout, queue expiry, empty/missing result, `Task not found for session` 또는 session loss가 발생하면 해당 모듈은 죽은 세션으로 간주하고, fresh `general` background task로 최대 1회만 retry한다. dead/no-event/lost session은 `session_id`로 resume하지 않으며, synchronous task를 background task로 변환하지 않는다.
- 정상 완료된 응답이 clarification만 요구하는 경우에는 live session을 재사용할 수 있다. 단, no-start, timeout, inactivity timeout, queue expiry, empty/missing result, `Task not found for session`, session loss 클래스는 live session으로 보지 않으며 재사용하지 않는다.
- 런타임이 first-event 또는 heartbeat 관측을 지원하면 bounded startup window 안에서 첫 이벤트를 확인한다. 현재 task API처럼 completion/error notification만 노출되는 런타임에서는 첫 timeout, expiry, error에 반응하고 같은 session에 두 번째 long wait를 쓰지 않는다.
- 각 숫자 모듈마다 가능한 경우 task ID, session ID, attempt count, last observed event/result, failure class를 기록한다.
- 다음 wave는 현재 wave의 두 모듈이 모두 `COMPLETED` 또는 terminal `FAILED_ORCHESTRATION` 상태가 된 뒤에만 시작한다.
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
- 일반 패스 리포트는 `RULES_DIR`의 `[0-9]*.md`에서 발견한 모든 숫자 prefix 모듈명을 나열하고, 모듈별 sub-agent 결과를 각각 표시한다.
- 숫자 prefix 모듈 중 실행 또는 수집이 누락된 항목이 있으면 `FAILED orchestration`으로 표시하고, 완료된 리뷰처럼 요약하지 않는다.
- 개별 패스 리포트를 출력 전에 다시 쓰거나 압축하거나 합치지 않는다.
- 패스에 적용 범위가 없으면 패스 이름, 사유, 그리고 `SKIPPED`가 비차단임을 명시해 `SKIPPED`로 출력한다.
- 모든 패스가 끝난 뒤에는 사용자가 다른 언어를 명시하지 않은 한 한국어로 전체 요약 리포트를 출력한다.
- 요약은 기존 review-doc 관례를 따라 실용적인 파일명 예시 `./review-reports/code-review-full-{branch-name}-{date}.md`로 저장한다.
- sibling review skill들과 같은 문서 저장 관례를 유지하고, 프로젝트가 이미 관례를 따르고 있으면 절대 경로를 강제하지 않는다.

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
