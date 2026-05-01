---
name: code-review-commit
description: Use when the user wants to review a single commit, invokes /code-review-commit, or needs commit-level feedback instead of whole-branch review. Runs the same modular multi-pass review as /code-review, but scopes the diff to one commit.
---

# Single-Commit Code Review

하나의 커밋만 정밀 리뷰하는 모드. 일반 `/code-review`가 브랜치 전체 diff를 보는 것과 달리, 이 skill은 **지정한 단일 커밋 1개**의 patch만 리뷰 대상으로 삼는다. 리뷰 규칙과 결과 통합 방식은 `/code-review`와 동일하게 유지해, 범위만 더 좁고 명확하게 만든 버전이다.

## 리뷰 규칙 위치

`~/.claude/review-rules/` — 숫자 prefix가 붙은 `.md` 파일만 리뷰 모듈로 간주. 파일명 앞 숫자는 실행 순서이며, `00-rule.md`가 항상 최우선이다.

**자동 모듈 스캔에서 제외되는 파일**: 숫자 prefix가 없는 파일(예: `fast.md`, `math.md`)은 특수 워크플로우(`/code-review-fast`, `/code-review-math`) 전용이며, 이 skill에서도 로드하지 않는다.

## 실행 절차

### Step 1: 대상 커밋 결정 및 유효성 확인

기본값은 `HEAD`다. 사용자가 커밋 해시를 주면 그 커밋을 사용한다.

```bash
# 기본: 마지막 커밋 리뷰
TARGET_COMMIT=HEAD

# 사용자가 명시한 경우: TARGET_COMMIT=<sha>

# 커밋 메타데이터 + 변경 통계 확인
git show --stat $TARGET_COMMIT
```

리뷰 범위는 **브랜치 전체가 아니라 해당 커밋 1개의 patch**다. 이 skill에서는 범위를 `git show {TARGET_COMMIT}` 기준으로 통일한다. root commit처럼 부모가 없는 경우에도 같은 방식으로 그대로 리뷰한다.

merge commit 은 기본적으로 리뷰 대상에서 제외한다. `git show <merge-sha>` 의 combined diff 는 일반 커밋 patch 와 의미가 다르므로, merge commit 이 들어오면 "지원하지 않는 대상"으로 종료하고 일반 `/code-review` 또는 수동 범위 리뷰를 안내한다.

### Step 2: 변경 파일 목록 확인

```bash
git show --name-only --format=oneline $TARGET_COMMIT
```

빈 변경이거나 patch를 얻을 수 없으면 리뷰를 수행하지 않는다.

### Step 3: Lint 확인 및 자동 수정

이 단계는 `TARGET_COMMIT == HEAD` 인 경우에만 수행한다. 과거 커밋(`HEAD~N`, 직접 지정한 `<sha>`)을 리뷰할 때는 현재 working tree 기준 lint 결과가 섞여 오탐을 만들 수 있으므로 건너뛴다.

- `TARGET_COMMIT == HEAD` 일 때만 `package.json`, lint config, CI/workflow 파일에서 실제 lint 명령을 찾는다
- `TARGET_COMMIT == HEAD` 이고 `lint:fix` 같은 자동 수정 스크립트가 있으면 먼저 실행한다
- 별도 `lint:fix`가 없어도 ESLint 기반이면 기존 lint 명령에 `--fix`를 붙인 동등 명령을 사용해 자동 수정 가능한 문제를 먼저 정리한다
- 자동 수정 후에는 lint를 다시 실행해 남은 오류를 확인한다
- 자동 수정으로 해결된 문제는 리뷰 이슈로 장황하게 반복하지 말고, 남은 위반이나 구조적 문제에 집중한다
- `TARGET_COMMIT != HEAD` 이면 lint 자동 수정/재실행은 하지 말고, 리뷰 모듈이 commit patch 안에서 직접 보이는 lint성 문제만 지적하게 둔다

### Step 4: 리뷰 모듈 목록 확인

```bash
ls ~/.claude/review-rules/[0-9]*.md
```

`/code-review`와 동일하게 **숫자 prefix가 붙은 파일만** 리뷰 패스로 사용한다.

### Step 5: 병렬 Sub-Agent Dispatch

**각 리뷰 모듈마다** 하나의 sub-agent를 `run_in_background=true`로 dispatch한다.

