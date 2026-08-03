# API 계약 호환성 검증

이 모듈은 API와 cross-boundary contract가 변경될 때 **기존 호출자와 소비자를 깨뜨리지 않는지** 점검한다. 여기서 API contract는 외부 HTTP API뿐 아니라 process, package, runtime 경계를 넘는 내부 계약까지 포함한다 (IPC channel, event payload, SDK/public export, config/env key, schema/DTO serialization).

React 앱은 대개 contract의 **소비자**다. 16-1 ~ 16-4는 소비자 관점에서 항상 적용하고, 16-5 ~ 16-7은 이 저장소가 contract를 **제공**하는 쪽(Electron main, BFF, 공개 패키지)일 때 적용한다.

private local helper 시그니처처럼 같은 런타임 내부에서만 쓰이는 구현 세부는 API contract로 보지 않는다.

## Trigger / 적용 조건

변경 코드가 request/response shape, HTTP status, error body, route path/param, query default, pagination, sorting, filtering, auth surface, schema/DTO validation, serialization format, IPC channel, event/webhook payload, SDK/public export, config/env key, cross-runtime adapter에 닿을 때 적용한다.

검토 범위는 `00-rule.md`를 따른다. 전체 호출자 탐색으로 넓히지 말고, diff 라인과 그 변경 때문에 직접 영향을 받는 contract 정의, adapter, mapper, validator, caller만 targeted check 한다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 기존 클라이언트, consumer, 배포 순서, 권한 흐름을 즉시 깨는 breaking contract 변경 |
| 🟡 WARNING | 호환성 증거, adapter, migration, validation alignment가 부족해 회귀 가능성이 큰 변경 |
| 🔵 INFO | 계약 의도, deprecation note, 타입/문서 표현을 더 명확히 하면 좋은 변경 |

---

## 16-1. 타입·스키마·mapper 정합성 🔴

클라이언트에서 가장 자주 깨지는 지점이다.

- 타입 정의만 바꾸고 runtime parser, zod/schema, generated client, DTO mapper가 그대로여서 실제 wire format과 어긋남
- generated 타입이나 OpenAPI 클라이언트를 재생성하지 않고 손으로 타입만 수정함
- snake_case ↔ camelCase, 날짜/숫자 직렬화, nested flattening 변환이 한쪽에만 반영됨
- 응답 필드를 옵셔널에서 필수로 좁혔는데 실제 응답에는 여전히 없을 수 있음

`02-type.md`가 타입 표현 자체를 본다면, 이 규칙은 **타입과 실제 wire format이 어긋나는지**를 본다.

## 16-2. 응답 소비 안전성 🔴

- 응답 shape가 바뀌었는데 그 값을 읽는 컴포넌트/훅/selector가 함께 바뀌지 않음
- enum/유니온이 넓어졌는데 caller의 exhaustive 분기, UI mapper가 새 값을 처리하지 못함
- nullable로 바뀐 필드를 non-null로 가정한 접근이 남아 있음
- 에러 응답 shape가 바뀌었는데 UI 에러 메시지 매핑, retry 판정이 그대로임

## 16-3. 쿼리 캐시 계약 🔴

React 쿼리 캐시는 서버 계약의 일부처럼 동작한다.

- query key 구조가 바뀌었는데 `invalidateQueries`/`setQueryData` 호출부가 함께 바뀌지 않아 무효화가 조용히 실패
- 같은 리소스를 서로 다른 key 형태로 조회해 캐시가 갈라짐
- mutation 후 무효화 대상 key가 실제 조회 key와 어긋남
- 응답 shape 변경 후 `setQueryData`로 쓰는 형태와 서버가 주는 형태가 달라짐

query key 상수의 단일 출처 문제는 `08-constants.md` 08-3을 함께 본다.

## 16-4. 라우트·쿼리 파라미터 의미 🔴

