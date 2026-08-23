import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Logger } from "../../diagnostics/logger.ts";
import { redactText, redactValue, safeError } from "../../diagnostics/redaction.ts";
import { AdapterError } from "../../domain/errors.ts";
import type { SessionService } from "./session-service.ts";
import { ACP_PROTOCOL_VERSION, ZCODE_ACP_VERSION } from "../../version.ts";

const ADAPTER_ERROR_CODE = -32010;

export function createAcpAgent(service: SessionService, logger: Logger): acp.AgentApp {
  return acp
    .agent({ name: "zcode-acp" })
    .onRequest("initialize", async (context) => {
      logger.log("info", "acp.initialize", {
        requestedProtocolVersion: context.params.protocolVersion,
        clientName: context.params.clientInfo?.name,
      });
      await service.initialize(context.params);
      const terminalAuth = context.params.clientCapabilities?.auth?.terminal === true;
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
          auth: { logout: {} },
        },
        agentInfo: {
          name: "zcode-acp",
          title: "ZCode via ACP",
          version: ZCODE_ACP_VERSION,
        },
        authMethods: terminalAuth
          ? [{
              id: "zcode-cli",
              name: "ZCode OAuth",
              description: "ZCode CLI の対話ログインを実行します",
              type: "terminal",
              args: ["login"],
            }]
          : [],
      } satisfies acp.InitializeResponse;
    })
    .onRequest("authenticate", async (context) => {
      try {
        return await service.authenticate(context.params);
      } catch (error) {
        logger.error("acp.authenticate.failed", error);
        throw toRequestError(error);
      }
    })
    .onRequest("logout", async (context) => {
      try {
        return await service.logout(context.params);
      } catch (error) {
        logger.error("acp.logout.failed", error);
        throw toRequestError(error);
      }
    })
    .onRequest("session/new", async (context) => {
      try {
        return await service.newSession(context.params);
      } catch (error) {
        logger.error("acp.session_new.failed", error);
        throw toRequestError(error);
      }
    })
    .onRequest("session/load", async (context) => {
      try {
        return await service.loadSession(context.params, context.client);
      } catch (error) {
        logger.error("acp.session_load.failed", error, { sessionId: context.params.sessionId });
        throw toRequestError(error);
      }
    })
    .onRequest("session/resume", async (context) => {
      try {
        return await service.resumeSession(context.params);
      } catch (error) {
        logger.error("acp.session_resume.failed", error, { sessionId: context.params.sessionId });
        throw toRequestError(error);
      }
    })
    .onRequest("session/list", async (context) => {
      try {
        return await service.listSessions(context.params);
      } catch (error) {
        logger.error("acp.session_list.failed", error);
        throw toRequestError(error);
      }
    })
    .onRequest("session/close", async (context) => {
      try {
        return await service.closeSession(context.params);
      } catch (error) {
        logger.error("acp.session_close.failed", error, { sessionId: context.params.sessionId });
        throw toRequestError(error);
      }
    })
    .onRequest("session/set_mode", async (context) => {
      try {
        return await service.setSessionMode(context.params, context.client);
      } catch (error) {
        logger.error("acp.session_set_mode.failed", error, { sessionId: context.params.sessionId });
        throw toRequestError(error);
      }
    })
    .onRequest("session/set_config_option", async (context) => {
      try {
        return await service.setSessionConfigOption(context.params, context.client);
      } catch (error) {
        logger.error("acp.session_set_config_option.failed", error, {
          sessionId: context.params.sessionId,
        });
        throw toRequestError(error);
      }
    })
    .onRequest("session/prompt", async (context) => {
      try {
        return await service.prompt(context.params, context.client, context.signal);
      } catch (error) {
        logger.error("acp.session_prompt.failed", error, {
          sessionId: context.params.sessionId,
        });
        throw toRequestError(error);
      }
    })
    .onNotification("session/cancel", async (context) => {
      try {
        await service.cancel(context.params);
      } catch (error) {
        logger.error("acp.session_cancel.failed", error, {
          sessionId: context.params.sessionId,
        });
      }
    });
}

export async function serveAcpStdio(service: SessionService, logger: Logger): Promise<void> {
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const connection = createAcpAgent(service, logger).connect(acp.ndJsonStream(output, input));

  try {
    await connection.closed;
  } finally {
    await service.close();
  }
}

function toRequestError(error: unknown): acp.RequestError {
  if (error instanceof acp.RequestError) {
    return error;
  }
  if (error instanceof AdapterError) {
    if (error.code === "INVALID_CONFIGURATION" || error.code === "INVALID_WORKSPACE") {
      return acp.RequestError.invalidParams(
        { adapterCode: error.code },
        `: ${error.message}`,
      );
    }
    return new acp.RequestError(ADAPTER_ERROR_CODE, redactText(error.message), {
      adapterCode: error.code,
      details: redactValue(error.details),
    });
  }

  return acp.RequestError.internalError({ error: safeError(error) });
}
