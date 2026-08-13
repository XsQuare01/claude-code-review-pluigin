# React 규칙 위반

이 모듈은 **React 런타임이 직접 깨지거나, React가 보장하는 전제를 코드가 위반하는 경우**만 다룬다. 이 리뷰 체계에서 가장 먼저 적용하는 React 전용 모듈이다.

다음은 이 문서의 검사 범위가 아니다 (중복 방지):

- useEffect 클린업/의존성, 비동기 상태, 리렌더 최적화 → `04-state.md`
- 컴포넌트 크기, JSX 가독성, 조건부 렌더링 표현 → `05-structure.md`, `06-jsx.md`
- 가상화, 번들, lazy 로딩, Suspense·Transition 배치 → `14-react-performance.md`
- 서버/클라이언트 경계, Server Function, 직렬화 → `21-rsc.md`

## 버전 전제

이 모듈의 기본 대상은 **React 18 이상**이다. 특정 버전에서만 성립하는 규칙에는 해당 규칙 옆에 버전 조건을 표기한다. 프로젝트의 React 버전은 `package.json`에서 확인하고, 확인되지 않으면 버전 조건이 붙은 규칙은 적용하지 않는다.

## 영향도 보정 예시

| 영향도 | 이 모듈에서 자주 보이는 근거 |
|----------|------|
| 높음 | Hook 순서 붕괴, hydration mismatch, 상태 소실, 비결정적 렌더, 외부 스토어 계약 위반처럼 실제 크래시·오동작·검증 실패로 닫힌 높은 영향 범주를 바로 지목할 수 있는 경우 |
| 낮음 | React다운 표현, 경계 명확화, 미래 동시성 렌더 대비, contract ambiguity처럼 현재 변경에서 닫힌 높은 영향 범주를 아직 닫지 못한 경우 |

유지보수성·표현 선호·일반적인 "나중에 문제 될 수 있음"만으로는 영향 높음이 되지 않는다. 실제 사용자 오동작, 검증 실패, 외부 파손 같은 닫힌 범주를 현재 변경에서 보여줄 때만 높음으로 올린다.

---

## 03-1. Hooks 규칙 🔴

hook은 **모든 렌더에서 같은 순서로 같은 개수만큼** 호출돼야 한다. 위반하면 React가 hook 상태를 잘못 매칭해 크래시하거나 다른 hook의 값을 읽는다.

- 조건문·반복문·`&&`/삼항 안에서 hook 호출
- early return **이후**에 hook 호출
- 이벤트 핸들러, 콜백, `useMemo` 내부처럼 렌더 경로가 아닌 곳에서 hook 호출
- 컴포넌트도 커스텀 훅도 아닌 일반 함수에서 hook 호출 (`use` 접두어 없는 함수)
- `try/catch` 블록 안에서 hook 호출

```typescript
// ❌ early return 이후 hook — 렌더마다 hook 개수가 달라짐
function Profile({ userId }: ProfileProps) {
  if (!userId) return <EmptyState />
  const { data } = useUser(userId)
  return <span>{data.name}</span>
}

// ✅ hook을 먼저, 분기는 그 뒤
function Profile({ userId }: ProfileProps) {
  const { data } = useUser(userId)
  if (!userId) return <EmptyState />
  return <span>{data.name}</span>
}
```

**예외 — `use` (React 19+)**: `use(resource)`는 이 규칙의 대상이 아니다. 다른 Hook과 달리 조건문·반복문 안에서 호출할 수 있도록 설계됐다. 프로젝트의 React 버전이 19 미만이면 `use` 자체가 없으므로 이 예외를 적용할 일도 없다. 조건부 `use` 호출을 Hooks 규칙 위반으로 지적하지 않는다.

```typescript
// ✅ use는 조건부 호출이 허용된다 (React 19+)
function Comments({ commentsPromise, show }: CommentsProps) {
  if (!show) return null
  const comments = use(commentsPromise)
  return <List items={comments} />
}
```

`eslint-plugin-react-hooks`의 `rules-of-hooks`를 suppression으로 끈 경우도 위반으로 본다. `exhaustive-deps` suppression은 `04-state.md`에서 다룬다.

