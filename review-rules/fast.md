# Fast Code Review Rules (압축본)

> Sync note: 숫자 prefix 상세 모듈(`00-rule.md` through `12-deletion-regression.md`)이 바뀌면 이 압축본도 함께 갱신해야 한다.

이 문서는 `~/.claude/review-rules/`의 숫자 prefix 상세 모듈(`00-rule.md` through `12-deletion-regression.md`)에서 **high-signal 지적 기준만** 추려낸 압축본이다. 상세 예시/코드 블록은 제거했고, 리뷰어가 **파일별 가장 중요한 이슈 1개**를 빠르게 판별하도록 구성했다.

상세 리뷰가 필요하면 `/code-review`를 쓰고, 이 문서는 오직 `/code-review-fast`에서만 사용한다.

## Severity

- 🔴 ERROR — 머지 전 필수 수정 (런타임 버그, 경계/원칙 위반)
- 🟡 WARNING — 수정 권장 (가독성, 일관성, 패턴 이탈)
- 🔵 INFO — 개선 제안 (네이밍, 스타일 미세 조정)

우선순위: 🔴 > 🟡 > 🔵. 같은 파일에 여러 지적 후보가 있으면 severity 높은 것을 남긴다.

## 최상위 공통 규칙 (00)

- 🔴 리뷰 통과용 mock/test/stub 신규 추가 금지 — 실제 요구사항 없는 `__test__`, `*.test.*`, mock 데이터는 "리뷰 우회" 신호
- 🔴 네이밍 혼용 금지 — 같은 개념을 `user`/`userData`/`currentUser`로 부르면 위반
- 🟡 자동 수정 가능한 lint는 리뷰 전에 정리, 남은 이슈만 다룬다
- 🟡 "편해서 shared/common에 둠" 같은 임시 배치는 위반 후보
- 🟡 동작만 한다고 통과시키지 말고, 왜 이 선택을 했는지와 더 단순한 대안 대비 정당성을 함께 본다

---

## 1. FSD 아키텍처 (01)

### 🔴 필수

- **레이어 경계**: `app → pages → widgets → features → entities → shared` 방향만 허용. 역방향·순환·type-only 우회 모두 지적
- **Public API**: 슬라이스 내부 경로 직접 import 금지 (`@renderer/entities/user/model/...`). 외부 접근은 `index.ts` 경유만
- **Wildcard re-export 금지** (`export * from './ui'`)
- **동일 레이어 cross-import 금지** — widgets/features/entities 슬라이스 간 직접 import. 예외: Redux 그룹의 공용 `model/`만 상대 경로 허용
- **Feature 동사 강제** — `features/*` 이름은 반드시 동사구. `features/hw-interface`, `features/user`, `features/auth` 같은 명사형은 위반 → `features/connect-hw` + `features/capture-camera` + `features/shutdown-hw` 처럼 행위 단위로 분할. feature 끼리 cross-import 금지, 공통은 entities 또는 widget/page 합성으로

### 🟡 역할 배치

파일이 **왜 이 레이어에 있어야 하는지**까지 본다. import만 맞고 역할이 어긋나면 위반.

- **app**: 초기화/provider/store 합성/전역 설정만. 도메인 로직 있으면 위반
- **pages**: 라우트 단위 조립만. 재사용 블록·도메인 액션은 아래로
- **widgets**: entity/feature 조합. 도메인 상태 변경은 feature public API로
- **features**: 사용자 액션 / mutation 호출 / 검증. **API 정의 파일(`*-api.ts`) 직접 두지 않음** — entities API import 해서 mutation 호출만. 조회 전용·표현 전용은 올리면 안 됨
- **entities**: 타입 / 조회(GET) / **API 정의 파일 자체 (`*-api.ts`, mutation 엔드포인트 정의 포함)** / 기본 표현. mutation 의 *호출* 위치는 feature 이지만 *정의* 는 여기. 라우팅·하드코딩 URL·단일 feature 전용 로직 금지
- **shared**: 여러 레이어 재사용 기반만. 도메인 종속·화면 전용 코드 금지

### 🟡 프로세스/Segment

- Renderer에서 `fs`/`path` 직접 사용 금지, Preload는 `contextBridge`만, IPC 타입은 cross-process 공유 위치
- `ui`에 비즈니스 로직, `model`에 UI, `api`에 도메인 판단, `hooks`에 범용 util, `lib`에 도메인 불명 `utils/helpers` 뭉치 → 위반

### 🔵 일관성

단수/복수 혼용 (`user/` vs `products/`), 슬라이스명-segment 충돌 (`features/ui`), 자기 index 재import.

---

## 2. 타입 안전성 (02)

### 🔴 필수

