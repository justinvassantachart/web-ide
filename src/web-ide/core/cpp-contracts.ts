import type { CppBuildPlanV1, CppCompileProfileV1 } from '../contracts/cpp'
import {
  canonicalStringifyV1,
  normalizeVfsPathV1,
} from '../public/canonical-contract'

const SHA256 = /^[a-f0-9]{64}$/
const DEFINE_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const ABI_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const LINK_LIBRARY = /^[A-Za-z0-9_+.-]{1,128}$/

function assertObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`)
  }
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  const extra = Object.keys(value).find((key) => !allowed.has(key))
  if (extra) throw new TypeError(`${label} contains unsupported property ${JSON.stringify(extra)}`)
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing) throw new TypeError(`${label} is missing property ${JSON.stringify(missing)}`)
}

function hasMoreThanCodePoints(value: string, limit: number): boolean {
  let count = 0
  for (let index = 0; index < value.length;) {
    const unit = value.charCodeAt(index)
    index += unit >= 0xd800 && unit <= 0xdbff ? 2 : 1
    count += 1
    if (count > limit) return true
  }
  return false
}

export function normalizeContractVfsPath(path: string): string {
  if (typeof path !== 'string') throw new TypeError('VFS path must be a string')
  const normalized = normalizeVfsPathV1(path)
  if (normalized !== path) throw new TypeError('VFS path must already be NFC-normalized')
  return normalized
}

function assertUniquePaths(paths: readonly string[], label: string): void {
  const normalized = paths.map(normalizeContractVfsPath)
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} contains duplicate paths`)
}

export function validateCppCompileProfile(profile: CppCompileProfileV1): CppCompileProfileV1 {
  canonicalStringifyV1(profile)
  assertObject(profile, 'C++ compile profile')
  assertKeys(
    profile,
    ['version', 'target', 'languageStandard', 'includeDirectories', 'defines', 'warningPreset', 'toolchain'],
    [],
    'C++ compile profile',
  )
  if (profile.version !== 1 || profile.target !== 'wasm32-wasip1') {
    throw new TypeError('unsupported C++ compile profile')
  }
  if (!['c++11', 'c++14', 'c++17', 'c++20', 'c++23'].includes(profile.languageStandard)) {
    throw new TypeError('unsupported C++ language standard')
  }
  if (!Array.isArray(profile.includeDirectories)) throw new TypeError('includeDirectories must be an array')
  if (profile.includeDirectories.length > 64) throw new RangeError('too many include directories')
  assertUniquePaths(profile.includeDirectories, 'includeDirectories')
  if (!Array.isArray(profile.defines)) throw new TypeError('defines must be an array')
  if (profile.defines.length > 128) throw new RangeError('too many defines')
  const names = new Set<string>()
  for (const [index, define] of profile.defines.entries()) {
    assertObject(define, `defines[${index}]`)
    assertKeys(define, ['name'], ['value'], `defines[${index}]`)
    if (
      typeof define.name !== 'string'
      || !DEFINE_NAME.test(define.name)
      || (define.value !== undefined && (
        typeof define.value !== 'string'
        || hasMoreThanCodePoints(define.value, 1024)
      ))
    ) {
      throw new TypeError('compile-profile define is invalid')
    }
    if (names.has(define.name)) throw new TypeError(`defines contains duplicate name: ${define.name}`)
    names.add(define.name)
  }
  if (profile.warningPreset !== 'default' && profile.warningPreset !== 'strict') {
    throw new TypeError('warning preset is invalid')
  }
  assertObject(profile.toolchain, 'compile-profile toolchain')
  assertKeys(
    profile.toolchain,
    ['compilerDigest', 'sysrootDigest', 'cxxAbiId'],
    [],
    'compile-profile toolchain',
  )
  if (
    typeof profile.toolchain.compilerDigest !== 'string'
    || typeof profile.toolchain.sysrootDigest !== 'string'
  ) throw new TypeError('toolchain digest is invalid')
  if (!SHA256.test(profile.toolchain.compilerDigest) || !SHA256.test(profile.toolchain.sysrootDigest)) {
    throw new TypeError('toolchain digest is invalid')
  }
  if (typeof profile.toolchain.cxxAbiId !== 'string' || !ABI_ID.test(profile.toolchain.cxxAbiId)) {
    throw new TypeError('C++ ABI id is invalid')
  }
  return profile
}

export function validateCppBuildPlan(plan: CppBuildPlanV1): CppBuildPlanV1 {
  canonicalStringifyV1(plan)
  assertObject(plan, 'C++ build plan')
  assertKeys(
    plan,
    ['version', 'profile', 'sources', 'archives', 'linkLibraries', 'outputPath'],
    [],
    'C++ build plan',
  )
  if (plan.version !== 1) throw new TypeError('unsupported C++ build plan')
  validateCppCompileProfile(plan.profile)
  if (!Array.isArray(plan.sources) || !Array.isArray(plan.archives) || !Array.isArray(plan.linkLibraries)) {
    throw new TypeError('C++ build-plan inputs must be arrays')
  }
  if (plan.sources.length < 1 || plan.sources.length > 500) throw new RangeError('source count is invalid')
  if (plan.archives.length > 64 || plan.linkLibraries.length > 64) throw new RangeError('link input count is invalid')
  assertUniquePaths(plan.sources, 'sources')
  for (const [index, archive] of plan.archives.entries()) {
    assertObject(archive, `archives[${index}]`)
    assertKeys(archive, ['path'], ['wholeArchive'], `archives[${index}]`)
    if (archive.wholeArchive !== undefined && typeof archive.wholeArchive !== 'boolean') {
      throw new TypeError(`archives[${index}].wholeArchive must be a boolean`)
    }
  }
  assertUniquePaths(plan.archives.map(({ path }) => path), 'archives')
  const inputs = [...plan.sources, ...plan.archives.map(({ path }) => path)]
  if (new Set(inputs).size !== inputs.length) throw new TypeError('a path cannot be both a source and an archive')
  const outputPath = normalizeContractVfsPath(plan.outputPath)
  if (inputs.includes(outputPath)) throw new TypeError('output path conflicts with an input')
  if (plan.linkLibraries.some((library) => typeof library !== 'string' || !LINK_LIBRARY.test(library))) {
    throw new TypeError('link library is invalid')
  }
  if (new Set(plan.linkLibraries).size !== plan.linkLibraries.length) {
    throw new TypeError('linkLibraries contains duplicate entries')
  }
  return plan
}

export function cppCompileFlags(profile: CppCompileProfileV1): readonly string[] {
  validateCppCompileProfile(profile)
  return Object.freeze([
    `-std=${profile.languageStandard}`,
    '--target=wasm32-wasip1',
    '-Wall',
    ...(profile.warningPreset === 'strict' ? ['-Wextra', '-Wpedantic'] : []),
    ...profile.includeDirectories.map((path) => `-I${path}`),
    ...profile.defines.map(({ name, value }) => `-D${name}${value === undefined ? '' : `=${value}`}`),
  ])
}
