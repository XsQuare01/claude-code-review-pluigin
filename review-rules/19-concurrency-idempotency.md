# 동시성 & 멱등성 위험

이 모듈은 반복 실행, 재시도, 비동기 순서 뒤바뀜, 동시 쓰기 때문에 같은 작업이 두 번 적용되거나 최신 의도가 오래된 작업에 덮이는 위험을 점검한다. 프론트엔드와 백엔드 모두 적용할 수 있지만, 변경 코드가 공유 상태, async ordering, retry, 외부 부작용, 반복 호출 경로, background job, read-modify-write 흐름을 직접 건드릴 때만 본다.

## Trigger / 적용 조건

Apply this module when changed code touches shared state, async request ordering, retry/backoff, external side effects, save/delete/payment/mutation actions, repeated invocation paths, background jobs, webhook/event consumers, or read-modify-write flows.

- read-only GET, 단순 조회, 순수 계산, 표시 전용 로컬 UI에는 적용하지 않는다.
- 변경 라인이나 변경 때문에 직접 깨진 인접 구조에 트리거가 없으면 동시성 일반론만으로 지적하지 않는다.
- 사용자 데이터, 결제, 저장/삭제, 알림, 파일/DB 쓰기, 외부 API 호출처럼 반복 실행 결과가 관측되는 흐름은 우선 고위험으로 본다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 중복 결제/저장/삭제, 데이터 손상, lost update, replay로 인한 외부 부작용, 오래된 작업이 최신 의도를 덮을 가능성 |
| 🟡 WARNING | 반복 실행, 재시도, out-of-order completion에 대한 안전 증거가 부족해 운영 회귀 가능 |
| 🔵 INFO | 변경 의도, 직렬화 근거, 멱등성 범위 설명을 보강하면 좋은 경우 |

---

## 19-1. Duplicate submit/repeated execution 🔴

- save/delete/payment/order/notification/mutation action이 double click, rapid re-entry, React StrictMode, retry, repeated event delivery로 두 번 실행될 수 있는데 방어가 없으면 위반 후보.
- 버튼 disabled, pending guard, operation lock, once-only handler, server-side dedupe 중 실제 흐름에 맞는 안전장치가 보여야 한다.
- 클라이언트 disabled만으로 외부 부작용 전체가 안전하다고 보지 않는다. 네트워크 재시도나 중복 이벤트가 가능한 흐름이면 서버 또는 처리 경계의 중복 방지도 함께 확인한다.

## 19-2. Idempotency key and operation identity 🔴

- 반복 요청이 그럴듯한 externally visible side effect에 stable idempotency key, operation ID, event ID, dedup boundary가 없으면 위반 후보.
- key는 요청마다 랜덤으로 새로 만들면 안 되고, 같은 사용자 의도 또는 같은 외부 이벤트를 안정적으로 식별해야 한다.
- dedupe 저장소, unique constraint, atomic claim, TTL 같은 처리 경계가 없으면 check-then-act race로 중복 처리될 수 있다.

## 19-3. Retry/backoff side-effect safety 🔴

- retry가 non-idempotent operation을 그대로 다시 호출해 결제, 저장, 알림, 파일 쓰기, 외부 API 호출을 중복시킬 수 있으면 위반.
- transient failure에 retry가 필요하다면 backoff/jitter, retry budget, timeout, abort, idempotency key가 흐름에 맞게 있어야 한다.
- 모든 실패를 같은 방식으로 재시도하지 않는다. validation/auth/domain error처럼 재시도해도 성공하지 않는 실패는 retry 대상에서 제외해야 한다.

## 19-4. Race/order hazards 🔴

- 느린 이전 응답이 빠른 최신 응답을 덮어쓰거나, out-of-order event가 최신 상태를 과거 상태로 되돌리면 위반 후보.
- sequence number, version, request token, updatedAt 비교, latest-only guard, conditional transition 없이 last-write-wins를 적용하면 의도와 맞는지 확인한다.
- 검색, 필터, autosave, tab switch, route change, subscription event처럼 연속 입력이나 이벤트 순서가 바뀔 수 있는 흐름을 우선 본다.

## 19-5. Read-modify-write and transaction boundary 🔴

- balance/count/inventory/status transition, 파일/DB update, quota consume 같은 read-modify-write 흐름에 lock, transaction, compare-and-swap, version guard가 없으면 위반 후보.
- `read current → calculate next → write next` 사이에 concurrent write가 끼어 lost update가 날 수 있는지 확인한다.
- check-then-act로 중복 처리 여부를 확인한 뒤 부작용을 실행하는 구조는 atomic insert/claim 또는 transaction 경계가 없으면 안전하지 않다.

## 19-6. Background jobs/webhook replay 🔴

- job handler, queue consumer, webhook consumer, event subscriber가 replay-safe하지 않거나 processed event ID를 영속화하지 않으면 위반 후보.
- at-least-once delivery에서는 중복 전달을 정상 상황으로 본다. 처리 완료 로그, unique event key, atomic claim, retry window TTL, 부분 실패 복구 경로를 확인한다.
- side effect 후 processed 표시를 남기는 순서가 실패에 취약하면 같은 이벤트가 다시 실행될 수 있다. 가능한 경우 부작용 전 원자적 claim이나 조건부 상태 전이를 확인한다.