- **타입 우회**: `any`, `@ts-ignore`, `@ts-expect-error`, 근거 없는 `as` 단언, `[key: string]: any` Props
- **Props 인터페이스**: 인라인 타입 대신 named interface/type. 이벤트 핸들러 타입 명시
- **타입 복잡도**: 인라인 타입 3필드 초과, 유틸리티 타입 3단+ 중첩, 이름 없는 유니온 5멤버+ → 추출

### 🟡 주요

- API 응답 nullable인데 Props non-optional, snake_case ↔ camelCase 변환 누락
- 유니온 null/undefined narrowing 없이 접근, discriminated union exhaustive check 누락
- 판별자 필드 혼용 (`kind` vs `type`), 제네릭 단일 문자 + `extends` 없음

### 🔵 기타

public 함수/훅 반환 타입 생략, 미사용 타입, 제네릭 3개+ 의미 없는 이름.

---

## 3. 상태 관리 & 사이드이펙트 (03)

### 🔴 필수

- **useEffect 클린업 누락**: 구독/타이머/리스너/fetch (`AbortController`) 언마운트 처리
- **의존성 배열**: 누락, 빈 `[]` 오용, 객체/배열 참조 직접 삽입
- **hook deps suppression**: `eslint-disable-next-line react-hooks/exhaustive-deps` 로 검사를 우회하고도 정당한 이유/구조적 대안이 보이지 않음
- **useEffect 의도**: 주석 없고 여러 무관 작업 혼합, 의존성 5개+ → 분리 신호
- **비동기 경쟁 조건**: 빠른 연속 요청 시 이전 응답이 최신 덮어씀, 미처리 rejection

### 🟡 주요

- 동일 성격 state를 다른 라이브러리 혼용 (Zustand vs Context+useState)
- Prop drilling 3단+ 또는 중간 컴포넌트가 자기 책임과 무관한 state/handler를 전달만 함
- Context Provider value가 매 렌더 새 객체 (`useMemo` 누락), `React.memo` 자식에 새 참조 전달
- 파생 값을 별도 state로 관리, stale closure (`setCount(count+1)` vs functional)
- 직접 변이 (`push`, `splice`)
- 커스텀 훅 반환값 10개+, `handle`/`on` 접두어 없는 핸들러/Props

### 🔵 기타

페칭 라이브러리 일관성, staleTime/cacheTime 설정, optimistic update 적절성.

---

## 4. 컴포넌트 구조 & JSX (04)

### 🔴 필수

- **함수 20줄 초과** → 분할 검토 (추상화 수준 혼재, 중첩 3단+, 독립 작업 3개+)
- **컴포넌트 150줄 초과** → 반드시 분할 (JSX 인라인 로직 10줄+, useState 5개+)
- **삼항 2단+ 중첩**, `{count && <X/>}`의 falsy(`0`/`''`) 렌더링 함정
- **파일당 하나의 컴포넌트** — export 컴포넌트 2개+ 금지 (내부 헬퍼 제외)

### 🟡 주요

- if-else 중첩 2단+ → early return으로 평탄화
- 매개변수 3개 초과 → 객체 파라미터, boolean 파라미터 호출부 불분명
- Props 4개+ 한 줄, 인라인 함수 5줄+, 인라인 스타일 3속성+, 불필요 Fragment
- `map` 콜백 10줄+ → 별도 컴포넌트, key에 index 사용
- 무분별 `{...props}` 전달 (rest는 HTML 요소에만)
- 컴포넌트 300줄 초과, UI+비즈니스 로직 혼재 → 훅 분리
- 2+ 슬라이스/훅/컴포넌트에 동일 로직 복사 → 공용화 또는 한쪽 삭제로 단일 출처 유지

### 🔵 기타

barrel export/path alias 일관성, 매직 넘버/문자열, segment 구조 불일치.

---

## 5. 네이밍 & 주석 & 상수 (05)

### 🔴 필수

- **모호한 이름**: `d`, `temp`, `data`, `info`, `item`, `stuff`, `result` (루프 `i` 제외)
- **boolean/핸들러 접두어 누락**: `is/has/should/can`, `handle`, `on`
- **매직 넘버**: 타임아웃·재시도·페이지 크기·z-index 인라인 하드코딩 → named constant
- **상수 중복 정의**: 동일 값이 2+ 파일에 각각 선언 (Query Key, endpoint, localStorage key, 에러 메시지). **단일 출처**로 통합 필요
- **상수 위치 고정**: 상수의 위치는 `lib/constants.ts`로 고정. 신규/변경 상수가 다른 파일이나 폴더에 선언되면 위반

### 🟡 주요

