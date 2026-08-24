import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertExternalOutputPath,
  readRegularFileSnapshot,
  sha256Bytes,
} from './release-utils.mjs'

const RESERVATION_SENTINEL = '.web-ide-publication-reservation'
const RESERVATION_SENTINEL_BYTES = Buffer.from('reserved for verified publication\n')

async function pathState(target) {
  try {
    return await lstat(target, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function assertPlainDirectory(info, label) {
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError(`${label} must be a plain directory, not a symlink`)
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino)
}

function identityText(info) {
  return info ? `${String(info.dev)}:${String(info.ino)}` : 'absent'
}

function publicationHooks(hooks) {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new TypeError('Publication transaction hooks must be an object')
  }
  const keys = Object.keys(hooks)
  if (keys.some((key) => key !== 'beforePublish')) {
    throw new TypeError(`Publication transaction hooks contain an unknown field: ${keys.join(', ')}`)
  }
  if (
    hooks.beforePublish !== undefined
    && typeof hooks.beforePublish !== 'function'
  ) throw new TypeError('Publication before-publish hook must be a function')
  return hooks
}

async function assertIdentity(target, expected, label) {
  const actual = await pathState(target)
  if (!sameIdentity(actual, expected)) {
    throw new TypeError(
      `${label} identity changed (expected ${identityText(expected)}, found ${identityText(actual)})`,
    )
  }
  assertPlainDirectory(actual, label)
  return actual
}

async function stagingDirectoryFor(target) {
  const parent = path.dirname(target)
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(path.join(parent, `.${path.basename(target)}.staging-`))
  const identity = await pathState(directory)
  assertPlainDirectory(identity, 'Publication staging directory')
  return { directory, identity }
}

async function inspectFlatDirectory(
  directory,
  label,
  { allowEmpty = false, allowReservationSentinel = false } = {},
) {
  const records = []
  let sawReservationSentinel = false
  for (const fileName of (await readdir(directory)).sort()) {
    if (fileName !== path.basename(fileName) || fileName === '.' || fileName === '..') {
      throw new TypeError(`${label} contains an unsafe filename`)
    }
    if (fileName === RESERVATION_SENTINEL) {
      if (!allowReservationSentinel) {
        throw new TypeError(`${label} contains an active publication reservation`)
      }
      const sentinel = await readRegularFileSnapshot(
        path.join(directory, fileName),
        `${label} publication reservation`,
        RESERVATION_SENTINEL_BYTES.length,
      )
      if (!sentinel.bytes.equals(RESERVATION_SENTINEL_BYTES)) {
        throw new TypeError(`${label} publication reservation has unexpected bytes`)
      }
      sawReservationSentinel = true
      continue
    }
    const filePath = path.join(directory, fileName)
    const info = await pathState(filePath)
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new TypeError(`${label} may contain only regular non-symlink files: ${fileName}`)
    }
    const snapshot = await readRegularFileSnapshot(filePath, `${label} file ${fileName}`)
    records.push({ fileName, size: snapshot.size, sha256: snapshot.sha256 })
  }
  if (allowReservationSentinel && !sawReservationSentinel) {
    throw new TypeError(`${label} lost its active publication reservation`)
  }
  if (!allowEmpty && records.length === 0) throw new TypeError(`${label} must not be empty`)
  return {
    records,
    digest: sha256Bytes(Buffer.from(canonicalJSONString(records))),
  }
}

