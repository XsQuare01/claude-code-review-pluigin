# Eval harness

`/code-review`를 실제로 실행해 채점한다. 설계는 `2026-08-21-code-review-eval-harness-design.md`.

## 이름 충돌 — 가장 먼저 알아야 할 사실

**`/code-review`는 Claude Code 내장 명령과 충돌한다.** 이 플러그인이 로드돼 있어도
`-p` 세션에서 `/code-review`를 그대로 부르면 내장 명령이 먹고, 플러그인의 스킬은
한 번도 실행되지 않는다. 그 상태로 돌려도 프로세스는 정상 종료되고 뭔가 리포트
비슷한 걸 만들 수 있어서, 겉보기엔 멀쩡한데 아무것도 재지 않는 숫자가 나온다.
반드시 정규화된 이름 `/react-code-review-plugin:code-review`로 불러야 한다.
`evals/cases/*/case.json`의 `command` 필드가 이 형식을 쓴다 — 새 케이스를 추가할
때도 그대로 따라야 한다.

## 돌리는 방법

    # fixture만 만든다 (claude를 부르지 않음, 비용 없음)
    node scripts/eval-review.mjs --case location-trap --dry-run

    # 워킹 트리 상태로 1회
    node scripts/eval-review.mjs --case location-trap --runs 1

    # 특정 ref를 팔로 쓴다
    git worktree add ../eval-arm-main main
    node scripts/eval-review.mjs --case location-trap --plugin-dir ../eval-arm-main --label main

`--plugin-dir`이 워킹 트리를 그대로 로드하므로 **버전 범프도 플러그인 재설치도 필요 없다.**
(`RULES_DIR`이 설치된 캐시가 아니라 `--plugin-dir`로 준 트리로 해석된다는 것은
sentinel 규칙 파일로 확인했다 — `baseline.json`의 exit condition 3 참고.)

## `--add-dir`에 플러그인 디렉터리도 넣어야 하는 이유

`runClaude`는 fixture 루트뿐 아니라 `pluginDir`도 `--add-dir`로 넘긴다.
`--plugin-dir`은 플러그인을 **로드**만 하고, 스킬이 자기 규칙 모듈
(`review-rules/00-rule.md`, 번호가 붙은 규칙 문서들)과 `prepare-verification.mjs`를
**읽으려면** 그 경로 자체가 세션의 허용 작업 디렉터리 안에 있어야 한다. fixture만
허용하면 스킬이 자기 규칙을 Glob도 Read도 못 해서, 리뷰가 조용히 "규칙 미확인"
판단으로 줄어든다. 증상은 리포트에 인용된 규칙 ID마다 `규칙 미확인`이 반복해서
나오는 것이다 — 이 문구가 보이면 `--add-dir`가 플러그인 경로를 빠뜨렸다는 뜻이다.

## 두 가지 리포트 레이아웃

`/code-review` 워크플로우는 지적사항을 표 또는 `####` 블록, 두 레이아웃 중
하나로 낸다. 둘 다 C-7을 지킨다 — 계약이 고정하는 것은 섹션 **이름과 순서**고,
지적사항을 표로 늘어놓을지 각 항목을 `####` 헤딩으로 쓸지는 계약 밖이다. 실제
리포트도 실행마다 어느 쪽을 쓸지 갈렸다. `scripts/lib/eval-grade.mjs`의
`parseFindings`가 두 레이아웃을 모두 이해하고, 한 셀 안에 `` `path:line` — `code
quote` `` 형태로 같이 들어오는 인용도 분리해서 읽는다. 파서를 손보게 되면 두
레이아웃을 다 유지해야 한다 — 하나만 남기면 실행 절반의 리포트가 조용히
"findings 0"으로 채점된다(실제로 이 결함 때문에 5건짜리 리뷰가 0건으로 채점된
적이 있다).

## fixture의 TypeScript 오류는 의도한 것이다

`evals/cases/*/`가 만드는 fixture의 `.tsx` 파일을 IDE로 열면
`cannot find module 'react'`, JSX 타이핑 오류 등이 뜬다. 각 케이스가
`tsconfig.json`을 갖고 있지만 저장소에 `node_modules`가 없기 때문이다. **이건
예상된 상태이고 "고치면" 안 된다.** `/code-review` 워크플로우는 이 `tsconfig.json`을
읽어서 규칙 모듈의 적용 여부(예: React/Tailwind/FSD 트리거)를 판단한다.
`node_modules`를 채우거나 `tsconfig.json`을 지워서 IDE 오류를 없애면, 이 케이스가
재는 대상 — 워크플로우가 실제 저장소 설정을 읽고 규칙 적용 범위를 판단하는가 —
자체가 약해진다.

## hook 억제 여부 — 미해결

브리핑 Step 2(`--settings '{"hooks":{}}'`로 세션 hook을 죽일 수 있는지 실측)는
이번 회차에서 **돌리지 못했다** — harness 결함 4개를 고치는 작업이 먼저 필요해서
뒤로 밀렸다. 그래서 `durationSec`가 사용자 세션 hook(`~/.claude/settings.json`의
11개)의 오버헤드를 얼마나 포함하는지 확인되지 않은 상태다. `durationSec`는
**절대값이 아니라 두 팔 사이의 비교에만** 쓴다 — 두 팔이 같은 세션 설정으로
같은 머신에서 도는 한 오버헤드는 동일하게 걸리고, 차이는 여전히 유효하다.
이 확인은 아직 열려 있는 항목이다.

## 읽는 방법

점수는 벡터다. 단일 값으로 접지 않는다.

| 축 | 뜻 |
|---|---|
| `completed` | `true` / `timeout` / `failed` — runner가 강제한다 |
| `recall` | 심은 결함 중 잡은 것. `ruleOnly`는 위치 없이 규칙만으로 맞은 수 |
| `falsePositives` | `mustNotFlag` 대상을 지적한 횟수 |
| `unclassified` | 어느 목록에도 없는 지적. **오탐이 아니다** — 심지 않은 진짜 문제일 수 있다 |
| `locationsInRange` | 인용한 경로·줄이 파일 안에 실재하는가 |
| `locationsOnTarget` | 심은 결함을 tolerance 안에서 가리켰는가 |
| `scriptRan` | 위치 대조 스크립트가 실제로 돌았는가 (이슈 #50) |
| `skeletonOk` | C-7 섹션 이름과 순서 |
| `summaryArithmetic` | 요약 표 합계가 상세 지적과 맞는가 |

## 주의

- **CI 게이트가 아니다.** 리뷰는 비결정적이고, 임계값으로 PR을 막으면 노이즈가 정책이 된다. 목적은 시계열이다.
- **fixture 재현율은 리뷰 품질의 증명이 아니다.** 알려진 결함을 통과하도록 프롬프트를 튜닝하는 압력이 실재한다. `unclassified`를 노이즈가 아니라 신호로 본다.
- `evals/results/`는 gitignore다. 커밋되는 것은 `evals/baseline.json` 하나다.
