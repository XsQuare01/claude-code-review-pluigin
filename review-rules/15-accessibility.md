# 접근성 검증

이 모듈은 변경된 UI 코드에서 바로 판단할 수 있는 high-signal 접근성 문제만 다룹니다. 전체 WCAG 설명서가 아니라, 리뷰 코멘트로 바로 수정 방향을 줄 수 있는 semantic HTML, keyboard, focus, accessible name, form error, visual alternative, ARIA 사용 문제를 찾습니다.

`00-rule.md`의 공통 범위가 우선합니다. 지적은 변경된 diff 라인 또는 그 변경 때문에 직접 깨진 인접 구조에만 한정합니다.

## Purpose / 범위

- 프론트엔드 UI 변경, 컴포넌트 변경, 라우트 전환 UI, dialog/modal/popover/flyout, form, image/icon/SVG/canvas, custom interactive control 변경에 적용합니다.
- backend-only diff, 데이터 모델만 바뀐 diff, UI에 닿지 않는 설정 변경에는 적용하지 않습니다.
- 수동 스크린샷 판독, 주관적 미감 평가, 전체 페이지 WCAG 감사는 요구하지 않습니다.
- `08-styling.md`가 담당하는 Tailwind 우선 원칙, 디자인 토큰, className 정리, 색상 팔레트 취향 문제를 중복 지적하지 않습니다.

## Trigger / 적용 조건

다음 중 하나가 변경 라인에 보일 때만 이 모듈을 적용합니다.

- 클릭, 선택, 제출, 열기, 닫기, 이동 같은 interactive UI 생성 또는 변경
- `onClick`, `onMouse*`, `onPointer*`, keyboard handler, `tabIndex`, `role`, `aria-*` 변경
- modal, dialog, popover, dropdown, tooltip, flyout, drawer, route transition UI 변경
- input, select, textarea, checkbox, radio, validation message, error summary 변경
- icon-only button, image, SVG, canvas, chart, visual status indicator 변경
- animation, transition, reduced-motion 처리, contrast 관련 class/token 변경이 diff에서 직접 보이는 경우

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 키보드 사용, 이름/라벨, focus, form error, semantic control 결함으로 실제 사용 경로가 막힘 |
| 🟡 WARNING | 접근 가능한 대안은 일부 있으나 보조기술, 키보드, 상태 동기화가 불완전함 |
| 🔵 INFO | 접근성 명확성, 유지보수성, 보조기술 힌트를 더 분명히 할 수 있음 |

---

## 15-1. Semantic HTML 우선 🔴

변경 코드가 interactive UI를 만들거나 바꾸는 경우, 클릭 가능한 `div`/`span`이나 임의 요소로 버튼/링크를 흉내 내면 지적합니다.

- 버튼 동작은 기본적으로 `<button>`을 사용합니다.
- 페이지 이동 또는 실제 링크는 `<a href="...">`를 사용합니다.
- `role="button"`, `role="link"`는 native element를 쓸 수 없는 명확한 제약이 있을 때만 허용합니다.
- button과 link의 의미가 바뀐 경우도 지적합니다. 예: navigation을 button으로 처리하거나 mutation action을 link로 처리.

Severity는 키보드 경로까지 막히면 `🔴 ERROR`, native element 대체 가능성이 명확하지만 일부 보완이 있으면 `🟡 WARNING`입니다.

## 15-2. Keyboard 접근성 🔴

마우스로만 가능한 상호작용을 만들면 지적합니다.

- `onClick`은 있는데 keyboard activation 경로가 없는 custom control
- `onMouseEnter`, `onMouseLeave`, drag, hover만으로 열리고 닫히는 필수 UI
- `tabIndex={-1}` 또는 focus 제거로 실제 조작 대상이 keyboard 탐색에서 빠짐
- custom button, option, tab, menu item이 Enter/Space/Arrow 같은 기대 키 입력을 처리하지 않음

native `<button>`, `<a>`, `<input>`처럼 기본 keyboard 동작이 있는 요소는 별도 handler를 요구하지 않습니다. 반대로 non-semantic 요소에 handler를 추가하는 방식은 `15-1`과 함께 봅니다.

