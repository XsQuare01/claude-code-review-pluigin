---
name: code-review
description: Use when the user asks to review code, invokes /code-review, before merging branches, or after completing a feature. Runs a bounded default modular code review pass; use /code-review-full for exhaustive multi-pass coverage.
---

# Multi-Pass Code Review

React 전용 모듈러 코드 리뷰 시스템. 리뷰 규칙 폴더에서 **숫자 prefix가 붙은 `.md` 파일 전체**를 리뷰 모듈로 사용한다. 기본 `/code-review`는 안전한 bounded 전략으로 단일 통합 리뷰 pass를 수행한다. 상세하고 exhaustive한 모듈별 multi-pass coverage가 필요하면 `/code-review-full`을 사용한다.

`00-rule.md`는 모든 리뷰 모듈보다 먼저 읽고 우선 적용하는 최상위 공통 규칙이다. 개별 모듈과 충돌하면 `00-rule.md` 기준을 따른다.

## 리뷰 규칙 위치

다음 순서로 존재하는 첫 번째 디렉터리를 `RULES_DIR`로 사용한다.

1. `${CLAUDE_PLUGIN_ROOT}/review-rules/` — 플러그인으로 설치된 경우
2. `./review-rules/` — 저장소에 직접 포함된 경우
3. `~/.claude/review-rules/` — 홈 디렉터리에 복사해 쓰는 경우

**모듈 목록을 파일명으로 하드코딩하지 않는다.** 항상 `RULES_DIR`을 실제로 나열해서 발견되는 숫자 prefix 파일 전체를 모듈로 삼는다. 모듈이 추가·삭제되어도 이 스킬은 수정할 필요가 없어야 한다.

파일명 앞 숫자는 실행 순서이며, `00-rule.md`가 항상 최우선이다.

**자동 모듈 스캔에서 제외되는 파일**: 숫자 prefix가 없는 파일(`fast.md`, `props.md`, `math.md`, `exception.md`)은 특수 워크플로우 전용이며, 일반 `/code-review`에서는 절대 로드하지 않는다.

## 실행 절차

### Step 1: Diff 범위 결정

```bash
# base 브랜치 결정: dev → main → master → origin/HEAD 순으로 존재하는 첫 번째를 사용
for candidate in dev main master; do
  if git rev-parse --verify --quiet "$candidate" >/dev/null; then
    BASE_BRANCH=$candidate; break
  fi
done
BASE_BRANCH=${BASE_BRANCH:-$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's|origin/||')}

MERGE_BASE=$(git merge-base $BASE_BRANCH HEAD)
echo "Review range: $MERGE_BASE..HEAD (base: $BASE_BRANCH)"

# 변경된 파일 목록
git diff --stat $MERGE_BASE..HEAD

# 실제 diff
git diff $MERGE_BASE..HEAD
```

사용자가 특정 범위를 지정하면 그것을 사용한다. 지정하지 않았고 위 후보가 모두 없으면 사용자에게 base를 묻고, 임의로 리뷰 범위를 정하지 않는다. `MERGE_BASE == HEAD`이면 리뷰할 변경이 없는 것으로 보고 종료한다.

리뷰 대상에서 아래 테스트/목 관련 경로는 제외한다. diff 확인 시 존재 여부를 볼 수는 있지만, sub-agent에 전달하는 변경 파일 목록과 리뷰 지적 범위에서는 제거한다.

- `__test__/**`, `__tests__/**`
- `*.test.*`, `*.spec.*`
- `__mocks__/**`, `mock/**`, `mocks/**`
- `*.mock.*`, `mockData/**`, `fixtures/**` 처럼 테스트/목 전용 자산임이 명확한 파일/폴더

### Step 2: Lint 확인 (read-only)

`00-rule.md` 00-9 실행 안전 계약을 따른다. **자동 수정은 실행하지 않는다.**

