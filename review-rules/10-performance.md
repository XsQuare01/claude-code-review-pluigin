# 알고리즘 효율성 & 시간·공간 복잡도

이 모듈은 **자료구조 선택과 계산 복잡도** 자체가 잘못된 경우를 찾는다. 다음은 **이 문서의 검사 범위가 아니다** (중복 방지):

- React 리렌더링 / useMemo 최적화 → `03-state.md`
- 함수 길이·중첩·early return → `04-structure.md`
- 에러 처리·패턴 일관성 → `06-code-quality.md`
- Three.js `useFrame` 내 재할당 → `01-fsd.md`의 "상태 관리 및 렌더링"

여기는 순수하게 **"같은 일을 더 낮은 Big-O로 할 수 있는데 높은 복잡도로 짰는가"** 를 본다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 큰 데이터에서 실질 성능 문제, 명백히 불필요한 O(N²) 이상 |
| 🟡 WARNING | 중소 데이터에서도 개선 여지, 자료구조 선택 부적절 |
| 🔵 INFO | 가독성·문서화 개선, 알고리즘 선택 근거 명시 권장 |

---

## 10-1. 중첩 루프에서 선형 탐색 🔴

바깥 루프 × 안쪽 `.find()` / `.includes()` / `.indexOf()` / `.some()` 조합은 전형적인 O(N·M) → O(N²) 패턴. 미리 Map/Set을 빌드하면 조회가 O(1)이 되어 전체 O(N+M)로 내려간다.

- 두 배열의 교집합·차집합·중복 검사
- "A의 각 원소가 B에 있는지" 검사
- 조인 키로 매칭 (DB join 흉내)

```typescript
// ❌ O(N·M)
const matched = a.filter(x => b.includes(x.id))

// ✅ O(N+M)
const bSet = new Set(b)
const matched = a.filter(x => bSet.has(x.id))
```

## 10-2. 반복 선형 탐색 🔴

같은 컬렉션을 여러 곳에서 반복 탐색하는데 매번 `find`/`includes`를 호출. 한 번 Map/Set을 빌드해두면 이후 호출은 전부 O(1).

- Array를 "있는지만" 확인하는 용도로만 쓰는 경우 → Set으로
- Array를 key 조회용으로 쓰는데 `.find(x => x.id === id)` 반복 → Map으로

## 10-3. 누적 Spread in Loop 🔴

루프마다 `[...arr, item]` 또는 `{...obj, [key]: v}`로 전체를 복사하면 O(N²). 배치로 모은 뒤 한 번에 spread하거나 mutable `.push()` 후 반환.

```typescript
// ❌ O(N²)
let result = []
for (const x of input) result = [...result, transform(x)]

// ✅ O(N)
const result: T[] = []
for (const x of input) result.push(transform(x))
```

`reduce`에서 `(acc, x) => [...acc, f(x)]` 패턴도 동일한 안티패턴.

## 10-4. 중복 계산 / 메모이제이션 누락 🔴

같은 입력에 대한 pure 함수 결과를 여러 번 계산. 특히:

- 재귀에서 memo 없음 (피보나치, LCS, edit distance 등 DP 후보)
- 루프 안에서 루프 바깥에 의존하는 값을 매번 재계산
- 동일 데이터에 같은 파생값을 여러 컴포넌트/함수가 각자 계산

React 컴포넌트 내부 `useMemo` 이슈는 `03-state.md`에서 다루므로 여기서는 순수 함수/비-React 로직만 본다.

## 10-5. N+1 I/O 🔴

루프 안에서 비동기 리소스를 1건씩 호출하는 패턴.

- DB: `for (const id of ids) await fetchUser(id)` → `fetchUsersByIds(ids)` 배치
- API: `for (const item of items) await api.get(...)` → bulk endpoint 또는 `Promise.all`
- 파일: 여러 파일을 순차 `await readFile` → 병렬
- 직렬 await chain인데 서로 독립 → `Promise.all`로 병렬화

```typescript
// ❌ 직렬 O(N·latency)
for (const id of ids) {
  const user = await fetchUser(id)
  results.push(user)
}

// ✅ 배치가 있으면 배치, 없으면 병렬
const results = await Promise.all(ids.map(fetchUser))
```

## 10-6. 자료구조 부적합 🟡

- **멤버십 체크 빈도 높음** → Array.includes 대신 `Set.has`
- **key 조회 빈도 높음** → 객체 리터럴 OK이나, 빈번한 추가/삭제·반복은 `Map`이 유리
- **우선순위 큐 필요** → 매번 `sort()` 대신 heap 구조
- **큰 범위 멤버십** (정수 범위 등) → BitSet 후보
- **중복 허용 카운팅** → Map<K, number> 또는 Multiset

