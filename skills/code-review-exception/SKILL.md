---
name: code-review-exception
description: Use when the user invokes /code-review-exception or wants a standalone review focused on exception handling, error propagation, fallback, and recovery. Excluded from the default /code-review.
---

# Exception Handling Code Review

예외 처리, 에러 전파, fallback, 복구 흐름만 독립적으로 검토하는 전용 리뷰 모드다. 일반 코드 품질·아키텍처 검사와는 분리되며, `exception.md`가 숫자 prefix가 없으므로 일반 `/code-review`에서는 자동 제외된다.

## 공통 계약

`RULES_DIR` 해석, 범위 결정, 제외 경로, 실행 안전, 리포트 저장, 실패 보고는 **`$RULES_DIR/workflow-contract.md`** 를 따른다. 아래는 이 워크플로우의 차이다.

| 항목 | 이 워크플로우 |
|------|---------------|
| `workflow-name` | `exception` |
| 모듈 집합 | `$RULES_DIR/exception.md` 단일 문서 (숫자 prefix 모듈·다른 특수 문서 미로드) |
| 규칙 ID | `EX-{n}` |
| 범위 없음 | `SKIPPED`로 기록 (C-8) |

일반 리뷰가 필요하면 `/code-review` 또는 `/code-review-fast`를 별도로 실행한다.

## 검사 범위

- 빈 `catch`, 무음 실패, 의미 없는 fallback
- throw / Result / UI 상태 흡수 계약 불일치
- async, effect, event handler, timeout, subscription, callback 실패 처리 누락
- 사용자 안내와 개발자 진단 정보 분리 실패
- 입력·응답 검증 누락과 복구 경로 부재

## 실행 절차

### Step 1: Diff 범위 결정

범위 결정은 `workflow-contract.md` C-4를 따른다. 결정된 범위로 `git diff --stat $MERGE_BASE..HEAD`와 `git diff $MERGE_BASE..HEAD`를 확인한다. 제외 경로는 C-5를 따른다.

변경 파일 중 예외 처리, 에러 전파, fallback, 복구, 검증 로직이 바뀐 파일만 리뷰 대상으로 좁힌다. 관련 변경이 없으면 `SKIPPED`로 종료한다. repo-wide fallback 스캔은 하지 않는다.

### Step 2: Lint 확인 (read-only, 선택)

`00-rule.md` 00-9 실행 안전 계약을 따른다. lint가 설정돼 있으면 **수정 옵션 없이** 실행하고, 자동 수정은 사용자가 명시적으로 요청했을 때만 한다. exception 리뷰는 lint와 별도 축이므로 lint가 없어도 그대로 진행 가능하다.

### Step 3: 단일 Sub-Agent Dispatch

**단 하나의 sub-agent**만 dispatch한다. `run_in_background=false`로 즉시 실행한다.