## 03-2. 렌더 순수성 🔴

컴포넌트 본문(return 이전)은 **같은 입력에 같은 출력**을 내는 순수 함수여야 한다. React 18+ StrictMode는 개발 모드에서 렌더를 두 번 호출하므로, 렌더 중 부수효과가 있으면 즉시 드러난다.

- 🔴 렌더 중 **다른 컴포넌트**의 state를 갱신 (React가 명시적으로 금지. 렌더 순서에 따라 결과가 달라진다)
- 🔴 렌더 중 무조건 `setState` 호출 → 무한 렌더 루프
- 🔴 렌더 중 props/외부 객체/모듈 스코프 변수 변이
- 🔴 렌더 중 DOM 직접 조작, 로깅 이상의 I/O, 구독 등록
- 🔴 렌더 중 `Math.random()`, `Date.now()`, `new Date()`, `crypto.randomUUID()` 호출로 렌더 결과가 매번 달라짐
- 🟡 렌더 중 `ref.current` 쓰기 (초기화 1회 lazy init 패턴은 예외)

**예외 — guarded render-phase adjustment**: 이전 props와 비교해 **자기 자신의** state를 조건부로 조정하는 패턴은 React가 문서화한 정당한 기법이다. 조건이 언젠가 거짓이 되므로 루프가 끝나고, React는 커밋과 DOM 반영 전에 그 자리에서 다시 렌더하므로 낡은 값이 화면에 나가지 않는다. effect로 같은 일을 하는 것보다 낫다.

지적 대상은 조건부 렌더 중 `setState` 자체가 아니라 **종료 조건이 없거나(무한 루프), 다른 컴포넌트를 건드리거나, 부수효과가 섞인 경우**다.

```typescript
// ✅ guarded adjustment — 자기 state, 종료 조건 있음, 부수효과 없음
function List({ items }: ListProps) {
  const [selection, setSelection] = useState(null)
  const [prevItems, setPrevItems] = useState(items)
  if (items !== prevItems) {          // 다음 렌더에서는 거짓이 된다
    setPrevItems(items)
    setSelection(null)
  }
  ...
}

// ❌ 종료 조건이 없다 — 매 렌더 재실행
if (items.length > 0) setCount(count + 1)

// ❌ 다른 컴포넌트의 state를 렌더 중에 건드린다
if (isReady) parentContext.setOpen(true)
```

```typescript
// ❌ 렌더마다 값이 달라져 hydration/StrictMode에서 불일치
function Row({ item }: RowProps) {
  const rowId = crypto.randomUUID()
  return <li id={rowId}>{item.name}</li>
}

// ✅ 안정적인 식별자 사용
function Row({ item }: RowProps) {
  const rowId = useId()
  return <li id={rowId}>{item.name}</li>
}
```

렌더 중 파생 계산은 순수하면 허용된다. "느릴 것 같아서" `useMemo`로 감싸는 판단은 `10-principles.md`의 Avoid Premature Optimization을 따른다.

## 03-3. key 안정성 🔴

key는 **리스트 재정렬·삽입·삭제 사이에서 같은 항목을 같은 컴포넌트 인스턴스로 유지**하기 위한 식별자다. 불안정하면 매 렌더 언마운트/재마운트가 일어나 입력값, 포커스, 애니메이션, 로컬 state가 사라진다.

- 🔴 렌더 중 생성한 값을 key로 사용 (`Math.random()`, `crypto.randomUUID()`, `Date.now()`, `index + Date.now()`)
- 🔴 리스트 항목마다 매번 새로 만든 객체 참조를 key로 사용
- 🟡 배열 인덱스를 key로 사용하면서 정렬·필터·삽입·삭제가 일어나는 리스트
- 🟡 형제 사이에서 중복되는 key
- 🔵 인덱스 key지만 append-only이고 순서가 고정된 리스트 → 지적하지 않음

```typescript
// ❌ 매 렌더 재마운트 → 입력 중이던 값이 사라짐
{items.map(item => <EditableRow key={Math.random()} item={item} />)}

// ✅ 도메인 식별자
{items.map(item => <EditableRow key={item.id} item={item} />)}
```

