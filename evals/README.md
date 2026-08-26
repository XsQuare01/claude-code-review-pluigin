# Eval harness

`/code-review`를 실제로 실행해 채점한다. 설계는 `C:\Users\bhmun\OneDrive\바탕 화면\Docs\2026-08-21-code-review-eval-harness-design.md`.

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

## 두 가지 리포트 레이아웃 — 그리고 이것은 계약 준수가 아니라 이탈이다

`/code-review` 워크플로우는 지적사항을 표 또는 `####` 블록, 두 레이아웃 중
하나로 낸다. **둘 다 C-7을 지킨다고 이전 판에 적었는데, 그 문장은 틀렸다.**
`workflow-contract.md`의 `### 문서 골격`은 "**섹션 이름·순서·헤딩 레벨은
아래로 고정한다**"고 적고, 그 표에는 `####` 레벨에 `{severity} {규칙 ID}
{제목}` — finding 하나당 하나 — 를 **전체** 워크플로우 대상으로 못박은
행이 있다. 뒤이은 `### 지적 표기`도 그 형태를 실제 예시로 못박는다. 즉
C-7이 고정하는 것은 섹션 이름·순서뿐이 아니라 **finding을 `####` 블록으로
내는 것 자체**다.

`skills/code-review/SKILL.md`와 그 아래 숫자 모듈들의 출력 형식표가 대신
쓰는 표 레이아웃은, 계약이 허용한 대안이 아니라 **계약 문서가 스스로
"알려진 간극"이라고 부르는 이탈**이다 — 계약 본문은 "남은 표 행 형식을
넓히는 것이 알려진 간극이며 후속 작업으로 추적한다"고 명시하고, `/code-review`·
`/code-review-commit`·`/code-review-fast`를 그 표 형식을 쓰는 워크플로우로
직접 지목한다. 이 harness는 그 이탈을 우연히 관측한 것이 아니라 — 실제
`main`/`pr52` 리포트가 한쪽은 `####` 블록(main), 한쪽은 표(pr52)를 써서
그 갈라짐을 그대로 드러냈다.

여기서 하지 않는 일: 이 사실을 근거로 skill이나 계약을 이 harness가 직접
고치지는 않는다. `scripts/lib/eval-grade.mjs`의 `parseFindings`는 두
레이아웃을 계속 다 이해해야 한다 — 실제 워크플로우가 실행마다 어느 쪽을
낼지 갈리는 한, 파서가 하나만 남기면 실행 절반의 리포트가 조용히 "findings
0"으로 채점된다(실제로 이 결함 때문에 5건짜리 리뷰가 0건으로 채점된 적이
있다). 표 형식은 한 셀 안에 `` `path:line` — `code quote` `` 형태로 위치와
인용이 같이 들어오는 경우도 있어 그것도 분리해서 읽는다. 계약과 skill을
맞추는 것은 이 브랜치의 범위 밖이며 별도 이슈로 남긴다.

## fixture의 TypeScript 오류는 의도한 것이다

`evals/cases/*/`가 만드는 fixture의 `.tsx` 파일을 IDE로 열면
`cannot find module 'react'`, JSX 타이핑 오류 등이 뜬다. 각 케이스가
`tsconfig.json`을 갖고 있지만 저장소에 `node_modules`가 없기 때문이다. **이건
예상된 상태이고 "고치면" 안 된다.** `/code-review` 워크플로우는 이 `tsconfig.json`을
읽어서 규칙 모듈의 적용 여부(예: React/Tailwind/FSD 트리거)를 판단한다.
`node_modules`를 채우거나 `tsconfig.json`을 지워서 IDE 오류를 없애면, 이 케이스가
재는 대상 — 워크플로우가 실제 저장소 설정을 읽고 규칙 적용 범위를 판단하는가 —
자체가 약해진다.

## hook 억제 여부 — 해결됨

**`--settings '{"hooks":{}}'`는 세션 hook을 억제하지 못한다.** `--settings`는
"추가" 설정을 로드할 뿐, 다른 출처(프로젝트/사용자/플러그인)의 hook을 대체하거나
덮어쓰지 않는다.

방법을 남긴다 — 재사용 가능한 부분이 이것이다: `claude -d hooks --debug-file
<path>`로 hook 디버그 로그를 받아, 같은 명령을 `--settings` 유무로 두 번 돌리고
로그에 찍힌 hook 실행 순서를 직접 비교한다. 두 실행 모두 `SessionStart:startup`,
superpowers 플러그인이 등록한 이름 붙은 `SessionStart`, `UserPromptSubmit`,
`Stop`, `SessionEnd`가 동일한 순서로, 동일하게 성공 처리되며 나타났다 — hook
레지스트리도 실행 로그도 갈리지 않았다. (참고로 소요 시간만 비교하는 방법은
결정적이지 않았다: 두 실행 모두 ~7초로 같았다. hook 오버헤드가 LLM 응답 시간에
묻힐 만큼 작을 수 있어서, 시간차만으로는 억제 여부를 가릴 수 없다 — 그래서
timing이 아니라 디버그 로그로 확인했다.)

