import type {
  RuntimeHostServiceV1,
  RuntimeSession,
} from '@/web-ide/contracts/runtime'
import type { Disposable } from '@/web-ide/core/disposable'

/** Raised when an optional service is requested from a legacy runtime. */
export class RuntimeHostServicesUnavailableError extends Error {
  readonly code = 'host_services_unavailable'

  constructor(runtimeId: string) {
    super(`Runtime provider "${runtimeId}" does not support host services`)
    this.name = 'RuntimeHostServicesUnavailableError'
  }
}

/**
 * Registers a service only through the selected instance-owned session. The
 * helper deliberately exposes no engine/channel implementation details.
 */
export function registerRuntimeHostService(
  session: RuntimeSession,
  service: RuntimeHostServiceV1,
): Disposable {
  if (session.capabilities.hostChannels !== true || !session.registerHostService) {
    throw new RuntimeHostServicesUnavailableError(session.id)
  }
  if (
    typeof service.capability !== 'string'
    || service.capability.length === 0
    || service.capability.length > 128
    || !Number.isSafeInteger(service.version)
    || service.version < 1
    || typeof service.open !== 'function'
  ) {
    throw new TypeError('runtime host service descriptor is invalid')
  }
  return session.registerHostService(service)
}
