# React 규칙 위반

이 모듈은 **React 런타임이 직접 깨지거나, React가 보장하는 전제를 코드가 위반하는 경우**만 다룬다. 이 리뷰 체계에서 가장 먼저 적용하는 React 전용 모듈이다.

다음은 이 문서의 검사 범위가 아니다 (중복 방지):

- useEffect 클린업/의존성, 비동기 상태, 리렌더 최적화 → `04-state.md`
- 컴포넌트 크기, JSX 가독성, 조건부 렌더링 표현 → `05-structure.md`, `06-jsx.md`
- 가상화, 번들, lazy 로딩 → `14-react-performance.md`

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | React 규칙 위반으로 크래시, 상태 소실, 비결정적 렌더 발생 |
| 🟡 WARNING | 현재는 동작하지만 StrictMode/동시성 렌더링에서 깨질 수 있음 |
| 🔵 INFO | 더 React다운 표현 가능 |

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

`eslint-plugin-react-hooks`의 `rules-of-hooks`를 suppression으로 끈 경우도 위반으로 본다. `exhaustive-deps` suppression은 `04-state.md`에서 다룬다.

## 03-2. 렌더 순수성 🔴

컴포넌트 본문(return 이전)은 **같은 입력에 같은 출력**을 내는 순수 함수여야 한다. React 18+ StrictMode는 개발 모드에서 렌더를 두 번 호출하므로, 렌더 중 부수효과가 있으면 즉시 드러난다.

- 렌더 중 `setState` 호출 (조건 없는 무한 루프, 또는 조건부라도 렌더-커밋 순환)
- 렌더 중 props/외부 객체/모듈 스코프 변수 변이
- 렌더 중 `ref.current` 쓰기 (초기화 1회 lazy init 패턴은 예외)
- 렌더 중 DOM 직접 조작, 로깅 이상의 I/O, 구독 등록
- 렌더 중 `Math.random()`, `Date.now()`, `new Date()`, `crypto.randomUUID()` 호출로 렌더 결과가 매번 달라짐

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

props나 서버 데이터를 `useState` 초기값으로 복사한 뒤 `useEffect`로 다시 동기화하는 구조는 React가 명시적으로 금지하는 안티패턴이다. 한 프레임 동안 낡은 값이 렌더되고, 두 출처가 어긋난다.

- `useState(props.x)` + `useEffect(() => setX(props.x), [props.x])`
- 서버 응답을 로컬 state에 복사해두고 캐시와 별도로 관리
- 계산 가능한 값을 state로 두고 effect에서 갱신

```typescript
// ❌ props와 state 두 출처가 어긋남
const [name, setName] = useState(user.name)
useEffect(() => { setName(user.name) }, [user.name])

// ✅ 렌더 중 파생
const name = user.name

// ✅ 정말 리셋이 필요하면 key로
<NameEditor key={user.id} initialName={user.name} />
```

예외: 사용자가 편집 중인 draft 상태처럼 **props와 의도적으로 갈라져야 하는** 값. 이때는 왜 갈라지는지가 이름이나 주석에서 드러나야 한다.

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

- 모듈 스코프 mutable 변수로 렌더 간 상태를 나름 (컴포넌트 인스턴스별로 격리되지 않음)
- 외부 스토어를 `useEffect` + `useState`로 직접 구독 → tearing 가능. `useSyncExternalStore` 사용
- StrictMode의 effect 이중 실행(mount → unmount → mount)에서 구독·타이머·연결이 중복 등록됨
- `useId` 없이 SSR/CSR 양쪽에서 생성되는 DOM id가 달라 hydration mismatch

---

## 03-CHECK. 리뷰 수행 방법

1. 변경된 컴포넌트·커스텀 훅에서 hook 호출 위치를 먼저 확인한다 (조건·루프·early return 이후).
2. return 이전 본문에 부수효과나 비결정적 호출이 있는지 본다.
3. 새로 추가·변경된 `map` 렌더에서 key 표현식이 안정적인지 확인한다.
4. `useState` 초기값이 props/서버 데이터이고 같은 값을 effect가 다시 set하는지 확인한다.
5. 추가된 `useEffect`마다 "이게 외부 시스템 동기화인가?"를 묻는다.

## 03-OUTPUT. 출력 형식

| Severity | Rule | 위치 | 이슈 | 개선 방향 |
|----------|------|------|------|----------|
| 🔴/🟡/🔵 | 03-x | 파일:라인 | 어떤 React 전제를 깨는지 | 구체적 수정 |

**원칙**
- "React 규칙 위반"이라고만 쓰지 말고, **언제 무엇이 깨지는지**(크래시/상태 소실/hydration mismatch)를 적는다
- diff에 없는 기존 코드는 지적하지 않는다
- lint 플러그인이 이미 잡는 항목이라도, suppression으로 꺼져 있으면 지적한다
