import { useEffect, useRef, useState } from 'react'
import type { WorkspaceController } from '@/web-ide/core/workspace-controller'

/** Preview reads immutable bytes; raster files never become Monaco text models. */
export function ImageAssetPreview({ path, workspace, onClose }: { path: string; workspace: WorkspaceController; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [source, setSource] = useState<string>()
  const [error, setError] = useState<string>()
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>()
  const [zoom, setZoom] = useState('fit')
  const asset = workspace.getAsset(path)
  const identity = asset ? `${asset.blobId}:${asset.sha256}` : path
  const [loadedIdentity, setLoadedIdentity] = useState<string>()
  const current = loadedIdentity === identity
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    let url: string | undefined
    if (!asset) return
    void workspace.materializeAssets({ schemaVersion: 2, files: [], assets: [asset] }, abort.signal).then((files) => {
      if (abort.signal.aborted) return
      url = URL.createObjectURL(new Blob([new Uint8Array(files[path])], { type: asset.mediaType }))
      setError(undefined)
      setDimensions(undefined)
      setLoadedIdentity(identity)
      setSource(url)
    }).catch((reason: unknown) => { if (!abort.signal.aborted) { setLoadedIdentity(identity); setSource(undefined); setDimensions(undefined); setError(reason instanceof Error ? reason.message : 'Could not load image') } })
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url) }
  }, [asset, identity, path, workspace])
  return <dialog ref={dialog} className="vsx-image-preview" aria-label={`Image preview: ${path.split('/').pop()}`} onCancel={onClose} onClose={onClose}>
    <div className="vsx-image-preview-header"><strong>{path.replace('/workspace/', '')}</strong><button type="button" onClick={onClose} aria-label="Close image preview">×</button></div>
    {!asset ? <p role="alert">This image is no longer in the workspace.</p> : current && error ? <p role="alert">{error}</p> : current && source ? <>
      <label>Zoom <select aria-label="Image zoom" value={zoom} onChange={(event) => setZoom(event.target.value)}><option value="fit">Fit</option><option value="0.5">50%</option><option value="1">100%</option><option value="2">200%</option></select></label>
      <div className="vsx-image-preview-scroll"><img src={source} alt={path.split('/').pop()} style={zoom === 'fit' ? undefined : { width: dimensions ? dimensions.width * Number(zoom) : undefined, maxWidth: 'none', maxHeight: 'none' }} onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError('The browser could not decode this image')} /></div>
    </> : <p role="status">Loading image…</p>}
    {asset && <p>{current && dimensions && `${dimensions.width} × ${dimensions.height} pixels · `}{asset.mediaType} · {asset.byteLength.toLocaleString()} bytes</p>}
    {current && source && workspace.getAssetPort()?.capabilities?.download !== false && <a href={source} download={path.split('/').pop()}>Download original</a>}
  </dialog>
}
