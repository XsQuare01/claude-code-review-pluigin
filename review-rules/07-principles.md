# 개발 원칙 준수 여부

코드가 아래 원칙을 위반하는지 점검. 위반 시 원칙명과 함께 지적.

이 모듈은 **다른 모듈에서 이미 구체적으로 다루지 않는 원칙 위반**을 보완하는 용도다. 상태/아키텍처/네이밍/DX/성능처럼 더 구체적인 모듈에 직접 대응되는 이슈는 그쪽 모듈을 우선 사용하고, 여기서는 원칙 차원의 해석이 추가로 필요할 때만 지적한다.

Severity는 "원칙 이름의 중요도"가 아니라 **현재 변경에서 그 위반이 만드는 실제 위험도**를 기준으로 판단한다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 원칙 위반으로 런타임 버그 또는 유지보수 심각 장애 |
| 🟡 WARNING | 원칙 위반으로 가독성/확장성 저해 |
| 🔵 INFO | 더 원칙에 부합하는 대안 존재 |

---

## 🔴 ERROR 등급 원칙

### SSOT (Single Source of Truth)
동일 데이터가 여러 state에 중복, 서버값을 로컬 state에 복사, 상수/타입 정의 중복.

### SRP (Single Responsibility Principle)
컴포넌트가 페칭+로직+렌더링 전부 담당, 훅이 무관한 여러 상태 관리.

### SoC (Separation of Concerns)
UI와 비즈니스 로직 혼재, 라우팅이 도메인 컴포넌트에 포함.

### Fail Fast (빠른 실패)
빈 catch 블록, 잘못된 입력이 깊이 전파된 후 에러, API 응답 미검증.

### Immutability (불변성)
`Array.push()`, `splice()`, `Object.assign(target)` 등 상태 직접 변이.

---

## 🟡 WARNING 등급 원칙

### DRY (Don't Repeat Yourself)
동일 로직 2곳+ 복사, 유효성 규칙 폼마다 하드코딩, API 패턴 반복.

### KISS (Keep It Simple)
현재 불필요한 추상화, 3줄이면 끝나는 로직을 별도 유틸/훅/HOC로 분리.

### YAGNI (You Aren't Gonna Need It)
미사용 Props/타입, "나중에 쓸" 유틸, 사용처 하나인데 과도한 일반화.

### OCP (Open/Closed Principle)
새 타입 추가 시 기존 컴포넌트 수정 필요, if/else 계속 길어지는 패턴 → 맵 기반.

### LSP (Liskov Substitution)
확장한 자식 Props가 부모와 호환 안 됨, extends 타입이 원래 제약 위반.

### ISP (Interface Segregation)
거대한 객체 Props 받으면서 1-2개만 사용, 훅이 과다한 값 반환.

### LoD (Law of Demeter)
`user.address.city.name` 같은 3단+ 체이닝, 데이터 내부 구조 강결합.

### PoLA (Principle of Least Astonishment)
`getX`가 데이터 변경, `isValid`가 예외 던짐, 이름과 동작 불일치.

### CQS (Command-Query Separation)
데이터 반환하면서 상태 변경, getter 내부 부수효과.

### Composition over Inheritance
HOC 3단+ 중첩, class extends 패턴 → 커스텀 훅 합성.

### Encapsulation (캡슐화)
내부 state를 ref로 외부 노출, 내부 헬퍼가 Public API에 포함.

### Defensive Programming (방어적)
API 응답 미검증, localStorage 파싱 없이 사용, URL 파라미터 미검증.

### Data-Presentation Separation
API 형식(snake_case, ISO 날짜)이 UI까지 관통, 변환 로직 인라인.

### Least Privilege (최소 권한)
필요 이상 데이터가 Props로 전달, 환경변수 불필요한 클라이언트 노출.

### Colocation (코로케이션)
단일 컴포넌트 전용 타입/유틸이 먼 shared에 위치.

### Explicit over Implicit
default export, `!!value`, `==` 사용 → named export, 명시적 비교, `===`.

### CoC (Convention over Configuration)
파일 네이밍 모듈마다 상이, export 패턴 혼용, 훅/유틸 네이밍 불일치.

---

## 🔵 INFO 등급 원칙

### DIP (Dependency Inversion)
특정 API 클라이언트 구현체 직접 import → 추상 레이어 경유.

### Idempotency (멱등성)
버튼 더블 클릭 중복 요청, Strict Mode useEffect 부수효과 중복.

### Transparency (투명성)
복잡한 정규표현식 주석 없음, workaround에 이유 없음, 암묵적 의존성.

### Robustness (Postel's Law)
입력 관대-내부 엄격 미적용. Props `string|number` 받되 내부 정규화.

### Tell Don't Ask
외부에서 상태 조회 후 조건 판단 → 객체에 행동 지시.

### Uniform Access
같은 값 도출 방식이 `user.fullName` vs `getFullName(user)` 혼재.

### Avoid Premature Optimization
성능 문제 없이 `useMemo`/`useCallback` 남용, 프로파일링 없는 최적화.

### Parsimony (Occam's Razor)
useState 충분한데 전역 상태 라이브러리, 불필요한 추상화 레이어.
