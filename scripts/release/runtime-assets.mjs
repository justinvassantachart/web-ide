import { createHash } from 'node:crypto'

import {
  assertExactKeys,
  assertNonEmptyString,
  sortStrings,
} from './release-utils.mjs'

const assetFields = [
  'id',
  'version',
  'requestedUrl',
  'finalUrl',
  'size',
  'sha256',
  'contentType',
  'headers',
  'license',
  'licenseTextPaths',
  'sourceRepository',
  'sourceLocations',
]

function assertHttpsUrl(value, location) {
  assertNonEmptyString(value, location)
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new TypeError(`${location} must use HTTPS`)
  if (url.username || url.password || url.hash) {
    throw new TypeError(`${location} must not contain credentials or a fragment`)
  }
  return url.href
}

function assertStringArray(value, location) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${location} must be a non-empty array`)
  }
  for (const [index, item] of value.entries()) {
    assertNonEmptyString(item, `${location}[${index}]`)
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${location} contains duplicates`)
}

export function validateRuntimeAssetLock(lock) {
  assertExactKeys(
    lock,
    ['schemaVersion', 'package', 'observedDate', 'digestRepresentation', 'expectedRedirectCount', 'requestTimeoutMs', 'scope', 'limitations', 'assets'],
    [],
    'runtime asset lock',
  )
  if (lock.schemaVersion !== 1 || lock.package !== 'web-ide') {
    throw new TypeError('Unsupported runtime asset lock identity')
  }
  if (!Array.isArray(lock.assets) || lock.assets.length === 0) {
    throw new TypeError('runtime asset lock assets must be a non-empty array')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(lock.observedDate)) throw new TypeError('runtime asset lock observedDate is invalid')
  if (lock.digestRepresentation !== 'identity-encoded-response-body') {
    throw new TypeError('runtime asset lock digest representation is unsupported')
  }
  if (lock.expectedRedirectCount !== 0) {
    throw new TypeError('runtime asset lock currently supports only an exact zero-redirect policy')
  }
  if (!Number.isSafeInteger(lock.requestTimeoutMs) || lock.requestTimeoutMs < 1000 || lock.requestTimeoutMs > 300000) {
    throw new TypeError('runtime asset lock requestTimeoutMs is invalid')
  }
  assertNonEmptyString(lock.scope, 'runtime asset lock scope')
  assertStringArray(lock.limitations, 'runtime asset lock limitations')
  const ids = new Set()
  for (const [index, asset] of lock.assets.entries()) {
    const location = `runtime asset lock assets[${index}]`
    assertExactKeys(asset, assetFields, [], location)
    assertNonEmptyString(asset.id, `${location}.id`)
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(asset.id)) {
      throw new TypeError(`${location}.id must be a stable lowercase identifier`)
    }
    if (ids.has(asset.id)) throw new TypeError(`Duplicate runtime asset id ${asset.id}`)
    ids.add(asset.id)
    assertNonEmptyString(asset.version, `${location}.version`)
    const requestedUrl = assertHttpsUrl(asset.requestedUrl, `${location}.requestedUrl`)
    const finalUrl = assertHttpsUrl(asset.finalUrl, `${location}.finalUrl`)
    if (lock.expectedRedirectCount === 0 && requestedUrl !== finalUrl) {
      throw new TypeError(`${location} finalUrl must equal requestedUrl under the exact zero-redirect policy`)
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new TypeError(`${location}.size must be a positive safe integer`)
    }
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256)) {
      throw new TypeError(`${location}.sha256 must be lowercase SHA-256 hex`)
    }
    assertNonEmptyString(asset.contentType, `${location}.contentType`)
    assertExactKeys(
      asset.headers,
      ['access-control-allow-origin', 'cross-origin-resource-policy'],
      [],
      `${location}.headers`,
    )
    for (const [name, value] of Object.entries(asset.headers)) {
      if (value !== null && typeof value !== 'string') {
        throw new TypeError(`${location}.headers.${name} must be a string or null`)
      }
    }
    assertNonEmptyString(asset.license, `${location}.license`)
    assertStringArray(asset.licenseTextPaths, `${location}.licenseTextPaths`)
    assertHttpsUrl(asset.sourceRepository, `${location}.sourceRepository`)
    assertStringArray(asset.sourceLocations, `${location}.sourceLocations`)
    for (const [sourceIndex, source] of asset.sourceLocations.entries()) {
      if (!/^(?:src|node_modules)\//u.test(source) || source.includes('..') || source.includes('\\')) {
        throw new TypeError(`${location}.sourceLocations[${sourceIndex}] is not a repository-relative source path`)
      }
    }
  }
  const sorted = sortStrings(lock.assets.map((asset) => asset.id))
  if (JSON.stringify(sorted) !== JSON.stringify(lock.assets.map((asset) => asset.id))) {
    throw new TypeError('runtime asset lock assets must be sorted by id')
  }
  return lock
}

