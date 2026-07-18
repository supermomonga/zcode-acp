import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { nativePrompt } from "../../src/domain/session-service.ts";

describe("ACP prompt content mapping", () => {
  test("maps text, links, images, audio, and embedded resources without dropping bytes", () => {
    const blocks: acp.ContentBlock[] = [
      { type: "text", text: "inspect these" },
      { type: "resource_link", name: "remote", uri: "https://example.test/context" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      { type: "audio", mimeType: "audio/wav", data: "d2F2" },
      {
        type: "resource",
        resource: { uri: "context://notes/readme.txt", mimeType: "text/plain", text: "notes" },
      },
      {
        type: "resource",
        resource: { uri: "context://data/value.bin", blob: "AQID" },
      },
    ];

    expect(nativePrompt(blocks)).toEqual({
      content: "inspect these\n\nremote: https://example.test/context",
      attachments: [
        {
          kind: "image",
          filename: "image.png",
          mimeType: "image/png",
          dataBase64: "aGVsbG8=",
          sizeBytes: 5,
        },
        {
          kind: "audio",
          filename: "audio.wav",
          mimeType: "audio/wav",
          dataBase64: "d2F2",
          sizeBytes: 3,
        },
        {
          kind: "file",
          filename: "readme.txt",
          mimeType: "text/plain",
          textContent: "notes",
          sizeBytes: 5,
        },
        {
          kind: "file",
          filename: "value.bin",
          mimeType: "application/octet-stream",
          dataBase64: "AQID",
          sizeBytes: 3,
        },
      ],
    });
  });
});
