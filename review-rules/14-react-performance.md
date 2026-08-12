# React 성능

이 모듈은 **React 앱이 실제로 느려지는 지점**을 본다. 렌더 횟수 자체가 아니라 렌더 비용, 로드 비용, 반응성이 대상이다.

다음은 이 문서의 검사 범위가 아니다 (중복 방지):

- 불필요한 리렌더, Context value 참조, memo 대상 → `04-state.md`
- key 불안정으로 인한 재마운트 → `03-react-rules.md`
- 순수 자료구조·알고리즘 복잡도 → `15-performance.md`
- 함수 길이, 컴포넌트 분할 → `05-structure.md`

## Trigger / 적용 조건

변경 라인에 다음이 보일 때만 적용한다.

- 리스트/테이블/그리드 렌더, 페이지네이션·무한 스크롤 추가·변경
- 라우트 추가, 대형 컴포넌트·라이브러리 import 추가
- 검색/필터/입력에 연결된 무거운 계산이나 렌더
- 이미지, 아이콘 세트, 폰트, 차트, 3D 씬 추가
- 새 전역 상태 구독, Context Provider 추가

데이터 규모가 작고 정적인 UI 변경에는 적용하지 않는다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 실제 데이터 규모에서 프레임 드랍, 입력 지연, 초기 로드 급증이 명확함 |
| 🟡 WARNING | 규모가 커지면 문제가 되는 구조, 표준 대안이 있는데 쓰지 않음 |
| 🔵 INFO | 측정 후 개선 여지, 근거 주석 권장 |

---

## 14-1. 대형 리스트 가상화 부재 🔴

수백 건 이상을 한 번에 DOM에 렌더하면 마운트 비용과 메모리가 선형으로 증가한다.

- 페이지네이션·가상화 없이 전체 목록을 `map`으로 렌더
- 무한 스크롤인데 이전 페이지 노드를 계속 누적
- 각 행이 무거운 컴포넌트(차트, 이미지, 에디터)인데 화면 밖까지 렌더

**판정 기준**: 실제 데이터 규모를 먼저 확인한다. 상한이 수십 건으로 고정된 목록은 지적하지 않는다. 상한이 열려 있거나 서버 페이지네이션이 없으면 지적한다.

**개선 방향**: 윈도잉 라이브러리, 서버 페이지네이션, `content-visibility`, 행 컴포넌트 경량화 중 흐름에 맞는 것을 제시한다.

## 14-2. 코드 스플리팅 부재 🟡

- 라우트가 추가됐는데 모든 화면이 초기 번들에 포함됨
- 모달·에디터·차트·3D 뷰어처럼 진입 직후 필요 없는 대형 컴포넌트를 정적 import
- 무거운 라이브러리를 최상위에서 import (날짜, 차트, 마크다운, 코드 하이라이터 등)
- 아이콘/유틸 라이브러리를 barrel로 통째 import 해 tree-shaking이 깨짐

```typescript
// ❌ 초기 번들에 에디터 전체가 포함
import { RichTextEditor } from '@/shared/ui/rich-text-editor'

// ✅ 실제 열릴 때 로드
const RichTextEditor = lazy(() => import('@/shared/ui/rich-text-editor'))
```

`lazy`를 도입하면 `Suspense` 경계와 로딩 fallback이 함께 있어야 한다. 없으면 `18-dangerous-change.md`가 아니라 이 모듈에서 함께 지적한다.

## 14-3. 입력 반응성 🟡

사용자 입력이 무거운 렌더를 동기적으로 유발하면 타이핑이 끊긴다.

- 검색어 입력마다 대형 리스트를 즉시 필터링·재정렬
- 입력 state가 무거운 형제 트리까지 리렌더시킴
- debounce/throttle 없이 매 keystroke 마다 네트워크 요청
- 🔴 controlled input의 값 state를 transition 안에서 갱신 — transition은 중단·지연될 수 있으므로 입력이 씹히거나 커서가 튄다. 입력값 갱신은 긴급 업데이트로 두고, 그 값을 소비하는 무거운 렌더만 뒤로 미룬다
- 🟡 transition/deferred로 갱신을 미뤄놓고 `isPending`이나 시각적 표시가 없어 사용자가 멈춘 것으로 인식
- 🟡 `await` 이후에 상태를 갱신하면서 그 갱신을 transition으로 감싸지 않아 중단 가능성이 사라짐 (async 함수에서는 `await` 뒤가 별도 실행 컨텍스트다)

**개선 방향**: `useDeferredValue`로 무거운 결과 갱신을 뒤로 미루거나, `useTransition`으로 비긴급 업데이트로 표시하거나, 입력 state를 하위로 격리한다.

**혼동하기 쉬운 구분** — 둘을 뒤바꾼 코드도 지적한다.

| 문제 | 도구 | 이유 |
|------|------|------|
| 렌더 비용이 커서 입력이 끊김 | `useTransition` / `useDeferredValue` | 렌더 우선순위 문제 |
| 요청이 너무 자주 나감 | debounce / throttle | 호출 빈도 문제 |
| 이전 요청 결과가 최신을 덮음 | abort / stale-result 무시 | 경쟁 조건 문제 (`04-state.md` 04-1) |

