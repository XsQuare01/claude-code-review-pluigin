---
name: code-review-qualitative
description: Use when the user invokes /code-review-qualitative or wants a qualitative (non line-level) review that scores a diff on 1~5 rubrics via an LLM-as-a-judge panel — architecture appropriateness and consistency/convention fit. Excluded from the default /code-review.
---

# Qualitative Rubric Code Review (LLM-as-a-judge)

diff 전체의 **정성 품질**을 1~5 척도로 채점하는 특수 리뷰 모드. 라인별 위반을 잡는 일반 모드와 분리되며, 일반 `/code-review`에서는 자동 제외된다.

## 룰 문서 위치

- **정성 루브릭 전용**: `~/.claude/review-rules/qualitative.md` — 이 skill에서만 사용
- 같은 폴더의 숫자 prefix 모듈(`00-rule.md` 등), `fast.md`, `math.md`는 **참조하지 않는다**
- 라인별 버그·타입·아키텍처 위반 리뷰가 필요하면 `/code-review`를 별도 실행한다

## 평가 축 (1~5, anchored)

- **A. 아키텍처 적절성** — over/under-engineering 균형, 확장성
- **B. 일관성·관습 정합** — 주변 코드 패턴·네이밍·컨벤션과의 정합

각 축의 1~5 anchor 기준과 채점 정책은 `qualitative.md`에 정의돼 있다.

## 핵심 원칙 (직교성)

라인 버그·타입 오류·보안 결함은 **점수에 반영하지 않는다**. 이 모드는 오직 정성 품질만 본다.

## 실행 절차

### Step 1: Diff 범위 결정

```bash
BASE_BRANCH=dev
MERGE_BASE=$(git merge-base $BASE_BRANCH HEAD)
git diff --stat $MERGE_BASE..HEAD
git diff $MERGE_BASE..HEAD
```

사용자가 범위를 지정하면 그것을 사용. 미지정 시 `dev` 기준. **빈 diff면 리뷰하지 않고 종료**. 변경 파일에서 테스트/목 경로(`__test__/**`, `*.test.*`, `mock*/**`, `fixtures/**` 등)는 제외한다.

### Step 2: Lint (선택)

정성 리뷰는 lint와 별개 축이므로 lint가 없어도 그대로 진행한다.

### Step 3: 심사 패널 Dispatch (judge 5명)

동일 프롬프트·동일 diff로 **judge sub-agent 5명**을 dispatch한다. judge 간 정보 공유는 없다(독립성 유지). `run_in_background`로 병렬 실행한다.

각 judge에게 보내는 프롬프트:

```
아래 지시에 따라 정성 코드 리뷰 채점을 수행하세요. 당신은 5명 심사 패널 중 1명입니다.

## 리뷰 대상
- 기준: {MERGE_BASE}
- 대상: HEAD
- 변경 파일(테스트/목 제외): {CHANGED_FILES}

## 채점 방법
1. `git diff {MERGE_BASE}..HEAD` 로 전체 diff를 확인하세요
2. 변경 파일을 직접 읽어 컨텍스트를 파악하세요
3. 먼저 아래 루브릭 문서를 Read 하세요:
   - `~/.claude/review-rules/qualitative.md`
   이 문서 하나만 사용합니다. 숫자 prefix 모듈·fast.md·math.md는 참조하지 마세요.
4. 두 축(A 아키텍처 적절성, B 일관성·관습 정합)을 anchor 표 기준으로 채점하세요
5. 모든 축은 기본 3점에서 시작하고, diff에서 구체적 근거를 인용했을 때만 올리거나 내리세요
6. 반드시 근거(파일:라인) → 점수 순서로 쓰세요. 점수는 1~5 정수만
7. 라인 버그·타입·보안 결함은 점수에 반영하지 마세요(직교성)

## 출력 형식 (정확히 이 형식으로)
### 축 A — 아키텍처 적절성
- 근거:
  - path:line — 근거
- 점수: N
- 개선안: (점수 4 미만이면 필수)

### 축 B — 일관성·관습 정합
- 근거:
  - path:line — 근거
- 점수: N
- 개선안: (점수 4 미만이면 필수)
```

### Step 4: 집계

5명의 축별 점수를 모아 계산한다:

- 대표 점수 = 축별 5개 점수의 **중앙값(median)** (정렬 후 3번째 값)
- spread = max - min
- 합의도: spread ≤ 1 높음 / = 2 보통 / ≥ 3 낮음(주의)
- 판정: 중앙값 ≥ 4 🟢 양호 / = 3 🟡 보통 / < 3 🔴 개선 필요
- 머지 가능 여부: 🔴 축 ≥ 1 → 수정 후 가능, 0 → 가능
- 대표 점수 4 미만인 축은 5명 개선안을 중복 제거·병합

### Step 5: 최종 리포트 출력 및 저장

아래 형식으로 출력하고 `./review-reports/code-review-qualitative-{branch-name}-{date}.md`로 저장한다. 기존 리뷰 문서가 있어도 항상 새로 작성한다. `workflow-name`은 `qualitative`. 사용자가 다른 언어를 명시하지 않으면 한국어.

```markdown
# 정성 코드 리뷰 리포트 (LLM-as-a-judge)

> 기준: {MERGE_BASE} | 대상: HEAD | 리뷰 시각: {TIMESTAMP}
> 변경 파일: {N}개 | 심사 패널: 5명

## 종합

| 축 | 대표 점수(중앙값) | 점수 분포(5명) | spread | 합의도 | 판정 |
|---|---|---|---|---|---|
| 아키텍처 적절성 | 3 | [2,3,3,3,4] | 2 | 보통 | 🟡 보통 |
| 일관성·관습 정합 | 4 | [4,4,4,5,4] | 1 | 높음 | 🟢 양호 |

**머지 가능 여부**: 🔴 0개 → 가능

## 축별 상세

### 아키텍처 적절성 — 🟡 3점 (보통)
**근거**
- path:line — ...
**개선안**
- ...

### 일관성·관습 정합 — 🟢 4점 (양호)
...

## 합의 낮음 플래그 (spread ≥ 3인 축이 있을 때만)
- (점수가 엇갈린 이유와 재검토 권고)
```

## 사용법

```
/code-review-qualitative                    — 현재 브랜치의 정성 품질 채점
/code-review-qualitative main..feature/x     — 특정 범위 채점
```

## 주의사항

- 이 모드는 라인별 버그·타입·보안을 검사하지 않는다. 그쪽은 `/code-review`로 별도 실행.
- 빈 diff면 "대상 없음"으로 즉시 종료.
- `qualitative.md`는 숫자 prefix가 없어 `/code-review` 자동 모듈 스캔에서 제외됨(컨벤션 분리).
- 향후 정성 축(가독성, 응집도 등)을 추가할 때도 `qualitative.md`에 anchor 표만 추가하면 된다.