## 19-7. Cancellation/abort and stale work cleanup 🔴

- 새 요청, unmount, cancel, route change 뒤에도 이전 async work가 계속 실행되어 stale result를 publish하거나 resource leak을 만들면 위반 후보.
- AbortController, unsubscribe, cleanup, request token, mounted guard, job cancellation 같은 증거가 있어야 한다.
- abort error와 실제 실패를 구분하지 않아 오래된 작업이 에러 UI나 성공 상태를 덮는지도 함께 확인한다.

## 19-8. Optimistic update rollback/reconciliation 🟡

- optimistic UI/cache write가 실패, retry, out-of-order completion, server canonical response와 맞지 않을 때 rollback 또는 reconciliation 없이 남으면 위반 후보.
- 실패 시 이전 값 복원, server response 반영, cache invalidation, conflict/version handling 중 해당 흐름에 맞는 정리 경로가 필요하다.
- 여러 optimistic mutation이 동시에 발생할 수 있으면 rollback 순서가 다른 mutation의 최신 변경을 지우지 않는지 확인한다.

## 19-9. Concurrency evidence requirement 🟡

- 동시성 위험이 있는 변경은 안전하다는 증거가 diff 또는 직접 연결된 인접 구조에 보여야 한다.
- 증거 예: disabled state, pending guard, operation lock, stable idempotency key, atomic dedupe claim, transaction, compare-and-swap, version check, AbortController, queue serialization, replay log, processed event table, optimistic rollback.
- 테스트 부재만으로 자동 위반 처리하지 않는다. 다만 사용자 데이터, 결제, 저장/삭제, 외부 부작용에 직접 닿는데 안전 증거가 전혀 없으면 지적한다.

---

## 19-CHECK. 리뷰 수행 방법

- diff에서 mutation action, retry, async request, job/webhook consumer, DB/file write, shared state update, optimistic update를 먼저 찾는다.
- 각 후보에 대해 "같은 의도가 두 번 들어오면?", "이전 작업이 나중에 끝나면?", "동시에 두 writer가 실행되면?", "처리 후 실패하면 다시 들어오나?"를 확인한다.
- 전체 저장소 스캔으로 범위를 넓히지 말고, 변경된 흐름과 직접 연결된 호출부, handler, persistence boundary, cleanup 경로만 targeted check 한다.
- 지적에는 반복 또는 순서 뒤바뀜 시나리오, 현재 방어 부재, 필요한 멱등성 또는 직렬화 증거를 포함한다.

## 19-OUTPUT. 출력 형식

| Severity | Rule | 위치 | 반복/경쟁 시나리오 | 현재 위험 | 필요한 안전장치 |
|----------|------|------|-------------------|-----------|----------------|
| 🔴/🟡/🔵 | 19-x | 파일:라인 | 구체적 재실행·순서 역전·동시 쓰기 | 왜 중복/덮어쓰기/데이터 손상이 가능한지 | key/lock/transaction/abort/rollback 등 |

**원칙**
- 한국어로 작성한다.
- 실행 가능한 이슈만 출력한다.
- 단순히 "동시성 위험"이라고 쓰지 말고, 어떤 이벤트가 몇 번 들어와 어떤 상태나 부작용이 잘못 적용되는지 설명한다.
- 리뷰 통과만을 위해 새 mock/test/stub을 추가하라고 요구하지 않는다. 실제 요구사항과 연결된 안전 증거를 요구한다.

## 19-SCOPE. 중복 방지

- React state race, hook dependency, 일반 cleanup 자체가 핵심이면 `03-state.md`를 우선한다. 단, 같은 mutation이 반복 실행되거나 stale async work가 외부 부작용 또는 최신 의도 덮어쓰기로 이어지면 이 모듈을 함께 적용한다.
- 예외 전파, fallback, 사용자 안내, 에러 메시지 자체가 핵심이면 `exception.md`를 우선한다. 단, retry, abort, rollback 실패가 중복 side effect나 replay unsafe 처리로 이어지면 이 모듈의 rule ID로 지적한다.
- public contract, 권한, 마이그레이션, irreversible delete 같은 운영 위험은 `13-dangerous-change.md`를 우선한다. 단, 그 위험의 직접 원인이 idempotency key 부재, transaction 부재, replay unsafe job이면 이 모듈에서 구체적 동시성 증거를 요구한다.
- 순수 성능 병렬화나 N+1 I/O 개선은 `10-performance.md`를 우선한다. 병렬화로 shared state write, order hazard, duplicate side effect가 생길 때만 이 모듈을 적용한다.
- read-only GET, 표시 전용 UI, 순수 local derived state에는 server idempotency를 요구하지 않는다.

## 요약

`19-concurrency-idempotency.md`는 변경 코드가 반복 실행, 재시도, replay, async ordering, 동시 쓰기 위험을 직접 만들 때만 적용한다. 핵심 질문은 "같은 작업이 두 번 들어와도 안전한가", "오래된 작업이 최신 상태를 덮지 않는가", "동시에 쓰면 lost update가 나지 않는가"이다. 안전 증거는 stable operation identity, atomic dedupe, transaction/version guard, abort cleanup, queue serialization, optimistic rollback처럼 실제 흐름에서 작동해야 한다.
