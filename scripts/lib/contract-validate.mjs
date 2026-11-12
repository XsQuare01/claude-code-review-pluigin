// 계약 manifest로 구조화된 값을 검사한다.
//
// 왜 공용인가: 판정 payload를 두 도구가 검사한다. `validate-rules.mjs`는 CI에서
// 계약 fixture를, `tally-verdicts.mjs --validate`는 실행 중 검증자가 돌려준 판정을
// 본다. 각자 검사하면 같은 판정을 한쪽은 통과시키고 다른 쪽은 막는다 — 판정 파일을
// 읽는 규칙이 두 스크립트에서 갈렸던 2.14.0의 실패와 같은 모양이다.
//
// 왜 manifest를 인자로 받는가: 검사 규칙의 정본은 `workflow-contract.md`의 manifest
// 블록이다. 이 파일은 파일을 읽지 않는다 — 호출자가 manifest를 꺼내 넘긴다.
// 오류는 `{ code, message }` 목록으로 돌려주고, 처리는 호출자가 정한다.

export function addError(target, code, message) {
  target.push({ code, message })
}

export function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

export function manifestAllowedSet(list) {
  return new Set(Array.isArray(list) ? list : [])
}

export function validatePlainObject(value, errors, code, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, code, `${where} must be an object`)
    return false
  }
  return true
}

export function scanForbiddenSeverity(value, errors, where) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenSeverity(item, errors, `${where}[${index}]`))
    return
  }
  if (hasOwn(value, 'severity')) addError(errors, 'E_FORBIDDEN_SEVERITY', `${where} must not contain severity`)
  for (const [key, nested] of Object.entries(value)) scanForbiddenSeverity(nested, errors, `${where}.${key}`)
}

export function validateRequiredString(object, key, errors, code, where) {
  if (!hasOwn(object, key) || typeof object[key] !== 'string' || object[key].trim() === '') {
    addError(errors, code, `${where}.${key} must be a non-empty string`)
  }
}

export function validateUnknownKeys(object, allowedKeys, errors, code, where, ignoredKeys = new Set()) {
  for (const key of Object.keys(object)) {
    if (ignoredKeys.has(key)) continue
    if (!allowedKeys.has(key)) addError(errors, code, `${where} contains unknown key "${key}"`)
  }
}

const LOCATION_KINDS = ['verified', 'deleted', 'unverified']

/** `REVIEW_RESULT_CONTRACT_V1`의 location variant 하나를 검사한다. */
export function validateLocationAgainst(resultManifest, location, errors, where) {
  if (!validatePlainObject(location, errors, 'E_LOCATION_NOT_OBJECT', where)) return
  if (typeof location.kind !== 'string') {
    addError(errors, 'E_LOCATION_MISSING_KIND', `${where}.kind must be a string`)
    return
  }
  const variants = resultManifest?.location?.variants ?? {}
  const variant = variants[location.kind]
  const allowed = resultManifest && LOCATION_KINDS.includes(location.kind) ? manifestAllowedSet(variant?.allowed) : undefined
  if (!allowed) {
    addError(errors, 'E_LOCATION_INVALID_KIND', `${where}.kind must be one of verified, deleted, unverified`)
    return
  }
  const ignoreSeverity = new Set(['severity'])
  if (location.kind === 'verified') {
    validateUnknownKeys(location, allowed, errors, 'E_LOCATION_UNKNOWN_KEY', where, ignoreSeverity)
    validateRequiredString(location, 'path', errors, 'E_LOCATION_VERIFIED_REQUIRES_PATH', where)
    if (!Number.isInteger(location.line) || location.line < 1) addError(errors, 'E_LOCATION_VERIFIED_REQUIRES_LINE', `${where}.line must be a positive integer`)
    if (hasOwn(location, 'endLine') && (!Number.isInteger(location.endLine) || location.endLine < 1 || location.endLine < location.line)) addError(errors, 'E_LOCATION_VERIFIED_INVALID_END_LINE', `${where}.endLine must be a positive integer >= line`)
    validateRequiredString(location, 'quote', errors, 'E_LOCATION_VERIFIED_REQUIRES_QUOTE', where)
    return
  }
  if (location.kind === 'deleted') {
    validateUnknownKeys(location, allowed, errors, 'E_LOCATION_UNKNOWN_KEY', where, ignoreSeverity)
    validateRequiredString(location, 'path', errors, 'E_LOCATION_DELETED_REQUIRES_PATH', where)
    if (!Number.isInteger(location.lineBefore) || location.lineBefore < 1) addError(errors, 'E_LOCATION_DELETED_REQUIRES_LINE_BEFORE', `${where}.lineBefore must be a positive integer`)
    if (hasOwn(location, 'endLine') && (!Number.isInteger(location.endLine) || location.endLine < 1 || location.endLine < location.lineBefore)) addError(errors, 'E_LOCATION_DELETED_INVALID_END_LINE', `${where}.endLine must be a positive integer >= lineBefore`)
    validateRequiredString(location, 'quote', errors, 'E_LOCATION_DELETED_REQUIRES_QUOTE', where)
    return
  }
  const forbiddenAwareAllowed = new Set([...allowed, ...(variant?.forbidden ?? [])])
  validateUnknownKeys(location, forbiddenAwareAllowed, errors, 'E_LOCATION_UNKNOWN_KEY', where, ignoreSeverity)
  validateRequiredString(location, 'reason', errors, 'E_LOCATION_UNVERIFIED_REQUIRES_REASON', where)
  for (const forbiddenKey of variant?.forbidden ?? []) {
    if (hasOwn(location, forbiddenKey)) {
      if (forbiddenKey === 'path') addError(errors, 'E_LOCATION_UNVERIFIED_FORBIDS_PATH', `${where}.path is forbidden when kind is unverified`)
      else if (forbiddenKey === 'line' || forbiddenKey === 'lineBefore') addError(errors, 'E_LOCATION_UNVERIFIED_FORBIDS_LINE', `${where}.line and .lineBefore are forbidden when kind is unverified`)
      else if (forbiddenKey === 'quote') addError(errors, 'E_LOCATION_UNVERIFIED_FORBIDS_QUOTE', `${where}.quote is forbidden when kind is unverified`)
    }
  }
}

