import { assertNoSecretLikeText } from './secret-patterns.mjs'

export function decodeValidationLog(bytes, fileName) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new TypeError(`Validation log must be UTF-8 text: ${fileName}`, { cause: error })
  }
  assertNoSecretLikeText(text, `Validation log ${fileName}`)
  return text
}
