export type AdapterErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_WORKSPACE"
  | "UNSUPPORTED_PLATFORM"
  | "UNSUPPORTED_ZCODE"
  | "RUNTIME_DISCOVERY_FAILED"
  | "RUNTIME_SMOKE_FAILED"
  | "NATIVE_PROTOCOL_ERROR"
  | "NATIVE_TIMEOUT"
  | "NATIVE_EXITED"
  | "AUTH_REQUIRED"
  | "UNSUPPORTED_CONTENT"
  | "SESSION_NOT_FOUND"
  | "SESSION_BUSY"
  | "INTERACTION_UNSUPPORTED";

export class AdapterError extends Error {
  override readonly name = "AdapterError";

  constructor(
    readonly code: AdapterErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
