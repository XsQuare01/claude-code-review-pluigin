# 알고리즘 효율성 & 복잡도

이 모듈은 **자료구조 선택과 계산 복잡도 자체가 잘못된 경우**를 찾는다.

다음은 이 문서의 검사 범위가 아니다 (중복 방지):

- 리렌더링, memo, Context 참조 → `04-state.md`
- 가상화, 번들, lazy, 입력 반응성, 이미지 → `14-react-performance.md`
- 함수 길이·중첩·early return → `05-structure.md`
- 에러 처리·패턴 일관성 → `09-code-quality.md`

여기는 순수하게 **"같은 일을 더 낮은 Big-O로 할 수 있는데 높은 복잡도로 짰는가"** 를 본다. 파일 I/O·DB 항목은 Electron main 프로세스나 BFF 코드를 함께 다룰 때만 적용한다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 큰 데이터에서 실질 성능 문제, 명백히 불필요한 O(N²) 이상 |
| 🟡 WARNING | 중소 데이터에서도 개선 여지, 자료구조 선택 부적절 |
| 🔵 INFO | 가독성·문서화 개선, 알고리즘 선택 근거 명시 권장 |

---

## 15-1. 중첩 루프에서 선형 탐색 🔴

바깥 루프 × 안쪽 `.find()` / `.includes()` / `.indexOf()` / `.some()` 조합은 전형적인 O(N·M) → O(N²) 패턴. 미리 Map/Set을 빌드하면 조회가 O(1)이 되어 전체 O(N+M)로 내려간다.

- 두 배열의 교집합·차집합·중복 검사
- "A의 각 원소가 B에 있는지" 검사
- 조인 키로 매칭

```typescript
// ❌ O(N·M)
const matched = a.filter(x => b.includes(x.id))

// ✅ O(N+M)
const bSet = new Set(b)
const matched = a.filter(x => bSet.has(x.id))
```

React에서는 리스트 렌더 안에서 이 패턴이 나오면 렌더마다 반복되므로 특히 강하게 본다.

## 15-2. 반복 선형 탐색 🔴

같은 컬렉션을 여러 곳에서 반복 탐색하는데 매번 `find`/`includes`를 호출. 한 번 Map/Set을 빌드해두면 이후 조회는 전부 O(1).

- Array를 "있는지만" 확인하는 용도로 쓰는 경우 → Set으로
- Array를 key 조회용으로 쓰는데 `.find(x => x.id === id)` 반복 → Map으로

## 15-3. 누적 Spread in Loop 🔴

루프마다 `[...arr, item]` 또는 `{...obj, [key]: v}`로 전체를 복사하면 O(N²). 배치로 모은 뒤 한 번에 spread하거나 `.push()` 후 반환.

```typescript
// ❌ O(N²)
let result = []
for (const x of input) result = [...result, transform(x)]

// ✅ O(N)
const result: T[] = []
for (const x of input) result.push(transform(x))
```

`reduce`에서 `(acc, x) => [...acc, f(x)]` 패턴도 동일한 안티패턴이다. 단, React state 업데이트에서 새 참조를 만드는 `setItems(prev => [...prev, item])`은 불변성 요구사항이므로 위반이 아니다.

## 15-4. 중복 계산 🔴

같은 입력에 대한 pure 함수 결과를 여러 번 계산.

- 재귀에서 memo 없음 (DP 후보)
- 루프 안에서 루프 바깥에 의존하는 값을 매번 재계산
- 동일 데이터에 같은 파생값을 여러 함수가 각자 계산

React 컴포넌트 내부의 `useMemo` 판단은 `14-react-performance.md`가 다루므로 여기서는 순수 함수 로직만 본다.

## 15-5. N+1 I/O 🔴

루프 안에서 비동기 리소스를 1건씩 호출하는 패턴.

- API: `for (const item of items) await api.get(...)` → bulk endpoint 또는 `Promise.all`
- 직렬 await chain인데 서로 독립 → `Promise.all`로 병렬화
- DB/파일 (서버 측 코드): 배치 조회 또는 병렬 읽기

```typescript
// ❌ 직렬 O(N·latency)
for (const id of ids) {
  const user = await fetchUser(id)
  results.push(user)
}

// ✅ 배치가 있으면 배치, 없으면 병렬
const results = await Promise.all(ids.map(fetchUser))
```

