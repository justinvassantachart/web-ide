import { assertExactKeys, assertNonEmptyString, sortStrings } from './release-utils.mjs'

function assertStringArray(value, location) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${location} must be a non-empty array`)
  for (const [index, item] of value.entries()) assertNonEmptyString(item, `${location}[${index}]`)
  if (new Set(value).size !== value.length) throw new TypeError(`${location} contains duplicates`)
}

export function validateRuntimeSourceProvenance(provenance, runtimeLock) {
  assertExactKeys(provenance, ['schemaVersion', 'package', 'records'], [], 'runtime source provenance')
  if (provenance.schemaVersion !== 1 || provenance.package !== 'web-ide' || !Array.isArray(provenance.records)) {
    throw new TypeError('Unsupported runtime source provenance identity')
  }
  const seenAssets = new Set()
  for (const [index, record] of provenance.records.entries()) {
    const location = `runtime source provenance records[${index}]`
    assertExactKeys(record, ['id', 'assets', 'relationship', 'source', 'inputs', 'limitations'], [], location)
    assertNonEmptyString(record.id, `${location}.id`)
    assertStringArray(record.assets, `${location}.assets`)
    assertNonEmptyString(record.relationship, `${location}.relationship`)
    assertExactKeys(record.source, ['repository', 'commit', 'paths'], [], `${location}.source`)
    assertNonEmptyString(record.source.repository, `${location}.source.repository`)
    assertNonEmptyString(record.source.commit, `${location}.source.commit`)
    assertStringArray(record.source.paths, `${location}.source.paths`)
    assertStringArray(record.inputs, `${location}.inputs`)
    assertStringArray(record.limitations, `${location}.limitations`)
    for (const asset of record.assets) {
      if (seenAssets.has(asset)) throw new TypeError(`Runtime asset ${asset} has duplicate source provenance`)
      seenAssets.add(asset)
    }
  }
  const expected = sortStrings(runtimeLock.assets.map((asset) => asset.id))
  const received = sortStrings(seenAssets)
  if (JSON.stringify(expected) !== JSON.stringify(received)) {
    throw new TypeError('Runtime source provenance does not cover the exact runtime asset lock')
  }
  return provenance
}

export function sourceProvenanceForAsset(provenance, assetId) {
  const record = provenance.records.find((candidate) => candidate.assets.includes(assetId))
  if (!record) throw new TypeError(`No source provenance for runtime asset ${assetId}`)
  return record
}
