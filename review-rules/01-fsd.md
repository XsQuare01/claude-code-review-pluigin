# FSD 아키텍처 검증

이 모듈은 **Feature-Sliced Design**을 쓰는 React 프로젝트를 전제한다. FSD를 쓰지 않는 프로젝트에서는 이 모듈을 적용하지 않는다.

**Electron 전용 항목**(01-5)은 renderer/preload/main 프로세스 경계가 실제로 존재하는 프로젝트에만 적용한다. 단일 웹 앱에서는 지적하지 않는다.

## 영향도 보정 예시

| 영향도 | 이 모듈에서 자주 보이는 근거 |
|----------|------|
| 높음 | 레이어 경계, public API, process seam 위반이 실제 오동작·외부 파손·검증 실패로 닫히는 경우 |
| 낮음 | 역할 배치, segment 위치, 구조 단순화, 네이밍 같은 변경 비용 중심 문제에 머무는 경우 |

---

## 01-1. 레이어 경계 및 의존성 방향 🔴

`app → pages → widgets → features → entities → shared` 방향만 허용. 하위→상위 import, 순환 의존, type-only import 위반도 모두 찾으세요.

## 01-2. Public API 및 import 경로 🔴

외부 접근은 반드시 각 슬라이스 `index.ts`를 통해서만. 다음 위반을 찾으세요:

- 내부 경로 직접 import (`@renderer/entities/user/model/...`)
- wildcard re-export (`export * from './ui'`)
- 크로스 레이어인데 상대 경로 사용, 또는 슬라이스 내부인데 alias 사용
- `index.ts` named export라도 private helper/internal hook/segment 내부 구현을 공개하면 Public API 누수로 본다

## 01-3. 동일 레이어 Cross-import 금지 🔴

같은 레이어 슬라이스 간 직접 import 금지. `widgets`, `features`, `entities` 모두 포함. 단, **Redux 그룹 폴더 예외** — 같은 그룹의 공용 `model/`만 상대 경로로 허용, 하위 feature 간 직접 import는 금지.

위반 발견 시 해결 방향도 함께 제시:

1. 함께 바뀌는 책임이면 슬라이스 병합 — 단, **feature 끼리 병합은 금지** (01-9 동사 강제 위반). feature 간 공통은 entities 또는 widget/page 합성으로
2. 공유 도메인 데이터면 entities/shared로 이동
3. 조합 책임이면 widget/page hooks로 올리기

## 01-4. Layer 역할 배치 🟡

각 변경 파일이 **왜 이 레이어에 있어야 하는지**까지 검증하세요. import 방향만 맞고 역할이 틀리면 위반입니다.

- **app**: 앱 초기화, provider, store 합성, 전역 설정만. 도메인 로직/화면 전용 구현이 내려오면 지적
- **pages**: 라우트 단위 화면 조립만. 독립 재사용 블록/도메인 액션 로직이 섞이면 지적
- **widgets**: 여러 entity/feature 조합 담당. 범용 widget은 props only, 도메인 특화 widget만 entities 조회 훅 허용. 도메인 상태 변경은 feature public API로만 수행
- **features**: 사용자 액션, mutation 호출, 검증, 여러 slice 동기화 담당. "행동"이 아닌 조회 전용/표현 전용 코드는 올리면 안 됨. **API 정의 파일(`*-api.ts`)을 직접 두지 않는다** — entities 에 정의된 API 중 mutation (POST/PUT/PATCH/DELETE) 을 *호출* 하는 행위만 담당
- **entities**: 타입, 조회(query, GET) 함수, **API 정의 파일 자체 (`*-api.ts`)**, 기본 표현 허용. 엔드포인트·요청·응답 스키마·HTTP 메서드 정의 (mutation 포함) 는 모두 entities/api 에 둔다. 단, mutation 의 *호출 위치* 는 feature. 라우팅, 하드코딩 URL, 단일 feature 전용 로직은 금지
- **shared**: 여러 레이어에서 재사용되는 기반만. 도메인 종속 로직/타입, 화면 전용 코드가 있으면 지적

특히 다음은 빡세게 본다:

- layer 이름과 실제 책임이 다르면 경계 위반으로 간주
- "당장은 편해서" 올린 shared/common 코드는 허용하지 않음
- feature/entity/widget 중 어디에 둬야 하는지 애매하면, 사용자 액션인지/조회인지/조합인지 기준으로 반드시 판정

## 01-5. 프로세스/IPC 경계 (Electron 전용) 🟡

- **Renderer**: UI, Query, WebSocket 담당. `fs`/`path` 직접 사용 금지
- **Preload**: `contextBridge`로 안전한 API만 노출. renderer feature 내부 경로 import 금지
- **Main**: 파일 I/O, OS API, `ipcMain.handle()` 담당
- Renderer는 main/preload를 직접 import하지 않는다. raw IPC 호출은 preload/shared adapter 또는 shared IPC contract로 캡슐화되어야 한다
- IPC 타입은 `shared/ipc-types` 등 cross-process 공유 위치에 두고, `unknown` 남용·에러 삼킴 대신 명시적 result 패턴 사용

IPC 채널·payload의 **호환성**은 `16-api-contract.md`가, 권한 경계는 `18-dangerous-change.md`가 다룬다.

## 01-6. Segment 규칙 🟡

