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
- 비동기 요청 결과를 반영하는데 **stale result가 최신 결과를 덮는 것을 막는 장치가 전혀 없음**
- StrictMode의 mount → unmount → mount 재실행에서 구독·연결이 중복 등록됨
- cleanup이 등록한 것과 다른 대상을 해제함 (핸들러 참조 불일치)

**`AbortController`를 유일한 정답으로 요구하지 않는다.** 요구하는 것은 "이전 요청의 결과가 최신 상태를 덮지 않는다"는 증거이고, 그 증거는 여러 형태일 수 있다.

| 방식 | 인정 여부 |
|------|-----------|
| `AbortController` + `signal` | ✅ 요청 자체를 취소. 네트워크 비용까지 절약 |
| cleanup의 `ignore` 플래그로 stale result 무시 | ✅ React 공식 문서가 제시하는 대안 |
| request token / sequence 비교 후 최신만 반영 | ✅ |
| 쿼리 라이브러리(React Query 등)에 위임 | ✅ 라이브러리가 이미 처리한다. 중복 구현을 요구하지 않음 |
| 아무 장치도 없음 | 🔴 위반 |

취소 자체가 필요 없는 effect(구독, 타이머, 이벤트 리스너)에 `AbortController`를 요구하지 않는다. 반대로 취소하면 안 되는 요청(전송 완료가 목적인 mutation)에 abort를 붙이라고 요구하지도 않는다.

```typescript
// ❌ 클린업 없음
useEffect(() => {
  const id = setInterval(() => setCount(c => c + 1), 1000)
}, [])

// ✅ abort로 취소
useEffect(() => {
  const controller = new AbortController()
  fetch(`/api/data/${id}`, { signal: controller.signal })
    .then(r => r.json()).then(setData)
    .catch(err => { if (!controller.signal.aborted) setError(err) })
  return () => controller.abort()
}, [id])

// ✅ stale result 무시 — abort 없이도 경쟁 조건은 막힌다
useEffect(() => {
  let ignore = false
  fetchData(id).then(result => { if (!ignore) setData(result) })
  return () => { ignore = true }
}, [id])
```

## 04-2. 의존성 배열 🔴

- 🔴 effect가 읽는 reactive value가 의존성에서 빠져 stale closure나 재실행 누락이 발생
- 🔴 빈 `[]`인데 내부에서 변하는 props/state를 읽음
- 🔴 의존성 배열 자체가 없어 매 렌더 실행되는데 그 재실행이 의도가 아님
- 🟡 `// eslint-disable-next-line react-hooks/exhaustive-deps` 또는 동등한 suppression으로 의존성 검사를 우회함

**객체/배열/함수를 의존성에 넣었다는 사실만으로 지적하지 않는다.** 판정 기준은 타입이 아니라 **그 참조가 실제로 매 렌더 새로 만들어지는가(identity churn)**다. 부모에서 안정적으로 유지되는 객체, 모듈 스코프 상수, `useMemo`/`useCallback`으로 고정된 값, 쿼리 라이브러리가 캐시로 돌려주는 객체는 의존성에 그대로 넣어도 문제가 없다.

지적하려면 다음이 **함께** 성립해야 한다.

1. 그 참조가 렌더마다 새로 생성된다 (컴포넌트 본문에서 리터럴로 만들어지거나 매번 새 객체를 반환)
2. 그 결과로 effect가 불필요하게 재실행된다 (재구독, 재요청, 무한 루프)

```typescript
// 🔴 identity churn — options가 매 렌더 새 객체라 effect가 매 렌더 재실행
function Chat({ roomId }: ChatProps) {
  const options = { roomId, serverUrl: 'wss://...' }
  useEffect(() => { connect(options) }, [options])
}

// ✅ 원시값으로 좁힌다
useEffect(() => { connect({ roomId, serverUrl }) }, [roomId, serverUrl])

// ✅ 객체 의존성이지만 참조가 안정적이다 — 지적하지 않음
const config = useMemo(() => ({ roomId }), [roomId])
useEffect(() => { connect(config) }, [config])
```

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
- Context Provider value가 매 렌더 새 객체이고, **그 때문에 실제로 비싼 리렌더가 발생**
- 하나의 Context가 값·액션·UI 상태를 모두 담아 일부만 바뀌어도 전체 구독자가 리렌더 → Context 분할 또는 selector 검토
- 파생 가능한 값을 별도 state로 관리

**Context value에 `useMemo`를 무조건 요구하지 않는다.** 아래를 먼저 확인하고, 근거가 있을 때만 지적한다.

- **소비자 영향**: Provider가 리렌더될 때 어차피 자식 트리도 리렌더되는 구조라면 `useMemo`는 아무것도 막지 못한다. 자식이 `memo`로 차단돼 있거나 구독자가 많을 때만 효과가 있다
- **identity contract**: value 객체 참조가 effect 의존성이나 `memo` 비교에 쓰여 churn이 실제 문제를 만드는가
- **Provider 갱신 빈도**: 앱 수명 동안 거의 안 바뀌는 Provider라면 지적 대상이 아니다
- **React Compiler**: 프로젝트에 Compiler가 켜져 있으면 memoization이 자동 삽입된다. 수동 `useMemo` 추가를 요구하지 않는다

```typescript
// 🟡 지적 대상 — 구독자가 많고 자식이 memo로 차단돼 있는데 value가 매 렌더 새 객체
<AuthContext.Provider value={{ user, setUser }}>

// ✅ 참조 고정
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
- Optimistic update 적절 사용 여부 — 실패 시 rollback 경로는 `17-concurrency.md` 17-4

## 04-OUTPUT. 출력 형식

<!-- REVIEW_RESULT_CONTRACT_V1_PRODUCER_OUTPUT -->

이 문서를 producer prompt에 쓸 때는 **`REVIEW_RESULT_CONTRACT_V1`** 을 따른다. 응답은 Markdown 표나 헤딩이 아니라 **raw JSON 객체 하나만** 반환한다.

- top-level에는 `schemaVersion`, `findings`, `openQuestions`를 항상 포함하고 `schemaVersion`은 `1`이어야 한다.
- `severity`는 producer가 내지 않는다. 이 모듈은 `impact`와 `confidence`만 판정한다.
- cleanup, 의존성 배열, 비동기 상태, stale closure, 불변성, 데이터 페칭 전략 같은 도메인별 설명은 새 schema field를 만들지 말고 `body`, `recommendation`, `evidence`에 담는다.
- `00-rule.md` 00-11에 걸리는 unresolved absence/possibility claim, search scope 미완료, 추가 탐색 요청만 `openQuestions`로 보낸다.
- 결함은 성립하지만 exact location만 확인하지 못했으면 finding을 유지하고 `location.kind="unverified"`와 `reason`만 사용한다.
- producer 문자열 필드는 최종 리포트의 신뢰된 Markdown이 아니다. heading/table/raw HTML/link를 직접 만들려고 하지 말고 plain prose만 넣는다.
