export const EFFECTIVE_COMMON_CONTEXT_POLICY_MARKER = 'EFFECTIVE_COMMON_CONTEXT_POLICY'
export const PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW_MARKER = 'PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW'

export const EFFECTIVE_COMMON_CONTEXT_CODES = {
  POLICY_BLOCK_COUNT: 'E_EFFECTIVE_COMMON_CONTEXT_POLICY_BLOCK_COUNT',
  POLICY_JSON: 'E_EFFECTIVE_COMMON_CONTEXT_POLICY_JSON',
  POLICY_SHAPE: 'E_EFFECTIVE_COMMON_CONTEXT_POLICY_SHAPE',
  ALLOW_BLOCK_COUNT: 'E_EFFECTIVE_COMMON_CONTEXT_PUBLIC_LITERAL_ALLOW_BLOCK_COUNT',
  PUBLIC_LITERAL_OUTSIDE_ALLOW_BLOCK: 'E_EFFECTIVE_COMMON_CONTEXT_PUBLIC_LITERAL_OUTSIDE_ALLOW_BLOCK',
}

function extractMarkedBlock(text, label) {
  const begin = `<!-- ${label}:BEGIN -->`
  const end = `<!-- ${label}:END -->`
  const beginCount = text.split(begin).length - 1
  const endCount = text.split(end).length - 1
  if (beginCount !== 1 || endCount !== 1) {
    return {
      error: {
        code: label === EFFECTIVE_COMMON_CONTEXT_POLICY_MARKER
          ? EFFECTIVE_COMMON_CONTEXT_CODES.POLICY_BLOCK_COUNT
          : EFFECTIVE_COMMON_CONTEXT_CODES.ALLOW_BLOCK_COUNT,
        message: `${label} block must appear exactly once (found BEGIN=${beginCount}, END=${endCount})`,
      },
    }
  }
  const start = text.indexOf(begin)
  const finish = text.indexOf(end)
  if (finish <= start) {
    return {
      error: {
        code: label === EFFECTIVE_COMMON_CONTEXT_POLICY_MARKER
          ? EFFECTIVE_COMMON_CONTEXT_CODES.POLICY_BLOCK_COUNT
          : EFFECTIVE_COMMON_CONTEXT_CODES.ALLOW_BLOCK_COUNT,
        message: `${label} block end appears before begin`,
      },
    }
  }
  return {
    block: text.slice(start + begin.length, finish).trim(),
    fullMatch: text.slice(start, finish + end.length),
  }
}

function parsePolicyJson(block) {
  const match = block.match(/^```json\s*([\s\S]*?)\s*```$/)
  if (!match) {
    return {
      error: {
        code: EFFECTIVE_COMMON_CONTEXT_CODES.POLICY_JSON,
        message: `${EFFECTIVE_COMMON_CONTEXT_POLICY_MARKER} block must contain exactly one json fenced block`,
      },
    }
  }
  try {
    return { value: JSON.parse(match[1]) }
  } catch (error) {
    return {
      error: {
        code: EFFECTIVE_COMMON_CONTEXT_CODES.POLICY_JSON,
        message: `${EFFECTIVE_COMMON_CONTEXT_POLICY_MARKER} block contains invalid JSON: ${error.message}`,
      },
    }
  }
}

function validatePolicyShape(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return {
      code: EFFECTIVE_COMMON_CONTEXT_CODES.POLICY_SHAPE,
      message: `${EFFECTIVE_COMMON_CONTEXT_POLICY_MARKER} must decode to an object`,
    }
  }
  const expected = {
    representationOwner: 'workflow-contract.md',
    structuredProducerUnverifiedLocation: 'location.kind=unverified',
    structuredProducerReasonField: 'reason',
    publicLiteralForbiddenInCommonContext: '위치 미확인',
    publicLiteralAllowBlock: PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW_MARKER,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (policy[key] !== value) {
      return {
        code: EFFECTIVE_COMMON_CONTEXT_CODES.POLICY_SHAPE,
        message: `${EFFECTIVE_COMMON_CONTEXT_POLICY_MARKER}.${key} must equal ${JSON.stringify(value)}`,
      }
    }
  }
  const actualKeys = Object.keys(policy).sort()
  const expectedKeys = Object.keys(expected).sort()
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    return {
      code: EFFECTIVE_COMMON_CONTEXT_CODES.POLICY_SHAPE,
      message: `${EFFECTIVE_COMMON_CONTEXT_POLICY_MARKER} must contain exactly ${expectedKeys.join(', ')}`,
    }
  }
  return null
}

export function validateEffectiveCommonContext(text, contextPath = 'effective common context') {
  const errors = []
  const policyResult = extractMarkedBlock(text, EFFECTIVE_COMMON_CONTEXT_POLICY_MARKER)
  if (policyResult.error) return [{ ...policyResult.error, message: `${contextPath}: ${policyResult.error.message}` }]

  const allowResult = extractMarkedBlock(text, PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW_MARKER)
  if (allowResult.error) return [{ ...allowResult.error, message: `${contextPath}: ${allowResult.error.message}` }]

  const parsedPolicy = parsePolicyJson(policyResult.block)
  if (parsedPolicy.error) return [{ ...parsedPolicy.error, message: `${contextPath}: ${parsedPolicy.error.message}` }]

  const shapeError = validatePolicyShape(parsedPolicy.value)
  if (shapeError) return [{ ...shapeError, message: `${contextPath}: ${shapeError.message}` }]

  const publicLiteral = parsedPolicy.value.publicLiteralForbiddenInCommonContext
  const stripped = text
    .replace(policyResult.fullMatch, '')
    .replace(allowResult.fullMatch, '')
  if (stripped.includes(publicLiteral)) {
    errors.push({
      code: EFFECTIVE_COMMON_CONTEXT_CODES.PUBLIC_LITERAL_OUTSIDE_ALLOW_BLOCK,
      message: `${contextPath}: public literal ${JSON.stringify(publicLiteral)} must not appear outside ${PUBLIC_OUTPUT_LOCATION_LITERAL_ALLOW_MARKER}`,
    })
  }

  return errors
}
