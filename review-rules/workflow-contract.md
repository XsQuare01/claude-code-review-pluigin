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

### 플러그인 버전 읽기

C-7의 `리뷰 기준`에 적을 플러그인 버전은 `RULES_DIR` 밖에 있으므로 여기서 함께 해석한다.

- `.claude-plugin/plugin.json`의 `version` 필드를 읽는다. 탐색 순서는 `RULES_DIR`의 상위 디렉터리, 그 다음 저장소 루트다
- 1번 경로로 해석했으면 `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`이 정본이다. 2·3번 경로로 해석했으면 그 파일이 아예 없을 수 있다
- 파일을 찾지 못했거나 `version`을 읽지 못하면 **버전을 추측하지 않고 `버전 미확인`으로 적는다.** `RULES_DIR`은 규칙 파일의 출처를, 버전은 severity 눈금을 알려주는 값이라 둘 중 하나만 확인돼도 그 사실이 리포트에 남아야 한다

## C-2. 모듈 탐색

```bash
ls "$RULES_DIR"/[0-9]*.md
```

- **모듈 목록을 파일명으로 하드코딩하지 않는다.** 항상 실제 나열 결과를 따른다
- 파일명 앞 숫자는 실행 순서이며 `00-rule.md`가 항상 최우선이다
- `00-rule.md`는 **공통 컨텍스트 전용**이다. 모든 모듈 prompt에 함께 전달하되 독립 모듈 pass로 실행하지 않는다
- 숫자 prefix가 없는 파일(`fast.md`, `props.md`, `math.md`, `exception.md`, `workflow-contract.md`, `catalog.json`)은 모듈 스캔에서 제외한다. 각각 자기 전용 워크플로우에서만 로드된다

### workflow별 실행 위치 (`phaseByWorkflow`)

모듈 대부분은 모든 워크플로우에서 같은 자리에 실행된다. 그렇지 않은 모듈은 `catalog.json`의 `phaseByWorkflow`에 선언하고, **여기에도 함께 적는다.** 한쪽에만 있으면 모듈 수 계산이 어긋나 누락으로 오인된다.

| 값 | 뜻 |
|----|-----|
| `module` | 일반 모듈 fan-out 대상 (선언이 없으면 이 값) |
| `consolidated` | 통합 단일 pass 안에서 함께 평가 |
| `post-verification-synthesis` | fan-out 대상이 아니라 **검증 이후 synthesis 단계**로 미룬다 |

**모듈 `10`(개발 원칙)은 `full`에서 `post-verification-synthesis`다.** 이 문서는 자기 역할을 "여러 모듈에 흩어진 지적을 대조해 하나의 원칙 위반으로 묶는 것"으로 선언하는데, 일반 fan-out에서는 다른 모듈의 결과가 입력에 없어 그 일을 구조적으로 수행할 수 없다. **실행 순서 문제가 아니라 데이터 의존성 문제**이므로 순서를 늦추는 것으로는 해결되지 않고, 다른 모듈 결과를 입력으로 받는 자리로 옮겨야 한다.

- `full`에서 모듈 `10`이 일반 모듈 pass로 실행되지 않은 것은 **누락이나 `FAILED orchestration`이 아니다.** `00-rule.md`가 독립 pass로 실행되지 않는 것과 같은 취급이다
- 따라서 `full`의 모듈 수 계산에서 `10`을 제외한다
- `default`와 `commit`은 통합 단일 pass이므로 종전대로 `consolidated`이며 동작이 바뀌지 않는다
- synthesis 단계의 입력·출력 계약은 C-6B 상태표를 따른다. **`rejected`만 제외되고 `not-eligible`·`verification-disabled`·`verification-unavailable`은 포함된다** — 빼면 selective 모드에서 입력이 줄어 대조 조건이 다시 무너진다
- synthesis는 **새 active finding을 만들지 않는다.** 어디서도 잡히지 않은 원칙 위반은 근본 원인 가설이나 openQuestion으로 낸다. 위치가 맞는다고 주장이 맞는 것은 아니며, 신규 finding을 그대로 편입하면 검증 gate를 통째로 우회한다

## C-3. 모듈 적용 조건 (profile / version gating)

모듈마다 적용 전제가 다르다. 전제가 성립하지 않는 모듈을 적용하면 그 자체가 오탐이다.

**판정 시점: 모듈을 로드하거나 sub-agent를 띄우기 전이다.** 프로파일과 버전은 프로젝트당 한 번만 판정하면 되는 값이므로, 오케스트레이터가 먼저 확인하고 그 결과를 각 모듈에 넘긴다. 모듈 안에서 각자 판정하면 같은 조사가 모듈 수만큼 반복되고, 적용되지도 않을 모듈에 작업을 띄우게 된다.

- 각 모듈 문서 상단의 전제(FSD, Electron, Tailwind, RSC, SSR, React/TypeScript 버전 등)를 먼저 확인한다
- `$RULES_DIR/catalog.json`에 모듈별 적용 조건이 기계 판독 가능한 형태로 정리돼 있다. 조건 판정에는 이 파일을 우선 참조하고, 판정 근거의 정본은 각 모듈 문서 본문이다
- **profile 성립 여부는 `profiles[].detect`의 신호로 판정한다.** 신호는 `dependency`(package.json 의존성), `file`(글롭), `content`(문자열 — `in`이 탐색 범위), `dirs`(`min`개 이상 존재), `profile`(다른 profile이 함의함)이며 `any`/`all`로 결합된다. 프레임워크 이름에 대한 인상이 아니라 찾은 것에 근거한다
- **매칭된 신호를 리포트에 한 줄로 남긴다** — 예: `tailwind: dependency tailwindcss 매칭`. 어떤 신호도 매칭되지 않았으면 그것을 `SKIPPED` 사유로 적는다. 무엇을 찾아봤는지 없는 SKIP은 검증할 수 없다
- `detect`가 `"declared"`인 profile은 **추론하지 않는다.** 사용자 요청이나 프로젝트 설정에 선언이 없으면 성립하지 않는 것으로 본다. `hints`는 사용자에게 물어볼 근거일 뿐 판정 근거가 아니다
- 전제가 성립하지 않는 모듈은 지적을 만들지 말고 `SKIPPED`와 사유를 리포트에 남긴다. **조용히 빼지 않는다** — 빠진 사실이 보이지 않으면 검토된 것으로 오인된다
- 전제를 확인할 수 없으면(설정 파일 부재 등) 그 모듈은 적용하지 않고 `UNKNOWN`으로 기록한다
- **누락 판정은 오탐과 같은 비용이다.** profile을 놓쳐 SKIP된 모듈은 리포트에서 "지적 없음"과 구분되지 않는다. `catalog.json`의 `cautions`는 실제로 관측된 오판정을 기록한 것이므로 해당 profile을 판정할 때 함께 읽는다

## C-4. 리뷰 범위 결정

**사용자가 범위를 지정했으면 그것이 최우선이다.** 지정된 범위가 있으면 아래 자동 판정을 수행하지 않는다.

지정이 없으면 base 브랜치를 다음 순서로 찾는다.

