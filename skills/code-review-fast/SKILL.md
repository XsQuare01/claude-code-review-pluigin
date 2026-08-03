---
name: code-review-fast
description: Use when the user wants a faster, shorter code review that highlights only the most important issue per file. Uses a single compressed rule document and a single sub-agent for minimum latency.
---

# Fast Code Review

짧고 빠른 코드 리뷰 모드. `/code-review`와 달리 **압축된 단일 룰 문서(`fast.md`)** 를 기반으로 **단일 sub-agent** 가 한 번에 전체를 검토한다. 숫자 prefix 상세 모듈을 전혀 로드하지 않아 sub-agent 오버헤드와 tail latency를 제거한 저지연 경로이며, 큐 포화(queue saturation), tail latency, timeout 위험이 우려될 때 적합하다.

## 핵심 원칙

1. 단일 룰 문서를 읽고, **출력은 high-signal만** 남긴다
2. 같은 파일에서 여러 이슈가 보여도 **가장 중요한 것 1개만** 남긴다
3. 사소한 스타일, 중복 설명, 비슷한 지적 반복은 버린다
4. 리뷰 결과는 **짧게**, 보통 파일당 1줄~2줄 수준으로 끝낸다

## 룰 문서 위치

`RULES_DIR`은 다음 순서로 존재하는 첫 번째 디렉터리다: `${CLAUDE_PLUGIN_ROOT}/review-rules/` → `./review-rules/` → `~/.claude/review-rules/`.

- **Fast 전용**: `$RULES_DIR/fast.md` — 이 skill에서만 사용하는 압축본 (상세 모듈과 같은 폴더에 함께 위치)
- 같은 폴더의 숫자 prefix 상세 모듈은 **참조하지 않는다**. 상세/포괄적 리뷰가 필요하면 `/code-review-full`을 쓴다.

## 실행 절차

### Step 1: Diff 범위 결정

```bash
for candidate in dev main master; do
  if git rev-parse --verify --quiet "$candidate" >/dev/null; then
    BASE_BRANCH=$candidate; break
  fi
done
BASE_BRANCH=${BASE_BRANCH:-$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's|origin/||')}
MERGE_BASE=$(git merge-base $BASE_BRANCH HEAD)
git diff --stat $MERGE_BASE..HEAD
git diff $MERGE_BASE..HEAD
```

사용자가 특정 범위를 지정하면 그것을 사용한다. 지정하지 않았고 후보 브랜치가 모두 없으면 사용자에게 base를 묻는다. 빈 diff면 리뷰를 수행하지 않는다.

### Step 2: Lint 자동 수정

- `package.json`/lint config에서 lint 명령 확인
- `lint:fix` 또는 ESLint `--fix` 가능하면 먼저 실행
- 자동 수정 후 남은 문제만 리뷰 대상

### Step 3: 단일 Sub-Agent Dispatch

**단 하나의 sub-agent**만 dispatch한다. `run_in_background=false`로 즉시 실행.