**따라서 `durationSec`는 항상 사용자의 세션 hook 오버헤드를 포함하고, 이는
같은 머신 위에서 도는 두 팔 사이의 비교에만 의미가 있다** — 절대값으로 쓰면
안 된다. 이 결론 자체는 이전과 같지만, 그 근거가 "확인 안 된 가정"에서
"측정된 사실"로 바뀌었다.

확인하지 못한 것도 정직하게 남긴다: 실행 중 cmd 창이 실제로 뜨는지는
관찰하지 못했다 — 이 환경이 데스크톱 없는 headless CLI이고, 문제의 hook 자체가
`conhost.exe --headless`를 통해 도는 방식이라(원래 창을 띄우지 않게 설계됨)
시각적으로 확인할 방법이 없었다. 이 한계는 창 여부에만 걸리고, 위의 억제 여부
결론(디버그 로그 기반)을 약화시키지 않는다.

나중에 정말로 hook을 격리해야 한다면: `--settings`가 아니라 다른 `HOME`/설정
루트를 쓰거나, 이 hook들이 없는 머신에서 돌리는 방법이 있다. **이건 검증하지
않았다** — 검증된 레시피로 오인하지 않도록 명시해 둔다.

## 권한 모드 — `bypassPermissions`를 쓴다. `--plugin-dir`에 복사본을 넘길 것

A1은 `--permission-mode acceptEdits`로 돌았고, 그것이 **Bash를 자동 승인하지
않았다.** 커밋된 A1 baseline이 그 증거를 담고 있다 — `main`은 `find`/`cat`
호출이 거부됐고, `pr52`는 `prepare-verification.mjs` 실행이 두 번 다 거부됐다
(리포트 본문도 "비대화형 세션이라 승인을 받을 수 없었다"고 직접 적었다).

그래서 `scriptRan.ran`이 **모든 run에서 구조적으로 `false`**였다. 그 값을 그냥
읽으면 "워크플로우가 위치 대조를 건너뛰었다"로 보이지만 실제 원인은 "harness
자신이 그 도구를 쓸 권한을 안 줬다"였다 — **측정 대상의 결함이 아니라 측정
장치의 한계를 측정 대상의 결함으로 오독하는 것.**

**A2에서 `bypassPermissions`로 바꿨다.** `--allowedTools`로 좁히지 않은 이유는
같은 함정 때문이다: 좁히면 다른 종류의 거부가 나타나고 harness는 다시
워크플로우가 아니라 자기 설정을 재게 된다. 사용자가 실제로 리뷰를 돌리는
조건에 가장 가까운 것이 이 모드다.

### 대가 — 살아 있는 저장소를 `--plugin-dir`에 넘기지 않는다

`bypassPermissions`는 리뷰가 허용 디렉터리 안에서 임의 명령을 돌릴 수 있다는
뜻이다. fixture는 매 실행 새로 만드는 임시 디렉터리라 그 자체는 문제가 아니지만,
**`pluginDir`도 `--add-dir`에 들어간다.** 그것이 이 저장소의 워킹 트리면 리뷰가
저장소에 쓸 수 있다.

기준선을 뜰 때는 팔을 복사해서 넘긴다.

    git worktree add ../eval-arm-main main
    node scripts/eval-review.mjs --case location-trap --plugin-dir ../eval-arm-main --label main

`--plugin-dir`이 이 저장소의 워킹 트리면 runner가 **경고를 출력한다.** 차단하지는
않는다 — 개발 중에 `--plugin-dir .`은 가장 흔한 사용법이고, 막으면 우회 경로가
생긴다. 우회 가능한 차단보다 보이는 경고가 낫다.

## sub-agent가 뜨지 않는다 — harness는 fan-out이 아니라 통합 pass를 재고 있다

`/code-review`는 모듈 fan-out으로 설계돼 있는데, 이 harness가 띄우는 모든 run에서
sub-agent가 **하나도 뜨지 않는다.** 봉투의 `subagent_stats.spawned`가 0이고,
리뷰 자신이 리포트에 이유를 적는다.

> 세션 지시상 Agent 도구를 쓰지 않아, bounded 통합 pass를 sub-agent 대신 직접 수행했습니다.

### 출처는 시스템 프롬프트다 — 설정으로 끌 수 없다

