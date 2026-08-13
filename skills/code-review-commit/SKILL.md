---
name: code-review-commit
description: Use when the user wants to review a single commit, invokes /code-review-commit, or needs commit-level feedback instead of whole-branch review. Runs the same modular multi-pass review as /code-review, but scopes the diff to one commit.
---

# Single-Commit Code Review

하나의 커밋만 정밀 리뷰하는 모드. 일반 `/code-review`가 브랜치 전체 diff를 보는 것과 달리, 이 skill은 **지정한 단일 커밋 1개**의 patch만 리뷰 대상으로 삼는다. 리뷰 규칙과 결과 통합 방식은 `/code-review`와 동일하게 유지해, 범위만 더 좁고 명확하게 만든 버전이다.

## 공통 계약

`RULES_DIR` 해석, 모듈 탐색, 적용 조건 판정, 제외 경로, 실행 안전, 리포트 저장, 실패 보고는 **`$RULES_DIR/workflow-contract.md`** 를 따른다. 아래는 이 워크플로우의 차이다.

| 항목 | 이 워크플로우 |
|------|---------------|
| `workflow-name` | `commit` |
| 범위 결정 | C-4의 merge-base 대신 **단일 커밋 patch** (Step 1) |
| 모듈 집합 | numbered non-00 전체 |
| 분할 방식 | 단일 통합 pass |

이 워크플로우는 **legacy producer workflow**다. `workflow-contract.md`의 ownership matrix에서 legacy로 유지되며, C-6A의 structured lifecycle은 여기 적용하지 않는다. 기존 producer 계약을 유지한다.

리뷰를 시작할 때 `workflow-contract.md`에서 이 워크플로우에 필요한 orchestration/public report skeleton만 확인한다. legacy workflow이므로 effective reviewer prompt에는 structured manifest나 structured producer instruction을 주입하지 않는다.

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

### Step 3: Lint 확인 (read-only)

`00-rule.md` 00-9 실행 안전 계약을 따른다. **자동 수정은 실행하지 않는다.**

이 단계는 `TARGET_COMMIT == HEAD` 인 경우에만 수행한다. 과거 커밋(`HEAD~N`, 직접 지정한 `<sha>`)을 리뷰할 때는 현재 working tree 기준 lint 결과가 섞여 오탐을 만들 수 있으므로 건너뛴다.

- `TARGET_COMMIT == HEAD` 일 때만 `package.json`, lint config, CI/workflow 파일에서 실제 lint 명령을 찾는다
- lint를 **수정 옵션 없이** 실행한다 (`--fix`, `--write` 금지)
- 자동 수정 가능한 항목은 실행하지 말고 개수와 성격만 기록해 `도구 실행 결과` 섹션에 적는다
- lint가 이미 잡는 항목은 리뷰 지적으로 중복 나열하지 말고 구조적 문제에 집중한다
- 사용자가 명시적으로 자동 수정을 요청한 경우에만 `lint:fix` 계열을 실행하고, 무엇을 고쳤는지 리포트에 남긴다
- `TARGET_COMMIT != HEAD` 이면 lint 실행 자체를 건너뛰고, 리뷰 모듈이 commit patch 안에서 직접 보이는 lint성 문제만 지적하게 둔다

### Step 4: 리뷰 모듈 목록 확인

```bash
ls "$RULES_DIR"/[0-9]*.md
```

`/code-review`와 동일하게 **발견된 숫자 prefix 파일 전체**를 리뷰 패스로 사용한다.

`00-rule.md`는 공통 규칙으로 항상 최우선 적용하며, numbered non-00 모듈 전체와 함께 단일 consolidated prompt에 포함한다.

### Step 5: 안전한 bounded Sub-Agent Dispatch

`/code-review-commit`은 **단일 통합 커밋 리뷰**를 수행한다. 숫자 prefix가 붙은 numbered non-00 리뷰 모듈 전체와 `00-rule.md` 공통 규칙을 하나의 sub-agent prompt에 포함하고, `run_in_background=false`로 즉시 실행한다. 이 bounded 기본 경로는 agent 폭증과 timeout 위험을 줄이기 위한 safe default이다.

상세하고 exhaustive한 모듈별 multi-pass coverage가 필요하면 이 single-commit workflow를 확장하지 말고, 커밋 patch 범위를 명시한 별도 수동 리뷰로 분리한다.

