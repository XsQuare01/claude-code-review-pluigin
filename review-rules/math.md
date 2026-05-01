# Linear Algebra Matrix Review Rules

선형대수학의 **행렬 계산** 전용 리뷰 문서. 오직 `/code-review-math`에서만 사용된다. 파일명에 숫자 prefix가 없으므로 일반 `/code-review`에서 자동 제외된다.

검사 범위:
- **A. 코드 구현**: numpy/scipy/PyTorch/JAX, Three.js Matrix3/Matrix4, WebGL/GLSL, Eigen, ml-matrix/mathjs 등 행렬 연산 구현 코드
- **C. 순수 수학 논리**: 수식이 선형대수 법칙에 부합하는지 (역행렬 존재 조건, transpose/inverse 규칙, eigenvalue 관계 등)

**B(docstring-코드 일치)는 이 문서의 검사 범위에서 제외**한다. 이 축은 일반 `/code-review`의 주석/문서 일관성 검토에서 다루는 편이 더 자연스럽기 때문이다.

## Severity

- 🔴 ERROR — 수식/코드가 수학적으로 틀림, 런타임 에러 또는 잘못된 결과 산출
- 🟡 WARNING — 가정 누락, 수치 안정성 저하, 관례 위반
- 🔵 INFO — 효율성·가독성 개선 제안

---

## A. 코드 구현 검사

### A-1. 차원 mismatch 🔴

- `m×n` 행렬과 `p×q` 행렬의 곱에서 `n ≠ p`인데 연산 시도
- Matrix-vector 곱에서 벡터 길이가 열 수와 다름
- Batch 차원 처리 실수 (`(B, m, n) @ (n, k)` vs `(B, m, n) @ (B, n, k)`)
- Reshape/concat 시 총 원소 수 불일치

실제 코드에 선언된 shape/size를 따라가며 연산별로 검증한다. 주석이나 변수명에 의존하지 말고 shape 추적.

### A-2. 행렬곱 vs 원소곱 혼동 🔴

- **numpy/PyTorch**: `A @ B` = 행렬곱, `A * B` = 원소곱(Hadamard). 반대 사용 시 위반
- **Three.js**: `Matrix4.multiply(m)` = 행렬곱. 컴포넌트 접근 후 스칼라 연산으로 대체하면 위반
- **JS 배열**: `A * B` 불가능하므로 반드시 라이브러리/루프. 의도치 않은 스칼라 변환 경계
- **GLSL**: `A * B`가 행렬곱임(numpy와 반대). 언어 간 코드 이식 시 자주 버그

### A-3. 역행렬 호출 주의 🔴

- `Ax = b` 풀 때 `inv(A) @ b` 대신 **`solve(A, b)`** 권장 (수치 안정성, 2~3배 빠름)
- `A^-1 B` 대신 `solve(A, B)` 또는 LU 분해 재사용
- 비정방행렬에 `inv()`/`det()` 호출 → 수학적으로 정의되지 않음
- **특이행렬/near-singular** 에 `inv()` — `cond(A)`가 매우 크면 결과가 무의미. 체크 없이 호출하면 위반
- Pseudo-inverse(`pinv`) 가 적절한데 `inv`를 쓰는 경우

### A-4. Storage order (row/column-major) 🟡

혼동이 가장 많은 영역. 라이브러리마다 다르다:

| 라이브러리 | 기본 storage | 비고 |
|-----------|-------------|------|
| numpy | row-major (C order) | `order='F'`로 변경 가능 |
| PyTorch | row-major | |
| Three.js Matrix4 | **column-major** | `.elements` 배열 순서 주의 |
| WebGL / GLSL | **column-major** | |
| Eigen (C++) | **column-major** 기본 | row-major 옵션 있음 |
| OpenGL (legacy) | **column-major** | |

라이브러리 경계를 넘나드는 코드(예: numpy → WebGL uniform)에서 **transpose 누락/중복**이 있는지 확인. `Matrix4.elements[1]`이 수학 표기로 `M[0][1]`이 아닌 `M[1][0]`임을 놓친 코드 지적.

### A-5. Index 기반 실수 🟡

- 수식은 1-indexed, 코드는 0-indexed — 변환 누락 (`A[i-1][j-1]`이 빠짐)
- 대각 원소 접근 `A[i][i]` vs 특정 행 `A[i]` 혼동
- Slicing 경계 — `A[0:n]`이 `n-1`까지임을 놓침