function validateRebuttal(rebuttal, verdictManifest, resultManifest, errors, where) {
  if (!validatePlainObject(rebuttal, errors, 'E_REBUTTAL_NOT_OBJECT', where)) return
  const spec = verdictManifest.rebuttal ?? {}
  validateUnknownKeys(rebuttal, manifestAllowedSet(spec.allowed), errors, 'E_REBUTTAL_UNKNOWN_KEY', where, new Set(['severity']))
  const kindEnum = spec.kindEnum ?? []
  if (typeof rebuttal.kind !== 'string' || !kindEnum.includes(rebuttal.kind)) {
    addError(errors, 'E_REBUTTAL_UNKNOWN_KIND', `${where}.kind must be one of ${kindEnum.join(', ')}`)
    return
  }
  const requiredByKind = spec.kindRequires?.[rebuttal.kind]
  if (requiredByKind === 'note') validateRequiredString(rebuttal, 'note', errors, 'E_REBUTTAL_OTHER_REQUIRES_NOTE', where)
  const locationOptional = (spec.locationOptionalKinds ?? []).includes(rebuttal.kind)
  if (!hasOwn(rebuttal, 'location')) {
    if (!locationOptional) addError(errors, 'E_REBUTTAL_REQUIRES_LOCATION', `${where}.location is required unless kind is ${(spec.locationOptionalKinds ?? []).join(', ')}`)
    return
  }
  const allowedVariants = spec.locationVariants ?? []
  if (rebuttal.location && typeof rebuttal.location === 'object' && typeof rebuttal.location.kind === 'string' && !allowedVariants.includes(rebuttal.location.kind)) {
    addError(errors, 'E_REBUTTAL_LOCATION_FORBIDS_UNVERIFIED', `${where}.location.kind must be one of ${allowedVariants.join(', ')} — an unverified rebuttal cannot delete a finding`)
    return
  }
  validateLocationAgainst(resultManifest, rebuttal.location, errors, `${where}.location`)
}

