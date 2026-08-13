# 3D 변환 & 행렬 리뷰 규칙

React 앱에서 실제로 등장하는 **행렬·변환 계산** 전용 리뷰 문서. 주 대상은 Three.js / React Three Fiber / WebGL·GLSL 이며, `/code-review-math`와 `/code-review-full`의 수학 패스에서만 사용된다. 숫자 prefix가 없으므로 일반 `/code-review`에서 자동 제외된다.

**규칙 ID는 `A-{번호}`(코드 구현) / `C-{번호}`(수학 논리) 형식으로 표기한다.**

적용 조건: 변경 파일에 `Matrix3`/`Matrix4`, `Quaternion`, `Euler`, GLSL 셰이더, projection/view 변환, 좌표 변환 계산이 있을 때만. 행렬 연산이 없는 UI 파일은 대상 아님.

## 영향도 보정 예시

| 영향도 | 이 문서에서 자주 보이는 근거 |
|----------|------|
| 높음 | 수식/코드 오류가 잘못된 화면 결과, 잘못된 좌표 변환, 런타임 실패 같은 닫힌 높은 영향 범주를 직접 만든 경우 |
| 낮음 | 가정 누락, 수치 안정성, 관례 위반, 표현 개선처럼 실제 파손 범주를 아직 닫지 못한 경우 |

수학적 아름다움이나 표현 차이만으로는 영향 높음이 아니다. 현재 변경에서 실제 변환 오류나 런타임 실패가 닫혀야 높음으로 둔다.

---

## A. 코드 구현 검사

### A-1. 차원 mismatch 🔴

- `Matrix3`와 `Matrix4`를 혼용해 변환을 적용
- `Vector3`에 4×4 변환을 적용할 때 `applyMatrix4`가 아닌 다른 경로를 써서 translation이 누락됨
- 셰이더에서 `vec3`/`vec4`, `mat3`/`mat4` 조합이 맞지 않음
- 배열로 직접 만든 행렬의 원소 수가 9/16과 다름

실제 코드에 선언된 타입과 크기를 따라가며 연산별로 검증한다. 주석이나 변수명에 의존하지 말고 추적한다.

### A-2. 곱셈 의미와 순서 🔴

- **GLSL**: `A * B`가 **행렬곱**이다 (numpy의 `*`와 반대). 이식된 코드에서 자주 버그가 난다
- **Three.js**: `a.multiply(b)`는 `a = a * b`, `a.premultiply(b)`는 `a = b * a`. 어느 쪽이 필요한지 확인
- 변환 합성 순서가 의도와 반대 — 일반적으로 `T * R * S`를 적용해야 스케일 → 회전 → 이동 순으로 동작
- local 변환과 world 변환을 섞어 곱함 (`matrix` vs `matrixWorld`)
- 행렬 곱은 **비가환**이다. 순서를 바꾼 리팩터링은 결과가 달라진다

### A-3. 역행렬 사용 🔴

- world → local 변환에 `matrixWorld`의 역행렬이 필요한데 전치나 다른 행렬을 사용
- 스케일이 0인 축이 있어 특이행렬이 된 상태에서 역행렬 호출
- 매 프레임 역행렬을 새로 계산 — 캐시 가능한지 확인
- normal 변환에 모델 행렬을 그대로 사용. 비균등 스케일이 있으면 **역전치 행렬**(`normalMatrix`)이 필요

### A-4. Storage order (column-major) 🟡

혼동이 가장 많은 영역이다.

| 대상 | storage |
|------|---------|
| Three.js `Matrix3`/`Matrix4` | **column-major** (`.elements` 순서 주의) |
| WebGL / GLSL | **column-major** |
| 수학 표기 / 대부분의 CPU 측 라이브러리 | row-major |

- `Matrix4.elements[1]`은 수학 표기의 `M[0][1]`이 아니라 `M[1][0]`이다
- `set()`은 **row-major 인자**를 받지만 내부 저장은 column-major다. 배열을 그대로 넣는 코드와 혼동하기 쉽다
- 라이브러리 경계를 넘나드는 코드(CPU 계산 → uniform 업로드)에서 transpose 누락/중복을 확인

### A-5. 각도 단위와 회전 표현 🔴

- degree와 radian 혼용 — Three.js API는 radian을 받는다
- `Euler`의 회전 순서(`'XYZ'` 기본)를 바꾸고도 사용하는 쪽을 맞추지 않음
- Euler 보간으로 짐벌락/급회전 발생 → `Quaternion.slerp` 검토
- 쿼터니언을 정규화하지 않고 누적 곱해 스케일이 뒤틀림