## 15-3. Focus management 🔴

modal, dialog, popover, flyout, drawer, route transition처럼 화면의 작업 맥락을 바꾸는 UI에서 focus 진입, 복원, trap이 필요한데 빠지면 지적합니다.

- modal/dialog가 열렸는데 첫 의미 있는 조작 지점 또는 제목으로 focus가 이동하지 않음
- 닫은 뒤 trigger 또는 합리적인 다음 위치로 focus가 복원되지 않음
- modal/dialog 안에서 focus가 배경 페이지로 빠져나가면 안 되는 구조인데 trap이 없음
- route transition, stepper, wizard 변경 후 새 콘텐츠 시작점이나 주요 heading으로 focus 이동 근거가 없음

가벼운 tooltip처럼 keyboard focus를 강제로 옮기면 오히려 해로운 UI는 예외입니다. 변경된 UI가 실제 작업 맥락을 가로채는지 먼저 확인합니다.

## 15-4. Accessible name/label 🔴

사용자가 조작하거나 탐색해야 하는 요소에 accessible name이 없으면 지적합니다.

- icon-only button에 `aria-label`, visible text, `aria-labelledby` 중 하나가 없음
- input, select, textarea, checkbox, radio에 label 연결이 없음
- dialog, modal, landmark, region이 이름 없이 추가되어 목적을 알기 어려움
- placeholder만 label처럼 사용함

눈에 보이는 텍스트가 이미 이름으로 쓰이는 native control은 중복 `aria-label`을 요구하지 않습니다. 다만 시각적으로만 보이고 보조기술 이름으로 연결되지 않는 경우는 지적합니다.

## 15-5. Form error announcement 🔴

validation 또는 error UI를 추가하거나 바꾸면서 control과 error가 연결되지 않거나 announced text가 없으면 지적합니다.

- invalid input과 error text가 `aria-describedby`, `aria-errormessage`, visible label 구조 등으로 연결되지 않음
- field error가 화면에는 보이지만 screen reader가 어떤 control의 오류인지 알 수 없음
- submit 후 error summary, toast, inline error가 status/live region 또는 focus 이동 없이 조용히 추가됨
- `aria-invalid` 상태가 실제 validation 상태와 맞지 않음

모든 form에 live region을 강제하지 않습니다. 변경 코드가 오류를 동적으로 표시하거나 제출 실패 후 사용자가 알아야 하는 상태를 만들 때만 적용합니다.

## 15-6. Image/visual-only content alternatives 🔴

의미 있는 image, icon, SVG, canvas, chart, color-only indicator가 텍스트 대안 없이 추가되면 지적합니다.

- 의미 있는 `<img>`에 적절한 `alt`가 없음
- icon/SVG만으로 상태, action, 결과를 전달하지만 텍스트 대안이 없음
- canvas/chart가 핵심 값을 표시하지만 table, summary, aria text 같은 대안이 없음
- 색상, 위치, 굵기 등 visual-only 방식으로만 success/error/selected 상태를 전달함

장식 이미지는 허용됩니다. 단, `alt=""`, `aria-hidden="true"`, CSS background 처리 등 장식임이 코드에서 명확해야 합니다.

## 15-7. ARIA misuse 🔴

ARIA로 잘못된 semantics를 덧칠하거나 UI 상태와 동기화되지 않으면 지적합니다.

- native element로 해결 가능한데 부정확한 `role`과 `aria-*` 조합으로 대체함
- role에 허용되지 않는 aria attribute를 붙임
- `aria-expanded`, `aria-selected`, `aria-checked`, `aria-current`, `aria-hidden`이 실제 UI 상태와 다름
- interactive 요소 또는 focusable 요소를 `aria-hidden="true"` 영역 안에 둠
- label, description, ownership 관계가 존재하지 않는 id를 참조함

ARIA는 보완 수단입니다. 잘못된 native 구조를 숨기는 패치로 쓰인 경우 `15-1`과 함께 더 단순한 semantic element를 우선 제안합니다.

## 15-8. Motion/contrast only when inferable 🟡

