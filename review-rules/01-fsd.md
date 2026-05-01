# FSD 아키텍처 검증

이 프로젝트는 Feature-Sliced Design 아키텍처를 따릅니다.

이 모듈은 **FSD + Electron(renderer/preload/main, IPC) + 일부 Three.js 렌더링 패턴**을 전제로 한다. 다른 스택에서는 해당 전제가 드러나는 항목만 적용하고, 그렇지 않으면 지적하지 않는다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 머지 전 반드시 수정 — 레이어 경계, Public API, cross-import 위반 |
| 🟡 WARNING | 수정 권장 — 역할 배치 오류, segment/경로 규칙 위반 |
| 🔵 INFO | 개선 제안 — 네이밍, 구조 단순화, 더 나은 배치 |

---

## 1-1. 레이어 경계 및 의존성 방향 🔴

`app → pages → widgets → features → entities → shared` 방향만 허용. 하위→상위 import, 순환 의존, type-only import 위반도 모두 찾으세요.

## 1-2. Public API 및 import 경로 🔴

외부 접근은 반드시 각 슬라이스 `index.ts`를 통해서만. 다음 위반을 찾으세요:

- 내부 경로 직접 import (`@renderer/entities/user/model/...`)
- wildcard re-export (`export * from './ui'`)
- 크로스 레이어인데 상대 경로 사용, 또는 슬라이스 내부인데 alias 사용

## 1-3. 동일 레이어 Cross-import 금지 🔴

같은 레이어 슬라이스 간 직접 import 금지. `widgets`, `features`, `entities` 모두 포함. 단, **Redux 그룹 폴더 예외** — 같은 그룹의 공용 `model/`만 상대 경로로 허용, 하위 feature 간 직접 import는 금지.

위반 발견 시 해결 방향도 함께 제시:
1. 함께 바뀌는 책임이면 슬라이스 병합 — 단, **feature 끼리 병합은 금지** (1-9 동사 강제 위반). feature 간 공통은 entities 또는 widget/page 합성으로
2. 공유 도메인 데이터면 entities/shared로 이동
3. 조합 책임이면 widget/page hooks로 올리기

## 1-4. Layer 역할 배치 🟡

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

## 1-5. 프로세스/IPC 경계 🟡

- **Renderer**: UI, Three.js, Query, WebSocket 담당. `fs`/`path` 직접 사용 금지
- **Preload**: `contextBridge`로 안전한 API만 노출. renderer feature 내부 경로 import 금지
- **Main**: 파일 I/O, OS API, `ipcMain.handle()` 담당
- IPC 타입은 `shared/ipc-types` 등 cross-process 공유 위치에 두고, `unknown` 남용·에러 삼킴 대신 명시적 result 패턴 사용

## 1-6. Segment 규칙 🟡

| Segment | 허용 | 금지 |
|---------|------|------|
| `ui` | UI, 스타일, 표시 로직 | 비즈니스 로직, 직접 API 호출 |
| `model` | 상태, 타입, slice | UI, 서버 통신 |
| `api` | 서버 통신, query key, DTO 변환 | UI, 도메인 판단 |
| `hooks` | 조합 로직, 커스텀 hook | 범용 util, 무분별한 side effect |
| `lib` | 내부 순수 함수 | 도메인 불명 `utils/helpers` 뭉치 |
| `config/context` | 설정, 상수, React Context | 런타임 비즈니스 로직 |

## 1-7. 상태 관리 및 렌더링 🟡

- 서버 캐시 상태는 TanStack Query 기준으로 `entities/*/api|hooks`
- 클라이언트 UI 상태는 `shared/store` 또는 `features/*/model`
- 특정 하위 트리 참조 공유만 React Context 사용
- 단순 local setter/toggle은 entity 허용 가능하지만, 3개 이상 feature가 공유하거나 비즈니스 로직이 커지면 feature로 올려야 함
- 비즈니스 로직은 custom hook으로 분리하고 컴포넌트는 가능한 한 순수 렌더링 유지
- `useFrame()` 내부의 객체 생성, selector 구독 등 프레임별 재렌더 유발 패턴은 지적

## 1-8. 네이밍 및 구조 일관성 🔵

- 단수/복수 혼용 (`user/` vs `products/`)
- 슬라이스 이름이 segment와 충돌 (`features/ui`)
- 자기 index를 다시 import하는 순환 구조

## 1-9. Feature 네이밍은 **동사** 강제 🔴

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
3. 여러 동사 feature 가 같은 entity API 를 import 하는 형태가 정답 — feature 끼리는 cross-import 하지 않음 (1-3 적용)
4. 분할이 과도해 보일 정도로 작은 동작이면 widget 또는 page hooks 로 합성하는 것이 더 적절한지 재검토