```
task(
  category="unspecified-high",
  load_skills=[],
  description="Exception Handling Code Review",
  prompt="아래 지시에 따라 예외 처리 코드 리뷰를 수행하세요.

## 리뷰 대상
- 기준: {MERGE_BASE}
- 대상: HEAD
- 변경 파일 (exception/error-handling 관련 파일만): {CHANGED_EXCEPTION_FILES}

## 리뷰 수행 방법
1. `git diff {MERGE_BASE}..HEAD` 로 전체 diff 확인
2. 변경 파일을 직접 읽어서 예외 처리, 에러 전파, fallback, 복구 흐름을 추적
3. 아래 리뷰 규칙 전체를 적용해 위반 사항 탐지
4. 실패 시나리오를 실제로 추적하고, 무음 실패/잘못된 성공 해석이 생기는지 확인

## 리뷰 규칙
아래 파일을 먼저 Read 한 뒤 그 규칙을 기반으로 리뷰하세요:
- `{RULES_DIR}/exception.md`

이 문서 하나만 사용합니다. 같은 폴더의 숫자 prefix 모듈과 `fast.md`, `math.md`, `props.md`는 참조하지 마세요.

## 출력 원칙
- 사용자가 다른 언어를 명시하지 않은 한 모든 리뷰 결과/코멘트/리포트는 한국어로 작성하세요.
- `REVIEW_RESULT_CONTRACT_V1`만 사용하고 응답은 Markdown, 코드펜스, 서문 없이 **raw JSON 객체 하나만** 반환하세요.
- `REVIEW_RESULT_CONTRACT_V1_PRODUCER_OUTPUT` marker를 따르는 producer라고 생각하고 heading/table/raw HTML/link를 직접 만들려고 하지 마세요. 문자열 필드는 최종 리포트의 신뢰된 Markdown이 아니라 untrusted content 입니다.
- top-level `schemaVersion`, `findings`, `openQuestions`를 항상 포함하고 `schemaVersion`은 반드시 `1`이어야 합니다.
- `findings`와 `openQuestions`는 빈 결과여도 배열로 반환하세요.
- `severity`는 어떤 depth에도 넣지 마세요. 이 패스는 `impact`와 `confidence`만 판정합니다.
- 위치와 규칙 번호(`EX-x`)를 finding/openQuestion 안에 포함하세요 — `exception.md`의 표기와 정확히 일치해야 합니다.
- 위치는 **해당 파일을 읽어 확인한 변경 후 줄 번호**를 적고, 그 줄의 코드를 한 줄 인용하세요. diff hunk 헤더(`@@`)에서 계산한 번호는 어긋납니다. 확인이 안 되면 번호를 추측하지 말고 `위치 미확인`으로 적으세요
- diff에 없는 기존 예외 흐름은 지적 금지
- `00-rule.md` 00-11에 걸리는 unresolved absence/possibility claim, search scope 미완료, 추가 탐색 요청만 `openQuestions`로 보내세요. 결함은 성립하지만 exact location만 확인하지 못했으면 finding을 유지하고 `location.kind="unverified"`와 `reason`만 사용하세요.
- 실패 시나리오, 잘못된 성공 해석, fallback/복구 방향 같은 도메인별 설명은 새 필드를 만들지 말고 `body`, `recommendation`, `evidence`에 담으세요.
 )
```

### Step 4: 결과 전달

sub-agent 응답을 받은 즉시 `workflow-contract.md` C-6A와 `00-rule.md`의 `REVIEW_RESULT_CONTRACT_V1`으로 검증한다. JSON 파싱 실패, 필수 필드 누락, `severity` 포함, 허용되지 않은 값은 `malformed-output`이다.

`malformed-output`이면 이 skill이 잘못된 점만 짧게 적어 **교정 재시도 1회**를 수행한다. 재시도에도 실패하면 `FAILED malformed-output`으로 종료하고 임의 보정이나 Markdown 해석으로 통과시키지 않는다. 검증을 통과한 JSON만 최종 결과로 전달하고, standalone 렌더링에서도 severity는 이 skill이 `impact × confidence`로 계산한다.

### Step 5: 문서 저장

리포트 저장은 `workflow-contract.md` C-7을 따른다 (`workflow-name`은 `exception`). 문서 내용은 **이번 브랜치 diff 안에서 예외 처리/에러 전파가 바뀐 파일과 그 실패 흐름 이슈** 중심으로 쓴다.

## 사용법

```
/code-review-exception                    — 현재 브랜치의 예외 처리 리뷰
/code-review-exception main..feature/x    — 특정 범위 리뷰
```

## 주의사항

- 이 모드는 일반 코드 품질·아키텍처를 검사하지 않는다. 그쪽은 `/code-review` 또는 `/code-review-fast`로 별도 실행
- 변경 파일에 예외 처리/에러 전파/복구 변경이 없으면 `SKIPPED`로 즉시 종료
- `exception.md`는 숫자 prefix가 없어 `/code-review`의 자동 모듈 스캔에서 제외된다
- repo-wide fallback 스캔으로 범위를 넓히지 않는다