motion과 contrast는 변경 코드에서 직접 추론할 수 있을 때만 지적합니다.

- animation, transition, auto-playing motion, parallax, repeated flashing 효과를 추가하면서 reduced-motion 대안이 없음
- text와 background color 조합, token 선택, disabled/placeholder/error 색상 변경이 diff에 직접 드러나며 contrast 저하가 명확함
- 정보가 색상 대비나 motion 변화로만 전달됨

주관적 화면 판독이나 캡처 기반 추정만으로 지적하지 않습니다. `08-styling.md`의 디자인 토큰, Tailwind 기본 팔레트, className 정리 문제와 중복되면 이 모듈에서는 접근성 영향이 직접 보이는 경우만 남깁니다.

---

## 15-CHECK / 리뷰 방법

1. 변경 라인에 `Trigger / 적용 조건`이 있는지 먼저 확인합니다.
2. native semantic element로 해결 가능한 interactive UI인지 봅니다.
3. keyboard only 사용자가 같은 작업을 완료할 수 있는지 확인합니다.
4. dialog/modal/popover/route transition은 focus entry, restore, trap 필요성을 확인합니다.
5. control, icon-only action, dialog, landmark에 accessible name이 있는지 확인합니다.
6. form error는 control 연결, announced text, 상태 동기화를 확인합니다.
7. image/icon/SVG/canvas/chart가 의미를 전달하면 텍스트 대안을 확인합니다.
8. ARIA는 유효한 role/state 조합이며 실제 UI 상태와 동기화되는지 확인합니다.
9. motion/contrast는 diff에서 직접 추론 가능한 경우만 판단합니다.

## 15-OUTPUT / 출력 형식

리뷰 코멘트는 문제, 현재 선택, 왜 부족한지, 개선 방향이 드러나게 짧게 작성합니다.

| Severity | Rule | 파일 | 핵심 이슈 | 개선 방향 |
|----------|------|------|----------|-----------|
| 🔴/🟡/🔵 | 15-N | path/to/file | 변경 UI의 접근성 결함 | semantic element, keyboard path, focus 처리, label, error 연결 등 구체 수정 |

예시 문장:

- `15-2`: 이 변경은 `div` 클릭으로 메뉴를 열지만 keyboard activation 경로가 없습니다. `<button>`으로 바꾸거나 Enter/Space 처리를 추가해 키보드 사용자가 같은 작업을 할 수 있게 해주세요.
- `15-5`: 새 error message가 input과 연결되지 않아 보조기술이 어떤 필드의 오류인지 알 수 없습니다. error id를 control의 description/error message로 연결하고 invalid 상태를 실제 validation 결과와 맞춰주세요.

## 15-SCOPE / 중복 방지

- backend-only diff, UI와 연결되지 않은 API/schema/model 변경은 이 모듈에서 제외합니다.
- 변경 라인 밖의 오래된 접근성 문제를 발견해도, 이번 diff가 직접 악화시키지 않았으면 지적하지 않습니다.
- mock/test/stub 추가를 리뷰 통과 조건으로 요구하지 않습니다.
- `08-styling.md`의 Tailwind 우선, 디자인 토큰, className 정리, 색상 팔레트 취향 문제는 중복 지적하지 않습니다.
- `04-structure.md`의 JSX 가독성, 컴포넌트 크기, 조건부 렌더링 문제는 접근성 영향이 직접 없으면 이 모듈에서 제외합니다.
- contrast와 motion은 변경 코드에서 색상, token, animation, transition 선택이 직접 보일 때만 다룹니다. 주관적 visual inspection은 요구하지 않습니다.
- WCAG 조항 나열보다 변경 UI에서 실제로 막히는 사용자 경로와 수정 가능한 코드 선택을 우선 설명합니다.

## Summary / 요약

접근성 리뷰는 사용자가 UI를 인식하고, 이동하고, 조작하고, 오류를 이해할 수 있는지 확인하는 diff 한정 점검입니다. semantic HTML, keyboard path, focus management, accessible name, form error 연결, visual alternative, ARIA state 동기화가 핵심이며, motion/contrast는 변경 코드에서 직접 판단 가능한 경우에만 지적합니다.
