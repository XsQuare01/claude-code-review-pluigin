import { execFileSync } from 'node:child_process'

// 리뷰 범위에서 지적 대상으로 삼지 않는 파일(C-5). 이름 규칙으로 가를 수 있는 것은 스크립트가 센다.
//
// 오케스트레이터가 세던 때 2026-10-12 실행은 테스트·mock 파일 249개를 빼고도 `scope.done`에 `excluded: 0`을
// 적었다. 세는 일이 기억에 맡겨지면 기록과 실제 범위가 어긋난다 — preflight가 세어 남긴다.
//
// 빼는 것은 **지적 대상**이지 증거가 아니다(00-3). 테스트 변경은 diff에 남고 producer가 근거로 읽는다.
// 이름으로 드러나지 않는 fixture를 더 뺐으면 그 목록을 리포트에 적는다 — 스크립트는 그 판단을 하지 않는다.
//
// React 규칙이 다루지 않는 언어의 파일(`outside`)도 여기서 가른다. 2026-10-28 점검에서 michelo.studio(프론트·백엔드
// 모노레포)의 한 범위를 넣었더니 리뷰 대상 285개 중 `.py`가 94개였다 — React 규칙 프롬프트에 그대로 들어가 오탐이
// 되거나, "지적 없음"이 백엔드를 검토한 것처럼 읽힌다. 빼되 조용히 빼지 않는다: 리포트에 `검토 안 함`으로 남는다.

const EXCLUDED_DIRECTORIES = new Set(['__test__', '__tests__', '__mocks__', 'mock', 'mocks', 'mockData'])
const EXCLUDED_FILE = /\.(?:test|spec|mock)\.[^/]+$/

// 다른 언어 앱의 매니페스트와, 같은 언어들의 소스 확장자. 이 폴더(저장소 루트는 빼고) 아래 파일과 어디에 있든 이
// 확장자의 파일은 React 규칙이 다루지 않는다. 루트의 매니페스트는 저장소 도구의 것일 수 있어 앱 경계로 쓰지 않는다 —
// michelo.studio의 루트 `pyproject.toml`은 개발 실행기이고, 그것을 앱으로 보면 `.github/`·`docs/`까지 빠진다.
const OTHER_LANGUAGE_MANIFESTS = new Set([
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile',
  'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json',
])
const OTHER_LANGUAGE_SOURCE = /\.(?:py|pyi|go|rs|java|kt|rb|php)$/
const SCOPE_MANIFESTS = new Set(['package.json', ...OTHER_LANGUAGE_MANIFESTS])

/** C-5의 이름 규칙에 걸리는 경로인가. 경로는 저장소 기준이고 구분자는 `/`다. */
export function isExcludedPath(path) {
  const segments = String(path).split('/')
  const name = segments.pop()
  return segments.some(segment => EXCLUDED_DIRECTORIES.has(segment)) || EXCLUDED_FILE.test(name)
}

/** 리뷰하는 트리의 매니페스트 경로(저장소 기준). 하위 폴더에서 불러도 저장소 기준 경로를 낸다. */
export function manifestsAt(repo, ref = 'HEAD') {
  const out = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', '--name-only', ref], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter(path => path && SCOPE_MANIFESTS.has(path.split('/').pop()))
}

/**
 * 변경 파일을 리뷰할 것(`files`)·테스트와 mock(`excluded`)·React 규칙이 다루지 않는 언어(`outside`)로 나눈다.
 * 순서는 받은 순서다. `manifests`는 `manifestsAt`의 결과다 — 주지 않으면 확장자로만 `outside`를 가른다.
 *
 * - `otherApps`: `outside` 중 다른 언어 앱 아래 파일을 앱마다 센 것 `{ root, manifest, files }`
 * - `packageRoots`: 리뷰할 파일이 속한 package.json 폴더마다 센 것 `{ root, files }` — 프로필은 이 폴더에서
 *   판정한다(C-3). 루트는 `.`이다
 */
export function scopeOf(changed, { manifests = [] } = {}) {
  const folders = new Map()
  for (const path of manifests) {
    const segments = path.split('/')
    const name = segments.pop()
    const folder = segments.join('/') || '.'
    const entry = folders.get(folder) ?? {}
    if (name === 'package.json') entry.js = true
    else if (folder !== '.' && entry.other === undefined) entry.other = name
    folders.set(folder, entry)
  }
  // 파일에서 가장 가까운 매니페스트. 한 폴더에 둘 다 있으면 JS다
  const nearest = path => {
    const segments = path.split('/')
    segments.pop()
    for (;;) {
      const folder = segments.join('/') || '.'
      const entry = folders.get(folder)
      if (entry?.js) return { kind: 'js', root: folder }
      if (entry?.other) return { kind: 'other', root: folder, manifest: entry.other }
      if (!segments.length) return null
      segments.pop()
    }
  }

  const files = []
  const excluded = []
  const outside = []
  const otherApps = new Map()
  const packageRoots = new Map()
  for (const path of changed) {
    const owner = nearest(path)
    if (owner?.kind === 'other') {
      outside.push(path)
      const app = otherApps.get(owner.root) ?? { root: owner.root, manifest: owner.manifest, files: 0 }
      app.files += 1
      otherApps.set(owner.root, app)
    } else if (OTHER_LANGUAGE_SOURCE.test(path)) {
      outside.push(path)
    } else if (isExcludedPath(path)) {
      excluded.push(path)
    } else {
      files.push(path)
      if (owner) packageRoots.set(owner.root, (packageRoots.get(owner.root) ?? 0) + 1)
    }
  }
  return {
    files,
    excluded,
    outside,
    otherApps: [...otherApps.values()],
    packageRoots: [...packageRoots].map(([root, count]) => ({ root, files: count })),
  }
}

/**
 * `검토 안 함`의 내역 — 다른 언어 앱마다, 그리고 앱 밖의 다른 언어 소스. `outside`는 수다(스냅숏은 목록을 싣지 않는다).
 * `code`는 경로를 감쌀 표기다 — 리포트 블록은 코드 표기로, 셸 출력은 그대로 쓴다.
 */
export function outsideSummary({ outside, otherApps }, code = text => text) {
  const inApps = otherApps.reduce((sum, app) => sum + app.files, 0)
  return [
    ...otherApps.map(app => `${code(app.root)}(${code(app.manifest)}) ${app.files}개`),
    ...(outside > inApps ? [`그 밖의 소스 ${outside - inApps}개`] : []),
  ].join(' · ')
}

/** 리포트의 `실행 계획`에 옮길 범위 한 줄. */
export function scopeLine(scope) {
  const counts = `리뷰 대상 ${scope.files.length}개 · 테스트·mock 제외 ${scope.excluded.length}개`
  if (!scope.outside.length) return counts
  return `${counts} · 검토 안 함 ${scope.outside.length}개 — React 규칙이 다루지 않는 언어: ${outsideSummary({ outside: scope.outside.length, otherApps: scope.otherApps })}`
}
