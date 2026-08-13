# 동시성 & 멱등성

이 모듈은 반복 실행, 재시도, 비동기 순서 뒤바뀜, 동시 쓰기 때문에 **같은 작업이 두 번 적용되거나 최신 의도가 오래된 작업에 덮이는 위험**을 점검한다.

앞쪽 17-1 ~ 17-4는 React 클라이언트에서 가장 자주 발생하는 항목이고, 17-5 ~ 17-7은 Electron main 프로세스나 BFF처럼 **서버 측 코드를 이 저장소에서 함께 다룰 때만** 적용한다.

## Trigger / 적용 조건

변경 코드가 shared state, async request ordering, retry/backoff, 외부 부작용, save/delete/payment/mutation, 반복 호출 경로, background job, webhook/event consumer, read-modify-write 흐름을 직접 건드릴 때만 적용한다.

- read-only GET, 단순 조회, 순수 계산, 표시 전용 로컬 UI에는 적용하지 않는다.
- 변경 라인이나 변경 때문에 직접 깨진 인접 구조에 트리거가 없으면 동시성 일반론만으로 지적하지 않는다.

## 영향도 보정 예시

| 영향도 | 이 모듈에서 자주 보이는 근거 |
|----------|------|
| 높음 | 중복 결제/저장/삭제, 데이터 손상, lost update, replay 외부 부작용처럼 실제 사고가 닫히는 경우 |
| 낮음 | 안전 증거 부족, 직렬화 설명 부족, 예방적 보강 필요에 머무는 경우 |

---

## 17-1. 중복 제출 / 반복 실행 🔴

중복 실행은 **경로가 다르면 방어책도 다르다.** 아래 두 갈래를 섞어서 지적하지 않는다.

**(a) 사용자·네트워크 경로의 중복** — double click, rapid re-entry, 네트워크 retry, at-least-once event 재전달

- save/delete/payment/order/notification/mutation action이 이 경로로 두 번 실행될 수 있는데 방어가 없으면 위반 후보.
- 버튼 disabled, pending guard, mutation의 `isPending` 가드, once-only handler, 서버 dedupe 중 실제 흐름에 맞는 안전장치가 보여야 한다.
- 클라이언트 disabled만으로 외부 부작용 전체가 안전하다고 보지 않는다. 네트워크 재시도나 중복 이벤트가 가능한 흐름이면 서버 또는 처리 경계의 중복 방지도 함께 확인한다.

**(b) React 렌더·Effect 경로의 중복** — 렌더/Effect가 다시 실행되면서 mutation까지 같이 실행되는 경우

- 개발 모드 StrictMode의 effect 이중 실행(mount → unmount → mount), 의존성 변경으로 인한 effect 재실행, 동시성 렌더의 렌더 폐기·재시도가 여기 해당한다.
- 근본 원인은 **mutation이 effect나 렌더 경로에 있다는 것**이다. 사용자 액션의 결과는 이벤트 핸들러에서 실행돼야 한다 (`03-react-rules.md` 03-5). 핸들러로 옮기면 이 경로의 중복은 사라진다.
- effect에 남아야 하는 외부 시스템 동기화라면 cleanup과 재실행 안전성을 확인한다 (`04-state.md` 04-1).

**StrictMode는 click 같은 사용자 이벤트를 두 번 dispatch하지 않는다.** StrictMode를 (a)의 원인으로 적지 않는다. StrictMode에서 mutation이 두 번 실행됐다면 그것은 StrictMode의 문제가 아니라 **mutation이 effect/렌더 경로에 있다는 신호**이며, 지적할 대상은 그 배치다. 또한 StrictMode는 개발 모드 전용이므로, 프로덕션 중복 위험의 근거로 쓰지 않는다.

## 17-2. 경쟁 조건 / 순서 역전 🔴

- 느린 이전 응답이 빠른 최신 응답을 덮어쓰거나, out-of-order event가 최신 상태를 과거 상태로 되돌리면 위반 후보.
- sequence number, version, request token, `updatedAt` 비교, latest-only guard 없이 last-write-wins를 적용하면 의도와 맞는지 확인한다.
- 검색, 필터, autosave, tab switch, route change, subscription event처럼 연속 입력이나 이벤트 순서가 바뀔 수 있는 흐름을 우선 본다.
- 쿼리 라이브러리를 쓰면서도 수동 `useEffect` + `setState`로 페칭해 경쟁 조건을 스스로 만든 경우를 함께 지적한다.

## 17-3. 취소 / stale work 정리 🔴

- 새 요청, 언마운트, cancel, route change 뒤에도 이전 async work가 계속 실행되어 stale result를 publish하거나 resource leak을 만들면 위반 후보.
- `AbortController`, unsubscribe, cleanup, request token, mounted guard 같은 증거가 있어야 한다.
- abort 에러와 실제 실패를 구분하지 않아 취소된 작업이 에러 UI를 띄우는지도 함께 확인한다.

## 17-4. Optimistic update rollback 🟡