```
task(
  category="unspecified-high",
  load_skills=[],
  run_in_background=true,
  description="Commit Review: {MODULE_NAME}",
  prompt="아래 지시에 따라 단일 커밋 코드 리뷰를 수행하세요.

## 리뷰 대상
- Commit: {TARGET_COMMIT}
- 변경 파일: {CHANGED_FILES}

## 리뷰 수행 방법
1. `git show --format=medium {TARGET_COMMIT}` 로 커밋 patch 전체를 확인하세요
2. 변경된 파일들을 직접 읽어서 컨텍스트를 파악하세요
3. 아래 리뷰 규칙에 따라 위반 사항을 찾으세요
4. 위반이 없는 규칙은 출력하지 마세요
5. 반드시 **이 커밋 patch 안의 변경 라인만** 지적하세요
6. root commit 도 동일하게 `git show {TARGET_COMMIT}` 기준으로 해석하세요
7. 동작 여부만 보지 말고, 문제 정의·의도·선택 근거·장기 변경 비용까지 함께 검토하세요

## 리뷰 규칙
{RULES_CONTENT — 해당 .md 파일 전체 내용}

## 출력 형식
위반 사항만 아래 형식으로 출력하세요. 위반이 없으면 '위반 없음'만 출력.
가능하면 각 이슈는 **문제 → 현재 선택 → 왜 부족한지**가 드러나게 쓰세요.

### [모듈명]

| Severity | Rule | 위치 | 이슈 | 개선 제안 |
|----------|------|------|------|----------|
| 🔴/🟡/🔵 | 규칙번호 | 파일:라인 | 구체적 위반(문제/현재 선택/부족한 이유 포함) | 수정 방향 |

## 금지 사항
- 이 커밋 diff에 포함되지 않은 기존 코드를 지적하지 마세요
- 부모 커밋이나 이후 커밋의 변경을 섞지 마세요
- 추측으로 지적하지 마세요 — 실제 코드를 읽고 확인하세요
- 위반이 아닌 것을 억지로 찾지 마세요"
)
```

**중요**: 모든 sub-agent를 동시에 dispatch한 뒤, 완료 알림을 기다린다. 순차 실행하지 않는다.

### Step 6: 결과 수집 및 통합

모든 sub-agent 완료 후:

1. `background_output(task_id="...")` 로 각 결과 수집
2. 결과를 severity 순서로 병합: 🔴 ERROR → 🟡 WARNING → 🔵 INFO
3. 같은 severity 내에서는 모듈 순서대로 정렬
4. 위반 없는 모듈은 최하단에 "✅ 통과" 로 요약

### Step 7: 최종 리포트 출력

```markdown
# Commit Code Review Report

> **Commit**: {TARGET_COMMIT} | **리뷰 시각**: {TIMESTAMP}
> **변경 파일**: {N}개 | **리뷰 모듈**: {M}개

## 🔴 ERROR (커밋 수정 필수)

| Module | Rule | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| ... | ... | ... | ... | ... |

## 🟡 WARNING (수정 권장)

| Module | Rule | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| ... | ... | ... | ... | ... |

## 🔵 INFO (개선 제안)

| Module | Rule | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| ... | ... | ... | ... | ... |

## 요약

| 모듈 | 🔴 | 🟡 | 🔵 | 결과 |
|------|-----|-----|-----|------|
| FSD 아키텍처 | 0 | 1 | 0 | ⚠️ |
| 타입 안전성 | 0 | 0 | 0 | ✅ |
| ... | ... | ... | ... | ... |

**권장 액션**: 🔴 {N}개 → {Accept / Amend 권장 / Fixup 필요}
```

최종 리포트는 기본적으로 `.md` 파일로 저장한다. 저장 경로는 `C:\Users\bhmun\OneDrive\바탕 화면\Docs\code-review-commit-{branch-name}-{date}.md`를 우선 사용한다. 문서 내용은 **해당 커밋 patch 안에서 실제로 바뀐 내용** 중심으로 쓰고, 다른 커밋/브랜치의 일반론은 넣지 않는다. 기존 리뷰 문서가 이미 있어도 그 문서를 이유로 리뷰를 건너뛰지 말고 **항상 새 리뷰를 수행한 뒤 새 파일로 저장**한다. 이 워크플로우의 기본 `workflow-name`은 `commit`이다.

## 사용법

```
/code-review-commit         — 마지막 커밋(HEAD) 리뷰
/code-review-commit HEAD~2  — 특정 커밋 1개 리뷰
/code-review-commit <sha>   — 지정한 커밋 해시 리뷰
```

브랜치 전체가 아니라 **정확히 하나의 커밋**만 본다. 여러 커밋 범위를 보고 싶으면 `/code-review`, `/code-review-fast` 또는 범위를 직접 지정한 일반 리뷰를 사용한다.

## 주의사항

- 각 sub-agent는 독립적 — 서로의 결과를 참조하지 않는다
- merge commit 은 기본적으로 지원하지 않는다. 그런 경우 일반 `/code-review` 또는 명시적 범위 리뷰로 전환한다
- 이 skill은 commit patch 기준이므로, 이후 커밋에서 수정된 문제까지 미리 반영해서 판단하지 않는다
- diff에 포함되지 않은 기존 코드는 리뷰 대상이 아니다
- fixup/squash 전 개별 커밋 품질을 점검할 때 특히 유용하다
- `HEAD` 리뷰일 때만 lint를 먼저 확인하고, 자동 수정 가능한 항목은 선반영한 뒤 남은 문제만 리뷰한다
