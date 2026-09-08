import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from 'react'
import { EngineProvider } from '@/engine/EngineContext'
import { useEngine } from '@/engine/engine-context'
import type { WebIDEConfiguration } from './contracts/configuration'
import { IDEPluginManager } from './core/plugin-manager'
import { IDEContributionContext } from './react/contribution-context'
import { WorkbenchLayout } from './react/WorkbenchLayout'
import { WorkspaceHostBridge } from './react/WorkspaceHostBridge'
import type { RuntimeProvider } from './contracts/runtime'
import type {
  LanguageToolingProvider,
  LanguageToolingService,
} from './contracts/language-tooling'
import type { WebIDEInstanceHandle } from './contracts/instance'
import { WebIDEConfigurationContext } from './react/configuration-context'
import { InstanceHandleBridge } from './react/InstanceHandleBridge'
import { useWebIDEHost } from './react/host-context'
import { isTestProviderV2, resolveTestProvider } from '@/testing/test-execution'
import { TestingV2Mount } from '@/testing/TestingV2Mount'
import type { WorkspaceFiles } from './contracts/host'
import {
  LanguageToolingContext,
  NO_LANGUAGE_TOOLING,
} from './react/language-tooling-context'
import { resolveLanguageToolingProvider } from './core/language-tooling'
import { createRuntimeSessionFactory } from './core/runtime-provider'
import { createWebIDEInstanceController } from './core/instance-handle'
import { SourcePresentationProvider } from './react/source-presentation-context'
import { RunPipelineCoordinatorProvider } from '@/components/layout/RunPipelineCoordinator'
import { resolveWebIDEInitialLayout } from './core/initial-layout'
import { createPanelLayoutController } from './core/panel-layout'
import { PanelLayoutContext } from './react/panel-layout-context'
import { createSidebarLayoutController } from './core/sidebar-layout'
import { SidebarLayoutContext } from './react/sidebar-layout-context'
import {
  createWorkbenchInstance,
  useWorkbenchInstance,
  WorkbenchInstanceContext,
} from './react/workbench-instance-context'

const runtimeMountKeys = new WeakMap<RuntimeProvider, number>()
let nextRuntimeMountKey = 1
const languageToolingMountKeys = new WeakMap<LanguageToolingProvider, number>()
let nextLanguageToolingMountKey = 1

function getRuntimeMountKey(runtime: RuntimeProvider): string {
  let key = runtimeMountKeys.get(runtime)
  if (key === undefined) {
    key = nextRuntimeMountKey
    nextRuntimeMountKey += 1
    runtimeMountKeys.set(runtime, key)
  }
  return `${runtime.id}:${key}`
}

function getLanguageToolingMountKey(provider: LanguageToolingProvider): string {
  let key = languageToolingMountKeys.get(provider)
  if (key === undefined) {
    key = nextLanguageToolingMountKey
    nextLanguageToolingMountKey += 1
    languageToolingMountKeys.set(provider, key)
  }
  return `${provider.id}:${key}`
}

export interface WebIDEProps {
  configuration: WebIDEConfiguration
}

export const WebIDE = forwardRef<WebIDEInstanceHandle, WebIDEProps>(function WebIDE(
  props,
  instanceRef,
) {
  const host = useWebIDEHost()
  const workspaceKey = host?.workspace?.id ?? 'default-project'
  return (
    <WebIDEWorkspaceMount
      key={workspaceKey}
      {...props}
      instanceRef={instanceRef}
      workspaceKey={workspaceKey}
    />
  )
})