- 컴포넌트명이 내용 설명 못 함, `Container`/`Wrapper`/`Component` 단독, 파일명 불일치, `Manager`/`Processor` 남용
- `I` 접두어 일관성, `{Component}Props` 패턴 미준수
- 파일 네이밍 혼용 (PascalCase/kebab-case)
- 불필요 주석(코드 반복/주석 처리 코드/오래된 설명), 이슈 미연결 TODO
- 필수 주석 누락: 비자명 비즈니스 규칙, 복잡한 정규식, workaround(이유+제거 시점), 의도적 비표준
- 매직 문자열 산재, 상태값 문자열 비교 → 유니온/enum
- 사용자 노출 문자열(UI 문구, toast, dialog, empty state 등) 하드코딩 → i18n 적용 권장

---

## 6. Import & Dead Code & 일관성 (06)

### 🔴 필수

- **Dead code**: 도달 불가 코드, 미사용 변수/함수/타입/import, 주석 처리 블록, 장기 비활성 feature flag
- **중복 구현 공존**: 같은 목적의 이전/새 구현이 함께 남아 실제로 하나는 삭제 가능한 상태
- **패턴 일관성**: 같은 성격 컴포넌트가 다른 구조, API 호출이 useQuery/fetch 혼용, 같은 데이터 `user`/`userData`/`currentUser` 혼용

### 🟡 주요

- Import 순서 혼란 (외부 → 절대 → 상대 → `import type` → 스타일), 미사용 import, `import type` 미사용
- named/default export 혼용, re-export 내부 노출, 한 파일 5+ export
- 로직 없는 wrapper 컴포넌트, 값 그대로 반환 함수, 빈 useEffect/catch
- 스타일 불일치 (화살표 vs function 컴포넌트, 세미콜론/따옴표/trailing comma)
- 에러 처리 통일 (toast/inline/Error Boundary), 사용자용 vs 개발자용 구분
- 이중 부정 (`!isNotValid`), 부정형 변수명, `if (!x)` 블록이 else보다 김
- 5단+ 중첩 destructuring, 과도한 rename
- `!!value` → `Boolean(value)`, `if (array.length)` → `length > 0`
- 3+ 조건 `&&`/`||` 연결 → 의미 있는 변수 추출

### 🔵 테스트

`test('test1', ...)`, 한/영 혼용, AAA 분리, 테스트 간 상태 공유.

---

## 7. 개발 원칙 (07)

### 🔴 원칙 위반 (반드시 지적)

- **SSOT**: 동일 데이터가 여러 state, 서버값 로컬 복사, 상수/타입 중복
- **SRP**: 페칭+로직+렌더링 전담 컴포넌트, 무관한 여러 상태 관리 훅
- **SoC**: UI와 비즈니스 로직 혼재, 라우팅이 도메인 컴포넌트에 포함
- **Fail Fast**: 빈 catch, 미검증 입력 깊이 전파, API 응답 미검증
- **Immutability**: `push`/`splice`/`Object.assign(target)` 직접 변이

### 🟡 주요 원칙 (골라서 지적)

DRY, KISS, YAGNI, OCP, LSP, ISP, LoD (`a.b.c.d` 3단+ 체이닝), PoLA (`getX`가 변경, `isValid`가 throw), CQS, Composition > Inheritance, Encapsulation, Defensive(API/localStorage/URL 미검증), Data-Presentation 분리, Least Privilege, Colocation, Explicit(default export/`!!`/`==` 회피), CoC.

### 🔵 기타

DIP, Idempotency (더블 클릭 중복 요청), Transparency, Robustness, Tell Don't Ask, Uniform Access, Avoid Premature Optimization, Parsimony.

---

## 8. 스타일링 (08)

### 🔴 필수

- **Tailwind 우선**: 정적 레이아웃/상태/hover/focus/유한 조건 분기는 `className`. `style={{}}` 하드코딩은 위반
- **디자인 토큰**: 색상/배경/border/shadow는 프로젝트 시맨틱 토큰. hex 하드코딩, Tailwind 기본 팔레트(`gray-800`, `text-blue-500`) 사용 금지

### 🟡 주요

- `style={{}}`는 런타임 계산값(동적 위치/크기/transform)에만. 유한 조건은 조건부 className으로
- CSS 파일은 keyframe/복잡 선택자/gradient/써드파티 오버라이드에만. 단순 레이아웃·spacing·flex·grid 때문에 새 `.css` 금지
- `!important`, `@apply` 남용, 컴포넌트 전용 CSS를 전역에 올림

### 🔵 기타

긴 className 정리, 반복 스타일 묶음 추출, 전역은 `app/styles/`·컴포넌트 전용은 같은 폴더.

---

## 9. 개발자 경험 (DX) (09)

### 🔴 필수

- **발견성**: 파일/폴더 이름만으로 역할 파악 불가, public API만 봐서 사용법 안 드러남, 비슷한 책임 코드가 여러 위치 산재
- **수정 안전성**: 한 군데 수정에 여러 파일 암묵적으로 알아야 함, side effect/외부 호출 경계 숨김, 동일 개념이 여러 이름/형태로 노출