병렬화가 shared state write나 순서 의존을 만들면 `17-concurrency.md`를 함께 본다.

## 15-6. 자료구조 부적합 🟡

- **멤버십 체크 빈도 높음** → `Array.includes` 대신 `Set.has`
- **key 조회 빈도 높음** → 빈번한 추가/삭제·반복이면 `Map`이 유리
- **우선순위 큐 필요** → 매번 `sort()` 대신 heap 구조
- **중복 허용 카운팅** → `Map<K, number>`

## 15-7. 정렬 오남용 🟡

- `min`/`max` 하나만 필요한데 전체 `sort()` 호출 → O(N) 단일 pass
- "상위 k개" 필요에 전체 정렬 → partial sort / heap
- 여러 번 탐색인데 매번 linear scan → 한 번 정렬 + binary search
- `sort()`가 원본 배열을 변이한다는 점을 놓쳐 state나 props 배열을 직접 정렬 (`toSorted()` 또는 복사 후 정렬)

## 15-8. 불필요한 중간 배열 🟡

- `.map().filter().map().reduce()` 체인이 매번 새 배열 생성. 큰 데이터에서는 단일 for-of 패스
- `.flatMap().filter()`가 중간 배열을 크게 만드는 경우 필터부터 적용

작은 배열(<100)에서는 가독성 우선, 큰 데이터(>10K)나 hot path에서만 지적한다.

## 15-9. 루프 내 반복 할당 🟡

- 정규식을 루프 내부에서 반복 생성 → 루프 밖으로
- 상수 테이블/설정 객체를 루프 내부에서 생성
- `Intl` 포매터를 반복 생성

## 15-10. String 누적 🟡

`str += part` in loop는 큰 N에서 느릴 수 있다. 배열에 push 후 `join('')`.

## 15-11. 공간 복잡도 🟡

- Sliding window / two-pointer로 O(1) 추가 공간 가능한데 O(N) 보조 배열 사용
- 재귀 깊이가 N에 비례 → stack overflow 위험. iterative 전환
- 전체 순열·조합을 메모리에 보관 → generator로 lazy

## 15-12. 알고리즘 선택 🔵

- Brute force인데 분할정복·greedy·DP 후보
- 그래프 문제에서 BFS·DFS·Dijkstra·union-find 중 잘못 선택
- 라이브러리/내장 함수의 실제 복잡도(예: `Array.unshift` O(N))를 잘못 가정한 코드

구현 난이도·팀 역량을 고려해 항상 더 좋은 알고리즘을 강요하지 않는다. **명백히 데이터 규모가 크고 성능이 문제 되는 경우**에만 지적한다.

---

## 15-OUTPUT. 출력 형식

<!-- REVIEW_RESULT_CONTRACT_V1_PRODUCER_OUTPUT -->

이 문서를 producer prompt에 쓸 때는 **`REVIEW_RESULT_CONTRACT_V1`** 을 따른다. 응답은 Markdown 표나 헤딩이 아니라 **raw JSON 객체 하나만** 반환한다.

- top-level에는 `schemaVersion`, `findings`, `openQuestions`를 항상 포함하고 `schemaVersion`은 `1`이어야 한다.
- `severity`는 producer가 내지 않는다. 이 모듈은 `impact`와 `confidence`만 판정한다.
- 현재 복잡도, 개선 복잡도, 병목 설명, 자료구조/알고리즘 대안은 새 schema field를 만들지 말고 `body`, `recommendation`, `evidence`에 담는다.
- `00-rule.md` 00-11에 걸리는 unresolved absence/possibility claim, search scope 미완료, 추가 탐색 요청만 `openQuestions`로 보낸다.
- 결함은 성립하지만 exact location만 확인하지 못했으면 finding을 유지하고 `location.kind="unverified"`와 `reason`만 사용한다.
- producer 문자열 필드는 최종 리포트의 신뢰된 Markdown이 아니다. heading/table/raw HTML/link를 직접 만들려고 하지 말고 plain prose만 넣는다.

**원칙**
- 실제 데이터 규모를 고려해서 지적한다 (10건짜리 배열에 O(N²)는 대부분 문제 아님)
- "이론적으로는 느리지만 현재 규모에선 상관없다" 싶으면 🔵로 낮추거나 생략한다
- 복잡도 개선을 제시할 때 자료구조명·알고리즘명을 명확히 한다
- diff에 없는 기존 코드는 지적하지 않는다