function validateVerdictItem(item, verdictManifest, resultManifest, errors, where) {
  if (!validatePlainObject(item, errors, 'E_VERDICT_ITEM_NOT_OBJECT', where)) return
  const spec = verdictManifest.verdictsItem ?? {}
  validateUnknownKeys(item, manifestAllowedSet(spec.allowed), errors, 'E_VERDICT_ITEM_UNKNOWN_KEY', where, new Set(['severity']))
  validateRequiredString(item, 'candidateId', errors, 'E_VERDICT_ITEM_REQUIRES_CANDIDATE_ID', where)
  validateRequiredString(item, 'evidence', errors, 'E_VERDICT_ITEM_REQUIRES_EVIDENCE', where)

  const dispositionEnum = verdictManifest.disposition?.enum ?? []
  if (typeof item.disposition !== 'string' || !dispositionEnum.includes(item.disposition)) {
    addError(errors, 'E_VERDICT_UNKNOWN_DISPOSITION', `${where}.disposition must be one of ${dispositionEnum.join(', ')}`)
  } else {
    const requiredField = verdictManifest.disposition?.requires?.[item.disposition]
    if (requiredField === 'rebuttal' && !hasOwn(item, 'rebuttal')) {
      addError(errors, 'E_VERDICT_REJECTED_REQUIRES_REBUTTAL', `${where}.rebuttal is required when disposition is rejected`)
    }
    if (requiredField === 'reason') validateRequiredString(item, 'reason', errors, 'E_VERDICT_NEEDS_CONTEXT_REQUIRES_REASON', where)
  }

  if (hasOwn(item, 'rebuttal')) validateRebuttal(item.rebuttal, verdictManifest, resultManifest, errors, `${where}.rebuttal`)
  if (hasOwn(item, 'usedCrossFileContext') && typeof item.usedCrossFileContext !== 'boolean') {
    addError(errors, 'E_VERDICT_USED_CROSS_FILE_CONTEXT_INVALID', `${where}.usedCrossFileContext must be a boolean`)
  }
  const axisEnum = verdictManifest.observedAxes?.enum ?? []
  if (hasOwn(item, 'observedImpact') && !axisEnum.includes(item.observedImpact)) {
    addError(errors, 'E_VERDICT_OBSERVED_IMPACT_INVALID', `${where}.observedImpact must be one of ${axisEnum.join(', ')}`)
  }
  if (hasOwn(item, 'observedConfidence') && !axisEnum.includes(item.observedConfidence)) {
    addError(errors, 'E_VERDICT_OBSERVED_CONFIDENCE_INVALID', `${where}.observedConfidence must be one of ${axisEnum.join(', ')}`)
  }
  if (hasOwn(item, 'location')) validateLocationAgainst(resultManifest, item.location, errors, `${where}.location`)
  else addError(errors, 'E_VERDICT_ITEM_REQUIRES_LOCATION', `${where}.location is required`)
}

/** `REVIEW_VERDICT_CONTRACT_V1` payload 하나를 검사한다. 오류가 없으면 빈 배열이다. */
export function validateVerdictPayload(value, verdictManifest, resultManifest) {
  const errors = []
  if (!validatePlainObject(value, errors, 'E_VERDICT_NOT_OBJECT', 'result')) return errors
  scanForbiddenSeverity(value, errors, 'result')
  validateUnknownKeys(value, manifestAllowedSet(verdictManifest.topLevel?.allowed), errors, 'E_VERDICT_TOP_LEVEL_UNKNOWN_KEY', 'result', new Set(['severity']))
  if (value.schemaVersion !== verdictManifest.schemaVersion) {
    addError(errors, 'E_VERDICT_SCHEMA_VERSION_INVALID', `result.schemaVersion must be ${verdictManifest.schemaVersion}`)
  }
  if (!Array.isArray(value.verdicts)) {
    addError(errors, 'E_VERDICT_TOP_LEVEL_REQUIRES_VERDICTS', 'result.verdicts must always be an array')
    return errors
  }
  value.verdicts.forEach((item, index) => validateVerdictItem(item, verdictManifest, resultManifest, errors, `result.verdicts[${index}]`))
  return errors
}

/**
 * `REVIEW_RESULT_CONTRACT_V1` manifest에서 결과 검사에 쓰는 허용 목록을 뽑는다.
 * manifest가 없으면 `null`이다 — 그때 검사는 모든 키를 모르는 키로 본다.
 */
export function resultSchemaOf(manifest) {
  if (!manifest) return null
  return {
    manifest,
    topLevelAllowed: manifestAllowedSet(manifest.topLevel?.allowed),
    findingAllowed: manifestAllowedSet(manifest.findingsItem?.allowed),
    openQuestionAllowed: manifestAllowedSet(manifest.openQuestionsItem?.allowed),
    locationAllowed: {
      verified: manifestAllowedSet(manifest.location?.variants?.verified?.allowed),
      deleted: manifestAllowedSet(manifest.location?.variants?.deleted?.allowed),
      unverified: manifestAllowedSet(manifest.location?.variants?.unverified?.allowed),
    },
    categoryIds: Array.isArray(manifest.impact?.categoryEnum) ? manifest.impact.categoryEnum : [],
    categoryLabels: manifest.impact?.categoryLabels ?? {},
  }
}