### A-6. Broadcasting 오류 🟡

- `(m, n) + (n,)` 의도가 "행별 broadcast"인지 "열별"인지 불명확한 코드
- `(m,) * (n,)`가 스칼라 곱이 아니라 shape 오류
- Bias 더할 때 `(batch, features) + (features,)` 의도 vs `(batch, 1)` 의도 구분 누락
- 암묵적 broadcasting으로 shape가 맞는 듯 보이지만 의미가 틀린 계산

### A-7. Float 동등 비교 🟡

- 행렬 동등 `A == B` 원소별 비교 → 부동소수점 오차로 실패
- 올바른 형태: `np.allclose(A, B, rtol, atol)`, `torch.allclose`, 또는 명시적 `|A-B| < eps`
- 특히 `inv(A) @ A == I` 같은 단위행렬 동등 비교는 거의 항상 실패

### A-8. 벡터화 누락 🟡

- 행렬 연산을 `for` 루프로 원소별 계산 — numpy/torch 내장 연산(`@`, `einsum`, `matmul`)로 교체 가능한데 그대로 둠
- List comprehension으로 행별 루프 → `np.apply_along_axis` 또는 vectorize
- Numerical library에서 scalar 연산을 누적해 행렬 빌드하는 패턴

### A-9. In-place vs Copy 🔵

- `A += B`, `A[:] = ...` 같은 in-place가 다른 참조에 영향 주는지 확인
- `A = A @ B`가 새 배열 할당 — 큰 행렬에서 메모리 중복
- PyTorch의 `.add_()` vs `.add()`, numpy의 `out=` 인자 사용 일관성

### A-10. Sparse / dense 선택 🔵

- 대부분이 0인 행렬을 dense로 저장·연산 → 메모리/시간 낭비
- Sparse 후보: 희소 그래프 인접행렬, 대규모 선형 시스템의 희소 A
- 반대로 작은 행렬에 sparse 적용 → overhead만 증가

---

## C. 순수 수학 논리 검사

### C-1. 역행렬 존재 조건 🔴

- `A^-1` 사용 시 **A가 정방행렬**인가? 비정방이면 pseudo-inverse 필요
- **det(A) ≠ 0** (또는 rank가 full)인가? 코드에서 singular 가능성 있는 행렬(특히 데이터 기반 공분산, Gram matrix)에 inv 호출 시 지적
- 대칭/양정치(Cholesky 필요) 가정 누락

### C-2. Eigenvalue / Eigenvector 🔴

- `Av = λv`에서 v가 영벡터이면 안 됨 (trivial)
- 실수 eigenvalue 가정 없이 `np.linalg.eig` 결과를 실수로 캐스팅 (비대칭 실수 행렬은 복소 eigenvalue 가능) → 대신 `eigh` 고려
- Eigenvalue 순서 — 라이브러리마다 정렬 방식 다름. 정렬 전제로 인덱싱하면 위반
- Eigenvector는 방향만 결정됨 — 부호/스케일 비교 금지

### C-3. Projection 공식 🔴

- 열공간 projection `P = A(A^T A)^-1 A^T`
  - `A^T A`가 invertible하려면 A의 열이 **linearly independent** 해야 함. rank deficient면 pseudo-inverse 사용
  - P는 **symmetric** (`P^T = P`) + **idempotent** (`P² = P`) 이어야 함
- Orthogonal projection은 `Q Q^T` (Q의 열이 orthonormal일 때)

### C-4. Transpose 규칙 🟡

- `(AB)^T = B^T A^T` — **순서 반전 필수**. `(AB)^T = A^T B^T`라 적으면 위반
- `(A^T)^T = A`
- `(A + B)^T = A^T + B^T`
- `(cA)^T = c A^T`

### C-5. Inverse 규칙 🟡

- `(AB)^-1 = B^-1 A^-1` — **순서 반전 필수**
- `(A^T)^-1 = (A^-1)^T`
- `(A^-1)^-1 = A`
- `(cA)^-1 = (1/c) A^-1` (c ≠ 0)

### C-6. 곱셈 비가환성 🟡

- `A B ≠ B A` (일반적으로). 비가환 전제로 식 전개가 맞는지 확인
- 결합법칙 `(AB)C = A(BC)` 은 성립 — 계산 순서 최적화(작은 차원 먼저)는 가능
- 분배법칙 `A(B+C) = AB + AC`, `(B+C)A = BA + CA` 성립

