export { WebIDEHostProvider } from './web-ide/react/WebIDEHostProvider'
export { useWebIDEHost } from './web-ide/react/host-context'
export type {
  IDEChrome,
  IDEHostEvents,
  IDEWorkspace,
  IDEWorkspacePersistence,
  IDEWorkspaceDocumentPersistence,
  WebIDEHost,
  WorkspaceFiles,
  WorkspaceSaveContext,
} from './web-ide/contracts/host'
export type {
  IDEEvent,
  IDEEventMap,
  IDEEventSink,
  IDEEventType,
  IDESessionMode,
} from './web-ide/contracts/events'

export type { WorkspaceDocumentV2, WorkspaceAssetRefV1, WorkspaceAssetPort } from './assets/contracts'
export type { WorkspaceApplyDocumentV2, WorkspaceApplyLocalDocumentV2, WorkspaceDocumentChangeV2, IDEWorkspaceDocumentFeed } from './web-ide/contracts/workspace'
