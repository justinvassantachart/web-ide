import type {
  RuntimeHostServiceV1,
  RuntimeSession,
} from '@/web-ide/contracts/runtime'
import type { Disposable } from '@/web-ide/core/disposable'

const CAPABILITY = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/
const HOST_CHANNEL_HEADER_BYTES = 36
const MAX_ATOMIC_FRAME_BYTES = 64 * 1024 - 1

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

function uint(value: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new TypeError(`${label} must be an integer between 0 and ${max}`)
  }
}

/** Validates the public runtime host-service descriptor boundary. */
export function validateRuntimeHostServiceV1(service: RuntimeHostServiceV1): void {
  if (service === null || typeof service !== 'object') {
    throw new TypeError('host service must be an object')
  }
  if (
    typeof service.capability !== 'string'
    || !wellFormed(service.capability)
    || service.capability.length > 255
    || !CAPABILITY.test(service.capability)
  ) throw new TypeError('host service capability must be a reverse-DNS identifier')
  uint(service.version, 0xffff, 'host service version')
  if (service.version === 0) throw new TypeError('host service version must be positive')
  if (typeof service.open !== 'function') throw new TypeError('host service open must be a function')
  if (service.limits !== undefined) {
    if (service.limits === null || typeof service.limits !== 'object' || Array.isArray(service.limits)) {
      throw new TypeError('host service limits must be an object')
    }
    const allowed = new Set(['maxFrameBytes', 'maxPendingSends', 'maxInFlightRequests'])
    for (const key of Object.keys(service.limits)) {
      if (!allowed.has(key)) throw new TypeError(`host service limits.${key} is unknown`)
    }
    if (service.limits.maxFrameBytes !== undefined) {
      uint(service.limits.maxFrameBytes, MAX_ATOMIC_FRAME_BYTES, 'limits.maxFrameBytes')
      const openPayloadBytes = new TextEncoder().encode(JSON.stringify({
        capability: service.capability,
        version: service.version,
      })).length
      const minimum = HOST_CHANNEL_HEADER_BYTES + openPayloadBytes
      if (service.limits.maxFrameBytes < minimum) {
        throw new TypeError(`limits.maxFrameBytes must be at least ${minimum}`)
      }
    }
    if (service.limits.maxPendingSends !== undefined) {
      uint(service.limits.maxPendingSends, 1024, 'limits.maxPendingSends')
    }
    if (service.limits.maxInFlightRequests !== undefined) {
      uint(service.limits.maxInFlightRequests, 1024, 'limits.maxInFlightRequests')
    }
  }
}

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
  validateRuntimeHostServiceV1(service)
  return session.registerHostService(service)
}