async function removeVerifiedStagingQuarantine({
  quarantineRoot,
  quarantineRootIdentity,
  quarantineDirectory,
  stagingIdentity,
  inventory,
  label,
}) {
  await assertIdentity(quarantineDirectory, stagingIdentity, `${label} staging quarantine`)
  const currentInventory = await inspectFlatDirectory(
    quarantineDirectory,
    `${label} staging quarantine`,
    { allowEmpty: true },
  )
  if (canonicalJSONString(currentInventory) !== canonicalJSONString(inventory)) {
    throw new TypeError(`${label} staging contents changed after quarantine`)
  }
  for (const [index, record] of inventory.records.entries()) {
    await assertIdentity(quarantineDirectory, stagingIdentity, `${label} staging quarantine`)
    const remaining = inventory.records.slice(index).map((item) => item.fileName)
    if (JSON.stringify((await readdir(quarantineDirectory)).sort()) !== JSON.stringify(remaining)) {
      throw new TypeError(`${label} staging quarantine changed during cleanup`)
    }
    const snapshot = await readRegularFileSnapshot(
      path.join(quarantineDirectory, record.fileName),
      `${label} staging quarantine file ${record.fileName}`,
    )
    if (snapshot.size !== record.size || snapshot.sha256 !== record.sha256) {
      throw new TypeError(`${label} staging file changed before cleanup: ${record.fileName}`)
    }
    await unlink(path.join(quarantineDirectory, record.fileName))
  }
  await assertIdentity(quarantineDirectory, stagingIdentity, `${label} staging quarantine`)
  if ((await readdir(quarantineDirectory)).length !== 0) {
    throw new TypeError(`${label} staging quarantine gained an unexpected entry`)
  }
  await rmdir(quarantineDirectory)
  await assertIdentity(quarantineRoot, quarantineRootIdentity, `${label} staging quarantine root`)
  if ((await readdir(quarantineRoot)).length !== 0) {
    throw new TypeError(`${label} staging quarantine root gained an unexpected entry`)
  }
  await rmdir(quarantineRoot)
}

async function cleanupOwnedStaging(stagingDirectory, stagingIdentity, label) {
  await assertIdentity(stagingDirectory, stagingIdentity, `${label} staging directory`)
  const inventory = await inspectFlatDirectory(stagingDirectory, `${label} staging directory`, {
    allowEmpty: true,
  })
  const quarantineRoot = await mkdtemp(path.join(
    path.dirname(stagingDirectory),
    `.${path.basename(stagingDirectory)}.cleanup-`,
  ))
  const quarantineRootIdentity = await pathState(quarantineRoot)
  assertPlainDirectory(quarantineRootIdentity, `${label} staging quarantine root`)
  const quarantineDirectory = path.join(quarantineRoot, 'staging')
  await assertIdentity(stagingDirectory, stagingIdentity, `${label} staging directory`)
  await rename(stagingDirectory, quarantineDirectory)
  const moved = await pathState(quarantineDirectory)
  if (!sameIdentity(moved, stagingIdentity)) {
    throw new TypeError(
      `${label} staging identity changed during quarantine; inspect ${quarantineDirectory}`,
    )
  }
  try {
    await removeVerifiedStagingQuarantine({
      quarantineRoot,
      quarantineRootIdentity,
      quarantineDirectory,
      stagingIdentity,
      inventory,
      label,
    })
  } catch (error) {
    throw new Error(
      `${label} staging cleanup failed; retained recovery path ${quarantineDirectory}`,
      { cause: error },
    )
  }
}

function publicationMarker(targetDirectory, inventory) {
  const bytes = Buffer.from(canonicalJSONString({
    schemaVersion: 1,
    result: 'complete',
    targetName: path.basename(targetDirectory),
    fileCount: inventory.records.length,
    contentSha256: inventory.digest,
  }))
  return {
    path: path.join(
      path.dirname(targetDirectory),
      `.${path.basename(targetDirectory)}.publication-${inventory.digest}.complete.json`,
    ),
    bytes,
  }
}

async function writeCompletionMarker(targetDirectory, inventory) {
  const marker = publicationMarker(targetDirectory, inventory)
  try {
    await writeFile(marker.path, marker.bytes, { flag: 'wx', mode: 0o600 })
    const identity = await pathState(marker.path)
    if (!identity?.isFile() || identity.isSymbolicLink()) {
      throw new TypeError(`Publication completion marker is not a regular file: ${marker.path}`)
    }
    return { path: marker.path, created: true, identity }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await readRegularFileSnapshot(marker.path, 'Publication completion marker', 4096)
    if (!existing.bytes.equals(marker.bytes)) {
      throw new TypeError(`Publication completion marker already exists with different bytes: ${marker.path}`)
    }
    return { path: marker.path, created: false, identity: null }
  }
}