```bash
for candidate in main master; do
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
- **read-only는 프롬프트가 아니라 도구로 강제한다.** 지적을 만드는 sub-agent(producer)는
  파일을 쓸 수 있는 도구 없이 띄운다. 편집 도구뿐 아니라 셸도 제외한다 — 셸이 있으면
  리다이렉션이나 `sed -i`로 쓸 수 있어 편집 도구만 빼는 것은 절반짜리다.
  만능 에이전트(`general` 등 모든 도구를 가진 유형)로 producer를 띄우지 않는다
- 도구 이름은 런타임마다 다르므로 **능력 기준**으로 읽는다: producer는 "쓰기 도구 없음",
  오케스트레이터는 셸을 유지한다(diff 수집·스크립트·타임라인). 지적을 만드는 쪽과
  도구를 쓰는 쪽을 분리하는 것이 이 조항의 요점이다
- 런타임이 producer의 도구를 제한할 수 없으면, 그 실행은 **격리된 사본에서** 하거나
  producer를 띄우지 않고 오케스트레이터가 직접 읽어 리뷰한다. 제한할 수 없다는 사실을
  리포트에 적는다
- 자동 수정과 코드 수정은 사용자가 명시적으로 요청했을 때만
- 사용자의 read-only / 파일 수정 금지 / 텍스트 응답 요청이 다른 모든 규칙보다 우선
- 도구 실행 결과는 리뷰 지적과 분리해 별도 섹션으로 보고

## C-6A. 구조화된 결과 ownership 및 lifecycle

`REVIEW_RESULT_CONTRACT_V1`은 **producer → orchestrator 내부 인터페이스**다. 최종 Markdown 공개 형식은 유지하고, 이 내부 인터페이스만 구조화한다. 이 변경은 **의도적으로 수용한 내부 계약 변경**이며 `.claude-plugin/plugin.json` `2.4.0`에서 **MINOR**로 취급한다. 기본 이유는 producer 출력과 최종 리포트 렌더링을 분리해, shared contract·validation·dedupe를 한 곳에서 고정하기 위해서다.

### ownership matrix

| owner | mode | contract ownership |
|------|------|--------------------|
| `skills/code-review-full/SKILL.md` | `full` 일반 numbered + full specialist dispatch | structured-v1 producer 지시 보유 |
| `skills/code-review-props/SKILL.md` | `props` standalone specialist | structured-v1 producer 지시 보유 |
| `skills/code-review-math/SKILL.md` | `math` standalone specialist | structured-v1 producer 지시 보유 |
| `skills/code-review-exception/SKILL.md` | `exception` standalone specialist | structured-v1 producer 지시 보유 |
| `agents/correctness-reviewer.md` | correctness pass | direct agent only (`not structured-v1 until orchestrated consumer exists`) |
| `skills/code-review/SKILL.md` | `default` | legacy producer 유지 |
| `skills/code-review-commit/SKILL.md` | `commit` | legacy producer 유지 |
| `skills/code-review-fast/SKILL.md` | `fast` | legacy producer 유지 |

- numbered rule modules `01`~`21`과 specialist rule docs `props.md` / `math.md` / `exception.md`는 **workflow-neutral domain judgment docs**다. producer schema, raw JSON, malformed-output, renderer, legacy/structured ownership을 직접 소유하지 않는다.
- correctness agent는 `CR-{n}` namespace와 `00-9`/`00-10`/`00-11` evidence discipline을 그대로 따르지만, **phase-1 structured-v1 owner는 아니다.** 지금은 built-in validation/render consumer가 없으므로 direct-agent evidence-first 결과만 낸다.
- 아래 lifecycle은 **structured-v1 owner에만 적용**한다. legacy owner(`default`, `commit`, `fast`)는 기존 producer 계약을 유지한다.

`REVIEW_RESULT_CONTRACT_V1`을 쓰는 owner에서는 결과가 **producer → validation → aggregation → Markdown rendering** 순서로 흐른다. 공통 원칙은 다음과 같다.

- producer 출력은 **prompt만으로 유도한 JSON 객체 하나**여야 한다. 코드 펜스, 서문, Markdown 헤딩, 표, severity 문자열을 섞지 않는다
- 이 제한은 네이티브 스키마 강제가 아니라 **프롬프트 계약**이다. 따라서 "정적 문서가 있으니 런타임 적합성도 보장된다"고 주장하지 않는다
- producer는 `impact`와 `confidence`까지 판정하되, **severity와 최종 Markdown은 오케스트레이터 전용 책임**이다

### producer

- producer instruction owner는 아래 manifest를 **그대로 주입한 런타임 placeholder** `REVIEW_RESULT_CONTRACT_V1_MANIFEST`를 prompt에 포함해 `REVIEW_RESULT_CONTRACT_V1` JSON 하나만 반환하게 만든다
- `REVIEW_RESULT_CONTRACT_V1_MANIFEST`의 source는 이 문서의 **manifest sentinel JSON block 전문 그대로**다. owner 문서가 schema token을 부분 복제해 substitute context를 만들지 않는다
- top-level `schemaVersion`은 `1`이어야 한다
- `findings`와 `openQuestions`는 항상 배열로 반환한다. 빈 결과도 필드는 생략하지 않는다
- `openQuestions`는 `findings`와 분리된 **별도 필수 필드**다. 확인이 덜 된 항목을 finding으로 끌어올려 대체하지 않는다
- `openQuestions`는 **주장 자체의 진실 여부나 탐색 범위가 아직 닫히지 않은 경우**에만 쓴다. 특히 `00-rule.md` 00-11에 걸리는 incomplete absence/possibility claim, diff 밖 추가 확인 요청, search scope 미완료 항목이 여기에 해당한다
- 결함 자체는 성립하지만 **정확한 위치만 아직 확정하지 못한 경우**는 finding으로 유지하고 `location.kind = "unverified"` 를 쓴다. 이것은 openQuestion의 대체물이 아니다
- `location.kind = "unverified"` 는 **위치를 아직 확인하지 못했다는 사실 자체**를 표현한다. 이 변형에는 `reason`이 필요하고 `path`, `line`, `lineBefore`, `quote`를 꾸며 넣지 않는다
- structured prompt는 producer에게 공개 Markdown 상태 토큰 **`위치 미확인` 문자열을 literal로 쓰라고 지시하지 않는다.** producer는 오직 `location.kind = "unverified"` 와 `reason`으로 표현하고, 공개 Korean 상태 토큰 렌더링은 최종 renderer 책임이다

### validation

- 오케스트레이터는 producer 응답을 받은 즉시 envelope와 필수 필드를 검증한다
- JSON 파싱 실패, 필수 필드 누락, 금지 필드(`severity`) 포함, 허용되지 않은 location/impact/category 값은 **malformed-output**이다
- malformed-output이든 legacy/prose 출력이든 **교정 재시도는 한 번만** 한다. 재시도 prompt는 잘못된 점만 짧게 지적하고 같은 계약으로 다시 요구한다
- 두 번째도 malformed-output이면 그 pass는 **`FAILED malformed-output`으로 종료**한다. 부분 해석이나 추측 보정으로 통과시키지 않는다

### aggregation

- aggregation은 **검증을 통과한 JSON만** 입력으로 받는다
- openQuestions는 findings로 승격하지 않는다. 별도 목록으로 유지한다
- deduplication 규칙은 **이 문서가 정본**이다. 각 워크플로우는 더 약한 인접 줄수 근사 규칙이나 별도 병합 정의를 만들지 않고 여기에만 따른다
- 다음이 **모두 같을 때만** findings를 병합한다: 같은 `ruleId`, `location.kind`가 `verified` 또는 `deleted`, 같은 정규화 위치(`verified.path + verified.line` 또는 `deleted.path + deleted.lineBefore`), 같은 핵심 주장/근본 원인/깨지는 조건, 같은 `impact` 값과 `category` 값, 같은 `confidence` 값
- `location.kind = "unverified"` finding은 **자동 병합하지 않는다.** anchor가 없으므로 서술 유사성만으로 같은 사실이라고 단정하지 않는다
- `openQuestions`는 **자동 병합하지 않는다.** unresolved search scope를 기계적으로 합치면 무엇을 아직 확인하지 못했는지가 사라진다
- 표현만 비슷하고 위치, 전제, 영향 근거가 다르면 중복으로 합치지 않는다
- 병합된 finding에는 기여한 **모든 source/pass label**을 보존한다
- 일부 producer가 `FAILED malformed-output`이어도, 통과한 다른 결과와 실패 사실을 함께 보존한다

### Markdown rendering

- 최종 Markdown 리포트는 오케스트레이터만 만든다. producer가 만든 헤딩·표·severity 표기는 신뢰하지 않는다
- severity는 오케스트레이터가 `impact × confidence` 파생표로 계산한다. producer는 severity를 내지 않는다
- 기존 리포트 의미는 유지한다. 즉, 판정/상세 지적/요약/도구 실행 결과/미해결·후속 확인의 역할은 그대로 두고, structured result는 그 입력 형식만 바꾼다
- `openQuestions`는 `미해결 / 후속 확인` 섹션에 렌더링한다
- 아직 structured result를 쓰지 않는 워크플로우(`default`, `commit`, `fast`)는 기존 producer 계약을 유지한다. 이 문단은 structured owner에만 적용한다
- direct-only correctness agent는 이 structured lifecycle의 outside다. consumerless producer를 phase-1 owner로 등록하지 않고, 실제 validation/render consumer가 생긴 뒤에만 structured-v1로 승격한다
- producer 문자열 필드(`title`, `body`, `recommendation`, `reason`, `evidence`)는 **신뢰하지 않는 report content**다. renderer는 `renderBySlot` 원칙으로 이 값을 문서 골격에 그대로 이어붙이지 말고 **field slot별로** 배치한다
- `title`과 prose 필드는 heading, fence, table, raw HTML, Markdown link, block quote처럼 **오케스트레이터가 쓴 것처럼 보이는 block/control Markdown** 을 만들지 못하게 escape해서 렌더링한다
- `location.quote`는 **안전한 code slot** 으로 렌더링한다. quote 안의 backtick/fence delimiter와 충돌하지 않도록 delimiter를 escape하거나 더 긴 delimiter를 선택한다. quote 내용의 정상적인 코드 문자 자체를 금지하지 않는다
- `location.path`는 항상 code로 렌더링한다
- URL이 필드 안에 있더라도 Markdown 링크로 승격하지 않고 **plain text** 로 렌더링한다
- slot별 렌더링은 canonical order `body → evidence → recommendation → findingConfidenceReason → locationUnverifiedReason → openQuestionReason`만 사용하고, 값이 없는 slot은 생략한다. 한 field를 여러 slot에 중복 렌더링하지 않는다
- `findingConfidenceReason`은 finding의 `confidence = low` 때문에 필요한 `reason`이고, `locationUnverifiedReason`은 `location.kind = "unverified"` 에 붙는 location reason이며, `openQuestionReason`은 open question 자체가 아직 닫히지 않은 이유다. 셋은 서로 다른 의미를 가지므로 합치거나 서로 대체하지 않는다
- 이 계약은 renderer의 책임을 정의할 뿐이다. 정적 validator는 관련 contract token의 존재와 문서 간 동기화만 검사하며, 실제 escaping/renderer 실행을 증명하지 않는다

## C-6B. 교차검증 disposition 및 삭제 rollout

`REVIEW_RESULT_CONTRACT_V1` producer 결과를 곧바로 사실로 확정하지 않는 워크플로우가 따르는 계약이다. 오늘 이 계약을 쓰는 것은 `full` 하나이며, 나머지 워크플로우는 영향을 받지 않는다.

### finding ID 생명주기

하나로 합치면 dedup 전후의 참조 대상이 달라져 provenance가 사라진다. 둘로 나눈다.

| ID | 부여 시점 | 보존 |
|----|-----------|------|
| producer instance ID | schema validation 통과 직후 | 원 producer, source/pass label, 원본 finding 전문 |
| canonical candidate ID | exact dedup 이후 | `memberInstanceIds[]` |

검증·synthesis·rendering이 참조하는 단위는 candidate다.

**ID는 동일 실행 안에서만 안정적이다.** 실행 간 안정성은 보장하지 않는다. 자유 서술을 hash해 실행 간 안정성까지 만들려면 정규화·충돌 처리·버전 이행이 따라붙는다. 실행 간 추적이 필요해지면 그때 별도로 설계한다.

### 실행 위치

**검증은 exact dedup 이후에 한다.** 같은 결함을 여러 번 반박하는 낭비를 피한다. **위치 대조는 dedup보다 앞에 둔다** — dedup이 정규화 위치를 키로 쓰므로, 위치가 틀린 채로 병합하면 잘못된 병합이 만들어진다.

C-6A의 병합 판정 조건은 그대로다. 달라지는 것은 **실행 시점과 출력 인터페이스**이며, 병합 후에도 모든 instance ID·source label·원본 finding·candidate↔instance 관계를 보존한다.

### disposition

verifier가 반환하는 값과 오케스트레이터가 부여하는 값을 구분한다. **verifier는 자기 부재를 보고할 수 없다.**

| 값 | 부여 주체 | 뜻 |
|----|-----------|-----|
| `upheld` | verifier | 반례를 찾지 못했다 |
| `rejected` | verifier | 반례나 방어 장치를 찾았다 |
| `needs-context` | verifier | 이 컨텍스트로는 닫아 말할 수 없다 |
| `scope-open` | 오케스트레이터 | isolated에서도 `needs-context` — 00-11에 따라 openQuestion으로 |
| `not-eligible` | 오케스트레이터 | eligibility에서 `SKIP-VERIFY` |
| `verification-disabled` | 오케스트레이터 | 검증을 끈 실행의 검증 대상 |
| `verification-unavailable` | 오케스트레이터 | verifier를 띄웠으나 결과를 얻지 못함 |

**`verification-disabled`와 `verification-unavailable`을 구분하는 이유**는 "검증을 끈 실행"과 "검증이 깨진 실행"이 다르기 때문이다. 전자는 사용자의 선택이고 후자는 사고다. coverage에서 같은 칸에 들어가면 검증을 끈 리뷰가 실패한 리뷰처럼 읽힌다.

`upheld`를 쓰고 `confirmed`를 쓰지 않는다. **반례를 찾지 못한 것은 증명과 같지 않다.**

### 상태표 — rendering · synthesis · merge verdict의 단일 정본

| 상태 | active 리포트 | synthesis 입력 | `impact = high`일 때 차단 | audit |
|------|---------------|----------------|---------------------------|-------|
| `not-eligible` | 포함 | 포함 | 차단 | `disposition`만 |
| `verification-disabled` | 포함 | 포함 | 차단 | `disposition`만 |
| `upheld` | 포함 (검증 표시) | 포함 | 차단 | 포함 |
| `rejected` | **아래 rollout phase에 따름** | 제외 | phase에 따름 | 포함 (원본 전문 + rebuttal) |
| `scope-open` | openQuestion으로 이동 | 증상 제외, openQuestion으로 전달 | 차단하지 않음 | 포함 |
| `verification-unavailable` | **포함 (fail-open)** + 실패 표시 | 포함 + `unavailable` 표시 | **차단** | 포함 |

- **다른 절에서 같은 판단을 다시 정의하지 않는다.** 각 워크플로우 SKILL 문서는 이 표를 참조한다
- **`rejected`를 active에서 빼는 이유** — 구체적 반례가 확인된 것은 불확실한 주장이 아니라 거짓으로 판정된 후보다. `confidence = low`로 강등해 🔵로 남기면 이미 끝난 판단을 읽는 사람이 다시 하게 된다
- **`verification-unavailable`이 fail-open인 이유** — 검증하지 못한 것을 반박된 것으로 취급하면, 검증자를 죽이는 것이 곧 지적을 지우는 경로가 된다
- **`verification-unavailable`을 synthesis에 넣는 이유** — 빼면 selective 모드에서 입력이 줄어 `10-principles.md`의 대조 조건이 다시 무너진다. 넣되 표시한다

개별 finding의 차단 여부는 이 표가 정한다. **gate 전체의 완결성 판정(`INCONCLUSIVE`)은 다른 값**이며 모드별 정책을 따른다. 둘을 섞으면 "차단 후보가 있는데 판정은 통과"가 나온다.

### `rebuttal.kind = other`

닫힌 목록만 허용하면 목록 밖의 정당한 사유가 나왔을 때 검증자가 가장 가까운 값에 억지로 밀어 넣고, 그러면 `kind` 분포 자체를 신뢰할 수 없게 된다. 목록을 지키려다 목록의 신호값을 잃는다.

**`other`는 어떤 phase에서도 finding의 상태를 바꾸지 않는다.** active로 유지하고 원 severity와 차단 여부를 보존한다. `scope-open`으로 투영하지 않는다 — 그것은 finding을 openQuestion으로 옮겨 active와 차단을 함께 잃게 하므로, "삭제하지 않는다"고 해놓고 같은 결과를 만든다. **`other`가 차단 우회로가 되어서는 안 된다.**

`other`가 하는 일은 아무것도 바꾸지 않고 기록하는 것뿐이다. `other`가 충분히 쌓였을 때만 새 `kind` 승격을 검토한다.

### 삭제 rollout phase

`rejected`의 active 제외는 되돌릴 수 없고, **틀렸을 때 조용히 실패한다** — 잘못 반박하면 리포트가 오히려 깨끗해 보인다. 다른 실패는 비용이 늘거나 지표가 튀어 관측되지만 이것만 실패가 성공처럼 보인다. 따라서 처음부터 켜지 않는다.

| phase | `rejected`의 active 처리 | `impact = high`의 차단 |
|-------|--------------------------|------------------------|
| `rollout-shadow` (기본) | `반박됨 — 관찰 중`으로 유지 | **차단한다** |
| `active-deletion` | 제외 | 차단하지 않음 (active에 없으므로) |

**`rollout-shadow`에서도 high-impact가 차단한다는 것이 이 phase의 핵심이다.** 관찰 기간을 무방비 기간으로 만들지 않는다. 삭제했다면 어떤 차단이 풀렸을지의 가상 결과는 audit에만 기록한다.


#### 오케스트레이터가 다시 적어야 하는 규칙

C-6B에만 있고 실행 문서에 없는 규칙은 **실행 문서만 읽는 오케스트레이터에게 보이지 않는다.** 실제로 한 실행이 shadow에서 반박된 차단 후보를 "판정 근거로 승격하지 않았다"고 처리했다 — 다른 차단 후보가 있어 결과는 바뀌지 않았지만, 그것이 유일한 차단 후보였다면 관찰 기간이 곧 무방비 기간이 됐을 것이다.

아래 문구는 owner skill이 **그대로 담아야 한다.** validator가 확인한다.

<!-- CROSS_VERIFICATION_OWNER_RESTATEMENTS:BEGIN -->
```json
{
  "mustAppearInOwner": {
    "shadow-still-blocks": "rollout-shadow에서 반박된 finding도 원 severity를 유지하며 판정에서 차단 후보로 계산한다",
    "candidate-id-mapping": "candidate ID를 리포트에 쓰면 finding과의 매핑을 같은 리포트 안에 싣는다",
    "counts-provenance": "coverage 숫자의 출처를 함께 적는다"
  }
}
```
<!-- CROSS_VERIFICATION_OWNER_RESTATEMENTS:END -->

### coverage 숫자의 출처

`prepare-verification.mjs`를 돌린 리포트와 모델이 눈으로 센 리포트는 **겉보기에 똑같다.** 산술이 맞아도 그것이 결정적으로 계산된 것인지 알 수 없다.

**coverage 숫자의 출처를 함께 적는다.**

```
Verification coverage: 대상 10 중 7 검증 … · counts 출처: `prepare-verification.mjs`
Verification coverage: 대상 10 중 7 검증 … · counts 출처: 미실행 (모델 판정)
```

- 스크립트를 돌렸으면 그 사실을 적고, `도구 실행 결과`에도 실행을 남긴다
- 돌리지 않았으면 **미실행이라고 적는다.** 숫자가 맞더라도 결정적으로 판정했다고 서술하지 않는다
- 경로를 찾지 못했으면 그 사실을 사유와 함께 적는다

이 요구는 실행을 강제하지 못한다. **강제하는 대신 생략이 보이게 한다** — `SKIPPED`·`FAILED`·`UNKNOWN`을 구분해 적게 하는 C-8과 같은 이유다.

### candidate ID 표기

candidate ID는 오케스트레이터가 부여하는 내부 식별자이고 형식을 고정하지 않는다. 다만 **리포트 본문에 등장하는 순간 독자의 것이 된다.**

- **candidate ID를 리포트에 쓰면 finding과의 매핑을 같은 리포트 안에 싣는다.** 표 한 줄이면 충분하다
- 매핑 없이 ID만 언급하면 독자는 그 ID가 어느 지적인지 문서를 뒤져 추측해야 한다. 실제로 한 실행이 반박 사실을 `HR-2`로만 적어, 그것이 어느 finding인지 두 절을 대조해야 알 수 있었다
- ID를 쓰지 않고 규칙 ID와 위치로만 지칭해도 된다. 요구는 "추적 가능할 것"이지 "ID를 쓸 것"이 아니다

phase는 전역이 아니라 **`impact`별 오케스트레이터 설정**이다. 하나뿐이면 아래의 독립 승인을 표현할 수 없다.

```
deletionPhase:
  high: rollout-shadow | active-deletion     # 기본 rollout-shadow
  low:  rollout-shadow | active-deletion     # 기본 rollout-shadow