```
task(
  category="unspecified-high",
  load_skills=[],
  run_in_background=false,
  description="Commit Review (bounded consolidated pass)",
  prompt="아래 지시에 따라 단일 커밋 코드 리뷰를 수행하세요.

## 리뷰 대상
- 커밋: {TARGET_COMMIT}
- 변경 파일: {CHANGED_FILES}

## 리뷰 수행 방법
1. `git show --format=medium {TARGET_COMMIT}` 로 커밋 patch 전체를 확인하세요
2. 변경된 파일들을 직접 읽어서 컨텍스트를 파악하세요
3. `00-rule.md` 공통 규칙을 모든 모듈보다 우선 적용하세요
4. 아래 numbered non-00 리뷰 모듈들을 모듈 순서대로 검토하세요
5. 아래 리뷰 규칙에 따라 위반 사항을 찾으세요
6. 위반이 없는 규칙은 출력하지 마세요
7. 반드시 **이 커밋 patch 안의 변경 라인만** 지적하세요
8. root commit 도 동일하게 `git show {TARGET_COMMIT}` 기준으로 해석하세요
9. 동작 여부만 보지 말고, 문제 정의·의도·선택 근거·장기 변경 비용까지 함께 검토하세요

## 공통 리뷰 규칙
{COMMON_RULES_CONTENT — 00-rule.md 전체 내용}

## 모듈 리뷰 규칙
{MODULE_RULES_CONTENT — numbered non-00 모듈 .md 파일 전체 내용, 모듈 순서 유지}

00-rule.md와 모듈 규칙이 충돌하면 00-rule.md를 우선 적용하세요.
규칙 ID는 `00-rule.md` 00-2 표기 규칙을 그대로 따르세요. 숫자 모듈은 파일 prefix와 동일한 `{파일번호}-{규칙번호}` 형식(`01-3`, `03-1`, `19-2`, `20-4`), 개발 원칙은 `10-{원칙 약어}`(`10-SSOT`) 형식입니다. 이 pass에서는 `EX-`, `P-`, `A-`, `C-` 계열 ID를 사용하지 마세요.

## 출력 형식
위반 사항만 아래 형식으로 출력하세요. 위반이 없으면 '위반 없음'만 출력.
사용자가 다른 언어를 명시하지 않은 한 모든 리뷰 결과/코멘트/리포트는 한국어로 작성하세요.
가능하면 각 이슈는 **문제 → 현재 선택 → 왜 부족한지**가 드러나게 쓰세요.

### [모듈명]

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|----------|------|------|------|----------|
| 🔴/🟡/🔵 | 규칙번호 | 파일:라인 | 구체적 위반(문제/현재 선택/부족한 이유 포함) | 수정 방향 |

- 위치는 **해당 파일을 읽어 확인한 변경 후 줄 번호**를 적고, 그 줄의 코드를 한 줄 인용하세요. diff hunk 헤더(`@@`)에서 계산한 번호는 어긋납니다. 확인이 안 되면 번호를 추측하지 말고 `위치 미확인`으로 적으세요 (`00-rule.md` 00-10)
- 리포트의 섹션 이름·순서·헤딩 레벨은 `workflow-contract.md` C-7 **문서 골격**을 따르세요. 골격 표에 없는 섹션을 새로 만들지 마세요

## 금지 사항
- 이 커밋 diff에 포함되지 않은 기존 코드를 지적하지 마세요
- 부모 커밋이나 이후 커밋의 변경을 섞지 마세요
- 추측으로 지적하지 마세요 — 실제 코드를 읽고 확인하세요
- 위반이 아닌 것을 억지로 찾지 마세요"
)
```

**중요**: `/code-review-commit`은 bounded 단일 통합 pass로 완료한다. bounded pass가 실패하거나 timeout되면 완료로 표시하지 말고, 어떤 범위가 성공/실패/미확인인지 최종 리포트에 정직하게 기록한다.

### Step 6: 결과 수집 및 통합

bounded 단일 통합 pass 완료 후:

1. 단일 통합 pass 결과를 확인한다
2. 결과를 derived severity 순서로 병합: 🔴 → 🟡 → 🔵
3. 같은 severity 내에서는 모듈 순서대로 정렬
4. 위반 없는 모듈은 최하단에 "✅ 통과" 로 요약

### Step 7: 최종 리포트 출력

```markdown
# `{대상}` 커밋 코드 리뷰 리포트

## 리뷰 기준

> **커밋**: {TARGET_COMMIT} | **리뷰 시각**: {TIMESTAMP}
> **변경 파일**: {N}개 | **리뷰 모듈**: {M}개

## 판정

머지/체리픽 관점의 결론과 차단 사유를 한두 줄로 요약한다.

## 실행 계획

커밋 patch 기준, bounded pass 성공/실패 상태, `SKIPPED`/`UNKNOWN` 사유를 적는다.

## 상세 지적

### {모듈명}

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| 🔴/🟡/🔵 | 규칙번호 | 파일:라인(또는 범위/삭제 전 범위) | 구체적 위반 | 수정 방향 |

## 도구 실행 결과

| 명령 | 결과 | 비고 |
|------|------|------|
| ... | ... | HEAD가 아닐 때는 lint 생략 사유를 적는다 |

## 미해결 / 후속 확인

추가 확인이 필요한 absence claim, 범위 제한, unresolved follow-up을 적는다.
```

리포트 저장은 `workflow-contract.md` C-7을 따른다 (`workflow-name`은 `commit`). 문서 내용은 **해당 커밋 patch 안에서 실제로 바뀐 내용** 중심으로 쓰고, 다른 커밋/브랜치의 일반론은 넣지 않는다.

## 사용법

```
/code-review-commit         — 마지막 커밋(HEAD) 리뷰
/code-review-commit HEAD~2  — 특정 커밋 1개 리뷰
/code-review-commit <sha>   — 지정한 커밋 해시 리뷰
```

브랜치 전체가 아니라 **정확히 하나의 커밋**만 본다. 여러 커밋 범위를 보고 싶으면 `/code-review`, `/code-review-fast` 또는 범위를 직접 지정한 일반 리뷰를 사용한다.

## 주의사항

- bounded 단일 통합 pass 안에서 `00-rule.md`와 numbered non-00 모듈 전체를 함께 검토한다
- merge commit 은 기본적으로 지원하지 않는다. 그런 경우 일반 `/code-review` 또는 명시적 범위 리뷰로 전환한다
- 이 skill은 commit patch 기준이므로, 이후 커밋에서 수정된 문제까지 미리 반영해서 판단하지 않는다
- diff에 포함되지 않은 기존 코드는 리뷰 대상이 아니다
- fixup/squash 전 개별 커밋 품질을 점검할 때 특히 유용하다
- `HEAD` 리뷰일 때만 lint를 수정 옵션 없이 확인한다. 자동 수정은 사용자가 요청했을 때만 한다 (`00-rule.md` 00-9)
