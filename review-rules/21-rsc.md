# React Server Components & Server/Client 경계

이 모듈은 **코드가 서버에서 실행되는지 클라이언트에서 실행되는지**, 그리고 그 경계를 넘는 값과 권한이 안전한지를 본다.

RSC에서는 파일이 어디서 실행되는지가 파일 내용만으로 드러나지 않는다. 지시어 하나가 그 파일과 그 파일이 import하는 모든 것의 실행 위치를 바꾸고, 경계를 넘는 값은 직렬화를 통과해야 하며, 서버 전용이라고 믿었던 코드가 클라이언트 번들로 딸려 들어갈 수 있다. 이 세 가지가 이 모듈의 대상이다.

## Trigger / 적용 조건

**RSC를 지원하는 프레임워크를 쓰는 프로젝트에만 적용한다.** 다음 중 하나 이상이 확인될 때만 이 모듈을 적용하고, 확인되지 않으면 모듈 전체를 `SKIPPED`로 처리한다.

- 저장소에 `'use client'` 또는 `'use server'` 지시어가 존재한다
- Next.js App Router, React Router framework mode, Waku 등 RSC를 지원하는 프레임워크 설정이 있다
- 번들러/프레임워크 설정에 React Server Components가 활성화돼 있다

Vite + SPA, CRA, Electron renderer 전용처럼 서버 컴포넌트 개념이 없는 프로젝트에는 적용하지 않는다. SSR을 쓰지만 RSC는 아닌 프로젝트(전통적 Next.js Pages Router 등)에도 적용하지 않는다 — 그 경우 hydration 관련 항목은 `03-react-rules.md` 03-8이 다룬다.

다음은 이 문서의 검사 범위가 아니다 (중복 방지):

- hydration 불일치 자체 → `03-react-rules.md` 03-8
- FSD 레이어 배치, Electron 프로세스 경계 → `01-fsd.md`
- 권한 검사 누락의 운영 위험 등급 → `18-dangerous-change.md`
- 요청 shape·payload 호환성 → `16-api-contract.md`

## 영향도 보정 예시

| 영향도 | 이 모듈에서 자주 보이는 근거 |
|----------|------|
| 높음 | 서버 비밀 유출, 권한 우회, 빌드/런타임 실패, 직렬화 크래시처럼 닫힌 높은 영향 범주를 직접 지목할 수 있는 경우 |
| 낮음 | 클라이언트 번들 비대화, 경계 오배치, 과도한 payload, guard 부족처럼 회귀 위험은 있지만 아직 닫힌 높은 영향 범주를 직접 닫지 못한 경우 |

RSC 경계 문제라도 단순 bundle size, structure, clarity 문제만으로는 영향 높음이 아니다. 실제 비밀 유출·권한 우회·직렬화 실패가 닫힐 때만 높음으로 둔다.

---

## 21-1. `'use client'` 경계 배치 🟡

`'use client'`는 "이 파일을 클라이언트에서 실행하라"가 아니라 **"여기부터 아래 전부가 클라이언트 번들이다"**를 뜻한다. 이 파일이 import하는 모듈은 전이적으로 클라이언트 코드가 되며, 그 모듈들이 import하는 것도 마찬가지다.

- 🟡 트리 상단(레이아웃, 페이지 루트)에 `'use client'`를 붙여 하위 전체가 클라이언트로 끌려감
- 🟡 상호작용이 필요한 부분만 분리하면 되는데 큰 컴포넌트 전체를 클라이언트로 전환
- 🟡 `'use client'` 파일이 무거운 서버 전용 유틸(파싱, 마크다운, 날짜 라이브러리 등)을 import해 번들로 딸려 들어감
- 🔵 지시어가 파일 최상단이 아니거나 중복 선언

**판정 기준**: 경계를 아래로 밀 수 있는지 본다. 상태나 이벤트 핸들러를 실제로 쓰는 최소 단위만 클라이언트로 두고, 나머지는 서버에 남긴 뒤 `children`으로 서버 콘텐츠를 주입할 수 있으면 지적한다.

```tsx
// 🟡 페이지 전체가 클라이언트로 넘어간다
'use client'
export default function Page() {
  const [open, setOpen] = useState(false)
  return <article>{/* 대부분 정적 콘텐츠 */}</article>
}

// ✅ 상호작용 부분만 클라이언트, 나머지는 서버에 남는다
export default function Page() {
  return <Collapsible><ArticleBody /></Collapsible>   // ArticleBody는 서버 컴포넌트
}
```

## 21-2. `'use server'` 의미 혼동 🔴

`'use server'`는 **Server Function을 표시하는 지시어**다. "이 파일을 서버 컴포넌트로 만든다"는 뜻이 아니다. 서버 컴포넌트는 기본값이므로 별도 지시어가 없다.

- 🔴 서버 컴포넌트를 만들려고 `'use server'`를 붙임 — 그 파일의 export가 전부 클라이언트에서 호출 가능한 endpoint가 된다
- 🔴 Server Function이 아닌 값(상수, 타입, 일반 객체)을 `'use server'` 파일에서 export
- 🟡 Server Function 파일에 클라이언트가 호출할 필요 없는 내부 헬퍼가 함께 export됨

