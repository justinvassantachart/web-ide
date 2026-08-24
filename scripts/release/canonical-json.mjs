function assertCanonicalValue(value, location) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Canonical JSON cannot encode a non-finite number at ${location}`)
    }
    return
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new TypeError(`Canonical JSON cannot encode a sparse array at ${location}`)
      }
      assertCanonicalValue(value[index], `${location}[${index}]`)
    }
    return
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`Canonical JSON requires a plain object at ${location}`)
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      throw new TypeError(`Canonical JSON cannot encode undefined at ${location}.${key}`)
    }
    assertCanonicalValue(child, `${location}.${key}`)
  }
}

function serialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`)
    .join(',')}}`
}

export function canonicalJSONString(value) {
  assertCanonicalValue(value, '$')
  return `${serialize(value)}\n`
}

