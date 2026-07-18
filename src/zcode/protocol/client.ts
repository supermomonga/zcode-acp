import type { z } from "zod";
import { AdapterError } from "../../domain/errors.ts";
import type { Logger } from "../../diagnostics/logger.ts";
import {
  NativeEnvelopeSchema,
  type NativeEnvelope,
  type NativeNotification,
  type NativeRequest,
} from "./v1/schemas.ts";
import { readNdjson } from "./ndjson.ts";

export interface NativeTransport {
  readonly readable: ReadableStream<Uint8Array>;
  write(frame: string): Promise<void>;
  close(): Promise<void>;
}

export type ReverseRequestHandler = (request: NativeRequest) => Promise<unknown>;
export type NotificationHandler = (notification: NativeNotification) => Promise<void> | void;

interface PendingRequest {
  readonly method: string;
  readonly parse: (value: unknown) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class ZCodeProtocolClient {
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readLoop: Promise<void> | undefined;
  private notificationQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly transport: NativeTransport,
    private readonly logger: Logger,
    private readonly reverseRequestHandler?: ReverseRequestHandler,
    private readonly notificationHandler?: NotificationHandler,
  ) {}

  start(): void {
    if (this.readLoop !== undefined) {
      return;
    }
    this.readLoop = this.runReadLoop();
    void this.readLoop.catch(() => undefined);
  }

  async request<Schema extends z.ZodType>(
    method: string,
    params: unknown,
    resultSchema: Schema,
    timeoutMs = 30_000,
  ): Promise<z.output<Schema>> {
    if (this.closed) {
      throw new AdapterError("NATIVE_EXITED", "Native protocol transport is closed");
    }
    this.start();

    const id = this.nextRequestId++;
    const key = String(id);
    const response = new Promise<z.output<Schema>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(
          new AdapterError("NATIVE_TIMEOUT", `Native request timed out: ${method}`, {
            method,
            timeoutMs,
          }),
        );
      }, timeoutMs);

      this.pending.set(key, {
        method,
        parse: (value) => resultSchema.parse(value),
        resolve: (value) => resolve(value as z.output<Schema>),
        reject,
        timer,
      });
    });

    try {
      await this.transport.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch (error) {
      const pending = this.pending.get(key);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
        pending.reject(error);
      }
    }
    return response;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.transport.close();
    this.rejectAll(new AdapterError("NATIVE_EXITED", "Native protocol transport closed"));
    void this.readLoop?.catch(() => undefined);
  }

  private async runReadLoop(): Promise<void> {
    try {
      for await (const value of readNdjson(this.transport.readable)) {
        await this.handleEnvelope(NativeEnvelopeSchema.parse(value));
      }
      if (!this.closed) {
        throw new AdapterError("NATIVE_EXITED", "Native stdout closed unexpectedly");
      }
    } catch (error) {
      this.closed = true;
      this.rejectAll(error);
      this.logger.error("zcode.transport.failed", error);
      throw error;
    }
  }

  private async handleEnvelope(envelope: NativeEnvelope): Promise<void> {
    if ("method" in envelope && "id" in envelope) {
      await this.handleReverseRequest(envelope);
      return;
    }
    if ("method" in envelope) {
      if (this.notificationHandler !== undefined) {
        this.notificationQueue = this.notificationQueue.then(() =>
          this.notificationHandler!(envelope)
        );
        void this.notificationQueue.catch((error) => {
          if (this.closed) return;
          this.closed = true;
          this.rejectAll(error);
          this.logger.error("zcode.notification.failed", error);
        });
      }
      return;
    }

    const pending = this.pending.get(String(envelope.id));
    if (pending === undefined) {
      this.logger.log("warn", "zcode.response.late_or_unknown", { responseId: envelope.id });
      return;
    }
    this.pending.delete(String(envelope.id));
    clearTimeout(pending.timer);

    if ("error" in envelope) {
      pending.reject(
        new AdapterError("NATIVE_PROTOCOL_ERROR", envelope.error.message, {
          method: pending.method,
          nativeCode: envelope.error.code,
        }),
      );
      return;
    }

    try {
      pending.resolve(pending.parse(envelope.result));
    } catch (error) {
      pending.reject(
        new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          `Native result validation failed: ${pending.method}`,
          { method: pending.method },
          { cause: error },
        ),
      );
    }
  }

  private async handleReverseRequest(request: NativeRequest): Promise<void> {
    if (this.reverseRequestHandler === undefined) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `Unsupported native reverse request: ${request.method}`,
        { method: request.method },
      );
    }

    const result = await this.reverseRequestHandler(request);
    await this.transport.write(`${JSON.stringify({ id: request.id, result })}\n`);
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