export function validateRuntimeAssetVerification(report, lock) {
  validateRuntimeAssetLock(lock)
  assertExactKeys(
    report,
    [
      'schemaVersion', 'package', 'observedDate', 'digestRepresentation',
      'expectedRedirectCount', 'requestTimeoutMs', 'scope', 'limitations',
      'result', 'assets',
    ],
    [],
    'runtime asset verification',
  )
  if (
    report.schemaVersion !== 1
    || report.package !== 'web-ide'
    || report.observedDate !== lock.observedDate
    || report.digestRepresentation !== lock.digestRepresentation
    || report.expectedRedirectCount !== lock.expectedRedirectCount
    || report.requestTimeoutMs !== lock.requestTimeoutMs
    || report.scope !== lock.scope
    || JSON.stringify(report.limitations) !== JSON.stringify(lock.limitations)
    || report.result !== 'pass'
    || !Array.isArray(report.assets)
    || report.assets.length !== lock.assets.length
  ) {
    throw new TypeError('Runtime asset verification does not match the reviewed lock')
  }
  for (const [index, expected] of lock.assets.entries()) {
    const actual = report.assets[index]
    const location = `runtime asset verification assets[${index}]`
    assertExactKeys(
      actual,
      [
        'id', 'requestedUrl', 'finalUrl', 'redirectCount', 'status',
        'contentType', 'headers', 'size', 'sha256',
      ],
      [],
      location,
    )
    assertExactKeys(
      actual.headers,
      ['access-control-allow-origin', 'cross-origin-resource-policy'],
      [],
      `${location}.headers`,
    )
    if (
      actual.id !== expected.id
      || actual.requestedUrl !== expected.requestedUrl
      || actual.finalUrl !== expected.finalUrl
      || actual.redirectCount !== lock.expectedRedirectCount
      || actual.status !== 200
      || actual.contentType !== expected.contentType
      || actual.size !== expected.size
      || actual.sha256 !== expected.sha256
      || JSON.stringify(actual.headers) !== JSON.stringify(expected.headers)
    ) {
      throw new TypeError(`${expected.id} runtime verification is not an exact pass receipt`)
    }
  }
  return report
}

async function digestResponse(response, maximumSize, controller, assetId) {
  if (!response.body) throw new TypeError('Runtime asset response has no body')
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > maximumSize) {
      controller.abort(new Error(`${assetId} exceeded its locked maximum streamed size ${maximumSize}`))
      throw new TypeError(`${assetId} exceeded its locked maximum streamed size ${maximumSize}`)
    }
    hash.update(chunk)
  }
  return { size, sha256: hash.digest('hex') }
}

export async function verifyRuntimeAssets(
  lock,
  fetchImplementation = globalThis.fetch,
  options = {},
) {
  validateRuntimeAssetLock(lock)
  if (typeof fetchImplementation !== 'function') throw new TypeError('A fetch implementation is required')
  const results = []
  const timeoutMs = options.timeoutMs ?? lock.requestTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > lock.requestTimeoutMs) {
    throw new TypeError('Runtime verification timeout override is invalid')
  }
  for (const asset of lock.assets) {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new Error(`${asset.id} exceeded the ${timeoutMs} ms request timeout`))
    }, timeoutMs)
    let evidence
    try {
      const response = await fetchImplementation(asset.requestedUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          accept: '*/*',
          'accept-encoding': 'identity',
          'user-agent': 'web-ide-release-evidence/0.3.0',
        },
      })
      if (response.status !== 200) throw new TypeError(`${asset.id} returned HTTP ${response.status}`)
      if (response.redirected) throw new TypeError(`${asset.id} violated the exact zero-redirect policy`)
      evidence = {
        id: asset.id,
        requestedUrl: asset.requestedUrl,
        finalUrl: response.url,
        redirectCount: 0,
        status: response.status,
        contentType: response.headers.get('content-type'),
        headers: {
          'access-control-allow-origin': response.headers.get('access-control-allow-origin'),
          'cross-origin-resource-policy': response.headers.get('cross-origin-resource-policy'),
        },
        ...(await digestResponse(response, asset.size, controller, asset.id)),
      }
    } finally {
      clearTimeout(timeout)
    }
    for (const field of ['finalUrl', 'size', 'sha256', 'contentType']) {
      if (evidence[field] !== asset[field]) {
        throw new TypeError(`${asset.id} ${field} mismatch: expected ${JSON.stringify(asset[field])}, received ${JSON.stringify(evidence[field])}`)
      }
    }
    for (const [name, expected] of Object.entries(asset.headers)) {
      if (evidence.headers[name] !== expected) {
        throw new TypeError(`${asset.id} header ${name} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(evidence.headers[name])}`)
      }
    }
    results.push(evidence)
  }
  return {
    schemaVersion: 1,
    package: 'web-ide',
    observedDate: lock.observedDate,
    digestRepresentation: lock.digestRepresentation,
    expectedRedirectCount: lock.expectedRedirectCount,
    requestTimeoutMs: lock.requestTimeoutMs,
    scope: lock.scope,
    limitations: lock.limitations,
    result: 'pass',
    assets: results,
  }
}