- `package.json`, lint config, CI/workflow 파일에서 실제 lint 명령을 찾는다
- lint를 **수정 옵션 없이** 실행한다 (`--fix`, `--write` 금지)
- 자동 수정으로 해결 가능한 항목은 실행하지 말고 개수와 성격만 기록해, 최종 리포트의 `## 도구 실행 결과` 섹션에 적는다
- lint가 이미 잡는 항목은 리뷰 지적으로 중복해서 나열하지 않고, 구조적 문제에 집중한다
- 사용자가 명시적으로 자동 수정을 요청한 경우에만 `lint:fix` 계열을 실행하고, 무엇을 고쳤는지 리포트에 남긴다

### Step 3: 리뷰 모듈 목록 확인

```bash
ls "$RULES_DIR"/[0-9]*.md
```

**발견된 숫자 prefix 파일 전체**를 리뷰 패스(pass)로 사용한다. 목록을 미리 가정하지 말고 실제 출력에 따른다. `fast.md`, `props.md`, `math.md`, `exception.md`는 이 스캔에서 제외된다.

`00-rule.md` is loaded as common rules for every module. Do not treat `00-rule.md` as a normal review module unless the user explicitly requests a common-rule-only pass. Numbered non-00 modules remain review modules, but default `/code-review` evaluates them through one consolidated bounded pass instead of per-module fan-out.

#### `--module` 필터

`--module` 인자가 주어지면 위에서 나열한 모듈 중 **선택된 것만** 리뷰 대상으로 삼는다. 인자가 없으면 non-00 모듈 전체를 사용한다.

**토큰 매핑**: 각 모듈 파일 `NN-slug.md`는 세 가지 토큰으로 지정할 수 있다. 매핑은 파일명에서 그때그때 유도하며, 목록을 하드코딩하지 않는다.

| 토큰 형태 | 예시 | 대상 |
|-----------|------|------|
| 번호 | `03` | `03-react-rules.md` |
| slug | `react-rules` | `03-react-rules.md` |
| slug 접두 일치 (유일할 때) | `react` | `03-react-rules.md` |
| 전체 이름 | `03-react-rules` | `03-react-rules.md` |

- 구분자는 쉼표이며 공백은 무시한다: `--module fsd, type` == `--module fsd,type`
- 대소문자를 구분하지 않는다
- `.md` 확장자를 붙여도 받아들인다

**해석 실패 처리** — 리뷰를 임의로 진행하지 않고 중단한 뒤 사용자에게 알린다.

- 어느 모듈과도 매칭되지 않는 토큰: 그 토큰을 명시하고, 사용 가능한 모듈 목록(번호 + slug)을 함께 출력한다
- 접두 일치가 여러 모듈에 걸리는 토큰(예: 모듈이 늘어 `perf`가 둘 이상에 맞는 경우): 후보를 나열하고 더 구체적인 토큰을 요청한다
- `00`을 지정한 경우: `00-rule.md`는 공통 규칙이라 항상 적용된다고 알리고, 나머지 선택으로 진행한다. 선택이 `00` 뿐이면 공통 규칙만 검토하는 pass인지 되묻는다
- 결과 선택이 비면 전체 리뷰로 조용히 넘어가지 않는다

**선택 결과 반영**

- Step 4의 `{MODULE_RULES_CONTENT}`에는 **선택된 모듈만** 넣는다
- `00-rule.md` 공통 규칙은 선택과 무관하게 항상 포함한다
- 최종 리포트 헤더의 `리뷰 모듈` 개수와 요약 표에는 선택된 모듈만 나열하고, 필터가 적용됐다는 사실과 선택 목록을 리포트 상단에 명시한다. 검토하지 않은 모듈을 "✅ 통과"로 표시하지 않는다

### Step 4: 안전한 bounded Sub-Agent Dispatch

기본 `/code-review`는 **단일 통합 리뷰**를 수행한다. Step 3에서 선택된 non-00 리뷰 모듈(필터가 없으면 전체)과 `00-rule.md` 공통 규칙을 하나의 sub-agent prompt에 포함하고, `run_in_background=false`로 즉시 실행한다. 이 bounded 기본 경로는 agent 폭증과 timeout 위험을 줄이기 위한 safe default이다.

