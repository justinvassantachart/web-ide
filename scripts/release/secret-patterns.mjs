const SECRET_LIKE_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u, 'private key'],
  [/AKIA[0-9A-Z]{16}/u, 'AWS access key'],
  [/AIza[0-9A-Za-z_-]{35}/u, 'Google API key'],
  [/gh[pousr]_[A-Za-z0-9_]{20,}/u, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{20,}/u, 'GitHub fine-grained token'],
  [/npm_[A-Za-z0-9_-]{20,}/u, 'npm token'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/u, 'Slack token'],
  [/\bsk_live_[A-Za-z0-9]{16,}/u, 'live Stripe key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u, 'JSON Web Token'],
  [/(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+\S+/iu, 'authorization credential'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/iu, 'Bearer credential'],
  [/https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/iu, 'credential-bearing URL'],
  [
    /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|client[_-]?secret|github[_-]?token|npm[_-]?token|pass(?:word|wd)?|secret|token)\s*[=:]\s*['"][A-Za-z0-9_./+~-]{8,}['"]/imu,
    'secret assignment',
  ],
  [
    /^[ \t]*(?:(?:[A-Z0-9]+[_-])*(?:API[_-]?KEY|CLIENT[_-]?SECRET|GITHUB[_-]?TOKEN|NPM[_-]?TOKEN|PASS(?:WORD|WD)?|SECRET|TOKEN)|(?:api[_-]?key|client[_-]?secret|github[_-]?token|npm[_-]?token|pass(?:word|wd)?|secret|token))\s*[=:]\s*['"]?[A-Za-z0-9_./+~-]{8,}['"]?[ \t]*$/imu,
    'secret assignment',
  ],
]

function containsBasicCredential(text) {
  const pattern = /\bbasic\s+([A-Za-z0-9+/]{8,}={0,2})(?=\s|$)/giu
  for (const match of text.matchAll(pattern)) {
    const encoded = match[1]
    const unpadded = encoded.replace(/=+$/u, '')
    const paddingLength = (4 - (unpadded.length % 4)) % 4
    const normalized = `${unpadded}${'='.repeat(paddingLength)}`
    const decoded = Buffer.from(normalized, 'base64')
    if (
      decoded.toString('base64').replace(/=+$/u, '') === unpadded
      && decoded.includes(0x3a)
      && decoded.every((byte) => byte >= 0x20 && byte <= 0x7e)
    ) return true
  }
  return false
}

export function assertNoSecretLikeText(text, location) {
  for (const [pattern, label] of SECRET_LIKE_PATTERNS) {
    if (pattern.test(text)) throw new TypeError(`${location} contains a ${label}`)
  }
  if (containsBasicCredential(text)) {
    throw new TypeError(`${location} contains a Basic credential`)
  }
}