```

**전환은 경과가 아니라 증거로 한다.** "N회 실행했다"는 반박 정확도를 증명하지 못한다. 아래를 모두 충족한 뒤 명시적으로 전환한다.

- 최소 실행 수
- `impact`별 최소 `rejected` 표본 수 — high와 low를 합산하지 않는다
- 사람이 판정한 suppression 정확도
- 사전에 정한 false-suppression 허용치 — 결과를 보고 정하면 기준이 아니다
- kill switch — `impact`별 복귀와 전역 복귀를 구분한다
- `impact` high / low의 독립적인 전환 승인

**승인 무효화** — 검증자 모델, 반박 프롬프트, `rebuttal.kind` taxonomy, 라우팅 정책이 실질적으로 바뀌면 해당 `impact`의 phase를 `rollout-shadow`로 되돌린다. 이전 승인은 그때의 검증자에 대한 측정이었지 파이프라인 일반에 대한 것이 아니다.

**진단 신호와 승격 근거를 구분한다.** `disposition` 분포와 `rejected` 비율은 의심할 근거일 뿐이고, `active-deletion` 전환의 근거는 **사람이 판정한 false-suppression rate 하나뿐**이다. 분포가 정상으로 보여도 개별 반박은 틀릴 수 있다.

**route별로 나눠서 잰다.** bundle verifier는 컨텍스트 부족을 인식하지 못한 채 `rejected`를 낼 수 있고 isolated는 그 실패 모드가 없다. 합산하면 bundle의 오판이 희석된다. bundle route에는 별도 전환 기준을 두고, bundle의 false-suppression이 임계를 넘으면 **그 route의 결과에 삭제 권한을 주지 않는다.** 라우팅 근사의 실패가 삭제 권한과 분리돼야, 근사를 조일수록 suppression이 조용히 늘는 일이 없다.

### 오판 가시성

`rejected`를 active에서 빼면 검증자의 오판이 진짜 결함의 소멸이 된다. audit는 보존하지만 audit를 읽는 사람은 없다.

**따라서 흔적은 audit이 아니라 리포트에 남긴다.** `active-deletion` phase에서 `미해결 / 후속 확인` 섹션에 적는다.

- `impact = high`였던 것: 규칙 ID · anchor path · `rebuttal.kind` — 건별 한 줄
- `impact = low`였던 것: 건수만

본문과 `rebuttal.location`·`note`는 audit에 둔다. **보존의 정본은 audit이 아니라 리포트 본문이며, audit이 없어도 이 설계는 성립해야 한다.**

### audit — 실행 중 자료와 영속 projection은 다른 인터페이스다

하나로 두면 "원본 전문을 갖는다"와 "소스 전문을 싣지 않는다"가 같은 객체에 동시에 걸린다.

| 인터페이스 | 성격 | 내용 |
|-----------|------|------|
| `VerificationAudit` | 내부 · 실행 중 · 비영속 | candidateId, memberInstanceIds, 원본 finding 전문, disposition, rebuttal/reason/evidence, observed 두 축, usedCrossFileContext, 실패 metadata, 라우팅 경로 |
| `VerificationAuditSidecar` | 영속 · 최소화 projection | candidateId, ruleId, impact/confidence, category, disposition, rebuttal(`kind`·`location`·`note`), usedCrossFileContext, route, failureClass, location |

**sidecar는 부분집합이며 상위 집합이 아니다.** 원본 finding 전문과 `evidence` 자유 서술은 싣지 않는다 — 그 둘이 소스와 내부 서술을 가장 많이 담는다. `note`에 길이 상한을 둔다. `not-eligible`·`verification-disabled`는 `disposition`까지만 싣되, 반사실 계산에 모수가 필요하므로 **싣긴 싣는다.**

| 모드 | 영속성 |
|------|--------|
| `selective` | 비영속. 실행 종료 시 폐기. 사용자가 명시적으로 요청할 때만 파일 산출 |
| `exhaustive` | sidecar를 **기본 저장** |

`exhaustive`는 릴리스 게이트·정기 품질 측정 용도이므로 산출물이 남는 것이 자연스럽고, **이 경로가 측정 자료의 유일한 축적 수단이다.**

**read-only / no-write / text-only 요청에서는 모드와 무관하게 파일 저장과 원격 전송을 생략하고 응답에 `audit persistence disabled`를 표시한다.** C-6의 사용자 우선 계약이 이 기본값보다 위에 있다. 표시를 요구하는 이유는 저장이 생략된 실행을 나중에 "측정했는데 자료가 없다"로 오독하지 않게 하기 위해서다.

## REVIEW_RESULT_CONTRACT_V1

아래 manifest가 structured-v1 owner가 참조하는 shared schema 정본이다.

<!-- REVIEW_RESULT_CONTRACT_V1:BEGIN -->
```json
{
  "contractName": "REVIEW_RESULT_CONTRACT_V1",
  "schemaVersion": 1,
  "topLevel": {
    "required": [
      "schemaVersion",
      "findings",
      "openQuestions"
    ],
    "allowed": [
      "schemaVersion",
      "findings",
      "openQuestions"
    ],
    "forbidden": [
      "severity"
    ]
  },
  "impact": {
    "enum": [
      "high",
      "low"
    ],
    "highRequires": [
      "category",
      "evidence"
    ],
    "lowForbids": [
      "category"
    ],
    "lowAllowsOptional": [
      "evidence"
    ],
    "categoryEnum": [
      "user-malfunction",
      "data-loss",
      "security-exposure",
      "verification-failure",
      "external-breakage"
    ],
    "categoryLabels": {
      "user-malfunction": "사용자에게 보이는 오동작 또는 사용 불가",
      "data-loss": "데이터 손상·유실",
      "security-exposure": "보안 노출",
      "verification-failure": "빌드·타입체크·테스트 실패",
      "external-breakage": "빌드 밖 계약/복구 경로 파손"
    }
  },
  "confidence": {
    "enum": [
      "high",
      "low"
    ],
    "lowRequires": [
      "reason"
    ]
  },
  "location": {
    "kindField": "kind",
    "variants": {
      "verified": {
        "allowed": [
          "kind",
          "path",
          "line",
          "endLine",
          "quote"
        ],
        "required": [
          "path",
          "line",
          "quote"
        ],
        "optional": [
          "endLine"
        ],
        "constraints": {
          "endLine": "positive-and-gte-line"
        }
      },
      "deleted": {
        "allowed": [
          "kind",
          "path",
          "lineBefore",
          "endLine",
          "quote"
        ],
        "required": [
          "path",
          "lineBefore",
          "quote"
        ],
        "optional": [
          "endLine"
        ],
        "constraints": {
          "endLine": "positive-and-gte-lineBefore"
        }
      },
      "unverified": {
        "allowed": [
          "kind",
          "reason"
        ],
        "required": [
          "reason"
        ],
        "forbidden": [
          "path",
          "line",
          "lineBefore",
          "quote"
        ]
      }
    }
  },
  "findingsItem": {
    "required": [
      "ruleId",
      "title",
      "body",
      "impact",
      "confidence",
      "location"
    ],
    "allowed": [
      "ruleId",
      "title",
      "body",
      "impact",
      "confidence",
      "location",
      "category",
      "evidence",
      "reason",
      "recommendation"
    ],
    "forbidden": [
      "severity"
    ]
  },
  "openQuestionsItem": {
    "required": [
      "title",
      "body",
      "location",
      "reason"
    ],
    "allowed": [
      "ruleId",
      "title",
      "body",
      "location",
      "reason",
      "recommendation"
    ]
  },
  "renderingSafety": {
    "untrustedFields": [
      "title",
      "body",
      "recommendation",
      "reason",
      "evidence",
      "location.path",
      "location.quote"
    ],
    "renderBySlot": true,
    "escapeMarkdownControlInProseFields": true,
    "codeFields": [
      "location.path",
      "location.quote"
    ],
    "slots": {
      "body": {
        "sourceFields": [
          "body"
        ],
        "omitWhenMissing": true
      },
      "evidence": {
        "sourceFields": [
          "evidence"
        ],
        "omitWhenMissing": true
      },
      "recommendation": {
        "sourceFields": [
          "recommendation"
        ],
        "omitWhenMissing": true
      },
      "findingConfidenceReason": {
        "sourceFields": [
          "reason"
        ],
        "appliesWhen": "finding.confidence=low",
        "omitWhenMissing": true
      },
      "locationUnverifiedReason": {
        "sourceFields": [
          "location.reason"
        ],
        "appliesWhen": "location.kind=unverified",
        "omitWhenMissing": true
      },
      "openQuestionReason": {
        "sourceFields": [
          "reason"
        ],
        "appliesWhen": "openQuestion",
        "omitWhenMissing": true
      }
    },
    "slotOrder": [
      "body",
      "evidence",
      "recommendation",
      "findingConfidenceReason",
      "locationUnverifiedReason",
      "openQuestionReason"
    ],
    "slotLabels": {
      "body": "본문",
      "evidence": "근거",
      "recommendation": "개선 제안",
      "findingConfidenceReason": "확신 근거",
      "locationUnverifiedReason": "위치 미확인 사유",
      "openQuestionReason": "추가 확인 이유"
    },
    "urlsRenderAs": "plain-text",
    "staticValidatorScope": "doc-sync-only"
  }
}
```
<!-- REVIEW_RESULT_CONTRACT_V1:END -->

## REVIEW_VERDICT_CONTRACT_V1

교차검증 verifier → 오케스트레이터 내부 인터페이스다. `REVIEW_RESULT_CONTRACT_V1`과 같은 지위이며, manifest sentinel 방식과 retry/fail-closed 정책을 그대로 재사용한다.

- verifier는 **주장의 참·거짓만 판정한다.** `impact`·`confidence`·severity를 바꾸지 않는다. `observedImpact`/`observedConfidence`는 audit 전용 비권위 값이며 리포트에 영향을 주지 않는다
- **bundle verifier와 isolated verifier는 같은 인터페이스를 쓴다.** 단계마다 다른 enum을 두면 호출자가 verifier 종류를 알아야 결과를 해석하게 된다
- **반환된 `candidateId` 집합은 요청한 집합과 정확히 일치해야 한다.** 누락도 추가도 허용하지 않는다. bundle이나 cluster 단위로 한꺼번에 판정하는 것을 막는 기계적 장치다
- `rebuttal.location`은 **`REVIEW_RESULT_CONTRACT_V1`의 location variant를 그대로 쓰되 `unverified`를 허용하지 않는다.** 위치를 확인하지 못한 반박으로 지적을 지울 수 없다
- `rebuttal.kind = other`는 목록 밖 사유를 억지로 끼워 넣지 않게 하는 escape hatch다. **`other`는 어떤 phase에서도 삭제를 유발하지 않으므로** `location`을 요구하지 않고 `note`를 요구한다

<!-- REVIEW_VERDICT_CONTRACT_V1:BEGIN -->
```json
{
  "contractName": "REVIEW_VERDICT_CONTRACT_V1",
  "schemaVersion": 1,
  "topLevel": {
    "required": [
      "schemaVersion",
      "verdicts"
    ],
    "allowed": [
      "schemaVersion",
      "verdicts"
    ],
    "forbidden": [
      "severity"
    ]
  },
  "disposition": {
    "enum": [
      "upheld",
      "rejected",
      "needs-context"
    ],
    "requires": {
      "rejected": "rebuttal",
      "needs-context": "reason"
    }
  },
  "rebuttal": {
    "required": [
      "kind"
    ],
    "allowed": [
      "kind",
      "location",
      "note"
    ],
    "kindEnum": [
      "guard-exists",
      "idempotent-or-safe",
      "unreachable",
      "contract-differs",
      "location-wrong",
      "other"
    ],
    "kindLabels": {
      "guard-exists": "이 주장을 막는 가드가 있다",
      "idempotent-or-safe": "반복 실행이나 재진입이 안전하다",
      "unreachable": "지적이 가리킨 경로에 도달하지 않는다",
      "contract-differs": "전제한 계약이 실제와 다르다",
      "location-wrong": "결함은 성립하나 위치가 틀렸다",
      "other": "닫힌 목록 밖의 사유 — 삭제를 유발하지 않는다"
    },
    "deletionAllowingKinds": [
      "guard-exists",
      "idempotent-or-safe",
      "unreachable",
      "contract-differs",
      "location-wrong"
    ],
    "locationOptionalKinds": [
      "other"
    ],
    "locationVariants": [
      "verified",
      "deleted"
    ],
    "kindRequires": {
      "other": "note"
    }
  },
  "observedAxes": {
    "enum": [
      "high",
      "low"
    ],
    "fields": [
      "observedImpact",
      "observedConfidence"
    ],
    "authority": "audit-only"
  },
  "verdictsItem": {
    "required": [
      "candidateId",
      "disposition",
      "evidence",
      "location"
    ],
    "allowed": [
      "candidateId",
      "disposition",
      "evidence",
      "location",
      "rebuttal",
      "reason",
      "usedCrossFileContext",
      "observedImpact",
      "observedConfidence"
    ],
    "forbidden": [
      "severity"
    ]
  }
}
```
<!-- REVIEW_VERDICT_CONTRACT_V1:END -->

## C-7. 리포트 저장

- 파일명: `code-review-{workflow-name}-{branch-name}-{date}.md`
- 기본 저장 위치는 `./review-reports/`
- **프로젝트나 사용자 설정이 문서 저장 위치를 따로 지정하고 있으면 그쪽이 우선한다** (`CLAUDE.md`, `AGENTS.md` 등). 사용자 지시가 이 계약보다 우선하며, 그렇게 저장한 것은 위반이 아니다. 어디에 저장했든 **경로를 사용자에게 보고**한다
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

### 어떻게 쓰는가

지금까지 이 절은 **어디에 무슨 이름으로** 쓸지만 정했다. 어떻게 쓰는지는 정하지
않았고, 그 자리에서 실제로 시간이 샜다 — 한 실행이 694줄짜리 리포트를 **세 번**
만들었다. 렌더가 느려서가 아니라 저장이 깨져서였다.

- **UTF-8로 쓴다.** 한글과 이모지가 본문에 들어가므로 인코딩을 명시하지 않은 저장은
  깨진다. 시스템 기본 코드페이지에 맡기지 않는다
- **본문을 셸로 흘려보내지 않는다.** 파일 쓰기 도구로 직접 쓴다. 문서를 파이프나
  명령줄 인자로 넘기면 따옴표·백슬래시·비ASCII 문자가 지나는 길마다 손상 지점이
  하나씩 늘어난다. 실제로 한글 폴더명이 `?? ??`로 바뀌어 저장이 실패했다
- **경로에 비ASCII가 들어갈 수 있다.** 사용자 설정이 저장 위치를 지정하면 그 경로에
  한글이 들어오는 것은 정상이다. 경로를 다루는 쪽이 그것을 견뎌야 한다
- **쓴 뒤에 확인한다.** 파일이 존재하는지, 줄 수가 예상과 맞는지, 본문의 한글이
  그대로인지 읽어서 본다. **확인 없이 "저장했다"고 보고하지 않는다** — 위 실행에서
  두 번째 시도는 파일이 생겼지만 내용이 손상돼 있었고, 그것을 읽어봤기 때문에 알았다
- 저장에 실패하면 **문서를 다시 만들지 말고 저장만 다시 시도한다.** 본문은 이미
  손에 있다. 전체를 다시 생성하면 그만큼의 시간이 통째로 다시 든다

### 문서 제목

H1은 **`# {대상} {워크플로우 이름} 리포트`** 형식이며, 대상은 리뷰한 브랜치(커밋 리뷰면 커밋)다.

