import { AdapterError } from "../../domain/errors.ts";
import type { HostOperationDescriptor, HostProtocolDescriptor } from "../discovery/types.ts";

export interface AdaptedHostRequest {
  readonly service: "agent" | "task";
  readonly method: string;
  readonly params: unknown;
}

export function adaptHostRequest(
  protocol: HostProtocolDescriptor,
  method: string,
  params: unknown,
): AdaptedHostRequest {
  if (method === "cancelGeneration") {
    return {
      service: protocol.operations.cancelGeneration.service,
      method: protocol.operations.cancelGeneration.method,
      params: remapSession(requireRecord(params), protocol.operations.cancelGeneration),
    };
  }

  if (method === "respondStructuredInput") {
    const input = requireRecord(params);
    const response = requireRecord(input.response);
    const { response: _response, ...base } = input;
    const remapped = remapSession(base, protocol.operations.respondStructuredInput);
    return {
      service: protocol.operations.respondStructuredInput.service,
      method: protocol.operations.respondStructuredInput.method,
      params: { ...remapped, ...response },
    };
  }

  if (method === "respondPermission") {
    const input = requireRecord(params);
    const { optionId, response: _response, ...base } = input;
    const remapped = remapSession(base, protocol.operations.respondPermission);
    return {
      service: protocol.operations.respondPermission.service,
      method: protocol.operations.respondPermission.method,
      params: { ...remapped, optionId: requireString(optionId, "permission optionId") },
    };
  }

  return { service: "agent", method, params };
}

function remapSession(
  params: Record<string, unknown>,
  operation: HostOperationDescriptor,
): Record<string, unknown> {
  const sessionId = requireString(params.sessionId, "sessionId");
  const { sessionId: _sessionId, ...rest } = params;
  return { ...rest, [operation.sessionParameter]: sessionId };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdapterError("NATIVE_PROTOCOL_ERROR", "Host bridge parameters must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterError("NATIVE_PROTOCOL_ERROR", `Host bridge ${name} must be a string`);
  }
  return value;
}
