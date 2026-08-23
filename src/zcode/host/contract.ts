import { AdapterError } from "../../domain/errors.ts";
import type { HostContractDescriptor, HostOperationDescriptor } from "../discovery/types.ts";

export interface AdaptedHostRequest {
  readonly service: "agent" | "task";
  readonly method: string;
  readonly params: unknown;
}

export function adaptHostRequest(
  contract: HostContractDescriptor,
  method: string,
  params: unknown,
): AdaptedHostRequest {
  if (method === "cancelGeneration") {
    return {
      service: contract.operations.cancelGeneration.service,
      method: contract.operations.cancelGeneration.method,
      params: remapSession(requireRecord(params), contract.operations.cancelGeneration),
    };
  }

  if (method === "respondStructuredInput") {
    const input = requireRecord(params);
    const response = requireRecord(input.response);
    const { response: _response, ...base } = input;
    const remapped = remapSession(base, contract.operations.respondStructuredInput);
    return {
      service: contract.operations.respondStructuredInput.service,
      method: contract.operations.respondStructuredInput.method,
      params: contract.operations.respondStructuredInput.responseShape === "nested"
        ? { ...remapped, response }
        : { ...remapped, ...response },
    };
  }

  if (method === "respondPermission") {
    const input = requireRecord(params);
    const { optionId, response, ...base } = input;
    const remapped = remapSession(base, contract.operations.respondPermission);
    const answer = contract.operations.respondPermission.answerShape === "response"
      ? { response: requireRecord(response) }
      : { optionId: requireString(optionId, "permission optionId") };
    return {
      service: contract.operations.respondPermission.service,
      method: contract.operations.respondPermission.method,
      params: { ...remapped, ...answer },
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