function validateFinding(item, schema, errors, where) {
  if (!validatePlainObject(item, errors, 'E_FINDING_NOT_OBJECT', where)) return
  validateUnknownKeys(item, schema?.findingAllowed ?? new Set(), errors, 'E_FINDING_UNKNOWN_KEY', where)
  for (const key of ['ruleId', 'title', 'body']) validateRequiredString(item, key, errors, `E_FINDING_REQUIRES_${key.toUpperCase()}`, where)
  if (!['high', 'low'].includes(item.impact)) addError(errors, 'E_FINDING_INVALID_IMPACT', `${where}.impact must be high or low`)
  if (!['high', 'low'].includes(item.confidence)) addError(errors, 'E_FINDING_INVALID_CONFIDENCE', `${where}.confidence must be high or low`)
  validateLocationAgainst(schema?.manifest ?? null, item.location, errors, `${where}.location`)
  if (item.impact === 'high') {
    if (!hasOwn(item, 'category')) addError(errors, 'E_FINDING_HIGH_REQUIRES_CATEGORY', `${where}.category is required when impact is high`)
    else if (!(schema?.categoryIds ?? []).includes(item.category)) addError(errors, 'E_FINDING_INVALID_CATEGORY', `${where}.category must be one of the five approved IDs`)
    if (!hasOwn(item, 'evidence') || typeof item.evidence !== 'string' || item.evidence.trim() === '') {
      addError(errors, 'E_FINDING_HIGH_REQUIRES_EVIDENCE', `${where}.evidence is required when impact is high`)
    }
  }
  if (item.impact === 'low' && hasOwn(item, 'category')) addError(errors, 'E_FINDING_LOW_FORBIDS_CATEGORY', `${where}.category is forbidden when impact is low`)
  if (item.confidence === 'low' && (!hasOwn(item, 'reason') || typeof item.reason !== 'string' || item.reason.trim() === '')) {
    addError(errors, 'E_FINDING_LOW_CONFIDENCE_REQUIRES_REASON', `${where}.reason is required when confidence is low`)
  }
}

function validateOpenQuestion(item, schema, errors, where) {
  if (!validatePlainObject(item, errors, 'E_OPEN_QUESTION_NOT_OBJECT', where)) return
  validateUnknownKeys(item, schema?.openQuestionAllowed ?? new Set(), errors, 'E_OPEN_QUESTION_UNKNOWN_KEY', where)
  for (const key of ['title', 'body', 'reason']) validateRequiredString(item, key, errors, `E_OPEN_QUESTION_REQUIRES_${key.toUpperCase()}`, where)
  validateLocationAgainst(schema?.manifest ?? null, item.location, errors, `${where}.location`)
}

/**
 * producer 결과 payload 하나를 `REVIEW_RESULT_CONTRACT_V1`(C-6A)로 검사한다. 오류가 없으면 빈 배열이다.
 *
 * `validate-rules.mjs`는 계약 fixture를, 작업 대장(`review-tasks.mjs done`)은 실행 중 받은 모듈 결과를
 * 이것으로 본다. 대장이 검사하지 않던 때는 오케스트레이터가 계약 위반을 찾아 실패를 손으로 남겼고, 그
 * 경로에는 교정 프롬프트가 만들어지지 않았다(PR #112 리뷰).
 */
export function validateResultPayload(value, manifest) {
  const schema = resultSchemaOf(manifest)
  const errors = []
  if (!validatePlainObject(value, errors, 'E_TOPLEVEL_NOT_OBJECT', 'result')) return errors
  scanForbiddenSeverity(value, errors, 'result')
  validateUnknownKeys(value, schema?.topLevelAllowed ?? new Set(), errors, 'E_TOPLEVEL_UNKNOWN_KEY', 'result')
  if (!hasOwn(value, 'schemaVersion')) addError(errors, 'E_TOPLEVEL_MISSING_SCHEMA_VERSION', 'result.schemaVersion is required')
  else if (value.schemaVersion !== 1) addError(errors, 'E_TOPLEVEL_INVALID_SCHEMA_VERSION', 'result.schemaVersion must be 1')
  if (!hasOwn(value, 'findings')) addError(errors, 'E_TOPLEVEL_MISSING_FINDINGS', 'result.findings is required')
  else if (!Array.isArray(value.findings)) addError(errors, 'E_TOPLEVEL_FINDINGS_NOT_ARRAY', 'result.findings must be an array')
  if (!hasOwn(value, 'openQuestions')) addError(errors, 'E_TOPLEVEL_MISSING_OPEN_QUESTIONS', 'result.openQuestions is required')
  else if (!Array.isArray(value.openQuestions)) addError(errors, 'E_TOPLEVEL_OPEN_QUESTIONS_NOT_ARRAY', 'result.openQuestions must be an array')
  if (Array.isArray(value.findings)) value.findings.forEach((item, index) => validateFinding(item, schema, errors, `result.findings[${index}]`))
  if (Array.isArray(value.openQuestions)) value.openQuestions.forEach((item, index) => validateOpenQuestion(item, schema, errors, `result.openQuestions[${index}]`))
  return errors
}