이 머신에서 뜨는 claude 세션의 시스템 프롬프트에 다음 두 줄이 들어 있다.

    Do not call the AgentTool unless the user requested it
    Do not use workflows or deep-research unless the user requested it

`~/.claude/settings.json`에도 `~/.claude/CLAUDE.md`에도 없다 — headless 세션에
직접 물어 확인했다. 훅은 전부 `conhost.exe`(터미널 깜빡임 억제)라 텍스트를
주입하지 않는다. Agent 도구 자체는 headless에서도 **사용 가능하다**(별도 프로브로
확인). 모델이 쓰지 않기로 선택하는 것이다.

### 그래서 두 개의 서로 다른 기준선이 가능하다

| | 무엇을 재는가 | 어떻게 |
|---|---|---|
| **as-experienced** | 이 머신에서 사용자가 실제로 받는 것 | 지금 그대로. sub-agent 없음 |
| **as-designed** | 워크플로우 정의대로의 fan-out | `--append-system-prompt`로 dispatch를 명시적으로 요청 |

**둘 중 무엇을 기준선으로 삼는지는 B의 판정을 바꾼다.** B의 후보가 묶음
fan-out이므로, as-experienced 기준선과 비교하면 "fan-out 대 통합"이 아니라
"fan-out 대 통합"을 재게 되는데 — 그 통합은 현재 *설계*가 아니라 현재 *실행*이다.
반대로 as-designed 기준선은 이 사용자가 실제로 받지 않는 동작을 잰다.

두 기준선의 비용도 다르다. 통합 pass는 실측 $3.4~4.0/run이고, 21개 모듈로
fan-out하면 에이전트당 출력이 곱해져 그보다 크다 — 2.6.0을 죽인 것이 정확히
그 곱셈이었다.

### `opFailures`를 읽을 때

`spawned: 0`인 run에서 `opFailures.total: 0`은 **"실패가 없었다"가 아니라
"fan-out이 재현되지 않았다"**이다. 이 축은 as-designed 기준선에서만 의미를 갖는다.

### `scriptRan.ran`을 읽을 때

권한이 열렸으므로 이제 `ran: false`는 **측정 결과**다. 다만 세 가지를 계속
구분한다.

| 값 | 의미 |
|---|---|
| `ran: true` | 스크립트가 실제로 돌았다 |
| `ran: false`, `declaredSkipped: true` | 워크플로우가 안 돌리기로 하고 그렇게 적었다 |
| `ran: false`, `declaredSkipped: false` | 워크플로우가 대조를 언급조차 하지 않았다 |

`permissionDenials`가 비어 있는지 함께 본다. 거부가 남아 있으면 여전히 harness
쪽 한계이지 측정 결과가 아니다.

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
| `scriptRan` | 위치 대조 스크립트가 실제로 돌았는가 (이슈 #50). `ran`/`declaredSkipped` 조합을 함께 읽는다 — 위 절 참고 |
| `skeletonOk` | C-7 섹션 이름과 순서 |
| `summaryArithmetic` | 요약 표 합계가 상세 지적과 맞는가 |
| `fixtureDirty` | run 뒤 fixture의 `git status --porcelain` (`review-reports/` 제외). 비어 있어야 정상 — 리뷰가 파일을 고쳤다는 뜻이면 그 자체가 회귀다 |
| `unverifiable` | 리뷰가 **확인할 수 없어 판단을 보류한** 건수. `위치 미확인 사유:`(상세 지적 안) + `추가 확인 이유:`(미해결 섹션 안) + `범위 미확정`(문서 전체). **탐지 실패가 아니다** — 이 축이 없으면 보류를 늘려 실패를 감추는 변화와 진짜 개선이 같은 점수를 받는다. `recall`의 분모에서 빼지 않는다 |
| `opFailures` | sub-agent 실패·kill·거부의 합(봉투의 `subagent_stats`). 2.6.0은 타임아웃 3회로 죽었고 `-full`은 4회를 겪고도 완주했다 — `completed`만 세면 그 차이가 사라진다. **`spawned: 0`이면 이 값의 0은 "실패 없음"이 아니라 "fan-out이 재현되지 않음"이다.** 봉투에 stats가 없으면 0이 아니라 `null` |

## 주의

- **CI 게이트가 아니다.** 리뷰는 비결정적이고, 임계값으로 PR을 막으면 노이즈가 정책이 된다. 목적은 시계열이다.
- **fixture 재현율은 리뷰 품질의 증명이 아니다.** 알려진 결함을 통과하도록 프롬프트를 튜닝하는 압력이 실재한다. `unclassified`를 노이즈가 아니라 신호로 본다.
- `evals/results/`는 gitignore다. 커밋되는 것은 `evals/baseline.json` 하나다.