```
# `feat/camera-preview` 전체 코드 리뷰 리포트
# `feat/camera-preview` 빠른 코드 리뷰 리포트
# `a1b2c3d` 커밋 코드 리뷰 리포트
```

| workflow-name | 워크플로우 이름 |
|---------------|-----------------|
| `default` | 코드 리뷰 |
| `full` | 전체 코드 리뷰 |
| `fast` | 빠른 코드 리뷰 |
| `commit` | 커밋 코드 리뷰 |
| `props` | Props/인자 전달 코드 리뷰 |
| `math` | 수학 코드 리뷰 |
| `exception` | 예외 처리 코드 리뷰 |

**대상을 제목에 넣는 이유**는 리포트가 쌓이기 때문이다. 워크플로우 이름만 있는 제목은 열 개가 모이면 서로 구분되지 않고, 파일명을 봐야 어느 브랜치 것인지 알 수 있다. 제목은 문서를 열었을 때 가장 먼저 읽히는 자리이므로 거기서 식별이 끝나야 한다.

제목은 리포트를 **쓰기 시작할 때** 정한다. 다 쓴 뒤에 고치면 그 자체가 재작업이다.

### 문서 골격

**섹션 이름·순서·헤딩 레벨은 아래로 고정한다.** 같은 워크플로우가 만든 리포트는 같은 골격을 가져야 한다.

