import { AdapterError } from "../../domain/errors.ts";

export const DEFAULT_MAX_NATIVE_FRAME_BYTES = 16 * 1024 * 1024;

export async function* readNdjson(
  readable: ReadableStream<Uint8Array>,
  maxFrameBytes = DEFAULT_MAX_NATIVE_FRAME_BYTES,
): AsyncGenerator<unknown> {
  const reader = readable.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      pending = concatBytes(pending, result.value);

      let newline: number;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        yield* parseLine(stripTrailingCarriageReturn(line), maxFrameBytes);
      }

      if (pending.byteLength > maxFrameBytes) {
        throw frameTooLarge(maxFrameBytes);
      }
    }

    if (pending.byteLength > 0) {
      yield* parseLine(stripTrailingCarriageReturn(pending), maxFrameBytes);
    }
  } finally {
    reader.releaseLock();
  }
}

function* parseLine(
  line: Uint8Array<ArrayBufferLike>,
  maxFrameBytes: number,
): Generator<unknown> {
  if (line.byteLength === 0) {
    return;
  }
  if (line.byteLength > maxFrameBytes) {
    throw frameTooLarge(maxFrameBytes);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(line);
  } catch (error) {
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      "Native protocol contained invalid UTF-8",
      {},
      { cause: error },
    );
  }

  if (text.trim().length === 0) {
    return;
  }

  try {
    yield JSON.parse(text) as unknown;
  } catch (error) {
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      "Native stdout contained a non-JSON frame",
      {},
      { cause: error },
    );
  }
}

function stripTrailingCarriageReturn(
  value: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  return value.at(-1) === 0x0d ? value.slice(0, -1) : value;
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function frameTooLarge(maxFrameBytes: number): AdapterError {
  return new AdapterError(
    "NATIVE_PROTOCOL_ERROR",
    `Native protocol frame exceeded ${maxFrameBytes} bytes`,
  );
}