- optimistic UI/cache write가 실패, retry, out-of-order completion, server canonical response와 맞지 않을 때 rollback 또는 reconciliation 없이 남으면 위반 후보.
- 실패 시 이전 값 복원, server response 반영, cache invalidation, conflict/version handling 중 해당 흐름에 맞는 정리 경로가 필요하다.
- 여러 optimistic mutation이 동시에 발생할 수 있으면 rollback 순서가 다른 mutation의 최신 변경을 지우지 않는지 확인한다.

---

## 17-5. 멱등성 키와 작업 식별 🔴 *(서버 측 코드에만 적용)*

- 반복 요청이 외부에서 관측 가능한 side effect를 만드는데 stable idempotency key, operation ID, event ID, dedup boundary가 없으면 위반 후보.
- key는 요청마다 랜덤으로 새로 만들면 안 되고, 같은 사용자 의도 또는 같은 외부 이벤트를 안정적으로 식별해야 한다.
- dedupe 저장소, unique constraint, atomic claim, TTL 같은 처리 경계가 없으면 check-then-act race로 중복 처리될 수 있다.

## 17-6. Retry / backoff 안전성 🔴 *(서버 측 코드에만 적용)*

- retry가 non-idempotent operation을 그대로 다시 호출해 결제, 저장, 알림, 파일 쓰기, 외부 API 호출을 중복시킬 수 있으면 위반.
- transient failure에 retry가 필요하다면 backoff/jitter, retry budget, timeout, abort, idempotency key가 흐름에 맞게 있어야 한다.
- validation/auth/domain error처럼 재시도해도 성공하지 않는 실패는 retry 대상에서 제외해야 한다.

## 17-7. Read-modify-write / replay 🔴 *(서버 측 코드에만 적용)*

- balance/count/inventory/status transition, 파일/DB update, quota consume 같은 read-modify-write 흐름에 lock, transaction, compare-and-swap, version guard가 없으면 lost update 후보.
- job handler, queue consumer, webhook consumer가 replay-safe하지 않거나 processed event ID를 영속화하지 않으면 위반 후보.
- at-least-once delivery에서는 중복 전달을 정상 상황으로 본다. 부작용 전 원자적 claim이나 조건부 상태 전이를 확인한다.

## 17-8. 안전 증거 요구 🟡

- 동시성 위험이 있는 변경은 안전하다는 증거가 diff 또는 직접 연결된 인접 구조에 보여야 한다.
- 증거 예: disabled/pending guard, operation lock, stable idempotency key, atomic dedupe claim, transaction, compare-and-swap, version check, `AbortController`, queue serialization, replay log, optimistic rollback.
- 테스트 부재만으로 자동 위반 처리하지 않는다. 다만 사용자 데이터, 결제, 저장/삭제, 외부 부작용에 직접 닿는데 안전 증거가 전혀 없으면 지적한다.

---

## 17-CHECK. 리뷰 수행 방법

- diff에서 mutation action, retry, async request, DB/file write, shared state update, optimistic update를 먼저 찾는다.
- 각 후보에 "같은 의도가 두 번 들어오면?", "이전 작업이 나중에 끝나면?", "동시에 두 writer가 실행되면?", "처리 후 실패하면 다시 들어오나?"를 확인한다.
- 전체 저장소 스캔으로 범위를 넓히지 말고, 변경된 흐름과 직접 연결된 호출부, handler, persistence boundary, cleanup 경로만 targeted check 한다.

## 17-OUTPUT. 도메인 결과 가이드

- "동시성 위험"이라고만 쓰지 말고, **어떤 이벤트가 몇 번 들어오고 어떤 오래된 작업이 최신 의도를 덮는지**를 설명한다.
- 안전장치가 부족하다고 볼 때는 disabled guard, idempotency key, transaction, request token, rollback 중 **무엇을 확인했고 무엇이 없었는지**를 남긴다.
- 사용자 중복과 effect 경로 중복을 섞지 말고, 실제로 어느 경로의 재실행 문제인지 분리해 적는다.

**원칙**
- 단순히 "동시성 위험"이라고 쓰지 말고, 어떤 이벤트가 몇 번 들어와 어떤 상태나 부작용이 잘못 적용되는지 설명한다.
- 리뷰 통과만을 위해 새 mock/test/stub을 추가하라고 요구하지 않는다.

## 17-SCOPE. 중복 방지

- useEffect cleanup, 의존성, 일반적인 리렌더 문제가 핵심이면 `04-state.md`를 우선한다. 같은 mutation이 반복 실행되거나 stale async work가 외부 부작용으로 이어질 때만 이 모듈을 적용한다.
- 예외 전파, fallback, 사용자 안내가 핵심이면 `exception.md`를 우선한다.
- 권한, 데이터 손상, 결제, irreversible delete 같은 운영 위험 자체는 `18-dangerous-change.md`를 우선한다. 그 위험의 직접 원인이 멱등성/트랜잭션 부재이면 이 모듈에서 구체적 증거를 요구한다.
- 순수 성능 병렬화나 N+1 I/O 개선은 `15-performance.md`를 우선한다.
