export function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

export function extractMarkedBlock(text, label) {
  const begin = `<!-- ${label}:BEGIN -->`
  const end = `<!-- ${label}:END -->`
  const beginCount = text.split(begin).length - 1
  const endCount = text.split(end).length - 1
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error(`E_MANIFEST_BLOCK_COUNT: ${label} block must appear exactly once (found BEGIN=${beginCount}, END=${endCount})`)
  }
  const start = text.indexOf(begin)
  const finish = text.indexOf(end)
  if (finish <= start) throw new Error(`E_MANIFEST_BLOCK_ORDER: ${label} block end appears before begin`)
  return text.slice(start + begin.length, finish).trim()
}

export function parseJsonCodeBlock(block, label = 'JSON_BLOCK') {
  const match = block.match(/^```json\s*([\s\S]*?)\s*```$/)
  if (!match) throw new Error(`E_MANIFEST_JSON_FENCE: ${label} block must contain exactly one json fenced block`)
  try {
    return JSON.parse(match[1])
  } catch (error) {
    throw new Error(`E_MANIFEST_JSON: ${label} block contains invalid JSON: ${error.message}`)
  }
}

function manifestAllowedSet(list) {
  return new Set(Array.isArray(list) ? list : [])
}

export function deriveManifestSchema(manifest) {
  const categoryIds = Array.isArray(manifest?.impact?.categoryEnum) ? manifest.impact.categoryEnum : []
  const categoryLabels = manifest?.impact?.categoryLabels ?? {}
  return {
    manifest,
    topLevelAllowed: manifestAllowedSet(manifest?.topLevel?.allowed),
    findingAllowed: manifestAllowedSet(manifest?.findingsItem?.allowed),
    openQuestionAllowed: manifestAllowedSet(manifest?.openQuestionsItem?.allowed),
    locationAllowed: {
      verified: manifestAllowedSet(manifest?.location?.variants?.verified?.allowed),
      deleted: manifestAllowedSet(manifest?.location?.variants?.deleted?.allowed),
      unverified: manifestAllowedSet(manifest?.location?.variants?.unverified?.allowed),
    },
    categoryIds,
    categoryLabels,
  }
}

function addError(target, code, message) {
  target.push({ code, message })
}

function validatePlainObject(value, errors, code, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, code, `${where} must be an object`)
    return false
  }
  return true
}

function scanForbiddenSeverity(value, errors, where) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenSeverity(item, errors, `${where}[${index}]`))
    return
  }
  if (hasOwn(value, 'severity')) addError(errors, 'E_FORBIDDEN_SEVERITY', `${where} must not contain severity`)
  for (const [key, nested] of Object.entries(value)) scanForbiddenSeverity(nested, errors, `${where}.${key}`)
}

const FORBIDDEN_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/

function scanForbiddenControlCharacters(value, errors, where) {
  if (typeof value === 'string') {
    if (FORBIDDEN_CONTROL_CHARACTER.test(value)) {
      addError(errors, 'E_FORBIDDEN_CONTROL_CHARACTER', `${where} must not contain invisible control or bidirectional formatting characters`)
    }
    return
  }
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenControlCharacters(item, errors, `${where}[${index}]`))
    return
  }
  for (const [key, nested] of Object.entries(value)) scanForbiddenControlCharacters(nested, errors, `${where}.${key}`)
}

function validateRequiredString(object, key, errors, code, where) {
  if (!hasOwn(object, key) || typeof object[key] !== 'string' || object[key].trim() === '') {
    addError(errors, code, `${where}.${key} must be a non-empty string`)
  }
}

function validateUnknownKeys(object, allowedKeys, errors, code, where, ignoredKeys = new Set()) {
  for (const key of Object.keys(object)) {
    if (ignoredKeys.has(key)) continue
    if (!allowedKeys.has(key)) addError(errors, code, `${where} contains unknown key "${key}"`)
  }
}

function validateLocation(location, errors, where, schema) {
  if (!validatePlainObject(location, errors, 'E_LOCATION_NOT_OBJECT', where)) return
  if (typeof location.kind !== 'string') {
    addError(errors, 'E_LOCATION_MISSING_KIND', `${where}.kind must be a string`)
    return
  }
  const variants = schema?.manifest?.location?.variants ?? {}
  const variant = variants[location.kind]
  const allowed = schema?.locationAllowed?.[location.kind]
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
    if (!hasOwn(location, forbiddenKey)) continue
    if (forbiddenKey === 'path') addError(errors, 'E_LOCATION_UNVERIFIED_FORBIDS_PATH', `${where}.path is forbidden when kind is unverified`)
    else if (forbiddenKey === 'line' || forbiddenKey === 'lineBefore') addError(errors, 'E_LOCATION_UNVERIFIED_FORBIDS_LINE', `${where}.line and .lineBefore are forbidden when kind is unverified`)
    else if (forbiddenKey === 'quote') addError(errors, 'E_LOCATION_UNVERIFIED_FORBIDS_QUOTE', `${where}.quote is forbidden when kind is unverified`)
  }
}