| Segment | 허용 | 금지 |
|---------|------|------|
| `ui` | UI, 스타일, 표시 로직 | 비즈니스 로직, 직접 API 호출 |
| `model` | 상태, 타입, slice | UI, 서버 통신 |
| `api` | 서버 통신, query key, DTO 변환 | UI, 도메인 판단 |
| `hooks` | 조합 로직, 커스텀 hook | 범용 util, 무분별한 side effect |
| `lib` | 내부 순수 함수 | 도메인 불명 `utils/helpers` 뭉치 |
| `config/context` | 설정, 상수, React Context | 런타임 비즈니스 로직 |

**상수 배치는 프로젝트 관례를 우선한다.** 위 표는 FSD 정본 배치이지 유일한 정답이 아니다. 프로젝트가 이미 `lib/constants.ts` 같은 곳에 상수를 모으는 관례를 **일관되게** 지키고 있으면 그 배치를 위반으로 지적하지 않는다.

지적 대상은 위치 선택이 아니라 **혼용**이다.

- 같은 슬라이스 안에서 어떤 상수는 `config`에, 어떤 상수는 `lib`에 있으면 그것을 지적하고 한쪽으로 모으라고 제안한다
- 관례가 확립돼 있고 새 상수가 그 관례를 따르면 지적하지 않는다
- 관례가 무엇인지 판단할 근거가 diff 안에 없으면 지적 대신 `확인 필요`로 적는다 (`00-rule.md` 00-11)

**런타임 비즈니스 로직이나 상태를 보유하는 모듈은 이 예외에 해당하지 않는다.** 그건 상수가 아니므로 위 표의 segment 규칙을 그대로 적용한다.

## 01-7. 상태 소유 레이어 🟡

- 서버 캐시 상태는 TanStack Query 기준으로 `entities/*/api|hooks`
- 클라이언트 UI 상태는 `shared/store` 또는 `features/*/model`
- 특정 하위 트리 참조 공유만 React Context 사용
- 단순 local setter/toggle은 entity 허용 가능하지만, 3개 이상 feature가 공유하거나 비즈니스 로직이 커지면 feature로 올려야 함
- 비즈니스 로직은 custom hook으로 분리하고 컴포넌트는 가능한 한 순수 렌더링 유지

상태 관리 **구현**의 문제(클린업, 경쟁 조건, 리렌더)는 `04-state.md`가 다룬다.

## 01-8. 네이밍 및 구조 일관성 🔵

- 단수/복수 혼용 (`user/` vs `products/`)
- 슬라이스 이름이 segment와 충돌 (`features/ui`)
- 자기 index를 다시 import하는 순환 구조

## 01-9. Feature 네이밍은 **동사** 강제 🔴

`features/*` 슬라이스 이름은 **반드시 동사구**여야 한다. 명사·도메인 객체명·"무엇을" 만 드러나는 이름은 위반.

**위반 예시**

| ❌ 명사형 (도메인) | ✅ 동사형 (행위) |
|---|---|
| `features/hw-interface` | `features/connect-hw`, `features/capture-camera`, `features/shutdown-hw` |
| `features/user` | `features/sign-in`, `features/sign-up`, `features/update-profile` |
| `features/order` | `features/place-order`, `features/cancel-order` |
| `features/auth` | `features/sign-in`, `features/sign-out`, `features/refresh-token` |

**판정 기준**

- 슬라이스 이름이 *명사* (또는 도메인 객체명) 이면 거의 항상 위반 → entity 후보이거나, 여러 동사로 분할되어야 할 신호
- 같은 도메인 객체에 여러 동작이 묶여 있으면 entity 와 1:1 로 잘못 매핑된 신호. 행위 단위로 슬라이스를 찢는다
- `features/<entity-name>` 형태가 보이면 거의 항상 잘못된 묶음 — entities 와 짝을 맞추려는 충동을 끊어낸다
- 단일 feature 안에 connect/disconnect/capture 처럼 여러 동사가 섞여 있으면 분할 제안

**해결 방향 (위반 발견 시 함께 제시)**

1. 명사형 feature 안의 mutation/액션 단위를 추출해 동사 슬라이스로 분할 (예: `feature/hw-interface` → `feature/connect-hw` + `feature/capture-camera` + `feature/shutdown-hw`)
2. 분할 후 공통 타입·엔드포인트는 같은 도메인의 `entities/*/api` 또는 `entities/*/model` 로 내려보냄
3. 여러 동사 feature 가 같은 entity API 를 import 하는 형태가 정답 — feature 끼리는 cross-import 하지 않음 (01-3 적용)
4. 분할이 과도해 보일 정도로 작은 동작이면 widget 또는 page hooks 로 합성하는 것이 더 적절한지 재검토

## 01-OUTPUT. 도메인 결과 가이드

- 지적할 때는 **어느 레이어 경계가 어떻게 깨졌는지**, 어떤 public API/segment/process seam이 잘못 노출됐는지, 그 결과 변경 비용이나 오동작 위험이 어디서 생기는지까지 설명한다.
- feature 네이밍, cross-import, 역할 배치 문제를 남길 때는 **대체 배치 또는 합성 경로**를 함께 적어, 읽는 사람이 어디로 옮겨야 하는지 바로 판단할 수 있게 한다.
- Electron 경계라면 renderer/preload/main 중 **어느 경계가 실제로 섞였는지**를 명시하고, 단순 구조 취향이 아니라 안전·책임 분리 문제라는 근거를 남긴다.
