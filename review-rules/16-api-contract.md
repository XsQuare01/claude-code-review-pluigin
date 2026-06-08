# API 계약 호환성 검증

이 모듈은 API와 cross-boundary contract가 변경될 때 기존 호출자와 소비자를 깨뜨리지 않는지 점검한다. 여기서 **API contract**는 외부 또는 public HTTP API뿐 아니라 process, package, runtime 경계를 넘는 내부 계약까지 포함한다. 예: IPC channel, event payload, webhook payload, SDK/public export, config/env key, schema/DTO serialization format, route/query semantics.

private local helper 시그니처처럼 같은 파일이나 같은 런타임 내부에서만 쓰이는 구현 세부는 API contract로 보지 않는다. 단, 그 helper 변경이 공개 DTO, 직렬화 payload, route 의미, public export로 드러나면 이 모듈을 적용한다.

## Trigger / 적용 조건

Apply this module when changed code touches request/response shape, HTTP status, error body, route path, route param, query default, pagination, sorting, filtering, auth surface, schema/DTO validation, serialization format, IPC channel, event/webhook payload, SDK/public export, config/env key, or cross-runtime adapter.

검토 범위는 `00-rule.md`를 따른다. 전체 호출자 탐색으로 넓히지 말고, diff 라인과 그 변경 때문에 직접 영향을 받는 contract 정의, adapter, mapper, validator, caller/consumer만 targeted check 한다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 기존 클라이언트, consumer, 배포 순서, 권한 흐름을 즉시 깨는 breaking contract 변경 |
| 🟡 WARNING | 호환성 증거, adapter, migration, validation alignment가 부족해 회귀 가능성이 큰 변경 |
| 🔵 INFO | 계약 의도, deprecation note, 타입/문서 표현을 더 명확히 하면 좋은 변경 |

---

## 16-1. Request/response shape compatibility 🔴

- request 또는 response field를 제거, rename, required화하면 기존 caller/consumer 호환성 증거가 필요하다.
- nullable field를 non-null로 좁히거나, optional field를 필수로 바꾸거나, enum/string literal 범위를 줄이면 breaking 후보로 본다.
- response type을 넓혀도 caller가 exhaustive 분기, schema parse, UI mapper에서 새 값을 안전하게 처리하지 못하면 위반 후보다.
- snake_case/camelCase, 날짜/숫자/string 직렬화 방식, nested object flattening처럼 wire shape가 바뀌면 mapper와 serialized payload가 함께 맞아야 한다.

## 16-2. Status code and error format contract 🔴

- HTTP status code, success/failure 판정, error body shape, top-level error code name이 바뀌면 기존 caller가 같은 의미로 해석하는지 확인한다.
- `200` with error body, `204` with no body, `400` vs `422`, `401` vs `403`, retryable/non-retryable 구분 변경은 contract 변경으로 본다.
- error code rename이나 nested error field 변경은 UI message mapping, retry logic, telemetry, SDK exception mapping을 깨뜨릴 수 있다.
- 실패를 성공처럼 보이게 하거나 성공을 실패처럼 처리하게 만드는 변경은 `exception.md`와 함께 확인한다.

## 16-3. Route/query/pagination/filter/sort semantics 🔴

- route path, route param 이름/의미, query param default, required 여부가 바뀌면 호환성 증거가 필요하다.
- pagination 방식(cursor/page/offset), page size default, next cursor 의미, empty page 처리, total count 포함 여부가 바뀌면 기존 list caller가 깨질 수 있다.
- sort direction default, tie-breaker, filter inclusion/exclusion 의미, timezone/date range boundary가 바뀌면 같은 요청이 다른 결과를 반환하므로 contract 변경으로 본다.
- 새 query를 추가해도 기본값이 기존 동작과 다르면 breaking 후보다.

## 16-4. Versioning/deprecation/migration 🔴

- breaking contract 변경에는 versioning, adapter, staged rollout, compatibility layer, explicit migration path 중 하나 이상의 증거가 필요하다.
- 기존 endpoint, channel, public export를 바로 제거하거나 의미를 바꾸면 deprecation 기간과 대체 경로가 diff에 보여야 한다.
- 서버와 클라이언트, producer와 consumer, old package와 new package가 동시에 존재하는 배포 구간을 고려한다.
- “모든 caller가 같이 바뀐다”는 근거가 diff에 직접 연결된 caller/adapter 변경으로 드러나지 않으면 안전하다고 보지 않는다.

## 16-5. Auth/permission contract surface 🔴

- auth header, session cookie, token claim, role, permission, scope, tenant/user boundary 요구사항이 바뀌면 caller와 denial-case 처리가 함께 바뀌어야 한다.
- `401/403` 의미, refresh 필요 여부, anonymous 허용 여부, admin/user 분리 조건이 바뀌면 error mapping과 UI 흐름도 contract 일부로 본다.
- client gating만 바뀌고 server, IPC main process, backend permission check가 맞지 않으면 고위험 후보다.
- 권한 우회, 민감정보 노출, cross-tenant 접근 가능성이 있으면 `13-dangerous-change.md` 기준으로 severity를 올린다.

## 16-6. Schema/DTO validation alignment 🟡