function validateFinding(item, errors, where, schema) {
  if (!validatePlainObject(item, errors, 'E_FINDING_NOT_OBJECT', where)) return
  validateUnknownKeys(item, schema?.findingAllowed ?? new Set(), errors, 'E_FINDING_UNKNOWN_KEY', where)
  for (const key of ['ruleId', 'title', 'body']) validateRequiredString(item, key, errors, `E_FINDING_REQUIRES_${key.toUpperCase()}`, where)
  if (!['high', 'low'].includes(item.impact)) addError(errors, 'E_FINDING_INVALID_IMPACT', `${where}.impact must be high or low`)
  if (!['high', 'low'].includes(item.confidence)) addError(errors, 'E_FINDING_INVALID_CONFIDENCE', `${where}.confidence must be high or low`)
  validateLocation(item.location, errors, `${where}.location`, schema)
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

function validateOpenQuestion(item, errors, where, schema) {
  if (!validatePlainObject(item, errors, 'E_OPEN_QUESTION_NOT_OBJECT', where)) return
  validateUnknownKeys(item, schema?.openQuestionAllowed ?? new Set(), errors, 'E_OPEN_QUESTION_UNKNOWN_KEY', where)
  for (const key of ['title', 'body', 'reason']) validateRequiredString(item, key, errors, `E_OPEN_QUESTION_REQUIRES_${key.toUpperCase()}`, where)
  validateLocation(item.location, errors, `${where}.location`, schema)
}

export function validateReviewResultContract(value, manifest) {
  const schema = deriveManifestSchema(manifest)
  const errors = []
  if (!validatePlainObject(value, errors, 'E_TOPLEVEL_NOT_OBJECT', 'result')) return errors
  scanForbiddenSeverity(value, errors, 'result')
  scanForbiddenControlCharacters(value, errors, 'result')
  validateUnknownKeys(value, schema?.topLevelAllowed ?? new Set(), errors, 'E_TOPLEVEL_UNKNOWN_KEY', 'result')
  if (!hasOwn(value, 'schemaVersion')) addError(errors, 'E_TOPLEVEL_MISSING_SCHEMA_VERSION', 'result.schemaVersion is required')
  else if (value.schemaVersion !== 1) addError(errors, 'E_TOPLEVEL_INVALID_SCHEMA_VERSION', 'result.schemaVersion must be 1')
  if (!hasOwn(value, 'findings')) addError(errors, 'E_TOPLEVEL_MISSING_FINDINGS', 'result.findings is required')
  else if (!Array.isArray(value.findings)) addError(errors, 'E_TOPLEVEL_FINDINGS_NOT_ARRAY', 'result.findings must be an array')
  if (!hasOwn(value, 'openQuestions')) addError(errors, 'E_TOPLEVEL_MISSING_OPEN_QUESTIONS', 'result.openQuestions is required')
  else if (!Array.isArray(value.openQuestions)) addError(errors, 'E_TOPLEVEL_OPEN_QUESTIONS_NOT_ARRAY', 'result.openQuestions must be an array')
  if (Array.isArray(value.findings)) value.findings.forEach((item, index) => validateFinding(item, errors, `result.findings[${index}]`, schema))
  if (Array.isArray(value.openQuestions)) value.openQuestions.forEach((item, index) => validateOpenQuestion(item, errors, `result.openQuestions[${index}]`, schema))
  return errors
}

export function parseStructuredProducerResponse(raw, manifest) {
  if (typeof raw !== 'string') throw new Error('E_RESPONSE_NOT_STRING: producer response must be a string')
  const text = raw.trim()
  if (text === '') throw new Error('E_RESPONSE_NOT_JSON_OBJECT: producer response must be one JSON object')
  if (/^```/m.test(text)) throw new Error('E_RESPONSE_FENCED: producer response must not use fenced code blocks')
  if (!text.startsWith('{') || !text.endsWith('}')) throw new Error('E_RESPONSE_PROSE_OR_LEGACY: producer response must be one raw JSON object with no prose or legacy markdown')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`E_RESPONSE_INVALID_JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('E_RESPONSE_NOT_JSON_OBJECT: producer response must be one JSON object')
  const errors = validateReviewResultContract(parsed, manifest)
  if (errors.length > 0) {
    throw new Error(errors.map(error => `${error.code}: ${error.message}`).join('\n'))
  }
  return parsed
}
