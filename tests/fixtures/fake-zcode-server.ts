#!/usr/bin/env bun

export {};

for await (const line of console) {
  if (line.trim().length === 0) {
    continue;
  }
  const request = JSON.parse(line) as { id: string | number; method: string };
  process.stdout.write(
    `${JSON.stringify({
      id: request.id,
      result: {
        method: request.method,
        cwd: process.cwd(),
        electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === "1",
      },
    })}\n`,
  );
}
