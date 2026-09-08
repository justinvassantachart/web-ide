export interface CppCompileProfileV1 {
  readonly version: 1
  readonly target: 'wasm32-wasip1'
  readonly languageStandard: 'c++11' | 'c++14' | 'c++17' | 'c++20' | 'c++23'
  readonly includeDirectories: readonly string[]
  readonly defines: readonly { readonly name: string; readonly value?: string }[]
  readonly warningPreset: 'default' | 'strict'
  readonly toolchain: {
    readonly compilerDigest: string
    readonly sysrootDigest: string
    readonly cxxAbiId: string
  }
}

export interface CppBuildPlanV1 {
  readonly version: 1
  readonly profile: CppCompileProfileV1
  readonly sources: readonly string[]
  readonly archives: readonly {
    readonly path: string
    readonly wholeArchive?: boolean
  }[]
  readonly linkLibraries: readonly string[]
  readonly outputPath: string
}