### 🟡 주요

- 같은 기능군인데 생성/조회/변경 방식 제각각, 훅/액션/selector/query key/IPC 호출 패턴 불일치
- 짧은 usage 주석 필수 지점: 비자명 진입 순서, workaround 이유, 외부에서 오용하기 쉬운 public API
- 슬라이스/컴포넌트/훅 신규 추가 위치가 구조만 봐서 모호, 상수/타입/helper 단일 출처 없음
- 파일 위치 부적합 (지나치게 깊이 숨어 있거나, 특정 전용 코드가 shared에 올라감)

### 🔵 기타

2곳+ 반복되는데 공용 진입점 없음 vs 이른 추상화로 API 과복잡.

---

## 10. 알고리즘 효율성 & 복잡도 (10)

자료구조·알고리즘 복잡도 본질만 본다. React 렌더링 성능은 섹션 3, 함수 길이·중첩은 섹션 4에서 이미 커버됨.

### 🔴 필수

- **중첩 루프 선형 탐색**: 바깥 루프 × `.find`/`.includes`/`.indexOf`/`.some` → O(N²). Map/Set 빌드 후 O(1) 조회로 O(N+M)
- **반복 선형 탐색**: 같은 컬렉션을 여러 번 `find`/`includes` → Map/Set 사전 구축
- **누적 spread in loop**: `arr = [...arr, item]`, `obj = {...obj, k:v}`, `reduce((acc,x) => [...acc, f(x)])` → O(N²). `.push()` 또는 배치 spread
- **메모이제이션 누락**: 같은 입력에 고비용 pure 재계산, DP 후보 재귀에 memo 없음
- **N+1 I/O**: 루프 안 DB/API/파일 호출. 배치 엔드포인트 또는 `Promise.all` 병렬화, 독립 await chain 직렬화

### 🟡 주요

- 멤버십 체크에 Array(`.includes`) vs Set(`.has`), key 조회 빈도 높으면 Map
- 우선순위 큐 필요에 매번 sort, 상위 k개에 전체 sort
- `min`/`max` 하나만 필요한데 전체 sort → O(N) 단일 pass
- `.map().filter().map()` 체인의 불필요한 중간 배열 (큰 데이터)
- 루프 내 정규식/상수 객체/파서 반복 생성 → 루프 밖
- `str += ...` in loop → push + join
- 큰 파일 전체 로드 / 전체 JSON.parse → streaming
- Sliding window/two-pointer로 O(1) 공간 가능한데 O(N) 보조 배열
- 재귀 깊이 N 비례 → iterative 전환

### 🔵 기타

- brute force인데 분할정복·greedy·DP 후보, O(N²) sort, 그래프 알고리즘 선택 오류
- hot path에 Big-O 주석 없음, 트레이드오프 이유 미기재
- 내장 함수의 실제 복잡도(`Array.unshift` O(N) 등) 잘못 가정

**지적 원칙**: 실제 데이터 규모를 고려. 10건 배열에 O(N²)는 대부분 문제 아님 — hot path·큰 데이터·수치상 차이가 드러나는 경우만.

---

## 11. 문제-의도-선택 근거 (11)

### 🔴 필수

- 해결해야 할 문제와 구현 방식이 어긋남 (단순 요구에 과한 추상화, 복잡한 요구에 임시 우회)
- 핵심 트레이드오프가 숨겨짐 (성능/단순성/확장성 중 무엇을 희생했는지 이유 없음)
- workaround/비표준 패턴인데 왜 필요한지, 언제 제거할지 설명이 없음

### 🟡 주요

- 코드/이름/짧은 주석만으로 왜 이 코드가 필요한지 파악되지 않음
- 더 단순한 표준 패턴으로 충분한데 커스텀 구조를 택한 근거가 약함
- 지금은 동작하지만 다음 수정자가 암묵적 전제를 많이 알아야 하는 구조

### 🔵 기타

- 성능보다 단순함, 단순함보다 확장성을 택한 이유를 짧게 남기면 좋아짐
- 파일별 핵심 이슈를 쓸 때는 가능하면 **문제 → 현재 선택 → 왜 부족한지** 순서로 적는다

---

## 출력 형식 (최종)

| Severity | 파일 | 핵심 이슈 | 이유 | 개선 방향 |
|----------|------|----------|------|------------|
| 🔴/🟡/🔵 | path/to/file | 가장 중요한 1개 | 왜 중요한지 | 짧은 수정 방향 |

**원칙**
- 파일당 이슈는 최대 1개 (severity 높은 것)
- 위반 없는 파일/영역은 상세 표에 포함하지 않음
- 단순 스타일·반복 지적·영향 작은 코멘트는 생략
- diff에 없는 기존 코드 지적 금지, 추측 금지
