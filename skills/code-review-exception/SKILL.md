---
name: code-review-exception
description: Use when the user invokes /code-review-exception or wants a standalone review focused on exception handling, error propagation, fallback, and recovery. Excluded from the default /code-review.
---

# Exception Handling Code Review

예외 처리, 에러 전파, fallback, 복구 흐름만 독립적으로 검토하는 전용 리뷰 모드다. 일반 코드 품질·아키텍처 검사와는 분리되며, `exception.md`가 숫자 prefix가 없으므로 일반 `/code-review`에서는 자동 제외된다.

## 룰 문서 위치

`RULES_DIR`은 다음 순서로 존재하는 첫 번째 디렉터리다: `${CLAUDE_PLUGIN_ROOT}/review-rules/` → `./review-rules/` → `~/.claude/review-rules/`.

- **Exception 전용**: `$RULES_DIR/exception.md` — 이 skill에서만 사용
- 같은 폴더의 숫자 prefix 모듈과 `fast.md`, `math.md`, `props.md`는 **참조하지 않는다**
- 일반 리뷰가 필요하면 `/code-review` 또는 `/code-review-fast`를 별도로 실행한다

## 검사 범위

- 빈 `catch`, 무음 실패, 의미 없는 fallback
- throw / Result / UI 상태 흡수 계약 불일치
- async, effect, event handler, timeout, subscription, callback 실패 처리 누락
- 사용자 안내와 개발자 진단 정보 분리 실패
- 입력·응답 검증 누락과 복구 경로 부재

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

변경 파일 중 예외 처리, 에러 전파, fallback, 복구, 검증 로직이 바뀐 파일만 리뷰 대상으로 좁힌다. 관련 변경이 없으면 `SKIPPED`로 종료한다. repo-wide fallback 스캔은 하지 않는다.

### Step 2: Lint 자동 수정 (선택)

lint가 설정돼 있으면 자동 수정 가능한 문제를 먼저 정리한다. 단, exception 리뷰는 lint와 별도 축이므로 lint가 없어도 그대로 진행 가능하다.

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
- severity 우선순위: 🔴 > 🟡 > 🔵
- 위치(파일:line)와 규칙 번호(`EX-x`)를 반드시 표기 — `exception.md`의 표기와 정확히 일치해야 합니다
- diff에 없는 기존 예외 흐름은 지적 금지
- 추측 금지 — 의심스러우면 '검증 필요'로 표기
- 이슈 없으면 '위반 없음'만 출력

## 출력 형식 (마크다운)

# 예외 처리 코드 리뷰 리포트

> **기준**: {MERGE_BASE} | **대상**: HEAD
> **검사 파일**: {N}개 (exception/error-handling 변경)

## 한눈에 보기
- 🔴: N개 / 🟡: N개 / 🔵: N개

## 위반 목록

| 심각도 | 파일 | 위치 | 규칙 | 이슈 | 개선 방향 |
|----------|------|------|------|------|----------|
| 🔴 | path/to/file | L123 | EX-1 | ... | ... |
| 🟡 | path/to/file | L45 | EX-5 | ... | ... |

## 통과
- (이슈 없는 파일 리스트, 또는 '전부 통과' 요약)

**머지 가능 여부**: 🔴 {N}개 → {가능/불가/수정 후 가능}"
)
```

### Step 4: 결과 전달

sub-agent의 출력을 그대로 사용자에게 전달한다. 명백한 형식 오류만 짧게 보정한다.

### Step 5: 문서 저장

리포트는 기본적으로 `./review-reports/code-review-exception-{branch-name}-{date}.md`로 저장하고 경로를 보고한다. 문서 내용은 **이번 브랜치 diff 안에서 예외 처리/에러 전파가 바뀐 파일과 그 실패 흐름 이슈** 중심으로 쓴다. `workflow-name`은 `exception`이다.

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