- route path, param 이름/의미가 바뀌었는데 링크 생성부와 파싱부가 함께 바뀌지 않음
- query param default, required 여부, filter/sort 의미가 바뀌어 같은 URL이 다른 화면을 보여줌
- pagination 방식(cursor/page/offset)이나 page size default 변경으로 기존 목록 호출이 깨짐
- 딥링크·북마크된 기존 URL의 하위 호환이 고려되지 않음

---

## 16-5. Request/response shape 제공 🔴 *(contract 제공자일 때)*

- request/response field를 제거, rename, required화하면 기존 caller 호환성 증거가 필요하다.
- nullable을 non-null로 좁히거나 enum 범위를 줄이면 breaking 후보로 본다.
- wire shape가 바뀌면 mapper와 serialized payload가 함께 맞아야 한다.

## 16-6. Status code / error format 🔴 *(contract 제공자일 때)*

- HTTP status, success/failure 판정, error body shape, error code name이 바뀌면 기존 caller가 같은 의미로 해석하는지 확인한다.
- `200` with error body, `204` with no body, `400` vs `422`, `401` vs `403`, retryable 구분 변경은 contract 변경으로 본다.
- 실패를 성공처럼 보이게 만드는 변경은 `exception.md`와 함께 확인한다.

## 16-7. IPC/event/config/public export 🔴 *(contract 제공자일 때)*

- IPC channel name, event name, payload schema, ack/result shape가 바뀌면 producer와 consumer 양쪽 호환성을 확인한다.
- env key, config key, feature flag name/default, public export name, SDK signature 변경에는 old key fallback, alias, adapter, migration note 중 하나가 필요하다.
- Electron IPC는 `01-fsd.md`의 process boundary와 함께 보되, 이 모듈은 channel/payload 의미의 호환성만 지적한다.

## 16-8. 버저닝·마이그레이션 증거 🟡

- breaking contract 변경에는 versioning, adapter, staged rollout, compatibility layer, explicit migration path 중 하나 이상의 증거가 필요하다.
- 서버와 클라이언트가 동시에 존재하는 배포 구간을 고려한다. "모든 caller가 같이 바뀐다"는 근거가 diff에 직접 연결된 caller 변경으로 드러나지 않으면 안전하다고 보지 않는다.
- 테스트 부재만으로 자동 위반을 만들지 않는다. 다만 breaking 가능성이 있는데 증거가 없으면 지적한다.

---

## 16-CHECK. 리뷰 수행 방법

- diff에서 route, schema, DTO, mapper, generated type, validation, status/error code, auth requirement, IPC/event, config/env, public export, query key 변경을 먼저 찾는다.
- 각 변경이 process/package/runtime/public boundary를 넘는지 판정한다.
- contract 정의와 직접 연결된 adapter, mapper, caller, validation 경로만 targeted check 한다.
- breaking 여부는 이름 변경뿐 아니라 wire shape, source compatibility, semantic compatibility를 함께 본다.

## 16-OUTPUT. 출력 형식

각 지적은 다음을 포함한다.

- 변경된 contract 표면
- 깨질 수 있는 기존 caller/consumer 또는 배포 구간
- 현재 diff에 부족한 호환성 증거
- 권장 조치: adapter, fallback, versioning, staged rollout, migration note, schema/mapper alignment

## 16-SCOPE. 중복 방지

- 권한, 데이터 손상, 결제, 배포 불가 같은 운영 위험은 `18-dangerous-change.md`가 넓게 본다. auth contract 변경의 위험도가 크면 그쪽 severity로 올린다.
- `01-fsd.md`는 경계의 *위치*를, 이 모듈은 그 경계를 통과하는 *호환성*을 본다.
- `02-type.md`는 타입 안전성 자체를, 이 모듈은 타입 변경이 serialized contract를 깨뜨릴 때만 지적한다.
- 실패 흐름 자체는 `exception.md`를 우선한다.
- 단순 삭제 회귀는 `20-deletion-regression.md`를 우선한다.
