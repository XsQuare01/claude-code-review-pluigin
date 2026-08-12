# 위험 변경 점검

이 모듈은 **틀렸을 때 되돌리기 어렵거나 피해가 큰 변경**을 본다. 코드 품질이 아니라 운영 위험이 기준이다.

`16-api-contract.md`와 `17-concurrency.md`가 severity 상향 근거로 이 모듈을 참조한다.

## Trigger / 적용 조건

변경 라인이 다음 중 하나에 닿을 때만 적용한다.

- 인증·인가·권한·세션·토큰 처리
- 결제, 주문, 정산, 크레딧/쿼터 소비
- 저장, 삭제, 덮어쓰기, 마이그레이션, 스키마 변경
- 파일 쓰기, OS API, Electron main 프로세스의 시스템 접근
- 배포 산출물 동작을 바꾸는 config/env/feature flag 기본값
- 개인정보·민감정보의 저장·전송·로깅 경로

읽기 전용 조회, 표시 전용 UI, 순수 계산에는 적용하지 않는다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 데이터 손실, 권한 우회, 잘못된 과금, 롤백 불가, 배포 즉시 장애 가능 |
| 🟡 WARNING | 위험 흐름을 건드렸는데 안전 증거(검증·가드·복구 경로)가 부족함 |
| 🔵 INFO | 위험도는 낮으나 의도·복구 절차를 남기면 좋은 변경 |

---

## 18-1. 권한·인증 경계 🔴

- 클라이언트 gating만 바꾸고 서버 또는 Electron main 쪽 권한 검사가 그대로임
- 역할·스코프·테넌트 판정 로직이 바뀌었는데 거부 경로(`401`/`403`) 처리가 함께 바뀌지 않음
- 토큰·세션·쿠키 저장 위치나 만료 처리가 바뀌었는데 갱신·로그아웃 흐름이 정합하지 않음
- 권한 검사를 우회할 수 있는 새 진입점(딥링크, IPC 채널, 공개 export)이 추가됨

UI에서 버튼을 숨기는 것은 권한 통제가 아니다. **실제 판정 위치가 어디인지**를 확인한다.

## 18-2. 파괴적 데이터 변경 🔴

- 삭제·덮어쓰기·초기화가 확인 절차, 되돌리기, 소프트 삭제 없이 추가됨
- 부분 실패 시 일부만 적용되고 복구 경로가 없음
- 마이그레이션에 forward/backward 호환성, 롤백, 재실행 안전성 증거가 없음
- 로컬 저장소(localStorage, IndexedDB, 파일) 스키마가 바뀌었는데 기존 값 처리 경로가 없음

## 18-3. 결제·과금 흐름 🔴

- 금액·수량·통화·할인 계산 변경에 검증이나 서버 재확인이 없음
- 재시도·중복 실행 방어가 없음 → `17-concurrency.md`의 멱등성 증거를 함께 요구한다
- 실패 처리가 사용자에게 성공처럼 보이거나, 성공이 실패로 보임 → `exception.md`와 함께 본다

## 18-4. 민감정보 노출 🔴

- 토큰, 비밀번호, 개인정보가 로그·에러 메시지·URL·분석 이벤트에 포함됨
- 서버 전용 값이 클라이언트 번들에 들어가는 env 키로 옮겨짐
- 에러 응답 원문이 그대로 UI에 노출됨

## 18-5. 배포 동작을 바꾸는 설정 🟡

- feature flag 기본값 변경으로 같은 배포 산출물이 다르게 동작함
- env/config 키 rename에 old key fallback이나 마이그레이션 안내가 없음
- 빌드 타깃, 런타임 버전, 번들 설정 변경의 영향 범위가 diff에서 드러나지 않음

## 18-6. 안전 증거 요구 🟡

위험 흐름 변경에는 다음 중 하나 이상이 diff 또는 직접 연결된 인접 구조에 보여야 한다.

- 입력·응답 스키마 검증
- 권한 재확인 위치
- 확인 절차, 되돌리기, 소프트 삭제
- 멱등성 키, 트랜잭션, 버전 가드
- 단계적 롤아웃, feature flag, 롤백 절차
- 실패 시 복구 경로와 사용자 안내

테스트 부재만으로 자동 위반을 만들지 않는다. 다만 위 증거가 **하나도** 없으면 지적한다.

---

## 18-OUTPUT. 출력 형식

<!-- REVIEW_RESULT_CONTRACT_V1_PRODUCER_OUTPUT -->

이 문서를 producer prompt에 쓸 때는 **`REVIEW_RESULT_CONTRACT_V1`** 을 따른다. 응답은 Markdown 표나 헤딩이 아니라 **raw JSON 객체 하나만** 반환한다.

- top-level에는 `schemaVersion`, `findings`, `openQuestions`를 항상 포함하고 `schemaVersion`은 `1`이어야 한다.
- `severity`는 producer가 내지 않는다. 이 모듈은 `impact`와 `confidence`만 판정한다.
- 위험 시나리오, 현재 방어, 추가로 필요한 증거와 복구/롤백 방향은 새 schema field를 만들지 말고 `body`, `recommendation`, `evidence`에 담는다.
- `00-rule.md` 00-11에 걸리는 unresolved absence/possibility claim, search scope 미완료, 추가 탐색 요청만 `openQuestions`로 보낸다.
- 결함은 성립하지만 exact location만 확인하지 못했으면 finding을 유지하고 `location.kind="unverified"`와 `reason`만 사용한다.
- producer 문자열 필드는 최종 리포트의 신뢰된 Markdown이 아니다. heading/table/raw HTML/link를 직접 만들려고 하지 말고 plain prose만 넣는다.

## 18-SCOPE. 중복 방지

- contract의 shape/semantics 호환성 자체는 `16-api-contract.md`가 우선한다. 이 모듈은 그 변경이 권한·데이터·과금 위험으로 이어질 때만 severity를 올린다.
- 중복 실행·순서 역전·lost update의 구체적 방어책은 `17-concurrency.md`가 우선한다.
- 실패 전파·fallback·사용자 안내 자체는 `exception.md`가 우선한다.
- 단순 삭제 회귀는 `20-deletion-regression.md`가 우선한다.
- 리뷰 통과만을 위한 mock/test 추가를 요구하지 않는다 (`00-rule.md`).