`useDeferredValue`는 요청을 줄이지도, 취소하지도 않는다. 네트워크 호출 자체를 줄여야 하는 자리에 deferred를 쓴 코드는 문제가 그대로 남아 있는 것으로 본다.

```tsx
// ❌ 입력값 갱신이 transition 안에 있다 — 타이핑이 씹힌다
<input onChange={e => startTransition(() => setQuery(e.target.value))} />

// ✅ 입력은 즉시, 무거운 소비만 지연
const [query, setQuery] = useState('')
const deferredQuery = useDeferredValue(query)
<input value={query} onChange={e => setQuery(e.target.value)} />
<HeavyResults query={deferredQuery} />
```

## 14-4. 렌더 중 고비용 계산 🟡

- 매 렌더 대형 배열 정렬·그룹핑·정규식 컴파일·JSON 파싱
- 렌더마다 새 `Intl.NumberFormat`/`Intl.DateTimeFormat` 인스턴스 생성
- 리스트 항목마다 개별적으로 같은 파생값을 다시 계산

**개선 방향**: 계산을 컴포넌트 밖 모듈 스코프로 올리거나, 데이터 로드 시점으로 옮기거나, 실제 비용이 측정된 경우에만 `useMemo`를 쓴다. 측정 없는 `useMemo` 남발은 `10-principles.md`가 다룬다.

## 14-5. 이미지·에셋 🟡

- 원본 크기 이미지를 CSS로 축소해서 표시
- 목록 썸네일에 `loading="lazy"`, `decoding="async"` 없음
- 크기 미지정으로 레이아웃 시프트 발생 (`width`/`height` 또는 `aspect-ratio` 부재)
- 아이콘을 개별 이미지 요청으로 처리

## 14-6. Suspense·로딩 경계 배치 🟡

- 경계가 너무 위에 있어 작은 로딩에도 화면 전체가 사라짐
- 경계가 없어 lazy 컴포넌트나 데이터 대기 시 트리 전체가 멈춤
- 로딩 fallback이 실제 콘텐츠와 높이가 달라 레이아웃 시프트 발생
- 라우트 전환마다 전체 스켈레톤이 다시 그려져 체감 속도가 떨어짐
- 🔴 갱신으로 이미 보이던 콘텐츠가 fallback으로 되돌아감 — 사용자가 보던 화면이 사라지는 회귀다. 갱신을 transition으로 감싸면 기존 콘텐츠를 유지한 채 새 내용을 준비한다
- 🟡 Suspense 경계만 있고 그 안쪽에 Error Boundary가 없어, 데이터 로딩 실패가 무한 fallback이나 트리 전체 크래시로 이어짐
- 🟡 형제 Suspense 경계를 잘게 쪼개 콘텐츠가 순차적으로 튀어나오며 레이아웃이 여러 번 흔들림 — 함께 나타나야 자연스러운 블록은 한 경계로 묶는다

**판정 기준**: 경계 하나마다 "이 안이 로딩 중일 때 사용자가 무엇을 잃는가"를 묻는다. 잃는 범위가 필요 이상으로 넓으면 경계를 아래로, 화면이 산발적으로 흔들리면 경계를 위로 올린다.

## 14-7. 측정 근거 🔵

- hot path 최적화에 "왜 필요했는지"(프로파일 결과, 데이터 규모) 근거가 없음
- 메모리를 더 써서 빠르게 만드는 선택에 이유 주석이 없음
- 최적화가 코드 가독성을 크게 희생했는데 얻는 값이 명시되지 않음

---

## 14-OUTPUT. 출력 형식

<!-- REVIEW_RESULT_CONTRACT_V1_PRODUCER_OUTPUT -->

이 문서를 producer prompt에 쓸 때는 **`REVIEW_RESULT_CONTRACT_V1`** 을 따른다. 응답은 Markdown 표나 헤딩이 아니라 **raw JSON 객체 하나만** 반환한다.

- top-level에는 `schemaVersion`, `findings`, `openQuestions`를 항상 포함하고 `schemaVersion`은 `1`이어야 한다.
- `severity`는 producer가 내지 않는다. 이 모듈은 `impact`와 `confidence`만 판정한다.
- 데이터 규모, 상호작용 시나리오, 현재 비용, 대안은 새 schema field를 만들지 말고 `body`, `recommendation`, `evidence`에 담는다.
- `00-rule.md` 00-11에 걸리는 unresolved absence/possibility claim, search scope 미완료, 추가 탐색 요청만 `openQuestions`로 보낸다.
- 결함은 성립하지만 exact location만 확인하지 못했으면 finding을 유지하고 `location.kind="unverified"`와 `reason`만 사용한다.
- producer 문자열 필드는 최종 리포트의 신뢰된 Markdown이 아니다. heading/table/raw HTML/link를 직접 만들려고 하지 말고 plain prose만 넣는다.

**원칙**
- 실제 데이터 규모와 상호작용 빈도를 근거로 판단한다. 추정만으로 🔴을 주지 않는다
- "느릴 수 있다"가 아니라 **어떤 조작에서 무엇이 지연되는지** 적는다
- 측정 없이 `useMemo`/`useCallback`을 더 붙이라고 요구하지 않는다
- diff에 없는 기존 코드는 지적하지 않는다
