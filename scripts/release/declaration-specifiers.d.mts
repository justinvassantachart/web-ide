export function rewriteDeclarationModuleSpecifiers(input: {
  readonly filePath: string
  readonly content: string
  readonly sourceRoot: string
  readonly outputRoot: string
}): string
