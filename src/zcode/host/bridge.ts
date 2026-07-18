import { z } from "zod";
import type { Logger } from "../../diagnostics/logger.ts";
import { AdapterError } from "../../domain/errors.ts";
import { assertRuntimeSupported } from "../discovery/discover.ts";
import type { DiscoveredRuntime } from "../discovery/types.ts";
import {
  ZCodeProtocolClient,
  type NativeTransport,
} from "../protocol/client.ts";
import type { NativeNotification } from "../protocol/v1/schemas.ts";
import { DynamicEventSchema, type DynamicEvent } from "../protocol/v1/host-schemas.ts";
import { ZCODE_HOST_BRIDGE_SOURCE } from "./runtime-source.ts";

const SubscriptionResponseSchema = z.object({ subscribed: z.literal(true) }).strict();
const UnsubscriptionResponseSchema = z.object({ unsubscribed: z.literal(true) }).strict();
const EventNotificationParamsSchema = z
  .object({ subscriptionId: z.string().min(1), event: DynamicEventSchema })
  .strict();

export interface HostSubscription {
  dispose(): Promise<void>;
}

export class ZCodeHostBridge {
  private readonly handlers = new Map<string, (event: DynamicEvent) => Promise<void> | void>();
  private readonly client: ZCodeProtocolClient;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">,
    transport: BunBridgeTransport,
    private readonly logger: Logger,
  ) {
    this.client = new ZCodeProtocolClient(
      transport,
      logger,
      undefined,
      (notification) => this.handleNotification(notification),
    );
    this.client.start();
    void drain(child.stderr).then((byteCount) => {
      logger.log("debug", "zcode.host.stderr.closed", { byteCount });
    });
  }

  static start(
    runtime: DiscoveredRuntime,
    logger: Logger,
    environment: NodeJS.ProcessEnv = process.env,
  ): ZCodeHostBridge {
    assertRuntimeSupported(runtime);
    const child = Bun.spawn(
      [runtime.paths.executable, "-e", ZCODE_HOST_BRIDGE_SOURCE],
      {
        cwd: runtime.paths.installRoot,
        env: {
          ...environment,
          ELECTRON_RUN_AS_NODE: "1",
          ZCODE_ACP_HOST_INDEX: runtime.paths.hostIndex,
          ZCODE_ACP_HOST_RPC_MODULE: runtime.paths.hostRpcModule,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const bridge = new ZCodeHostBridge(
      child,
      new BunBridgeTransport(child.stdin, child.stdout),
      logger,
    );
    logger.log("info", "zcode.host.started", { pid: child.pid });
    void child.exited.then((exitCode) => {
      logger.log(exitCode === 0 ? "info" : "error", "zcode.host.exited", {
        pid: child.pid,
        exitCode,
      });
    });
    return bridge;
  }

  request<Schema extends z.ZodType>(
    method: string,
    params: unknown,
    resultSchema: Schema,
    timeoutMs = 30_000,
  ): Promise<z.output<Schema>> {
    return this.client.request(method, params, resultSchema, timeoutMs);
  }

  async subscribe(
    target: {
      workspacePath: string;
      sessionId: string;
      deliveryKind: "desktop-continuous";
      includeSnapshot: boolean;
    },
    handler: (event: DynamicEvent) => Promise<void> | void,
  ): Promise<HostSubscription> {
    const subscriptionId = crypto.randomUUID();
    this.handlers.set(subscriptionId, handler);
    try {
      await this.request(
        "__subscribe",
        { subscriptionId, target },
        SubscriptionResponseSchema,
      );
    } catch (error) {
      this.handlers.delete(subscriptionId);
      throw error;
    }

    let disposed = false;
    return {
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        this.handlers.delete(subscriptionId);
        await this.request(
          "__unsubscribe",
          { subscriptionId },
          UnsubscriptionResponseSchema,
        );
      },
    };
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async handleNotification(notification: NativeNotification): Promise<void> {
    if (notification.method !== "event") {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `Unsupported host notification: ${notification.method}`,
      );
    }
    const parsed = EventNotificationParamsSchema.parse(notification.params);
    const handler = this.handlers.get(parsed.subscriptionId);
    if (handler === undefined) {
      this.logger.log("debug", "zcode.host.event.after_unsubscribe", {
        subscriptionId: parsed.subscriptionId,
      });
      return;
    }
    await handler(parsed.event);
  }

  private async closeInternal(): Promise<void> {
    this.handlers.clear();
    await this.client.close();
    if (await waitForExit(this.child, 4_000)) return;
    this.child.kill("SIGTERM");
    if (await waitForExit(this.child, 2_000)) return;
    this.child.kill("SIGKILL");
    await this.child.exited;
  }
}

class BunBridgeTransport implements NativeTransport {
  private closed = false;

  constructor(
    private readonly stdin: Bun.FileSink,
    readonly readable: ReadableStream<Uint8Array>,
  ) {}

  async write(frame: string): Promise<void> {
    if (this.closed) throw new AdapterError("NATIVE_EXITED", "ZCode host stdin is closed");
    this.stdin.write(frame);
    await this.stdin.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stdin.end();
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return total;
      total += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

function waitForExit(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