자료구조가 용도에 안 맞으면 상수 배 이상의 오버헤드.

## 10-7. 정렬 오남용 🟡

- `min`/`max` 하나만 필요한데 전체 `sort()` 호출 → O(N log N) 대신 O(N) 단일 pass
- "상위 k개" 필요에 전체 정렬 → partial sort / heap
- 한 번만 쓸 데이터에 정렬 후 linear scan 대신 해시 조회로 O(N) 가능
- 여러 번 탐색인데 매번 linear scan → 한 번 정렬 + binary search

## 10-8. 불필요한 중간 배열 🟡

- `.map().filter().map().reduce()` 체인이 매번 새 배열 생성. 큰 데이터에서는 단일 for-of 패스 또는 transducer
- `.flatMap().filter()`가 중간 배열을 크게 만드는 경우 필터부터 적용

작은 배열(<100)에서는 가독성 우선, 큰 데이터(>10K)나 hot path에서만 지적.

## 10-9. 루프 내 반복 할당 🟡

매 iteration마다 똑같은 값을 다시 만드는 패턴.

- 정규식을 루프 내부에서 `new RegExp(...)` 또는 리터럴로 반복 생성 → 루프 밖으로
- 상수 테이블/설정 객체를 루프 내부에서 생성
- 불변 스키마 파서·validator를 매번 빌드

## 10-10. String 누적 🟡

`str += part` in loop는 일부 엔진에서 O(N²). 큰 문자열이면 배열에 push 후 `join('')`.

```typescript
// ❌ 큰 N에서 느림
let out = ''
for (const line of lines) out += line + '\n'

// ✅
const parts: string[] = []
for (const line of lines) parts.push(line)
const out = parts.join('\n')
```

## 10-11. 전체 로드 vs Streaming 🟡

- 큰 파일 `readFileSync` / 전체 JSON.parse → streaming parser
- 긴 응답을 한 번에 받아 메모리에 보관 → 청크 단위 처리
- DB 전체 SELECT 후 클라이언트에서 필터 → SQL WHERE로 내림

메모리 피크가 실제 문제가 될 수 있는 규모일 때만 지적.

## 10-12. 공간 복잡도 개선 🟡

- Sliding window / two-pointer로 O(1) 추가 공간 가능한데 O(N) 보조 배열 사용
- 재귀 깊이가 N에 비례 → stack overflow 위험. Iterative 또는 tail-call로 전환
- 전체 순열·조합을 메모리에 보관 → generator로 lazy

## 10-13. 알고리즘 선택 🔵

- Brute force인데 분할정복·greedy·DP 후보
- O(N²) 정렬 사용 (교재용이 아니라면 지적)
- 그래프 문제에서 BFS·DFS·Dijkstra·Bellman-Ford·union-find 중 잘못 선택
- 문자열 패턴 매칭에 naive loop 대신 KMP·Rabin-Karp·Aho-Corasick 후보
- 근사해로 충분한데 정확 해답을 과하게 계산

구현 난이도·팀 역량 고려해서 항상 더 좋은 알고리즘을 강요하지 않는다. **명백히 데이터 규모가 크고 성능이 문제 되는 경우**에만 지적.

## 10-14. Big-O 표기 🔵

- 성능이 중요한 hot path 함수에 복잡도 주석 없음
- 공간-시간 트레이드오프(메모리 더 써서 빠르게) 선택의 이유 주석 없음
- 라이브러리/내장 함수의 실제 복잡도(예: `Array.unshift` O(N))를 잘못 가정한 코드

---

## 출력 형식

| Severity | Rule | 위치 | 현재 복잡도 → 개선 | 이슈 | 개선 방향 |
|----------|------|------|-----------------|------|----------|
| 🔴/🟡/🔵 | 10-x | 파일:라인 | O(N²) → O(N) | 구체적 위반 | 자료구조/패턴 제시 |

**원칙**
- 실제 데이터 규모를 고려해서 지적 (10건짜리 배열에 O(N²)는 대부분 문제 아님)
- "이론적으로는 느리지만 현재 규모에선 상관없다" 싶은 경우 🔵로 낮추거나 생략
- diff에 없는 기존 코드 지적 금지
- 복잡도 개선 제시할 때 자료구조명·알고리즘명을 명확히 (예: "Set 기반 조회로 O(N)")
