import { readFile } from 'node:fs/promises'
const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'))
const spec = manifest.dependencies['debugger-sh-upstream']
const expected = /^https:\/\/github\.com\/justinvassantachart\/engine\/releases\/download\/upstream-([0-9a-f]{40})\/debugger-sh-0\.3\.16-upstream\.([0-9a-f]{12})\.tgz$/
const match = expected.exec(spec)
if (!match || !match[1].startsWith(match[2])) throw new Error('Upstream Engine must use an immutable source-qualified release tarball')
const entry = lock.packages['node_modules/debugger-sh-upstream']
if (entry.version !== `0.3.16-upstream.${match[2]}` || entry.resolved !== spec || !entry.integrity?.startsWith('sha512-')) throw new Error('Upstream Engine lock integrity is missing or mismatched')
const source = JSON.parse(await readFile(new URL('../../node_modules/debugger-sh-upstream/dist/source.json', import.meta.url), 'utf8'))
if (source.source !== match[1] || source.repository !== 'justinvassantachart/engine') throw new Error('Installed Engine source provenance does not match the release URL')
console.log(`Pinned upstream Engine ${entry.version}, ${entry.integrity}`)