| 레벨 | 섹션 | 내용 | 적용 |
|------|------|------|------|
| `#` | `{대상} {워크플로우 이름} 리포트` | 문서에 **하나뿐** | 전체 |
| `##` | 리뷰 기준 | 범위, base, merge-base, `RULES_DIR`, 플러그인 버전, 프로젝트 프로파일 | 전체 |
| `##` | 판정 | 결론 한 줄과 차단 사유. 길어야 서너 줄 | 전체 |
| `##` | 실행 계획 | 후보 N / 적용 M / `SKIPPED`·`UNKNOWN` 목록과 사유 / 실패 클래스별 건수 | 모듈을 쓰는 워크플로우 |
| `##` | 상세 지적 | 아래 모듈 섹션을 담는다 | 전체 |
| `###` | `{NN} {모듈 제목}` | 모듈 하나당 하나 | 모듈을 쓰는 워크플로우 |
| `####` | `{severity} {규칙 ID} {제목}` | finding 하나당 하나 | 전체 |
| `##` | 특수 패스 | Props·수학·예외를 `###`로 | `full` |
| `##` | 요약 | 중복 제거된 지적을 severity 순으로 | `full`, `default` |
| `##` | 도구 실행 결과 | C-6 / `00-rule.md` 00-9 | 전체 |
| `##` | 미해결 / 후속 확인 | 확인이 남은 항목 | 전체 |

