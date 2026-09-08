import { existsSync } from 'node:fs'
import path from 'node:path'

const RELATIVE_MODULE_SPECIFIER = /(\b(?:from|import)\s*(?:\(\s*)?)(['"])(\.{1,2}\/[^'"]+)\2/gu
const RUNTIME_EXTENSION = /\.(?:[cm]?js|json)(?:[?#].*)?$/u
const SOURCE_FILE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx']

function sourceFileExists(sourcePath) {
  return SOURCE_FILE_EXTENSIONS.some((extension) => existsSync(`${sourcePath}${extension}`))
}

function runtimeSpecifier({ filePath, outputRoot, sourceRoot, specifier }) {
  if (RUNTIME_EXTENSION.test(specifier)) return specifier
  if (/[?#]/u.test(specifier)) {
    throw new TypeError(
      `Declaration ${filePath} exposes non-runtime module specifier ${JSON.stringify(specifier)}`,
    )
  }

  const outputTarget = path.resolve(path.dirname(filePath), specifier)
  const sourceRelative = path.relative(outputRoot, outputTarget)
  if (sourceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelative)) {
    throw new TypeError(
      `Declaration ${filePath} resolves outside its output root: ${JSON.stringify(specifier)}`,
    )
  }

  const sourceTarget = path.resolve(sourceRoot, sourceRelative)
  if (sourceFileExists(sourceTarget)) return `${specifier}.js`
  if (sourceFileExists(path.join(sourceTarget, 'index'))) {
    return `${specifier.replace(/\/$/u, '')}/index.js`
  }
  throw new TypeError(
    `Declaration ${filePath} has no source target for ${JSON.stringify(specifier)}`,
  )
}

/** Rewrites generated relative declaration imports to explicit Node ESM paths. */
export function rewriteDeclarationModuleSpecifiers({
  filePath,
  content,
  sourceRoot,
  outputRoot,
}) {
  const absoluteFilePath = path.resolve(filePath)
  const absoluteOutputRoot = path.resolve(outputRoot)
  const absoluteSourceRoot = path.resolve(sourceRoot)
  return content.replace(
    RELATIVE_MODULE_SPECIFIER,
    (match, prefix, quote, specifier) => {
      const rewritten = runtimeSpecifier({
        filePath: absoluteFilePath,
        outputRoot: absoluteOutputRoot,
        sourceRoot: absoluteSourceRoot,
        specifier,
      })
      return `${prefix}${quote}${rewritten}${quote}`
    },
  )
}
