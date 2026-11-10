# Images and workspace documents

The `0.11.0-images.0` candidate supplies one image core to the Python and C++
graphics companions. The engine mounts ordinary bytes; image decoding, rendering
and persistence remain outside the engine. No Pillow, Tk or remote image fetch is
required.

## Host workspace integration

Import framework-free contracts from `web-ide/assets`:

```ts
import type { WorkspaceDocumentV2, WorkspaceAssetPort } from 'web-ide/assets'

const initialDocument: WorkspaceDocumentV2 = {
  schemaVersion: 2,
  files: [{ path: '/workspace/main.py', content: 'print("hello")\n' }],
  assets: [],
}
```

Provide `workspace.initialDocument` and `workspace.assets`, with memory workspace
caching. Add `workspace.documentPersistence` when edits should persist. Do not also provide
`initialFiles` or legacy `persistence`. `documentPersistence.save` receives the
complete immutable document for one workspace revision. Commit source and asset
references in one host compare-and-swap transaction. A reference contains a
canonical path, immutable blob identity, SHA-256, encoded byte length and MIME
type. `WorkspaceAssetPort.stage` stages immutable bytes and returns that reference;
staging alone does not attach it to a document.

`WorkspaceAssetPort.read` must authorize every read and return encoded bytes.
The IDE verifies length, digest and image header before mounting bytes. Optional
capabilities control import, delete, download and promotion. They are interface
policy, not a replacement for backend authorization.

Use `handle.workspace.documentSnapshot()` and `subscribeDocument()` for complete
state. `applyDocument()` is an external-authority full-document CAS operation;
`applyLocalDocument()` checks local-user policies before the same atomic commit.
Both require the current expected revision. Legacy fine-grained source edits
preserve assets; whole-workspace V1 replacement is rejected in V2 mode.
`handle.persistedDocument` projects current persistable source and asset references.
Keep asset ports stable while their authority is unchanged; replacing the port
cancels pending reads/uploads without resetting source edits. Change the mounted
workspace identity when switching principals, and enforce authorization in the port.

Paths use the existing workspace contract: absolute paths below `/workspace`, NFC
Unicode, no traversal, empty segments, backslashes or unpaired surrogates, at most
1,024 code points. Source text uses LF. File/directory and source/image collisions
are rejected before mutation. This generic package permits at most 500 entries
and 64 MiB of encoded images; hosts may enforce tighter limits.

The Explorer imports PNG, JPEG and non-animated WebP through the asset port.
Images open in a separate preview with original-file download, never as Monaco
text. Rename, folder rename, delete and undo preserve immutable references.
Read-only workspaces cannot stage or modify assets.

Run, Debug, tests and compiler warmup capture one document before asynchronous
reads. Cancellation aborts materialization. Execution plans own their bytes and
reject collisions with runtime files. `/workspace/images/photo.png` mounts as
`/images/photo.png`, matching source mapping; student code opens `images/photo.png`
relative to the guest root. A later edit cannot change an in-progress run.

## Shared graphics service

`createImageService()` owns one run's resources, transfers, presentation gallery
and generated outputs. The default codec uses `createImageBitmap` and
`OffscreenCanvas`; the entrypoint imports in workers without React, Monaco or a
DOM. Other environments can inject an `ImageCodec`.

Pixels are tightly packed row-major straight RGBA8. Decode respects orientation
and normalizes to sRGB. JPEG encoding composites transparency on white; PNG keeps
alpha. Animated images are rejected. Headers are checked before decode and actual
encoded MIME types afterward.

Default limits are 8 MiB encoded per image, 4,000,000 pixels, 4,096 pixels per axis,
128 MiB aggregate host image allocations, 64 MiB transfers, 32 KiB raw chunks,
32 presentations, 32 output paths and 256 live resource revisions. Abandoned
transfers expire after 60 seconds; collected logical resource metadata is removed.
Adapters charge renderer backing stores with `reserveExternalBytes`; reservations
remain charged through reset until the actual codec or renderer releases them. Companions
also enforce their compact guest allocation budget.

Protocol version 1 uses shared image mux channel 3. Encoded uploads use
`encoded.begin`, sequential `transfer.write`, then `encoded.decode`; pixel uploads
use `rgba.begin` and `rgba.commit`. Resource IDs and immutable versions prevent
retained scene nodes from changing when student code mutates an image. Pixel
loops remain local and do not need per-pixel host calls.

Adapters pin resources while scenes reference them. Publish a replacement scene
before releasing old pins. Guest ownership and scene pins are independent. Worker
hosts forward scene changes before image-release events.
`createImageResourceReplica()` stores owned, validated events on the rendering
side and rejects stale generations.

`presentation.show` retains an image independently of the graphics canvas. Gallery
PNG download works without a guest save and after completion. `disconnect()`
cancels transfers but retains displayed images and outputs. `reset()` and disposal
invalidate the generation and clear retained state. Reset on a new run; never
deliver old asynchronous replies into its replacement.

## Generated files

Adapters encode through `resource.encode`, obtain an `output.prepare` receipt,
write all encoded bytes into an ordinary guest file, then call `output.commit`.
Abort the receipt on write failure. Commit is idempotent within a 256-receipt
retry window; completed receipts become eligible for eviction only after their
transfer is gone, so an evicted prepare cannot replay its bytes. A failed replacement
leaves the prior output downloadable. Same-run reload and ordinary file APIs work.
Downloads survive normal exit. Saving a guest file does not implicitly modify the
persistent project: explicit Save to Project stages bytes and commits its reference
with the current source at one revision.

Hosts can provide `WorkspaceAssetPort.validateDocument` to apply stricter file
count, byte and path limits before upload and before every V2 commit. Uploads are
cancellable and preserve source edits made while bytes are staged; a conflicting
destination fails atomically. Image Undo reauthorizes every restored reference
before reattaching it. Preview supports fit and fixed zoom with natural dimensions.

## Validation and delivery

Contract tests cover atomic V2 changes, cancellation, ownership, chunk limits,
retained presentations, output receipts and canonical paths. The browser image
journey imports, previews, renames, deletes, undoes, saves and loads exact bytes in
Python Run and Debug. Existing Python/C++ debugger tests and the packed external
consumer remain required. The consumer imports `web-ide/assets` with NodeNext and
browser bundling.

The engine fork input and consumer lock bind exact engine source, tarball, SHA-512
integrity, embedded module and WASM. Historical stable-release fixtures retain
their original 0.10.1 schema and do not certify this prerelease. The staging
candidate has a separate source, checksum and observed acceptance record. Compiler
and sysroot identities remain unchanged; the engine admits the updated C++ graphics
certificate alongside the previous certificate. Pin the complete compatible tuple
in companions and hosts.