- **판정과 요약은 다른 것이다.** 판정은 머지 가능 여부의 결론이고, 요약은 지적 목록이다. 판정을 앞에 두는 이유는 긴 리포트에서 결론을 먼저 읽어야 하기 때문이고, 요약을 상세 뒤에 두는 이유는 요약이 상세를 대체하지 못하게 하기 위해서다
- 워크플로우에 해당하지 않는 섹션은 **생략한다**. 빈 섹션을 남기지 않는다
- 위 목록에 없는 섹션을 추가하지 않는다. 남길 내용이 있으면 `미해결 / 후속 확인`에 넣는다
- **플러그인 버전을 적는 이유**는 severity의 눈금이 버전에 따라 다르기 때문이다. 같은 🔴이 다른 판정 기준에서 나왔을 수 있으므로, 어느 눈금으로 판정된 리포트인지 리포트만 보고 알 수 있어야 한다. `RULES_DIR`이 어느 규칙 파일을 썼는지 알려주는 것과 같은 목적이다

**하위 에이전트가 만든 헤딩을 그대로 옮기지 않는다.** structured result 워크플로우에서는 하위 에이전트가 헤딩 자체를 만들지 않고 JSON만 반환한다. 레거시 Markdown 워크플로우에서 헤딩이 섞여 오면 오케스트레이터가 이 골격에 맞게 낮춘다. 어느 경우든 최종 문서 골격과 Markdown 표기는 오케스트레이터가 정한다.

### 지적 표기

finding 헤딩 **바로 다음 줄**에 영향도와 확신도를 적는다. `00-rule.md` 00-10이 요구하는 위치·인용 줄 또는 slot label 줄은 그 아래에 이어진다.

```
#### 🟡 `14-3` 렌더마다 새 배열이 생성돼 자식이 리렌더된다
영향: 낮음 · 확신: 높음
`src/components/List.tsx:42-45` — `const items = data.filter(...)`
본문: 리스트 파생값이 매 렌더 새 배열로 만들어져 memoized 자식이 계속 다시 그려집니다.
근거: diff 안에서 동일 입력에 대해 참조를 고정하는 경로가 없습니다.
개선 제안: 계산을 상위에서 memoize하거나 필요 시 데이터 shape를 안정화하세요.
```

### 교차검증 표기

교차검증을 수행하는 워크플로우는 두 축 줄에 축을 하나 더 붙인다.

```
#### 🔴 `17-3` close 중 pending Start가 target을 되살림
영향: 높음 (사용자에게 보이는 오동작) · 확신: 높음 · 교차검증: `유지`
```

**값은 아래 목록으로 고정한다.** producer가 내는 `disposition` 값(`upheld`, `rejected`, `needs-context`)을 공개 리포트에 그대로 쓰지 않는다 — 그것은 내부 인터페이스 값이고, 공개 표기는 renderer 책임이다 (C-6A).

<!-- CROSS_VERIFICATION_RENDER_TOKENS:BEGIN -->
```json
{
  "label": "교차검증",
  "tokens": {
    "upheld": "유지",
    "rejected-shadow": "반박됨 — 관찰 중",
    "rejected-other": "반박 시도 — 분류 밖",
    "scope-open": "범위 미확정",
    "verification-unavailable": "검증 실패",
    "not-eligible": "대상 아님",
    "verification-disabled": "꺼짐"
  }
}
```
<!-- CROSS_VERIFICATION_RENDER_TOKENS:END -->

