# 위험 변경 점검

이 모듈은 삭제가 아니어도 운영 위험이 큰 변경을 점검한다. `12-deletion-regression.md`가 삭제 회귀를 다루고, 여기서는 **public contract, 권한, 데이터 변경, 배포 순서, 마이그레이션 안전성**을 본다.

## Trigger / 적용 조건

Apply this module when changed code touches public contracts, auth/authz, permissions, persistence, deletion, payment, external side effects, migrations, config/env keys, or deployment compatibility.
If the issue is pure deletion regression, prefer `12-deletion-regression.md`.
If the issue is error propagation/fallback, also check `exception.md`.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 데이터 손상, 권한 우회, 결제 중복, irreversible delete, rollback 불가, 배포 즉시 장애 가능 |
| 🟡 WARNING | 호환성·검증·복구 증거가 부족해 운영 회귀 가능 |
| 🔵 INFO | 변경 의도나 안전장치 설명을 보강하면 좋은 경우 |

---

## 13-1. Public contract 변경 🔴

- export 함수/타입, route, IPC channel, event name, schema, DTO, serialization format, config/env key가 바뀌면 호환성 증거를 확인한다.
- 이름·필드·HTTP method·route param·응답 shape 변경은 호출부와 문서/타입/검증이 함께 바뀌어야 한다.
- backward compatibility가 필요한 contract에서 대체 경로, deprecation, adapter, migration 없이 바로 바꾸면 위반 후보.

## 13-2. 권한·정책 변경 🔴

- auth/authz, role/permission, feature flag, tenant/user scope, least-privilege 경계가 바뀌면 우선 고위험 변경으로 본다.
- 클라이언트 gating만 추가되고 서버/IPC/main-process 검증이 없으면 위반 후보.
- 거부 케이스, 만료/refresh, cross-tenant 접근, admin/user 분리, 민감정보 노출 경로를 확인한다.

## 13-3. 저장·삭제·결제·외부 부작용 🔴

- save/delete/payment/order/notification/file-write 같은 irreversible 또는 외부 부작용 변경은 재시도, 중복 클릭, timeout, partial success를 확인한다.
- idempotency key, transaction, optimistic update rollback, audit log, 사용자 확인/취소 경로가 필요한데 없으면 위반 후보.
- 실패를 성공으로 오해하게 만드는 응답 shape나 UI 상태 전환은 `exception.md`와 함께 고위험으로 본다.

## 13-4. 마이그레이션·배포 순서 🟡

- DB/storage/schema/config migration은 forward/backward compatibility, rollback, partial-apply recovery, data backfill 안전성을 확인한다.
- 새 코드와 옛 데이터, 옛 코드와 새 데이터가 동시에 존재하는 배포 구간을 고려한다.
- 파괴적 migration(drop/rename/type narrowing)은 대체 필드, backfill, staged deploy, rollback 불가 사유가 diff에 보여야 안전하다.

## 13-5. 검증 신호 🟡

- 테스트 부재가 자동 위반은 아니다. 다만 위 항목이 사용자 데이터, 권한, 결제, 저장/삭제, 배포 호환성에 영향을 주는데 검증 신호가 없으면 지적한다.
- 검증 신호는 테스트뿐 아니라 schema validation, typed contract, migration guard, feature flag rollout, runtime assertion, 문서화된 대체 경로일 수 있다.
- 리뷰 통과만을 위해 mock/test/stub을 추가하라고 요구하지 않는다. 실제 요구사항과 연결된 안전 증거만 확인한다.

---

## 13-CHECK. 리뷰 수행 방법

- diff에서 route/config/schema/permission/payment/save/delete/migration 관련 변경을 먼저 분류한다.
- 전체 저장소 스캔으로 넓히지 말고, 변경된 contract와 직접 연결된 호출부·adapter·검증 경로만 targeted check 한다.
- 각 지적은 `무엇이 바뀌었는지 / 깨질 수 있는 contract 또는 실패 흐름 / 필요한 안전장치`를 포함한다.

## 13-SCOPE. 중복 방지

- 순수 삭제 회귀는 `12-deletion-regression.md`를 우선한다.
- 에러 전파·fallback 자체가 핵심이면 `exception.md`를 우선하되, auth/payment/save/delete 같은 고위험 흐름이면 이 모듈의 severity 기준도 함께 적용한다.
- 단순 아키텍처 import 경계는 `01-fsd.md`를 우선하고, public contract 호환성 문제가 있을 때만 이 모듈에서 지적한다.