반대로 **의도적으로 상태를 리셋하려고** key를 바꾸는 패턴(`<Form key={userId} />`)은 정당하다. 의도가 코드나 짧은 주석에서 드러나는지만 확인한다.

## 03-4. props를 state로 복사 🔴

판정 기준은 "props를 state 초기값으로 썼는가"가 아니라 **소유권 계약이 무엇인가**다. props를 초기값으로만 쓰고 이후 컴포넌트가 그 값을 소유하는 것은 정상적인 uncontrolled 패턴이다. 문제는 **props가 계속 진실의 출처인데도 복사본을 만들어 effect로 따라가게** 만든 경우다. 이때 한 프레임 동안 낡은 값이 렌더되고 두 출처가 어긋난다.

- 🔴 `useState(props.x)` + `useEffect(() => setX(props.x), [props.x])` — props가 여전히 출처인데 복사본을 동기화
- 🔴 서버 응답을 로컬 state에 복사해두고 캐시와 별도로 관리
- 🔴 계산 가능한 값을 state로 두고 effect에서 갱신
- 🔵 prop 이름이 `initialX`/`defaultX`이고 이후 동기화가 없음 → 소유권이 자식으로 넘어간 것. 지적하지 않음
- 🔵 사용자가 편집 중인 draft처럼 props와 의도적으로 갈라지는 값 → 지적하지 않음

소유권이 자식에게 있다면 prop 이름(`initialX`, `defaultX`)이나 짧은 주석에서 그 의도가 드러나야 한다. 이름이 `value`인데 동기화가 없으면 그건 계약이 모호한 것이므로 영향/확신 축을 다시 판정해 보고한다.

```typescript
// ❌ props와 state 두 출처가 어긋남
const [name, setName] = useState(user.name)
useEffect(() => { setName(user.name) }, [user.name])

// ✅ 렌더 중 파생
const name = user.name

// ✅ 정말 리셋이 필요하면 key로
<NameEditor key={user.id} initialName={user.name} />

// ✅ 소유권이 자식에게 있다 — 이름이 계약을 드러내고 동기화 effect가 없다
function NameEditor({ initialName }: NameEditorProps) {
  const [name, setName] = useState(initialName)
  ...
}
```

## 03-5. Effect가 아니어야 하는 Effect 🟡

`useEffect`는 **외부 시스템과 동기화**할 때만 필요하다. 다음은 effect가 아니라 렌더 중 계산이나 이벤트 핸들러로 옮겨야 한다.

- 사용자 액션의 결과(전송, 토스트, 라우팅)를 effect에서 처리 → 핸들러로
- 다른 state를 보고 state를 갱신하는 연쇄 effect → 렌더 중 파생 또는 `useReducer`
- 데이터 변환·정렬·필터링을 effect + state로 처리 → 렌더 중 계산
- 마운트 시 1회 데이터 로드를 직접 구현 → 프로젝트의 쿼리 라이브러리 사용 (`04-state.md`)

## 03-6. ref 오용 🟡

- 렌더 결과에 반영돼야 하는 값을 `useRef`에 담아 UI가 갱신되지 않음
- 반대로 렌더에 쓰이지 않는 값(타이머 ID, 이전 값, 인스턴스)을 `useState`로 관리해 불필요한 리렌더 유발
- ref를 통해 자식 내부 state를 외부에서 직접 조작 (`10-principles.md` Encapsulation과 함께 본다)
- cleanup에서 ref를 비우지 않아 언마운트 후 stale DOM 노드를 잡고 있음

## 03-7. 동시성 렌더링 안전성 🟡

React 18+ 는 렌더를 중단·재개·폐기할 수 있다. 다음은 그 전제를 깬다.

- 모듈 스코프 mutable 변수로 렌더 간 상태를 나눔 (컴포넌트 인스턴스별로 격리되지 않음)
- StrictMode의 effect 이중 실행(mount → unmount → mount)에서 구독·타이머·연결이 중복 등록됨

외부 스토어 구독은 03-9, hydration 일치는 03-8에서 다룬다.

## 03-8. Hydration 일치 🔴 *(SSR/SSG를 쓰는 프로젝트에만 적용)*