async function removeOwnedCompletionMarker(marker) {
  if (!marker?.created) return false
  const current = await pathState(marker.path)
  if (!current || current.isSymbolicLink() || !current.isFile() || !sameIdentity(current, marker.identity)) {
    return false
  }
  await unlink(marker.path)
  return true
}

async function retainOwnedReservation(targetDirectory, reservation) {
  const current = await pathState(targetDirectory)
  if (!sameIdentity(current, reservation)) return null
  const recoveryRoot = await mkdtemp(path.join(
    path.dirname(targetDirectory),
    `.${path.basename(targetDirectory)}.failed-publication-`,
  ))
  const recoveryDirectory = path.join(recoveryRoot, 'partial')
  await assertIdentity(targetDirectory, reservation, 'Failed publication reservation')
  await rename(targetDirectory, recoveryDirectory)
  const retained = await pathState(recoveryDirectory)
  if (!sameIdentity(retained, reservation)) {
    throw new TypeError(`Failed publication changed while retained at ${recoveryDirectory}`)
  }
  return recoveryDirectory
}

async function removeVerifiedBackup({
  backupRoot,
  backupRootIdentity,
  backupDirectory,
  initialDirectoryIdentity,
  inventory,
  label,
}) {
  await assertIdentity(backupDirectory, initialDirectoryIdentity, `${label} recovery backup`)
  const finalInventory = await inspectFlatDirectory(backupDirectory, `${label} recovery backup`)
  if (canonicalJSONString(finalInventory) !== canonicalJSONString(inventory)) {
    throw new TypeError('Recovery backup contents changed after publication')
  }
  if (JSON.stringify(await readdir(backupRoot)) !== JSON.stringify(['original'])) {
    throw new TypeError('Recovery backup root contains unexpected entries')
  }
  for (const [index, record] of inventory.records.entries()) {
    await assertIdentity(backupDirectory, initialDirectoryIdentity, `${label} recovery backup`)
    const expectedRemaining = inventory.records.slice(index).map((item) => item.fileName)
    if (JSON.stringify((await readdir(backupDirectory)).sort()) !== JSON.stringify(expectedRemaining)) {
      throw new TypeError('Recovery backup changed while its reviewed files were removed')
    }
    const snapshot = await readRegularFileSnapshot(
      path.join(backupDirectory, record.fileName),
      `${label} recovery backup file ${record.fileName}`,
    )
    if (snapshot.size !== record.size || snapshot.sha256 !== record.sha256) {
      throw new TypeError(`Recovery backup file changed before removal: ${record.fileName}`)
    }
    await unlink(path.join(backupDirectory, record.fileName))
  }
  await assertIdentity(backupDirectory, initialDirectoryIdentity, `${label} recovery backup`)
  if ((await readdir(backupDirectory)).length !== 0) {
    throw new TypeError('Recovery backup gained an unexpected entry before removal')
  }
  await rmdir(backupDirectory)
  await assertIdentity(backupRoot, backupRootIdentity, `${label} recovery backup root`)
  if ((await readdir(backupRoot)).length !== 0) {
    throw new TypeError('Recovery backup root gained an unexpected entry before removal')
  }
  await rmdir(backupRoot)
}

