// 실행 이름(`--run`)의 검사는 여기 하나다.
//
// 세 스크립트(`review-preflight.mjs`·`review-timeline.mjs`·`lib/run-record.mjs`)가 각자
// 정규식을 들고 있었고, 그중 하나만 역슬래시를 막지 않았다(PR #86 리뷰). 같은 검사를
// 복사해 두면 한쪽만 고쳐진다.

/**
 * `--run`이 리포트 basename이 아니면 그 이유를, 맞으면 `null`을 돌려준다.
 *
 * - 경로 구분자(`/`, `\`)가 있으면 기록이 `.timing` 밖에 생긴다
 * - `.md`로 끝나면 리포트 **파일 이름**을 준 것이다. 2026-09-30의 한 실행이 그렇게 해서
 *   기록이 전부 `….md.jsonl`·`….md.routed.json`으로 남았고, 리포트만 가진 사람은 그
 *   기록을 찾지 못했다. `--check`가 끝에서 이름이 다르다고 짚지만 그때는 바꿀 수 없으므로
 *   처음에 거부한다
 *
 * `.md` 검사는 **기록을 남기는 쪽**에만 건다(`{ writing: false }`면 건너뛴다). 이미 그 이름으로
 * 남은 기록도 `--check`·`--summary`로 읽을 수 있어야 하기 때문이다.
 */
export function runNameProblem(run, { writing = true } = {}) {
  if (/[\\/]/.test(run)) return `--run must be a bare basename, got ${JSON.stringify(run)}`
  if (writing && /\.md$/i.test(run)) {
    return `--run은 리포트 파일 이름이 아니라 basename이다: ${JSON.stringify(run)} → ${JSON.stringify(run.replace(/\.md$/i, ''))}`
  }
  return null
}
