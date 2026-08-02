# 상태 관리 & 사이드이펙트

이 모듈은 **상태가 언제 어떻게 바뀌고, effect가 외부와 어떻게 동기화되는지**를 본다.

다음은 이 문서의 검사 범위가 아니다 (중복 방지):

- Hooks 호출 규칙, 렌더 순수성, props→state 복사, effect가 아니어야 할 effect → `03-react-rules.md`
- 가상화, 번들, 입력 반응성 → `14-react-performance.md`
- 상태를 어느 FSD 레이어가 소유해야 하는지 → `01-fsd.md` 01-7
- props 전달 구조 자체 → `props.md` (`/code-review-props`)

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 메모리 누수, 런타임 에러, 경쟁 조건 |
| 🟡 WARNING | 리렌더링, 동기화 버그, 패턴 불일치 |
| 🔵 INFO | 캐싱 전략, 최적화 기회 |

---

## 04-1. useEffect 클린업 🔴

- 구독/타이머/이벤트 리스너 등록 후 클린업 누락
- `fetch`에 `AbortController` 없이 언마운트 후 setState
- StrictMode의 mount → unmount → mount 재실행에서 구독·연결이 중복 등록됨
- cleanup이 등록한 것과 다른 대상을 해제함 (핸들러 참조 불일치)

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

## 04-2. 의존성 배열 🔴

- 의존성 배열 누락 (매 렌더 실행) 또는 빈 `[]` 오용
- 의존성에 객체/배열/함수 참조를 직접 넣어 매 렌더 트리거
- `// eslint-disable-next-line react-hooks/exhaustive-deps` 또는 동등한 suppression으로 의존성 검사를 우회함

suppression 자체만으로 자동 허용/자동 금지하지 말고, 아래를 함께 본다:

- 왜 suppression이 필요한지 짧은 근거가 있는가
- effect를 분리하거나 stable callback/ref로 바꾸는 구조적 대안이 있었는가
- suppression으로 인해 stale closure, 숨은 의존성, 재실행 누락 위험이 생기지 않는가

## 04-3. 비동기 상태 처리 🔴

- `isLoading`, `error`, `data` 3가지 상태 모두 UI에 반영되는지
- 경쟁 조건: 빠른 연속 요청 시 이전 응답이 최신을 덮어쓰는 경우
- 미처리 Promise rejection
- async 이벤트 핸들러 에러가 Error Boundary로 전파되지 않는 경우

외부 부작용이 반복 실행되거나 순서가 역전되는 문제는 `17-concurrency.md`를 함께 적용한다.

## 04-4. useEffect 의도 명확성 🔴

- 하나의 useEffect에서 여러 무관한 작업 수행 (분리 필요)
- 목적이 코드만으로 드러나지 않는데 설명/구조 분리도 없음
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

## 04-5. 상태 관리 패턴 일관성 🟡

- 동일 성격 상태가 다른 방식으로 관리 (Zustand vs useState+Context 혼용)
- 서버 상태(React Query) vs 클라이언트 상태(Zustand) 경계 불명확
- 같은 데이터를 서버 캐시와 로컬 state가 각자 들고 있어 어긋날 수 있음

Prop drilling 구조 자체는 `props.md`가 전담한다. 이 모듈에서는 **상태를 어디에 두었는가**가 문제일 때만 지적하고, 전달 단계 수를 세지 않는다.

## 04-6. 불필요한 리렌더링 🟡

- `React.memo` 자식에 매 렌더 새 참조 props 전달
- Context Provider value가 매 렌더 새 객체 (`useMemo` 필요)
- 하나의 Context가 값·액션·UI 상태를 모두 담아 일부만 바뀌어도 전체 구독자가 리렌더 → Context 분할 또는 selector 검토
- 파생 가능한 값을 별도 state로 관리

```typescript
// ❌ Context value 매 렌더 새 객체
<AuthContext.Provider value={{ user, setUser }}>

// ✅ GOOD
const value = useMemo(() => ({ user, setUser }), [user])
<AuthContext.Provider value={value}>
```

## 04-7. Stale Closure & 직접 변이 🟡

- 비동기 콜백/타이머에서 캡처된 state가 최신값이 아닌 경우 (functional update 미사용)
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

## 04-8. useState 사용 명확성 🟡

- 연관 state를 개별 `useState`로 분리 → 동기화 버그 가능 (하나의 객체 또는 `useReducer`)
- state 이름에서 용도 파악 불가
- 파생 가능한 값을 별도 state로 관리

```typescript
// ❌ 파생 값을 state로
const [fullName, setFullName] = useState('')

// ✅ 계산으로
const fullName = `${firstName} ${lastName}`.trim()
```

## 04-9. 데이터 페칭 전략 🔵

- 페칭 라이브러리(React Query 등) 사용 일관성
- 캐싱 전략 (staleTime, gcTime)
- 동일 데이터 중복 요청
- Optimistic update 적절 사용 여부 — 실패 시 rollback 경로는 `17-concurrency.md` 17-8