async function publishStagingIntoReservation({
  targetDirectory,
  stagingDirectory,
  stagingIdentity,
  reservation,
  label,
  beforePublish,
  onStagingClosed,
}) {
  await assertIdentity(stagingDirectory, stagingIdentity, `${label} staging directory`)
  const expected = await inspectFlatDirectory(stagingDirectory, `${label} staging directory`)
  let completionMarker
  try {
    for (const record of expected.records) {
      await assertIdentity(stagingDirectory, stagingIdentity, `${label} staging directory`)
      await assertIdentity(targetDirectory, reservation, `${label} reservation`)
      await rename(
        path.join(stagingDirectory, record.fileName),
        path.join(targetDirectory, record.fileName),
      )
      await assertIdentity(stagingDirectory, stagingIdentity, `${label} staging directory`)
      await assertIdentity(targetDirectory, reservation, `${label} reservation`)
    }
    await cleanupOwnedStaging(stagingDirectory, stagingIdentity, label)
    onStagingClosed()
    await assertIdentity(targetDirectory, reservation, `${label} reservation`)
    const published = await inspectFlatDirectory(targetDirectory, label, {
      allowReservationSentinel: true,
    })
    if (canonicalJSONString(published) !== canonicalJSONString(expected)) {
      throw new TypeError(`${label} changed while it was being published`)
    }
    if (beforePublish) {
      await beforePublish({
        targetDirectory,
        inventory: published,
      })
    }
    await assertIdentity(targetDirectory, reservation, `${label} reservation`)
    await unlink(path.join(targetDirectory, RESERVATION_SENTINEL))
    await assertIdentity(targetDirectory, reservation, `${label} reservation`)
    const closed = await inspectFlatDirectory(targetDirectory, label)
    if (canonicalJSONString(closed) !== canonicalJSONString(expected)) {
      throw new TypeError(`${label} changed while its publication was closed`)
    }
    completionMarker = await writeCompletionMarker(targetDirectory, closed)
    return completionMarker.path
  } catch (error) {
    try {
      await removeOwnedCompletionMarker(completionMarker)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${label} publication failed and its completion marker could not be removed`,
      )
    }
    throw error
  }
}

async function reserveTarget(targetDirectory, label) {
  try {
    await mkdir(targetDirectory, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new TypeError(`${label} was concurrently created while publication was in progress`)
    }
    throw error
  }
  const reservation = await pathState(targetDirectory)
  assertPlainDirectory(reservation, `${label} reservation`)
  await writeFile(
    path.join(targetDirectory, RESERVATION_SENTINEL),
    RESERVATION_SENTINEL_BYTES,
    { flag: 'wx', mode: 0o600 },
  )
  await assertIdentity(targetDirectory, reservation, `${label} reservation`)
  return reservation
}

export async function beginEmptyDirectoryTransaction(
  outputPath,
  label = 'Release output directory',
  hooks = {},
) {
  hooks = publicationHooks(hooks)
  const requested = path.resolve(outputPath)
  const requestedState = await pathState(requested)
  if (requestedState) assertPlainDirectory(requestedState, label)
  const targetDirectory = await assertExternalOutputPath(outputPath, label)
  const initial = await pathState(targetDirectory)
  if (initial) {
    assertPlainDirectory(initial, label)
    if ((await readdir(targetDirectory)).length !== 0) {
      throw new TypeError(`${label} must be empty before generation`)
    }
  }
  const staging = await stagingDirectoryFor(targetDirectory)
  const stagingDirectory = staging.directory
  const stagingIdentity = staging.identity
  let complete = false
  let stagingClosed = false
  return {
    targetDirectory,
    stagingDirectory,
    async commit() {
      if (complete) throw new TypeError(`${label} transaction is already complete`)
      const current = await pathState(targetDirectory)
      if (initial) {
        if (!sameIdentity(current, initial)) {
          throw new TypeError(`${label} changed while generation was in progress`)
        }
        assertPlainDirectory(current, label)
        if ((await readdir(targetDirectory)).length !== 0) {
          throw new TypeError(`${label} changed while generation was in progress`)
        }
        await assertIdentity(targetDirectory, initial, label)
        await rmdir(targetDirectory)
      } else if (current) {
        throw new TypeError(`${label} was concurrently created while generation was in progress`)
      }

      let reservation
      try {
        reservation = await reserveTarget(targetDirectory, label)
        await publishStagingIntoReservation({
          targetDirectory,
          stagingDirectory,
          stagingIdentity,
          reservation,
          label,
          beforePublish: hooks.beforePublish,
          onStagingClosed: () => { stagingClosed = true },
        })
        complete = true
      } catch (error) {
        const retainedPartial = reservation
          ? await retainOwnedReservation(targetDirectory, reservation)
          : null
        if (initial && !(await pathState(targetDirectory))) {
          try {
            await mkdir(targetDirectory, { mode: 0o700 })
          } catch (restoreError) {
            if (restoreError?.code !== 'EEXIST') throw new AggregateError(
              [error, restoreError],
              `${label} publication and empty-directory restoration failed`,
            )
          }
        }
        if (retainedPartial) {
          throw new Error(
            `${label} publication failed; partial bytes retained at recovery path ${retainedPartial}: ${error.message}`,
            { cause: error },
          )
        }
        throw error
      }
    },
    async rollback() {
      if (!complete && !stagingClosed) {
        await cleanupOwnedStaging(stagingDirectory, stagingIdentity, label)
        stagingClosed = true
      }
    },
  }
}

export async function beginDirectoryReplacement(
  outputPath,
  label = 'Release output directory',
  hooks = {},
) {
  hooks = publicationHooks(hooks)
  const requested = path.resolve(outputPath)
  assertPlainDirectory(await pathState(requested), label)
  const targetDirectory = await assertExternalOutputPath(outputPath, label)
  const initial = await pathState(targetDirectory)
  assertPlainDirectory(initial, label)
  const initialInventory = await inspectFlatDirectory(targetDirectory, label)
  const staging = await stagingDirectoryFor(targetDirectory)
  const stagingDirectory = staging.directory
  const stagingIdentity = staging.identity
  let complete = false
  let stagingClosed = false
  let retainedBackup = null
  return {
    targetDirectory,
    stagingDirectory,
    get retainedBackup() {
      return retainedBackup
    },
    async commit() {
      if (complete) throw new TypeError(`${label} transaction is already complete`)
      await assertIdentity(targetDirectory, initial, label)
      const currentInventory = await inspectFlatDirectory(targetDirectory, label)
      if (canonicalJSONString(currentInventory) !== canonicalJSONString(initialInventory)) {
        throw new TypeError(`${label} contents changed while replacement was staged`)
      }
      const backupRoot = await mkdtemp(path.join(
        path.dirname(targetDirectory),
        `.${path.basename(targetDirectory)}.backup-`,
      ))
      const backupRootIdentity = await pathState(backupRoot)
      assertPlainDirectory(backupRootIdentity, `${label} recovery backup root`)
      const backupDirectory = path.join(backupRoot, 'original')
      try {
        await assertIdentity(targetDirectory, initial, label)
        await rename(targetDirectory, backupDirectory)
      } catch (error) {
        try {
          await rmdir(backupRoot)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `${label} changed before backup and its empty backup root could not be removed`,
          )
        }
        throw error
      }
      const moved = await pathState(backupDirectory)
      if (!sameIdentity(moved, initial)) {
        retainedBackup = backupDirectory
        throw new TypeError(`${label} changed during backup; inspect retained recovery path ${backupDirectory}`)
      }
      const movedInventory = await inspectFlatDirectory(backupDirectory, `${label} recovery backup`)
      if (canonicalJSONString(movedInventory) !== canonicalJSONString(initialInventory)) {
        retainedBackup = backupDirectory
        throw new TypeError(`${label} contents changed during backup; inspect retained recovery path ${backupDirectory}`)
      }

      let reservation
      try {
        reservation = await reserveTarget(targetDirectory, label)
        await publishStagingIntoReservation({
          targetDirectory,
          stagingDirectory,
          stagingIdentity,
          reservation,
          label,
          beforePublish: hooks.beforePublish,
          onStagingClosed: () => { stagingClosed = true },
        })
        complete = true
      } catch (error) {
        const retainedPartial = reservation
          ? await retainOwnedReservation(targetDirectory, reservation)
          : null
        retainedBackup = backupDirectory
        throw new Error(
          `${label} publication failed; original retained at recovery path ${backupDirectory}`
            + (retainedPartial ? ` and partial output retained at ${retainedPartial}` : ''),
          { cause: error },
        )
      }
      try {
        await removeVerifiedBackup({
          backupRoot,
          backupRootIdentity,
          backupDirectory,
          initialDirectoryIdentity: initial,
          inventory: initialInventory,
          label,
        })
      } catch (error) {
        retainedBackup = backupDirectory
        process.stderr.write(
          `Final output committed; retained recoverable backup ${backupDirectory}: ${error.message}\n`,
        )
      }
    },
    async rollback() {
      if (!complete && !stagingClosed) {
        await cleanupOwnedStaging(stagingDirectory, stagingIdentity, label)
        stagingClosed = true
      }
    },
  }
}
