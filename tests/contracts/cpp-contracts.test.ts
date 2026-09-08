import { describe, expect, it } from 'vitest'
import type { CppBuildPlanV1, CppCompileProfileV1 } from '../../src/web-ide/contracts/cpp'
import {
  cppCompileFlags,
  validateCppBuildPlan,
  validateCppCompileProfile,
} from '../../src/web-ide/core/cpp-contracts'

const profile: CppCompileProfileV1 = {
  version: 1,
  target: 'wasm32-wasip1',
  languageStandard: 'c++20',
  includeDirectories: ['/support/include'],
  defines: [{ name: 'SYNTHETIC_FEATURE', value: '1' }],
  warningPreset: 'strict',
  toolchain: {
    compilerDigest: 'a'.repeat(64),
    sysrootDigest: 'b'.repeat(64),
    cxxAbiId: 'synthetic-libcxx-v1',
  },
}

const plan: CppBuildPlanV1 = {
  version: 1,
  profile,
  sources: ['/workspace/main.cpp'],
  archives: [{ path: '/support/libsynthetic.a', wholeArchive: true }],
  linkLibraries: ['c++'],
  outputPath: '/output/program.wasm',
}

describe('frozen C++ contract semantics', () => {
  it('accepts the reviewed shape and derives only allowlisted flags', () => {
    expect(validateCppCompileProfile(profile)).toBe(profile)
    expect(validateCppBuildPlan(plan)).toBe(plan)
    expect(cppCompileFlags(profile)).toEqual([
      '-std=c++20',
      '--target=wasm32-wasip1',
      '-Wall',
      '-Wextra',
      '-Wpedantic',
      '-I/support/include',
      '-DSYNTHETIC_FEATURE=1',
    ])
  })

  it('rejects extra fields, sparse arrays, and accessor-backed values', () => {
    expect(() => validateCppCompileProfile({ ...profile, command: 'clang++' } as CppCompileProfileV1))
      .toThrow(/unsupported property/)

    const sparse = { ...profile, defines: new Array(1) } as CppCompileProfileV1
    expect(() => validateCppCompileProfile(sparse)).toThrow(/dense array/)

    const accessor = { ...profile, toolchain: { ...profile.toolchain } }
    Object.defineProperty(accessor.toolchain, 'cxxAbiId', {
      enumerable: true,
      get: () => 'synthetic-libcxx-v1',
    })
    expect(() => validateCppCompileProfile(accessor)).toThrow(/data property/)
  })

  it('rejects malformed archives, duplicate libraries, and cross-input collisions', () => {
    expect(() => validateCppBuildPlan({
      ...plan,
      archives: [{ path: '/support/libsynthetic.a', wholeArchive: 'yes' as never }],
    })).toThrow(/boolean/)
    expect(() => validateCppBuildPlan({ ...plan, linkLibraries: ['c++', 'c++'] }))
      .toThrow(/duplicate/)
    expect(() => validateCppBuildPlan({
      ...plan,
      archives: [{ path: '/workspace/main.cpp' }],
    })).toThrow(/source and an archive/)
  })
})