hydration은 **서버가 만든 HTML과 클라이언트의 첫 렌더 결과가 같다**는 전제 위에서 동작한다. 어긋나면 React는 그 subtree를 버리고 클라이언트에서 다시 그리며, 그 과정에서 서버 렌더의 이점이 사라지고 깜빡임·포커스 소실·잘못된 초기 상태가 나타난다.

적용 조건: 프로젝트가 SSR, SSG, 또는 RSC를 사용할 때만 적용한다. 순수 CSR(Vite SPA, CRA, Electron renderer)에는 적용하지 않는다.

- 🔴 서버에 없는 정보(`window`, `document`, `localStorage`, `navigator`, `matchMedia`)를 첫 렌더에서 읽어 분기
- 🔴 사용자 locale, timezone, 화면 크기에 따라 첫 렌더 출력이 달라짐 (서버는 그 값을 모른다)
- 🔴 `Math.random()`, `Date.now()`, `new Date()`로 첫 렌더 출력이 결정됨 (03-2와 함께 본다)
- 🔴 `useId` 없이 만든 DOM id가 서버/클라이언트에서 달라짐
- 🟡 외부 스토어를 쓰면서 `getServerSnapshot`을 제공하지 않거나 클라이언트 초기 snapshot과 다른 값을 반환 (03-9와 함께 본다)
- 🟡 `suppressHydrationWarning`으로 불일치를 덮음 — 타임스탬프처럼 **불일치가 불가피하고 그 노드에 국한될 때만** 정당하다. 트리 상단이나 넓은 범위에 붙었으면 원인을 가린 것으로 본다

**판정 기준**: "첫 렌더에서 서버가 알 수 없는 값을 읽는가"를 묻는다. 브라우저 전용 값이 필요하면 첫 렌더는 서버와 같은 출력을 내고, effect에서 갱신하는 2단계 구조여야 한다.

```tsx
// ❌ 서버에는 window가 없다 — 첫 렌더가 어긋난다
const isWide = window.innerWidth > 768

// ✅ 첫 렌더는 서버와 동일, 이후 effect에서 보정
const [isWide, setIsWide] = useState(false)
useEffect(() => {
  const mq = window.matchMedia('(min-width: 768px)')
  const update = () => setIsWide(mq.matches)
  update()
  mq.addEventListener('change', update)
  return () => mq.removeEventListener('change', update)
}, [])
```

## 03-9. 외부 스토어 구독 계약 🟡

React 외부에 있는 상태(전역 스토어, 브라우저 API, 서드파티 SDK)를 구독할 때는 `useSyncExternalStore`가 요구하는 계약을 지켜야 한다. 계약을 어기면 무한 렌더, tearing, SSR 불일치가 난다.

- 🔴 unchanged 데이터인데 `getSnapshot`이 매번 새 객체/배열을 반환 → 무한 렌더 루프. 값이 안 바뀌면 **같은 참조**를 돌려줘야 한다
- 🔴 mutable 스토어에서 스냅샷을 즉석 생성 → 캐시된 immutable snapshot을 유지하고 변경 시에만 교체
- 🟡 외부 스토어를 `useEffect` + `useState`로 직접 구독 → 동시성 렌더에서 tearing 가능. `useSyncExternalStore` 사용
- 🟡 `subscribe` 함수가 렌더마다 새로 만들어져 구독이 매번 해제·재등록됨 → 컴포넌트 밖으로 옮기거나 `useCallback`으로 고정
- 🟡 `subscribe`가 unsubscribe 함수를 반환하지 않거나, 반환한 것이 실제 등록 대상과 다름
- 🟡 SSR을 쓰는데 `getServerSnapshot`이 없거나 클라이언트 초기 snapshot과 다른 값을 반환 (03-8과 함께 본다)

```typescript
// ❌ 매 호출 새 배열 — 무한 렌더
const getSnapshot = () => store.items.filter(i => i.active)

// ✅ 변경 시에만 새 참조를 만들고 그 사이엔 같은 참조를 반환
let cached = store.items
let cachedActive = cached.filter(i => i.active)
const getSnapshot = () => {
  if (store.items !== cached) {
    cached = store.items
    cachedActive = cached.filter(i => i.active)
  }
  return cachedActive
}
```