### A-6. Index / 슬라이싱 실수 🟡

- 수식은 1-indexed, 코드는 0-indexed — 변환 누락
- 대각 원소 접근 `m[i][i]` vs 특정 행 혼동
- `elements` 배열 인덱스를 행 우선으로 착각 (A-4 참조)

### A-7. Float 동등 비교 🟡

- 행렬/벡터를 `===` 또는 원소별 `==`로 비교 → 부동소수점 오차로 실패
- `inv(A) * A === I` 같은 단위행렬 비교는 거의 항상 실패
- 올바른 형태: epsilon 허용 비교(`Math.abs(a - b) < EPS`) 또는 라이브러리의 근사 비교

### A-8. In-place 변이와 참조 공유 🔴

Three.js 객체는 대부분 **가변**이다. React에서 특히 위험하다.

- `useFrame` 안에서 state나 props로 받은 벡터/행렬을 직접 변이해 렌더 사이클과 어긋남
- 공유된 `Vector3`/`Matrix4` 인스턴스를 여러 오브젝트가 참조하면서 한쪽 변경이 전파됨
- `clone()` 없이 반환해 호출자가 내부 상태를 변이할 수 있음

### A-9. 프레임 루프 내 할당 🟡

- `useFrame` 콜백 안에서 `new Vector3()`, `new Matrix4()`를 매 프레임 생성 → GC 압박. 모듈 스코프나 `useRef`로 재사용
- 매 프레임 `updateMatrixWorld()`를 전체 씬에 강제 호출
- 변하지 않는 오브젝트에 `matrixAutoUpdate`를 켜둔 채 방치

---

## C. 수학 논리 검사

### C-1. Transpose 규칙 🟡

- `(AB)^T = B^T A^T` — **순서 반전 필수**
- `(A^T)^T = A`, `(A + B)^T = A^T + B^T`, `(cA)^T = c A^T`

### C-2. Inverse 규칙 🟡

- `(AB)^-1 = B^-1 A^-1` — **순서 반전 필수**
- `(A^T)^-1 = (A^-1)^T`, `(A^-1)^-1 = A`
- 역행렬은 정방행렬에만 정의되고 `det(A) ≠ 0` 이어야 한다

### C-3. Identity 차원 🟡

`AI = A`, `IA = A`에서 `I`의 크기가 A의 차원과 맞아야 한다.

### C-4. Orthogonal 변환 🟡

- 순수 회전 행렬 `R`은 orthogonal: `R^T R = I` ⟹ `R^-1 = R^T`
- 따라서 **스케일이 없는 회전만 있다면** 역행렬 대신 전치를 쓸 수 있다. 스케일이 섞여 있으면 이 최적화는 틀린다
- Orthogonal 변환은 길이를 보존한다: `||Rx|| = ||x||`

### C-5. 선형 vs 아핀 🔴

- 선형변환 `T(x) = Ax`는 원점을 보존한다
- 아핀변환 `T(x) = Ax + b`는 원점을 옮긴다 — 선형이 아니다
- translation을 포함하려면 **4×4 homogeneous matrix**가 필요하다. 3×3으로 처리했다면 translation 누락 가능성
- 방향 벡터(normal, direction)에는 translation을 적용하면 안 된다 (`w = 0` vs `w = 1`)

### C-6. Projection 성질 🟡

- 투영 행렬 `P`는 **idempotent**(`P² = P`) 여야 한다
- perspective divide(`/w`)를 빠뜨리면 NDC 좌표가 틀린다
- near/far plane 값이 0이거나 뒤바뀌면 depth 정밀도가 무너진다

---

## 출력 가이드

- 실제 수식·코드를 읽고, **차원과 좌표 공간을 어떻게 추적했는지**를 설명한다.
- storage order, transpose/inverse, projection 전제는 어느 라이브러리 계약과 충돌하는지까지 남긴다.
- 수정 방향은 epsilon 비교, 역전치 사용, homogeneous matrix 전환처럼 바로 적용 가능한 수학적 교정으로 적는다.

**원칙**

- 실제 수식·코드를 읽고 검증한다. 이름·주석만 보고 판단하지 않는다
- 차원과 좌표 공간을 추적해서 명시한다 (예: `local → world: matrixWorld 적용 ✓`)
- 규칙 번호(A-x / C-x)를 반드시 표기한다
- diff에 없는 기존 수학 코드는 지적 대상이 아니다
- 추측 금지 — 의심스러우면 "검증 필요"로만 표기한다