```
task(
  category="unspecified-high",
  load_skills=[],
  description="Fast Code Review (single pass)",
  prompt="아래 지시에 따라 빠른 코드 리뷰를 수행하세요.

## 리뷰 대상
- 기준: {MERGE_BASE}
- 대상: HEAD
- 변경 파일: {CHANGED_FILES}

## 리뷰 수행 방법
1. `git diff {MERGE_BASE}..HEAD` 로 전체 diff 확인
2. 변경된 파일들을 직접 읽어서 컨텍스트 파악
3. 아래 리뷰 규칙 전체를 적용해 위반 사항 탐지
4. 출력은 파일별 가장 중요한 이슈 1개만
5. 파일 전체를 읽더라도 **지적은 diff에 포함된 변경 라인** 또는 그 변경 때문에 직접 깨진 **인접 라인/구조**로 제한

## 리뷰 규칙
아래 파일을 먼저 Read 한 뒤 그 규칙을 기반으로 리뷰하세요:
- `{RULES_DIR}/fast.md`

이 문서 하나만 사용합니다. 같은 폴더의 숫자 prefix 상세 모듈은 참조하지 마세요.
규칙 ID는 `fast.md`가 지시하는 대로 파일 prefix와 일치하는 형식(`03-1`, `16-2`, `10-SSOT`)으로 표기하세요.

## 출력 원칙
- 사용자가 다른 언어를 명시하지 않은 한 모든 리뷰 결과/코멘트/리포트는 한국어로 작성하세요.
- 같은 파일에서 여러 위반이 보이면 가장 심각한 것 1개만 출력
- severity 우선순위: 🔴 > 🟡 > 🔵
- 단순 스타일, 반복 지적, 영향이 작은 코멘트는 생략
- 이슈가 없는 파일은 출력에서 제외
- diff에 포함되지 않은 기존 코드는 지적 금지
- 파일 전체를 읽었다는 이유로 리뷰 범위를 파일 전체로 넓히지 말 것
- 추측 금지 — 실제 코드를 읽고 확인
- 가능하면 각 이슈는 **문제 → 현재 선택 → 왜 부족한지**가 드러나게 쓴다

## 출력 형식 (마크다운)

# 빠른 코드 리뷰 리포트

> **기준**: {MERGE_BASE} | **대상**: HEAD
> **변경 파일**: {N}개

## 한눈에 보기
- 🔴: N개 / 🟡: N개 / 🔵: N개
- 머지 전 반드시 볼 파일: {N}개

## 파일별 핵심 이슈

| 심각도 | 파일 | 핵심 이슈 | 이유 | 개선 방향 |
|----------|------|----------|------|------------|
| 🔴 | path/to/file | ... | ... | ... |

## 통과
- (이슈 없는 파일 리스트, 또는 '전부 통과' 요약)

**머지 가능 여부**: 🔴 {N}개 → {가능/불가/수정 후 가능}"
)
```

### Step 4: 결과 전달

sub-agent의 출력을 그대로 사용자에게 전달한다. 추가 편집/재정렬은 하지 않는다 (fast 취지). 다만 명백한 형식 오류가 있으면 짧게 보정한다.

### Step 5: 문서 저장

리포트는 기본적으로 `./review-reports/code-review-fast-{branch-name}-{date}.md`로 저장하고 경로를 보고한다. 문서 내용은 **이번 브랜치에서 바뀐 파일별 핵심 이슈** 중심으로 유지하고, 일반 설명은 최소화한다. 기존 리뷰 문서가 이미 있어도 그 문서를 이유로 리뷰를 건너뛰지 말고 **항상 새 리뷰를 수행한 뒤 새 파일로 저장**한다. 이 워크플로우의 `workflow-name`은 `fast`다.

## 사용법

```
/code-review-fast                    — 현재 브랜치 전체 빠른 리뷰
/code-review-fast main..feature/x    — 특정 범위 빠른 리뷰
```

모듈 단위 축소(`--module ...`)는 이 모드에서 더 이상 지원하지 않는다. 단일 에이전트 + 단일 압축 문서 구조이므로 모듈 선택은 무의미하다. 특정 주제만 보고 싶다면 사용자가 프롬프트로 지시한다 (예: "타입 안전성만 집중해서 봐줘").

## 주의사항

- 이 모드는 완전한 리뷰 대신 **우선순위 높은 지적만 빠르게 보는 저지연/timeout-safe 경로**다
- 큐 포화(queue saturation), tail latency, timeout 위험이 우려될 때 이 모드를 사용한다
- 상세/포괄적 리뷰가 필요하면 `/code-review-full`을 사용한다
- fast 룰 문서(`fast.md`)는 숫자 prefix 상세 모듈 전체의 압축본이며, 모듈이 추가·삭제·재배치되면 fast.md의 해당 섹션도 함께 갱신해야 한다. 압축하면서 원본의 예외 조항을 빠뜨리면 오탐이 생긴다
- 빈 diff면 리뷰를 수행하지 않는다
- lint 자동 수정이 가능한 항목은 리뷰 전에 반영하고, 남은 핵심 이슈만 다룬다