## 03-10. React 19 API 사용 🟡 *(React 19+ 프로젝트에만 적용)*

`package.json`의 React가 19 미만이면 이 규칙 전체를 적용하지 않는다. 아래 API가 없는 버전에서 "이걸 쓰라"고 요구하면 그 자체가 오탐이다.

**Actions와 pending 상태**

- 🔴 async Action이 연속 실행될 때 늦게 끝난 이전 Action이 최신 결과를 덮음 → 순서 보장은 `17-concurrency.md` 17-2와 함께 본다
- 🟡 `useActionState`/`useFormStatus`로 pending을 표현할 수 있는데 수동 `isLoading` state를 병행해 두 출처가 어긋남
- 🟡 Action의 에러 경로가 없어 실패가 조용히 사라짐 — 반환 state나 Error Boundary 중 하나로 드러나야 한다
- 🟡 `useFormStatus`를 form 바깥에서 호출 — 같은 form 안의 자손 컴포넌트에서만 값을 읽을 수 있다

**Optimistic UI**

- 🟡 `useOptimistic`의 낙관값이 실제 결과로 수렴하지 않거나, 실패 시 되돌아가는 경로가 없음 → `17-concurrency.md` 17-4와 함께 본다

**ref**

- 🔵 React 19에서는 함수 컴포넌트가 `ref`를 일반 prop으로 받을 수 있다. 기존 `forwardRef` 코드가 남아 있다는 사실만으로 지적하지 않는다. 새 코드에서 `forwardRef`를 쓰는 경우에만 프로젝트 관례를 확인한다

**React Compiler**

- 🔵 Compiler가 켜져 있으면 memoization이 자동 삽입된다. 수동 `useMemo`/`useCallback`/`memo` 추가를 요구하지 않고, 반대로 기존 수동 memoization을 제거하라고 요구하지도 않는다 (`04-state.md` 04-6, `14-react-performance.md` 14-4와 같은 기준)

---

## 03-CHECK. 리뷰 수행 방법

1. 변경된 컴포넌트·커스텀 훅에서 hook 호출 위치를 먼저 확인한다 (조건·루프·early return 이후).
2. return 이전 본문에 부수효과나 비결정적 호출이 있는지 본다.
3. 새로 추가·변경된 `map` 렌더에서 key 표현식이 안정적인지 확인한다.
4. `useState` 초기값이 props/서버 데이터이고 같은 값을 effect가 다시 set하는지 확인한다.
5. 추가된 `useEffect`마다 "이게 외부 시스템 동기화인가?"를 묻는다.
6. SSR/SSG 프로젝트라면 첫 렌더가 서버가 모르는 값을 읽는지 확인한다 (03-8).
7. 새 외부 스토어 구독마다 `getSnapshot` 참조 안정성과 `subscribe` cleanup을 확인한다 (03-9).

## 03-OUTPUT. 도메인 결과 가이드

- "React 규칙 위반"이라고만 적지 말고, **언제 무엇이 깨지는지**를 남긴다. 예: 어떤 렌더 경로에서 hook 순서가 바뀌는지, 어떤 hydration 입력이 서버/클라이언트 출력을 갈라놓는지.
- 상태 소실, 재마운트, 외부 스토어 무한 렌더처럼 결과가 크다면 **사용자나 런타임에 보이는 실패 시나리오**를 적고, 그렇지 않다면 왜 아직 영향 낮음인지 분명히 한다.
- 수정 방향은 "React답게 바꿔라"가 아니라 hook 이동, key 안정화, 렌더 중 파생, 서버와 같은 첫 렌더 유지처럼 **구체적인 React seam**으로 제안한다.

**원칙**
- "React 규칙 위반"이라고만 쓰지 말고, **언제 무엇이 깨지는지**(크래시/상태 소실/hydration mismatch)를 적는다
- diff에 없는 기존 코드는 지적하지 않는다
- lint 플러그인이 이미 잡는 항목이라도, suppression으로 꺼져 있으면 지적한다
