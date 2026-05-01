# 상태 관리 & 사이드이펙트

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 메모리 누수, 런타임 에러, 경쟁 조건 |
| 🟡 WARNING | 리렌더링, 동기화 버그, 패턴 불일치 |
| 🔵 INFO | 캐싱 전략, 최적화 기회 |

---

## 1-1. useEffect 클린업 & 의존성 배열 🔴

- 구독/타이머/이벤트 리스너 등록 후 클린업 누락
- `fetch`에 `AbortController` 없이 언마운트 후 setState
- 의존성 배열 누락 (매 렌더 실행) 또는 빈 `[]` 오용
- 의존성에 객체/배열 참조 직접 넣어 매번 트리거
- `// eslint-disable-next-line react-hooks/exhaustive-deps` 또는 동등한 hook-deps suppression으로 의존성 검사를 우회함 (정당한 이유 + 구조적 대안 없이 사용 시 위반)

단순 suppression 자체만으로 자동 허용/자동 금지하지 말고, 아래를 함께 본다:
- 왜 suppression이 필요한지 짧은 근거가 있는가
- effect를 분리하거나 stable callback/ref로 바꾸는 구조적 대안이 있었는가
- suppression으로 인해 stale closure, 숨은 의존성, 재실행 누락 위험이 생기지 않는가

```typescript
// ❌ 클린업 없음
useEffect(() => {
  const id = setInterval(() => setCount(c => c + 1), 1000)
}, [])

// ✅ GOOD
useEffect(() => {
  const controller = new AbortController()
  fetch('/api/data', { signal: controller.signal })
    .then(r => r.json()).then(setData)
    .catch(err => { if (!controller.signal.aborted) setError(err) })
  return () => controller.abort()
}, [])
```

## 1-2. 비동기 상태 처리 (로딩/에러/경쟁 조건) 🔴

- `isLoading`, `error`, `data` 3가지 상태 모두 UI에 반영되는지
- 경쟁 조건: 빠른 연속 요청 시 이전 응답이 최신을 덮어쓰는 경우
- 미처리 Promise rejection
- async 이벤트 핸들러 에러가 Error Boundary로 전파되지 않는 경우

## 1-3. 상태 관리 패턴 일관성 🟡

- 동일 성격 상태가 다른 방식으로 관리 (Zustand vs useState+Context 혼용)
- Prop drilling 3단계 이상 → Context 또는 상태 라이브러리 제안
- 중간 컴포넌트가 자기 책임과 무관한 state/handler/derived value를 단순 전달만 함
- 같은 데이터를 여러 하위 트리로 보내기 위해 상위에서 불필요하게 props를 넓게 threading 함
- 서버 상태(React Query) vs 클라이언트 상태(Zustand) 경계 불명확

특히 아래 패턴이면 drilling 과다 후보로 본다:
- `user`, `form`, `selectedId`, `isOpen`, `onChange`, `onSubmit` 같은 값이 3단 이상 연속 전달됨
- 중간 컴포넌트가 props를 소비하지 않거나, 이름만 바꿔 다시 넘김
- 한 변경에 여러 중간 컴포넌트의 props 정의를 같이 수정해야 함

단, 모든 drilling이 위반은 아니다. 범위를 함께 본다:
- 1~2단계 전달이고 구조가 단순한가
- 화면 로컬 상태라서 Context/전역 상태가 오히려 과한가
- drilling 제거보다 명시적 전달이 더 읽기 쉬운가

## 1-4. 불필요한 리렌더링 🟡

- `React.memo` 자식에 매 렌더 새 참조 props 전달
- Context Provider value가 매 렌더 새 객체 (`useMemo` 필요)
- 파생 가능한 값을 별도 state로 관리

```typescript
// ❌ Context value 매 렌더 새 객체
<AuthContext.Provider value={{ user, setUser }}>

// ✅ GOOD
const value = useMemo(() => ({ user, setUser }), [user])
<AuthContext.Provider value={value}>
```

## 1-5. Stale Closure & 직접 변이 🟡

- 비동기 콜백/타이머에서 캡처된 state가 최신값 아닌 경우 (functional update 미사용)
- `state.items.push()` 등 직접 변이

```typescript
// ❌ stale closure
setCount(count + 1)  // 항상 초기값 + 1

// ✅ functional update
setCount(c => c + 1)

// ❌ 직접 변이
items.push(item); setItems(items)

// ✅ 새 참조
setItems(prev => [...prev, item])
```

## 1-6. 데이터 페칭 전략 🔵

- 페칭 라이브러리(React Query 등) 사용 일관성
- 캐싱 전략 (staleTime, cacheTime)
- 동일 데이터 중복 요청
- Optimistic update 적절 사용 여부

---

## 2-1. useState 사용 명확성 🟡

- 연관 state를 개별 `useState`로 분리 → 동기화 버그 가능 (하나의 객체 또는 useReducer)
- state 이름에서 용도 파악 불가
- 파생 가능 값을 별도 state로 관리

```typescript
// ❌ 파생 값을 state로
const [fullName, setFullName] = useState('')

// ✅ 계산으로
const fullName = `${firstName} ${lastName}`.trim()
```

## 2-2. useEffect 의도 명확성 🔴

- useEffect의 목적이 코드만으로 바로 드러나지 않는데, 짧은 설명/구조 분리 없이 여러 책임이 섞여 있음
- 하나의 useEffect에서 여러 무관한 작업 수행 (분리 필요)
- 의존성 배열 5개 이상 → 이펙트 분리 검토 신호 (자동 위반 아님)

```typescript
// ❌ 여러 작업 혼합
useEffect(() => {
  document.title = `${user.name}`
  analytics.track('page_view')
  if (user.preferences.theme) setTheme(user.preferences.theme)
}, [user])

// ✅ 이펙트당 하나의 목적
useEffect(() => { document.title = `${user.name}` }, [user.name])
useEffect(() => { analytics.track('page_view') }, [user.id])
```

## 2-3. 커스텀 훅 명확성 🟡

- 훅 이름에서 역할 유추 불가 (`useData`, `useStuff`)
- 훅이 10개 이상 값 반환 (분할 필요)
- 훅 내부에 비관련 로직 혼재

## 2-4. 이벤트 핸들러 명확성 🟡

- `handle` 접두어 없는 핸들러명
- Props `on` 접두어 없는 이벤트 콜백명
- 핸들러 내부 5줄 초과 → 별도 함수 추출
- 인라인 핸들러에 로직 포함