- `rejected`는 `active-deletion` phase에서 active 리포트에 나타나지 않으므로 표기 대상이 아니다. `rollout-shadow`에서만 `반박됨 — 관찰 중`으로 나타난다 (C-6B)
- **검증 대상이 아니었던 finding에도 `대상 아님`을 적는다.** 축을 비워두면 "검증했는데 결과가 없음"과 "검증 대상이 아님"이 구분되지 않는다
- 반박 사실을 heading에 접미사로 덧붙이지 않는다. 상태는 축 줄 한 곳에서만 표현한다

`location.kind = "unverified"` 인 finding은 같은 자리에서 위치 줄 대신 `위치 미확인 사유: …`를 렌더링한다. `openQuestions`는 `미해결 / 후속 확인` 섹션에서 `추가 확인 이유: …` label을 쓴다. 둘 다 `reason` field를 사용하지만 slot 의미는 다르다.

- 판정 기준은 `00-rule.md`의 **Severity 기준**을 따른다. 여기에 복제하지 않는다
- severity는 두 축에서 파생한 **계산값**이다. 헤딩의 이모지가 두 축과 어긋나면 그 자체가 오류다
- **두 축은 지적을 만든 주체가 판정하고, 오케스트레이터는 그 값을 입력으로 severity만 계산한다.** structured result에서는 producer가 severity를 내지 않으므로, 오케스트레이터는 계산 불일치를 교정하는 대신 **처음부터 severity를 렌더링 단계에서만 만든다.** 레거시 Markdown 워크플로우에도 이 원칙이 목표 상태다

근거는 각 축에서 문제가 되는 쪽에만 요구한다.

| 값 | 근거 | 형식 |
|---|---|---|
| 영향 높음 | **필요** — 닫힌 목록의 다섯 항목 중 무엇인지 지목 | `영향: 높음 (데이터 손상)` |
| 영향 낮음 | 불필요 | `영향: 낮음` |
| 확신 높음 | 불필요 — 본문의 인용·확인 서술이 근거 | `확신: 높음` |
| 확신 낮음 | **필요** — 무엇을 확인 못 했는지 | `확신: 낮음 (부모 컴포넌트 미확인)` |

영향도는 **올리는 것**이 비싸고 확신도는 **내리는 것**이 비싸다. 등급 부풀리기와 근거 없는 추정이 각각 비용을 지불하게 된다. 대부분의 지적은 `영향: 낮음 · 확신: 높음` 한 줄로 끝난다.

**판정은 전역이고, 표시는 형식이 허용하는 범위다.** 일곱 워크플로우 **전부**가 두 축을 판정하고 severity를 거기서 파생한다 (`00-rule.md`의 **Severity 기준**). 워크플로우마다 다른 것은 두 축을 **리포트에 찍는지 여부**뿐이다.

위 `영향: … · 확신: …` 줄이 실제로 찍히는 자리는 골격의 `####` finding 헤딩이며, 오늘 그것은 `/code-review-full` 하나다. 표로 지적을 내보내는 형식 중에서는 `props.md`·`math.md`·`exception.md`의 출력 형식표가 `영향·확신` 열로 같은 두 값을 싣는다 — `/code-review-props`, `/code-review-math`, `/code-review-exception`과 `full`의 해당 패스가 여기 해당한다.

남은 것은 숫자 모듈들의 출력 형식표와 `fast.md`이며, `/code-review`·`/code-review-commit`·`/code-review-fast`가 그 형식으로 지적을 낸다. 그 행에는 아직 두 축을 실을 자리가 없다. **그 리포트도 파생을 적용해 등급을 정하지만, 두 축이 보이지 않으므로 읽는 사람이 리포트만으로 등급을 검증할 수 없다.** 등급이 규칙 고정값이라는 뜻이 아니다 — 검증 가능성의 차이지 판정 면제가 아니다.

**남은 표 행 형식을 넓히는 것이 알려진 간극이며 후속 작업으로 추적한다.** 계약을 한 곳에 두는 취지대로 표기를 일곱 워크플로우 공통으로 넓히는 것이 목표지만, 그 작업은 숫자 모듈의 출력 형식표와 `fast.md`를 함께 고쳐야 하므로 이 변경의 범위 밖이다. 검증 가능성이 워크플로우마다 다르다는 사실을 계약이 감추면, 계약을 읽고 리포트를 검사하는 사람이 표시되지 않은 것을 판정되지 않은 것으로 오인한다.

### 같은 규칙 ID가 여러 번 나올 때

한 리포트에서 같은 규칙 ID로 finding이 둘 이상 나오면 **순번을 붙인다**.

```
#### 🔴 `17-3 (1/2)` close 중 pending Start가 target을 되살림
#### 🔴 `17-3 (2/2)` cleanup 후 non-abort rejection이 최신 상태를 오염
```

순번이 없으면 "`17-3` 고쳤나?"라는 질문에 어느 것인지 답할 수 없다. 하나뿐이면 순번을 붙이지 않는다.

## C-8. 실패 보고 정직성

- 실패, timeout, 미수집이 발생한 범위는 완료로 표시하지 않는다
- 부분 결과는 보존하되, **무엇이 성공하고 무엇이 실패했는지**를 리포트에 명시한다
- 검토하지 않은 모듈을 "통과"로 표기하지 않는다. `SKIPPED`, `FAILED`, `UNKNOWN`을 구분해 적는다

---

## C-9. 실행 타임라인

리뷰는 **지나온 단계를 그때그때 파일에 남긴다.** 리포트가 아니라 사이드카에
남기는 이유는, 리포트 안에 적으면 렌더 단계가 죽는 순간 타임라인도 같이
사라지기 때문이다 — 정확히 알고 싶은 그 순간에.

### 어떻게

```
node <RULES_DIR>/../scripts/review-timeline.mjs --dir <리포트 디렉터리> --run <리포트 basename> --phase <단계> --set key=value --set key=value
```

**`--set`을 쓴다.** JSON 인용이 필요 없다 — 따옴표도 중괄호도 백슬래시도 값 안에
들어가지 않으므로, 셸마다 다르게 깨지던 지점이 사라진다.

**다만 셸의 인자 분리는 그대로다.** 값에 공백이 있으면 감싸야 한다.

```
--set note="검토 완료"        공백이 있으면 인용
--dir "C:\Users\...\바탕 화면\Docs"    경로도 마찬가지
```

인용을 빠뜨리면 스크립트가 남은 토큰을 **거부한다.** 조용히 잘린 값을 기록하지
않는다 — 기록이 잘린 채로 남으면 그것이 원래 값이었는지 알 방법이 없다.

중첩 값이 필요하면 `--data-file <경로>`로 JSON 파일을 넘긴다. BOM이 붙은 UTF-8과
UTF-16 파일도 읽는다 — PowerShell 5.1의 `Set-Content -Encoding UTF8`은 BOM을 붙이고
기본 `Out-File`은 UTF-16LE로 쓰기 때문이다.

`--data '<JSON>'`도 여전히 받지만 **PowerShell에서는 쓰지 않는다.** 실제로 Windows
경로와 한글이 섞인 JSON이 명령줄을 지나며 두 번 연속 깨졌고, 그 사이 다음 단계가
먼저 기록돼 이벤트 순서까지 뒤집혔다. 기록을 남기라고 만든 도구가 기록을 못
남기게 하는 것이 이 계약에서 가장 나쁜 실패다.

파일은 `<리포트 디렉터리>/.timing/<run>.jsonl`이고 **append 전용**이다.

- **시각을 문장으로 적지 않는다.** 모델에게는 시계가 없다. 타임스탬프·순번·
  경과 시간은 스크립트가 만든다. `--data`로 같은 이름의 값을 넘겨도 버려진다
- **단계를 지날 때마다 즉시 쓴다.** 끝에 몰아 쓰면 죽은 실행에서 아무것도
  남지 않아, 이 계약의 목적이 통째로 사라진다
- 이미 쓴 줄은 고치지 않는다. 고치면 마지막 줄이 무엇이었는지 믿을 수 없다
- 타임라인 기록 실패는 리뷰 실패가 아니다. 남기지 못했으면 그 사실을 리포트에
  적고 리뷰는 계속한다

### 남기는 단계

**아래 이름만 쓴다. 닫힌 목록이다.** 자기 실행에 맞게 이름을 새로 짓지 않는다 —
이름이 실행마다 달라지면 실행 간 비교가 불가능해지고, 무엇보다 **읽는 쪽이 알던
이름을 못 찾았을 때 그것이 "안 일어났다"인지 "다르게 불렀다"인지 구분할 수 없다.**