상세하고 exhaustive한 모듈별 multi-pass coverage가 필요하면 기본 `/code-review`를 확장하지 말고 `/code-review-full`을 사용한다.

```
task(
  category="unspecified-high",
  load_skills=[],
  run_in_background=false,
  description="Code Review (bounded consolidated pass)",
  prompt="아래 지시에 따라 코드 리뷰를 수행하세요.

## 리뷰 대상
- 기준: {MERGE_BASE}
- 대상: HEAD
- 변경 파일: {CHANGED_FILES}
- 제외 파일: `__test__/**`, `__tests__/**`, `*.test.*`, `*.spec.*`, `__mocks__/**`, `mock/**`, `mocks/**`, `*.mock.*`, 테스트/목 전용 fixture/mock data

## 리뷰 수행 방법
1. `git diff {MERGE_BASE}..HEAD` 로 전체 diff를 확인하세요
2. 변경된 파일들을 직접 읽어서 컨텍스트를 파악하세요
3. `00-rule.md` 공통 규칙을 모든 모듈보다 우선 적용하세요
4. 아래 numbered non-00 리뷰 모듈들을 모듈 순서대로 검토하세요
5. 아래 리뷰 규칙에 따라 위반 사항을 찾으세요
6. 위반이 없는 규칙은 출력하지 마세요
7. 동작 여부만 보지 말고, 문제 정의·의도·선택 근거·장기 변경 비용까지 함께 검토하세요
8. 파일 전체를 읽더라도 **지적은 diff에 포함된 변경 라인** 또는 그 변경 때문에 직접 깨진 **인접 라인/구조**로 제한하세요

## 공통 리뷰 규칙
{COMMON_RULES_CONTENT — 00-rule.md 전체 내용}

## 모듈 리뷰 규칙
{MODULE_RULES_CONTENT — Step 3에서 선택된 non-00 모듈 .md 파일 전체 내용, 모듈 순서 유지}

00-rule.md와 모듈 규칙이 충돌하면 00-rule.md를 우선 적용하세요.
규칙 ID는 `00-rule.md` 00-2 표기 규칙을 그대로 따르세요. 숫자 모듈은 파일 prefix와 동일한 `{파일번호}-{규칙번호}` 형식(`01-3`, `03-1`, `19-2`, `20-4`), 개발 원칙은 `10-{원칙 약어}`(`10-SSOT`) 형식입니다. 이 pass에서는 `EX-`, `P-`, `A-`, `C-` 계열 ID를 사용하지 마세요 — 해당 모듈은 여기서 로드되지 않습니다.

## 출력 형식
위반 사항만 아래 형식으로 출력하세요. 위반이 없으면 '위반 없음'만 출력.
사용자가 다른 언어를 명시하지 않은 한 모든 리뷰 결과/코멘트/리포트는 한국어로 작성하세요.
가능하면 각 이슈는 **문제 → 현재 선택 → 왜 부족한지**가 드러나게 쓰세요.

### [모듈명]

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|----------|------|------|------|----------|
| 🔴/🟡/🔵 | 규칙번호 | 파일:라인 | 구체적 위반(문제/현재 선택/부족한 이유 포함) | 수정 방향 |

## 금지 사항
- diff에 포함되지 않은 기존 코드를 지적하지 마세요
- 파일 전체를 읽었다는 이유로 리뷰 범위를 파일 전체로 넓히지 마세요
- 제외 파일(`__test__`, `__tests__`, test/spec 파일, mock/mocks/fixture 전용 파일)은 리뷰 이슈로 지적하지 마세요
- 추측으로 지적하지 마세요 — 실제 코드를 읽고 확인하세요
- 위반이 아닌 것을 억지로 찾지 마세요"
)
```

**중요**: 기본 `/code-review`는 bounded 단일 통합 pass로 완료한다. bounded pass가 실패하거나 timeout되면 완료로 표시하지 말고, 어떤 범위가 성공/실패/미확인인지 최종 리포트에 정직하게 기록한다.

### Step 5: 결과 수집 및 통합

bounded pass 완료 후:

1. sub-agent 결과를 확인한다
2. 결과를 severity 순서로 병합: 🔴 ERROR → 🟡 WARNING → 🔵 INFO
3. 같은 severity 내에서는 모듈 순서대로 정렬
4. 위반 없는 모듈은 최하단에 "✅ 통과" 로 요약

### Step 6: 최종 리포트 출력

```markdown
# 코드 리뷰 리포트

> **기준**: {MERGE_BASE} | **대상**: HEAD | **리뷰 시각**: {TIMESTAMP}
> **변경 파일**: {N}개 | **리뷰 모듈**: {M}개
> **모듈 필터**: {선택된 모듈 목록 — `--module`이 없으면 이 줄을 생략}

## 도구 실행 결과

| 명령 | 결과 | 비고 |
|------|------|------|
| ... | ... | 자동 수정 가능 항목은 실행하지 않고 개수만 기록 |

## 🔴 ERROR (머지 전 수정 필수)

| 모듈 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| ... | ... | ... | ... | ... |

## 🟡 WARNING (수정 권장)

| 모듈 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| ... | ... | ... | ... | ... |

## 🔵 INFO (개선 제안)

| 모듈 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| ... | ... | ... | ... | ... |

## 요약

| 모듈 | 🔴 | 🟡 | 🔵 | 결과 |
|------|-----|-----|-----|------|
| FSD 아키텍처 | 0 | 1 | 0 | ⚠️ |
| 타입 안전성 | 0 | 0 | 0 | ✅ |
| ... | ... | ... | ... | ... |

**머지 가능 여부**: 🔴 {N}개 → {가능/불가/수정 후 가능}
```

최종 리포트는 기본적으로 `.md` 파일로 저장한다. 단, 사용자가 read-only 리뷰, 파일 생성/수정 금지, 텍스트 응답만을 요청했으면 저장하지 않는다 — 이 요청은 `00-rule.md` 00-9에 따라 저장 규칙보다 우선한다. 저장 경로는 `00-rule.md` 00-5의 규칙을 따라 `./review-reports/code-review-default-{branch-name}-{date}.md`를 사용하고, 저장 경로를 함께 보고한다. 문서 내용은 **이번 브랜치 diff와 실제 변경 파일 기준**으로 작성하고, 저장소 전체 일반론이나 diff 밖의 장황한 설명은 피한다. 기존 리뷰 문서가 이미 있어도 그 문서를 이유로 리뷰를 건너뛰지 말고 **항상 새 리뷰를 수행한 뒤 새 파일로 저장**한다. 이 워크플로우의 `workflow-name`은 `default`이다.

## 사용법

```
/code-review                    — 현재 브랜치 전체 리뷰
/code-review main..feature/x    — 특정 범위 리뷰
/code-review --module fsd,type  — 특정 모듈만 리뷰 (slug)
/code-review --module 01,02,17  — 특정 모듈만 리뷰 (번호)
/code-review-full               — 상세/exhaustive 모듈별 multi-pass 리뷰
```

`--module` 토큰 해석과 실패 처리는 Step 3의 `--module 필터`를 따른다. 범위 지정과 `--module`은 함께 쓸 수 있다.

## 주의사항

- 기본 `/code-review`는 safe default로 bounded 단일 통합 리뷰를 사용한다
- 상세/exhaustive 모듈별 multi-pass coverage가 필요하면 `/code-review-full`을 사용한다
- diff에 포함되지 않은 기존 코드는 리뷰 대상이 아니다
- `__test__`, `__tests__`, test/spec 파일, mock/mocks/fixture 전용 파일은 일반 `/code-review` 대상이 아니다
- 리뷰 규칙 파일 추가/삭제만으로 리뷰 범위를 조절할 수 있다
- 빈 diff (변경 없음)이면 리뷰를 수행하지 않는다
- 리뷰는 read-only가 기본이다. lint는 수정 옵션 없이 실행하고, 자동 수정은 사용자가 요청했을 때만 한다 (`00-rule.md` 00-9)
- 사용자가 read-only/파일 수정 금지/텍스트 응답만을 요청하면 리뷰 문서도 만들지 않는다