`'use server'`로 표시된 함수는 **네트워크로 노출된 공개 endpoint와 같다.** 파일 안에 있다는 이유로 내부 함수라고 취급하지 않는다.

## 21-3. 경계를 넘는 props의 직렬화 🔴

서버 컴포넌트가 클라이언트 컴포넌트에 넘기는 props는 직렬화를 통과해야 한다.

- 🔴 함수, 클래스 인스턴스, `Date` 외의 커스텀 객체, `Map`/`Set`, Symbol, 순환 참조를 props로 전달
- 🔴 서버에서 만든 이벤트 핸들러를 클라이언트 컴포넌트에 props로 전달 (Server Function은 예외)
- 🟡 필요한 필드가 몇 개뿐인데 거대한 서버 객체를 통째로 전달 — payload가 그대로 네트워크를 탄다
- 🟡 ORM 엔티티나 DB row를 가공 없이 전달해 내부 필드가 클라이언트로 노출

**판정 기준**: 전달값이 JSON 직렬화 가능한 형태이거나 React가 지원하는 특수 타입(Server Function 참조, Promise, JSX)인지 본다. 크래시 여부와 별개로, 필요 이상의 필드가 넘어가면 payload와 노출 양쪽에서 지적한다.

## 21-4. 서버 전용 코드·비밀의 클라이언트 유출 🔴

- 🔴 API 키, DB 접속 문자열, 내부 토큰이 클라이언트 컴포넌트에서 읽히는 경로에 존재
- 🔴 클라이언트 노출 접두어(`NEXT_PUBLIC_` 등)가 붙은 env에 비밀값을 담음
- 🔴 DB 클라이언트, 파일시스템, 서버 SDK를 `'use client'` 경계 아래에서 import
- 🟡 서버 전용 모듈에 `server-only` 같은 가드가 없어 실수로 import될 수 있음

**판정 기준**: 그 값이 클라이언트에서 읽히는 경로에 도달하는지를 import 체인으로 확인한다. "서버에서만 쓸 의도였다"는 주석은 증거가 아니다.

## 21-5. Server Function의 권한과 입력 검증 🔴

Server Function은 클라이언트가 임의의 인자로 호출할 수 있는 공개 endpoint다. 폼에서만 호출한다는 사실은 아무것도 보장하지 않는다.

- 🔴 인증·인가 검사 없이 데이터를 읽거나 쓰는 Server Function
- 🔴 클라이언트가 보낸 ID를 검증 없이 신뢰해 다른 사용자의 리소스를 조작 (IDOR)
- 🔴 `FormData`나 인자를 런타임 검증 없이 그대로 DB/외부 API에 전달
- 🟡 호출자가 UI에서 가려져 있다는 이유로 권한 검사를 생략

권한 검사는 Server Function **안에서** 이뤄져야 한다. 호출하는 컴포넌트 쪽 gating은 UI 편의일 뿐 보안 경계가 아니다. 운영 위험 등급은 `18-dangerous-change.md` 18-1과 함께 본다.

## 21-6. 서버/클라이언트 실행 전제 혼동 🟡

- 🟡 서버 컴포넌트에서 `useState`, `useEffect`, 이벤트 핸들러, 브라우저 API 사용
- 🟡 클라이언트 컴포넌트에서 서버 전용 async 데이터 접근을 흉내 내려고 최상위 `await` 사용
- 🟡 Context Provider를 서버 컴포넌트에 두어 클라이언트 소비자가 값을 받지 못함
- 🔵 서버 컴포넌트에 불필요한 `'use client'` 하위 wrapper가 겹겹이 쌓임

---

## 21-CHECK. 리뷰 수행 방법

1. diff에서 `'use client'` / `'use server'` 지시어가 추가·이동·삭제됐는지 먼저 본다.
2. 새 `'use client'` 파일이 무엇을 import하는지 한 단계 따라가 번들 유입을 확인한다.
3. 서버 → 클라이언트로 넘어가는 props의 타입을 확인한다.
4. 새 Server Function마다 "인증 검사 있는가 / 입력을 검증하는가 / 이 인자를 조작하면 남의 데이터에 닿는가"를 묻는다.
5. env·비밀·서버 SDK가 클라이언트 경계 아래에서 import되는 경로가 있는지 확인한다.

## 21-OUTPUT. 도메인 결과 가이드

- "경계 위반"이라고만 쓰지 말고 **어느 값이 어느 방향으로 넘어가 무엇이 되는지**를 적는다.
- 비밀 유출, 공개 endpoint화, 직렬화 실패처럼 결과가 크면 어떤 import chain이나 props 전달이 그 결과를 만드는지 남긴다.
- bundle 비대화나 guard 부족처럼 낮은 영향 쪽 지적은 왜 아직 닫힌 높은 영향 범주를 증명하지 못했는지도 분명히 한다.

**원칙**
- "경계 위반"이라고만 쓰지 말고 **어느 값이 어느 방향으로 넘어가 무엇이 되는지** 적는다
- 프로젝트가 RSC를 쓰지 않으면 이 모듈 전체를 `SKIPPED`로 보고한다
- diff에 없는 기존 코드는 지적하지 않는다