function WebIDEWorkspaceMount({
  configuration,
  instanceRef,
  workspaceKey,
}: WebIDEProps & {
  instanceRef: Ref<WebIDEInstanceHandle>
  workspaceKey: string
}) {
  const host = useWebIDEHost()
  const plugins = useMemo(
    () => new IDEPluginManager(configuration.plugins),
    [configuration.plugins],
  )
  const initialLayout = useMemo(
    () => resolveWebIDEInitialLayout(configuration.initialLayout),
    [configuration.initialLayout],
  )
  const panelLayoutController = useMemo(
    () => createPanelLayoutController(initialLayout.selectedPanelId),
    [initialLayout.selectedPanelId],
  )
  const sidebarLayoutController = useMemo(
    () => createSidebarLayoutController(initialLayout.selectedActivityId),
    [initialLayout.selectedActivityId],
  )
  const panelLayoutContext = useMemo(
    () => ({ controller: panelLayoutController, initialLayout }),
    [initialLayout, panelLayoutController],
  )
  const workbenchInstance = useMemo(() => createWorkbenchInstance(), [])
  workbenchInstance.workspace.setLocalMutationPolicy(
    host?.workspace?.readOnly === true,
    host?.workspace?.mutationPolicy,
  )
  const instanceController = useMemo(
    () => createWebIDEInstanceController(workbenchInstance, panelLayoutController),
    [panelLayoutController, workbenchInstance],
  )
  const runtimeProvider = plugins.runtimeProviders.get(configuration.runtimeProvider)
  const createRuntimeSession = useMemo(
    () => runtimeProvider
      ? createRuntimeSessionFactory(runtimeProvider)
      : undefined,
    [runtimeProvider],
  )

  if (!runtimeProvider) {
    throw new Error(
      `No runtime provider contributed with id "${configuration.runtimeProvider}"`,
    )
  }
  if (
    initialLayout.selectedActivityId !== undefined
    && !plugins.activities.has(initialLayout.selectedActivityId)
  ) {
    throw new Error(
      `No activity contributed with id ${JSON.stringify(initialLayout.selectedActivityId)}`,
    )
  }
  if (
    initialLayout.selectedPanelId !== undefined
    && !plugins.panels.has(initialLayout.selectedPanelId)
  ) {
    throw new Error(
      `No panel contributed with id ${JSON.stringify(initialLayout.selectedPanelId)}`,
    )
  }
  const languageToolingProvider = resolveLanguageToolingProvider(
    plugins.languageToolingProviders.getSnapshot(),
    runtimeProvider,
    configuration.languageToolingProvider,
  )
  const testProvider = resolveTestProvider(
    plugins.testProviders.getSnapshot(),
    runtimeProvider,
    configuration.testProvider,
  )
  const runtimeMountKey = getRuntimeMountKey(runtimeProvider)

  return (
    <WorkbenchInstanceContext.Provider value={workbenchInstance}>
      <WebIDEConfigurationContext.Provider value={configuration}>
        <IDEContributionContext.Provider value={plugins}>
          <PanelLayoutContext.Provider value={panelLayoutContext}>
            <SidebarLayoutContext.Provider value={sidebarLayoutController}>
            <PluginManagerLifetime plugins={plugins} />
            <WorkspaceHostBridge instanceController={instanceController} />
            <InstanceHandleBridge
              instanceRef={instanceRef}
              handle={instanceController.handle}
            />
            <EngineProvider
              key={runtimeMountKey}
              createSession={createRuntimeSession!}
            >
              <RunPipelineCoordinatorProvider>
                {testProvider && isTestProviderV2(testProvider) && (
                  <TestingV2Mount provider={testProvider} />
                )}
                <PluginActivation plugins={plugins} />
                <SourcePresentationProvider key={workspaceKey} workspaceKey={workspaceKey}>
                  <LanguageToolingMount
                    provider={languageToolingProvider}
                    supplementalFiles={testProvider?.editorSupportFiles}
                  >
                    <WorkbenchLayout />
                  </LanguageToolingMount>
                </SourcePresentationProvider>
              </RunPipelineCoordinatorProvider>
            </EngineProvider>
            </SidebarLayoutContext.Provider>
          </PanelLayoutContext.Provider>
        </IDEContributionContext.Provider>
      </WebIDEConfigurationContext.Provider>
    </WorkbenchInstanceContext.Provider>
  )
}

function LanguageToolingMount({
  provider,
  supplementalFiles,
  children,
}: {
  provider: LanguageToolingProvider | undefined
  supplementalFiles: WorkspaceFiles | undefined
  children: ReactNode
}) {
  if (!provider) return children

  return (
    <ActiveLanguageToolingMount
      key={getLanguageToolingMountKey(provider)}
      provider={provider}
      disabled={false}
      supplementalFiles={supplementalFiles}
    >
      {children}
    </ActiveLanguageToolingMount>
  )
}

function ActiveLanguageToolingMount({
  provider,
  disabled,
  supplementalFiles,
  children,
}: {
  provider: LanguageToolingProvider
  disabled: boolean
  supplementalFiles: WorkspaceFiles | undefined
  children: ReactNode
}) {
  const instance = useWorkbenchInstance()
  const instanceWorkspace = instance.workspace
  const [service, setService] = useState(NO_LANGUAGE_TOOLING)
  const active = useRef(true)
  const workspace = useMemo(() => ({
    snapshot: () => instanceWorkspace.snapshot(),
    revision: () => instanceWorkspace.revision,
    subscribe: (listener: Parameters<typeof instanceWorkspace.subscribe>[0]) =>
      instanceWorkspace.subscribe(listener),
  }), [instanceWorkspace])
  const modelNamespace = useMemo(() => ({
    toUri: (path: string) => instanceWorkspace.toMonacoUri(path),
    owns: (uri: { authority: string; path: string }) => instanceWorkspace.ownsMonacoUri(uri),
  }), [instanceWorkspace])
  const publishService = useCallback(
    (next: LanguageToolingService | null) => {
      if (active.current) setService(next ?? NO_LANGUAGE_TOOLING)
    },
    [],
  )

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const ProviderComponent = provider.component
  return (
    <LanguageToolingContext.Provider value={service}>
      <ProviderComponent
        disabled={disabled}
        supplementalFiles={supplementalFiles}
        workspace={workspace}
        modelNamespace={modelNamespace}
        publishService={publishService}
      />
      {children}
    </LanguageToolingContext.Provider>
  )
}

function PluginManagerLifetime({ plugins }: { plugins: IDEPluginManager }) {
  const pendingDisposal = useRef<
    { manager: IDEPluginManager; cancelled: boolean } | undefined
  >(undefined)

  useEffect(() => {
    // React StrictMode intentionally performs setup -> cleanup -> setup with
    // the same instance. Cancel only that same-manager deferred disposal;
    // when configuration creates a different manager, the old one still
    // disposes after its activation cleanup has unwound.
    if (pendingDisposal.current?.manager === plugins) {
      pendingDisposal.current.cancelled = true
      pendingDisposal.current = undefined
    }

    return () => {
      const ticket = { manager: plugins, cancelled: false }
      pendingDisposal.current = ticket
      queueMicrotask(() => {
        if (!ticket.cancelled) ticket.manager.dispose()
      })
    }
  }, [plugins])

  return null
}

function PluginActivation({ plugins }: { plugins: IDEPluginManager }) {
  const runtime = useEngine()

  // Custom host plugins receive the selected session only after its provider
  // exists, so they can own typed runtime-event subscriptions and cleanup.
  useEffect(() => {
    const activation = plugins.activate({ runtime })
    return () => activation.dispose()
  }, [plugins, runtime])

  return null
}