실제로 한 실행이 `verification.prepared`·`verification.end`·`final.audit`·
`report.saved`를 자체로 지어 쓰고 `render.start`·`render.wrote`를 남기지 않았다.
그 실행은 완주해서 드러나지 않았지만, 문서를 쓰다 죽었다면 마지막 줄이
`synthesis.end`로 남아 **"synthesis에서 멈췄다"로 오독**됐을 것이다.

표에 없는 일을 기록해야 하면 이름을 짓지 말고 가장 가까운 단계의 `--set` 필드로
적는다. 이름이 정말 부족하면 이 표를 고치는 것이 순서다.

| `--phase` | 시점 | `--set`/`--data`에 담는 것 |
|---|---|---|
| `run.start` | 가장 먼저 | `host`, `rules`(해석된 RULES_DIR), `version`, `branch`, `changedFiles` |
| `scope.done` | 범위 확정(C-4) | `files`, `excluded` |
| `modules.planned` | 적용 모듈 확정(C-3) | `candidates`, `applied`, `skipped` |
| `dispatch.start` | **첫 sub-agent를 실제로 띄운 직후** | `modules`, `inflight` |
| `module.start` | **모듈 하나를 띄운 직후** | `module`, `taskId` |
| `module.done` | **모듈 하나가 끝날 때마다** | `module`, `status`(ok/failed), `findings`, `failureClass`, `taskId`, (있으면) `tokensIn`·`tokensOut` |
| `dispatch.end` | 전부 수집 후 | `ok`, `failed`, `failureClasses` |
| `script.done` | `prepare-verification.mjs` 실행 후 | `ran`, `counts` |
| `crossverify.start` / `.end` | 교차검증 패스 | `targets` / `upheld`, `rejected` |
| `synthesis.start` / `.end` | synthesis 패스 | `clusters` |
| `render.start` | **문서를 쓰기 직전** | `findings`(중복 제거 후) |
| `render.wrote` | 파일을 쓴 직후 | `path`, `lines` |
| `run.end` | 마지막 | `verdict`, `usageSource`, (있으면) `tokensIn`·`tokensOut`·`tokensCacheRead`·`costUsd` |

**`module`에는 번호가 아니라 모듈 이름을 적는다** — `01-fsd`, `11-styling`처럼.
번호만 적으면 같은 필드의 타입이 갈린다: `01`은 앞의 0 때문에 문자열로 남고 `11`은
숫자가 되어, 나중에 모듈별로 묶거나 두 실행을 비교할 때 `"11"`과 `11`이 서로 다른
것으로 읽힌다. 실제로 한 실행이 01~09는 문자열, 11~20은 숫자로 기록했다.

`module.done`을 모듈마다 쓰는 것이 fan-out의 유일한 증거다. `dispatch.end`
하나로 합치면, fan-out 도중에 죽은 실행은 아무 줄도 남기지 못한다.

### 리포트에 싣는 요약

리포트를 쓸 때 표를 **직접 만들지 않는다.** 산술을 모델이 눈으로 세지 않는다는
C-6A의 원칙이 여기에도 그대로 적용된다.

```bash
node "$RULES_DIR/../scripts/review-timeline.mjs" --dir <같은 값> --run <같은 값> --summary
```

출력한 Markdown 표를 리포트의 `실행 타임라인` 섹션에 그대로 붙인다.

### 사용량

시간은 이미 남는데 **무엇을 얼마나 썼는지가 남지 않는다.** 그래서 "이 패스가 값을
하는가" 같은 판단을 시간이라는 대리 지표로만 해야 한다. 토큰이 실제로 쓰는 자원이다.

- `run.end`에 **전체 사용량**을 남긴다. 모듈별 값을 런타임이 알려주면 `module.done`에도 남긴다
- **모델이 세지 않는다.** 시각과 같은 이유다 — 세어본 적 없는 수를 문장으로 적으면
  그것은 측정이 아니라 어림이다. 런타임이 보고한 값만 옮긴다
- **어디서 얻었는지를 `usageSource`로 함께 적는다.** 결과 봉투의 `usage`인지, task
  완료 알림인지, 세션 export나 통계 명령인지. 출처가 없는 숫자는 나중에 두 실행을
  비교할 때 같은 기준인지 알 수 없다
- **얻지 못했으면 `usageSource`를 `unavailable`로 적는다.** 필드를 통째로 빼면 "0이었다"와
  "재지 못했다"가 같은 모습이 된다 — 이 계약이 반복해서 가르는 그 구분이다

**`costUsd`는 청구액이 아니다.** 구독으로 도는 실행에서 그 값은 정가 환산이고, 실제로
소모되는 것은 사용량 한도다. 그래서 토큰이 정본이고 금액은 있으면 함께 적는 부가
값이다. 리포트에 금액만 옮겨 적어 "이 리뷰의 비용"이라고 서술하지 않는다.

### 순서

**`dispatch.start`는 실제로 띄운 직후에 적는다.** "이제 오케스트레이션을 시작한다"는
뜻으로 미리 적으면, 계획보다 앞선 시각이 기록돼 나중에 **워크플로우 위반과 단순
기록 순서 문제를 구분할 수 없게 된다.** 한 실행에서 정확히 그 상태가 됐고, 어느
쪽인지 끝내 판정하지 못했다.

**어느 task가 언제 떴는지는 `module.start`가 든다.** `dispatch.start`는 wave
단위라 개별 식별자를 담을 자리가 없다 — 거기에 `taskId`를 얹으려 해도 여러 개 중
하나만 적히거나 아예 못 적는다. task마다 한 줄이어야 `module.start` → `module.done`
짝으로 각 모듈이 얼마나 걸렸는지, 어느 것이 돌아오지 않았는지가 복원된다.

식별자가 없으면 사후에 물어도 답이 나오지 않는다. 실제로 한 실행에서 네 모듈이
같은 시각에 사라졌는데, launch 기록이 없어 **첫 wave가 통째로 유실된 것인지 다른
문제인지 끝내 가리지 못했다.**

**`run.end`는 마지막 이벤트여야 한다.** 그 뒤에 줄이 더 붙으면 "끝난 뒤에 일어난
일"이 되어, 읽는 쪽은 실행이 어디서 끝났는지 믿을 수 없다. 기록에 실패해 순서가
밀렸다면 `run.end`를 다시 적어 마지막 자리를 되찾는다.

### 리포트를 쓴 뒤에 실패하면

렌더가 끝난 뒤에 벌어진 일은 **리포트에 들어갈 자리가 없다.** 실제로 한 실행에서
리포트를 저장한 뒤 2시간짜리 단계가 실패했고, 타임라인에만 남고 리포트는 조용했다.
사람이 읽는 것은 리포트다.

- 렌더 이후 실패가 발생하면 **리포트를 갱신한다.** `도구 실행 결과`와
  `미해결 / 후속 확인`이 그 자리다 (C-8)
- 갱신할 수 없으면 그 사실 자체를 타임라인과 사용자 응답에 함께 남긴다.
  타임라인에만 적고 넘어가지 않는다
- **가장 좋은 것은 그런 단계를 렌더 뒤에 두지 않는 것이다.** 리포트에 반영할 수
  없는 검증은 리포트가 확정된 뒤에 하면 결과를 쓸 곳이 없다

### 없는 줄과 0인 줄은 다르다

`run.end`가 없는 타임라인은 **실행이 거기서 끝나지 않았다**는 뜻이지, 마지막
단계가 성공했다는 뜻이 아니다. `--summary`가 그 사실을 표 아래에 적는다.

같은 이유로, 실행되지 않은 단계의 줄을 사후에 채워 넣지 않는다. 빠진 줄은
그 자체가 관측 결과다.

## 워크플로우별 차이 선언

각 SKILL 문서는 이 계약을 참조한 뒤 아래 항목 중 자기 모드에서 달라지는 것만 적는다.

| 항목 | 기본 계약 | 다르게 선언하는 워크플로우 |
|------|-----------|---------------------------|
| 범위 결정 | C-4 (merge-base) | `commit` — 단일 커밋 patch |
| 모듈 집합 | C-2 (numbered non-00 전체) | `fast` — `fast.md` 단일 문서 / `props`·`math`·`exception` — 각 전용 문서 |
| 분할 방식 | 단일 통합 pass | `full` — 모듈별 sub-agent, wave 단위 |
| 출력 밀도 | 위반 전부 | `fast` — 파일당 최대 1개 |
| 모듈 필터 | 없음 | `default` — `--module` |