### C-7. Identity 차원 🟡

- `AI = A`, `IA = A`에서 `I`의 크기가 A의 차원에 맞아야 함. `A`가 `m×n`이면 `A I_n = A = I_m A`
- 코드에서 `np.eye(n)`의 n이 틀린 경우

### C-8. Determinant 규칙 🟡

- 정방행렬에만 정의
- `det(AB) = det(A) det(B)`
- `det(A^T) = det(A)`
- `det(A^-1) = 1 / det(A)`
- `det(cA) = c^n det(A)` (n×n 행렬, **c의 n제곱**)
- Triangular 행렬은 대각 원소 곱

### C-9. Trace 규칙 🟡

- 정방행렬에만 정의 (직사각형 확장 정의 사용 시 명시 필요)
- `tr(A + B) = tr(A) + tr(B)`
- `tr(cA) = c tr(A)`
- **Cyclic property**: `tr(ABC) = tr(BCA) = tr(CAB)` — 순환 가능. 단 `tr(ABC) ≠ tr(ACB)` 일반적
- `tr(A^T) = tr(A)`

### C-10. Rank / Nullity 🟡

- Rank-nullity: `rank(A) + nullity(A) = n` (여기서 n은 **열 수**)
- `rank(AB) ≤ min(rank(A), rank(B))`
- `rank(A) = rank(A^T) = rank(A^T A) = rank(A A^T)`

### C-11. Orthogonal / Unitary 🟡

- Orthogonal `Q`: `Q^T Q = Q Q^T = I` ⟹ `Q^-1 = Q^T`. 반드시 **정방**
- Unitary (복소): `Q^* Q = I` (conjugate transpose)
- Orthogonal 변환은 norm 보존: `||Qx|| = ||x||`

### C-12. Norm 정의 혼동 🟡

- L1: `sum(|a_i|)`, L2: `sqrt(sum(a_i^2))`, L∞: `max(|a_i|)`
- 행렬 norm — Frobenius `sqrt(sum(a_ij^2))`, spectral `max(σ_i)`(최대 특잇값), induced norm 등
- 벡터 norm과 행렬 norm을 같은 함수로 호출 시 의도 불일치 여부

### C-13. 대칭성 · 양정치성 가정 🟡

- 대칭 `A = A^T` 가정하는 공식: Cholesky, eigen(real eigenvalues 보장), quadratic form 등
- 양정치(PD): 모든 eigenvalue > 0. Cholesky가 성공하려면 SPD(대칭 양정치) 필요
- 양반정치(PSD): eigenvalue ≥ 0
- 코드에서 공분산/Gram 행렬이라 대칭 PSD 가정은 수학적으로는 맞지만, 수치 오차로 비대칭이 되면 실패 → `(A + A^T) / 2`로 강제 대칭화 필요

### C-14. 분해(decomposition) 전제 🔵

| 분해 | 전제 |
|------|------|
| LU | 정방, 가능한 모든 leading principal minor가 non-zero (또는 partial pivoting 사용) |
| Cholesky | 대칭 양정치 (SPD) |
| QR | 임의 행렬 (column-linearly-independent면 유일) |
| SVD | 임의 행렬 |
| Eigen | 정방. 실수 eigenvalue 보장은 대칭/에르미트일 때 |

전제 미검증 분해 호출은 지적.

### C-15. 선형성 / 아핀 구분 🔵

- 선형변환 `T(x) = Ax`는 원점 보존
- 아핀변환 `T(x) = Ax + b`는 원점 이동 — 선형 아님
- 3D 그래픽스에서 translation 포함 시 4×4 homogeneous matrix 사용. 3×3로 했다면 translation 누락 가능성

---

## 출력 형식

| Severity | 파일 | 위치 | 분류 | 이슈 | 개선 방향 |
|----------|------|------|------|------|----------|
| 🔴/🟡/🔵 | path/to/file | line | A-x / C-x | 수식/코드의 구체적 위반 | 수정 방향 (가능하면 올바른 식·함수명 제시) |

**원칙**
- 실제 수식·코드를 읽고 검증. 이름·주석만 보고 판단 금지
- Shape/차원은 추적해서 명시 (예: `A: (3,4), B: (4,5), A @ B: (3,5) ✓`)
- 규칙 번호(A-x / C-x)를 반드시 표기
- diff에 없는 기존 수학 코드는 지적 대상 아님
- 추측 금지 — 의심스러우면 "검증 필요" 로만 표기