- schema, runtime validation, generated type, DTO mapper, serialized payload가 서로 다르면 contract 위반 후보다.
- 타입 정의만 바뀌고 runtime parser, zod/schema, OpenAPI/generated client, mapper, fixture-like serialized example이 그대로면 실제 wire format과 어긋날 수 있다.
- validation은 더 엄격해져도 기존 valid payload를 거부할 수 있으므로 compatibility evidence가 필요하다.
- 변환 실패 경로가 새로 생기거나 바뀌면 `exception.md`의 입력·응답 검증 규칙도 함께 본다.

## 16-7. IPC/event/webhook contract 🔴

- IPC channel name, event name, webhook topic, payload schema, ack/result shape가 바뀌면 producer와 consumer 양쪽 호환성을 확인한다.
- event ordering, replay 가능성, duplicate delivery, retry semantics, idempotency key 위치가 바뀌면 기존 consumer가 같은 방식으로 처리할 수 있는지 봐야 한다.
- payload field 제거/rename, version field 누락, old consumer 무시 불가 field 추가는 breaking 후보다.
- Electron IPC는 `01-fsd.md`의 process boundary와 함께 보되, 이 모듈은 channel/payload 의미의 호환성만 지적한다.

## 16-8. Config/env/public export contract 🔴

- env key, config key, feature flag name/default, public export name, SDK function signature가 바뀌면 backwards-compatible handling이 필요하다.
- rename은 old key fallback, alias export, adapter, migration note 없이 바로 적용하면 breaking 후보다.
- feature flag default 변경은 같은 배포 산출물이 다른 동작을 하게 만들 수 있으므로 rollout 계획이나 명시적 의도가 보여야 한다.
- public export 제거/이동은 `01-fsd.md`의 Public API 경계와 함께 보되, 이 모듈은 외부 consumer 호환성에 집중한다.

## 16-9. Contract evidence requirement 🟡

- contract 변경이 있으면 diff 안에 caller update, consumer update, adapter, schema validation, compatibility layer, migration note, deprecation note, explicit removal requirement 중 하나 이상의 증거가 있어야 한다.
- 테스트 부재만으로 자동 위반을 만들지 않는다. 다만 breaking 가능성이 있는데 위 증거가 없으면 지적한다.
- “내부 API라 괜찮다”는 설명은 process, package, runtime, public export 경계를 넘지 않을 때만 유효하다.
- 지적할 때는 어떤 contract가 바뀌었는지, 어떤 기존 caller/consumer가 깨질 수 있는지, 어떤 호환성 증거가 필요한지 함께 적는다.

---

## 16-CHECK. 리뷰 수행 방법

- diff에서 route, schema, DTO, mapper, generated type, validation, status/error code, auth requirement, IPC/event/webhook, config/env, public export 변경을 먼저 찾는다.
- 각 변경이 process/package/runtime/public boundary를 넘는지 판정한다. 넘지 않는 private local helper 변경은 이 모듈로 지적하지 않는다.
- contract 정의와 직접 연결된 adapter, mapper, caller/consumer, validation 경로만 targeted check 한다.
- breaking 여부는 이름 변경뿐 아니라 wire shape, source compatibility, semantic compatibility를 함께 본다.

## 16-OUTPUT. 출력 형식

- 실행 가능한 이슈만 출력한다.
- 각 지적은 아래 정보를 포함한다.
  - 변경된 contract 표면
  - 깨질 수 있는 기존 caller/consumer 또는 배포 구간
  - 현재 diff에 부족한 호환성 증거
  - 권장 조치: adapter, fallback, versioning, staged rollout, migration note, schema/mapper alignment 중 필요한 항목

## 16-SCOPE. 중복 방지

- `13-dangerous-change.md`는 권한, 데이터 손상, 결제, 저장/삭제, 배포 불가 같은 운영 위험을 넓게 본다. 이 모듈은 API contract의 shape와 semantics가 직접 깨지는 경우만 맡고, auth 변경은 위험도가 크면 `13-dangerous-change.md` severity로 올린다.
- `01-fsd.md`는 FSD 레이어, Public API 노출 위치, Electron process boundary 위반을 본다. 이 모듈은 경계 위치가 아니라 그 경계를 통과하는 route, payload, export, channel의 호환성을 본다.
- `02-type.md`는 타입 안전성, null narrowing, 타입 우회, Props/API 타입 정합성을 본다. 이 모듈은 타입 변경이 boundary를 넘어 serialized contract나 public caller compatibility를 깨뜨릴 때만 지적한다.
- `exception.md`는 예외 전파, fallback, 실패 처리, 입력·응답 검증 실패 흐름을 본다. 이 모듈은 status/error body/error code 계약이 기존 caller 해석을 깨는지에 집중하고, 실패 흐름 자체는 `exception.md`를 우선한다.
- 단순 삭제 회귀는 `12-deletion-regression.md`를 우선한다. 삭제가 API contract 제거로 드러나면 이 모듈의 versioning/deprecation 증거도 함께 확인한다.

## 요약

API contract 변경은 필드 이름만의 문제가 아니다. request/response shape, status/error 의미, route/query/pagination semantics, auth 요구사항, schema/DTO 정합성, IPC/event/webhook payload, config/env/public export까지 경계를 넘는 약속은 모두 호환성 증거가 필요하다. 이 모듈은 저장소 전체를 훑지 않고, diff와 직접 연결된 contract 표면에서 기존 caller와 consumer가 깨지는지 확인한다.
