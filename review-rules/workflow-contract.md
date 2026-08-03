# 공통 워크플로우 계약

이 문서는 **모든 리뷰 워크플로우가 동일하게 지키는 실행 계약**이다. 각 워크플로우 SKILL 문서는 이 계약을 복제하지 않고 참조하며, **자기 모드에서 달라지는 부분만** 선언한다.

계약을 한 곳에 두는 이유는 단순하다. 같은 절차를 일곱 문서에 복제하면 그중 일부만 갱신되어 워크플로우마다 다르게 동작하게 되고, 사용자는 어느 명령이 어떻게 동작하는지 매번 확인해야 한다.

이 문서는 숫자 prefix가 없으므로 **리뷰 모듈 자동 스캔 대상이 아니다.** 리뷰 규칙이 아니라 실행 절차를 정의한다.

---

## C-1. 규칙 디렉터리 해석

다음 순서로 존재하는 첫 번째 디렉터리를 `RULES_DIR`로 사용한다.

1. `${CLAUDE_PLUGIN_ROOT}/review-rules/` — 플러그인으로 설치된 경우
2. `./review-rules/` — 저장소에 직접 포함된 경우
3. `~/.claude/review-rules/` — 홈 디렉터리에 복사해 쓰는 경우

해석된 경로를 리포트에 함께 적는다. 어떤 규칙 버전으로 리뷰했는지가 사후에 확인 가능해야 한다.

## C-2. 모듈 탐색

```bash
ls "$RULES_DIR"/[0-9]*.md
```

- **모듈 목록을 파일명으로 하드코딩하지 않는다.** 항상 실제 나열 결과를 따른다
- 파일명 앞 숫자는 실행 순서이며 `00-rule.md`가 항상 최우선이다
- `00-rule.md`는 **공통 컨텍스트 전용**이다. 모든 모듈 prompt에 함께 전달하되 독립 모듈 pass로 실행하지 않는다
- 숫자 prefix가 없는 파일(`fast.md`, `props.md`, `math.md`, `exception.md`, `workflow-contract.md`, `catalog.json`)은 모듈 스캔에서 제외한다. 각각 자기 전용 워크플로우에서만 로드된다

## C-3. 모듈 적용 조건 (profile / version gating)

모듈마다 적용 전제가 다르다. 전제가 성립하지 않는 모듈을 적용하면 그 자체가 오탐이다.

- 각 모듈 문서 상단의 전제(FSD, Electron, Tailwind, RSC, SSR, React/TypeScript 버전 등)를 먼저 확인한다
- `$RULES_DIR/catalog.json`에 모듈별 적용 조건이 기계 판독 가능한 형태로 정리돼 있다. 조건 판정에는 이 파일을 우선 참조하고, 판정 근거의 정본은 각 모듈 문서 본문이다
- 전제가 성립하지 않는 모듈은 지적을 만들지 말고 `SKIPPED`와 사유를 리포트에 남긴다. **조용히 빼지 않는다** — 빠진 사실이 보이지 않으면 검토된 것으로 오인된다
- 전제를 확인할 수 없으면(설정 파일 부재 등) 그 모듈은 적용하지 않고 `UNKNOWN`으로 기록한다

## C-4. 리뷰 범위 결정

**사용자가 범위를 지정했으면 그것이 최우선이다.** 지정된 범위가 있으면 아래 자동 판정을 수행하지 않는다.

지정이 없으면 base 브랜치를 다음 순서로 찾는다.

```bash
for candidate in dev main master; do
  if git rev-parse --verify --quiet "$candidate" >/dev/null; then
    BASE_BRANCH=$candidate; break
  fi
done
BASE_BRANCH=${BASE_BRANCH:-$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's|origin/||')}

MERGE_BASE=$(git merge-base $BASE_BRANCH HEAD)
```

- 후보가 모두 없으면 **사용자에게 base를 묻는다.** 임의로 정하지 않는다
- `MERGE_BASE == HEAD`이면 리뷰할 변경이 없는 것으로 보고 종료한다
- 결정된 base와 범위를 리포트에 적는다

커밋 단위 리뷰처럼 범위 결정 방식이 다른 워크플로우는 자기 SKILL 문서에서 그 차이만 선언한다.

## C-5. 제외 경로

다음 경로는 일반 리뷰 대상에서 제외한다. diff 확인 시 존재 여부는 볼 수 있으나, sub-agent에 전달하는 변경 파일 목록과 지적 범위에서는 뺀다.

- `__test__/**`, `__tests__/**`
- `*.test.*`, `*.spec.*`
- `__mocks__/**`, `mock/**`, `mocks/**`
- `*.mock.*`, `mockData/**`, 테스트/목 전용임이 명확한 fixture

제외의 의미는 `00-rule.md` 00-3을 따른다. **테스트 파일을 지적 대상에서 빼는 것이지, 테스트 변경을 증거에서 빼는 것이 아니다.**

## C-6. 실행 안전

`00-rule.md` 00-9 실행 안전 계약을 따른다. 요약하면:

- 리뷰는 기본 read-only. lint/typecheck/test는 수정 옵션 없이 실행
- 자동 수정과 코드 수정은 사용자가 명시적으로 요청했을 때만
- 사용자의 read-only / 파일 수정 금지 / 텍스트 응답 요청이 다른 모든 규칙보다 우선
- 도구 실행 결과는 리뷰 지적과 분리해 별도 섹션으로 보고

## C-7. 리포트 저장

- 파일명: `./review-reports/code-review-{workflow-name}-{branch-name}-{date}.md`
- `workflow-name`은 아래 등록된 값만 사용하고 생략하지 않는다

| workflow-name | 명령 |
|---------------|------|
| `default` | `/code-review` |
| `full` | `/code-review-full` |
| `fast` | `/code-review-fast` |
| `commit` | `/code-review-commit` |
| `props` | `/code-review-props` |
| `math` | `/code-review-math` |
| `exception` | `/code-review-exception` |

- 기존 리뷰 문서가 있어도 완료 신호로 보지 않는다. 항상 새 리뷰를 수행하고 새 파일을 만든다
- 저장 경로를 사용자에게 보고한다
- 사용자가 파일 생성을 원하지 않으면 저장하지 않는다 (C-6)

## C-8. 실패 보고 정직성

- 실패, timeout, 미수집이 발생한 범위는 완료로 표시하지 않는다
- 부분 결과는 보존하되, **무엇이 성공하고 무엇이 실패했는지**를 리포트에 명시한다
- 검토하지 않은 모듈을 "통과"로 표기하지 않는다. `SKIPPED`, `FAILED`, `UNKNOWN`을 구분해 적는다

---

## 워크플로우별 차이 선언

각 SKILL 문서는 이 계약을 참조한 뒤 아래 항목 중 자기 모드에서 달라지는 것만 적는다.

| 항목 | 기본 계약 | 다르게 선언하는 워크플로우 |
|------|-----------|---------------------------|
| 범위 결정 | C-4 (merge-base) | `commit` — 단일 커밋 patch |
| 모듈 집합 | C-2 (numbered non-00 전체) | `fast` — `fast.md` 단일 문서 / `props`·`math`·`exception` — 각 전용 문서 |
| 분할 방식 | 단일 통합 pass | `full` — 모듈별 sub-agent, wave 단위 |
| 출력 밀도 | 위반 전부 | `fast` — 파일당 최대 1개 |
| 모듈 필터 | 없음 | `default` — `--module` |
