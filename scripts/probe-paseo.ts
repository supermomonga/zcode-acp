import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

if (process.env.ZCODE_ACP_ENABLE_CONTRACT_PROBE !== "1") {
  throw new Error("Set ZCODE_ACP_ENABLE_CONTRACT_PROBE=1 to run the Paseo probe");
}

const workspace = await mkdtemp(join(tmpdir(), "zcode-acp-paseo-"));
const executable = resolve(process.env.ZCODE_ACP_PROBE_EXECUTABLE ?? "dist/zcode-acp");
await writeFile(join(workspace, "package.json"), `${JSON.stringify({
  name: "zcode-paseo-e2e-fixture",
  private: true,
}, null, 2)}\n`);

let server: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  server = await startServer(executable, await availablePort());
  const first = createOpencodeClient({ baseUrl: server.baseUrl, directory: workspace });
  const providers = await first.provider.list({ directory: workspace });
  if (providers.error || providers.data?.connected.join(",") !== "zcode") {
    throw new Error(`Unexpected providers: ${JSON.stringify(providers)}`);
  }
  const modelCatalog = providers.data.all[0]?.models ?? {};
  const models = Object.keys(modelCatalog);
  const modelNames = Object.values(modelCatalog).map((model) => model.name);
  if (models.length !== 3 || modelNames.some((name) => !name.startsWith("GLM-5"))) {
    throw new Error(`Unexpected models: ${JSON.stringify(modelCatalog)}`);
  }

  const eventsAbort = new AbortController();
  const timeout = setTimeout(() => eventsAbort.abort(), 180_000);
  const events = await first.global.event({
    sseMaxRetryAttempts: 0,
    signal: eventsAbort.signal,
  });
  const iterator = events.stream[Symbol.asyncIterator]();
  await iterator.next();
  const created = await first.session.create({ directory: workspace });
  if (created.error || !created.data?.id) throw new Error(JSON.stringify(created));
  const sessionId = created.data.id;
  const prompted = await first.session.promptAsync({
    sessionID: sessionId,
    directory: workspace,
    messageID: "paseo-live-user-1",
    model: { providerID: "zcode", modelID: models[0]! },
    agent: "build",
    parts: [{
      type: "text",
      text: "Read package.json in this workspace with the read tool, then reply with exactly zcode-paseo-e2e-fixture.",
    }],
  });
  if (prompted.error) throw new Error(JSON.stringify(prompted.error));

  let text = "";
  let toolCompleted = false;
  let idle = false;
  while (!idle) {
    const next = await iterator.next();
    if (next.done) throw new Error("OpenCode SSE ended before session.idle");
    const event = next.value.payload as {
      type: string;
      properties: Record<string, unknown>;
    };
    if (event.properties.sessionID !== sessionId) continue;
    if (event.type === "message.part.delta" && event.properties.field === "text") {
      text += String(event.properties.delta ?? "");
    }
    if (event.type === "message.part.updated") {
      const part = event.properties.part as {
        type?: string;
        state?: { status?: string };
      } | undefined;
      if (part?.type === "tool" && part.state?.status === "completed") toolCompleted = true;
    }
    if (event.type === "question.asked") {
      const question = event.properties as {
        id: string;
        questions: Array<{ options: Array<{ label: string }> }>;
      };
      await first.question.reply({
        requestID: question.id,
        directory: workspace,
        answers: question.questions.map(({ options }) => {
          const selected = options.find(({ label }) => /allow once/i.test(label)) ?? options[0];
          if (!selected) throw new Error("OpenCode question has no selectable option");
          return [selected.label];
        }),
      });
    }
    if (event.type === "session.error") {
      throw new Error(`OpenCode session failed: ${JSON.stringify(event.properties)}`);
    }
    idle = event.type === "session.idle";
  }
  clearTimeout(timeout);
  eventsAbort.abort();
  if (!toolCompleted || !text.includes("zcode-paseo-e2e-fixture")) {
    throw new Error(JSON.stringify({ toolCompleted, text }));
  }
  const messages = await first.session.messages({ sessionID: sessionId, directory: workspace });
  if (messages.error || (messages.data?.length ?? 0) < 2) {
    throw new Error(`Unexpected messages: ${JSON.stringify(messages)}`);
  }

  await server.stop();
  server = await startServer(executable, await availablePort());
  const resumed = createOpencodeClient({ baseUrl: server.baseUrl, directory: workspace });
  const restored = await resumed.session.get({ sessionID: sessionId, directory: workspace });
  if (restored.error || restored.data?.id !== sessionId) {
    throw new Error(`Session did not resume: ${JSON.stringify(restored)}`);
  }
  const history = await resumed.session.messages({ sessionID: sessionId, directory: workspace });
  if (history.error || (history.data?.length ?? 0) < 2) {
    throw new Error(`Session history did not resume: ${JSON.stringify(history)}`);
  }
  const deleted = await resumed.session.delete({ sessionID: sessionId, directory: workspace });
  if (deleted.error || deleted.data !== true) throw new Error(JSON.stringify(deleted));

  process.stdout.write(`${JSON.stringify({
    models: modelNames,
    sessionId,
    toolCompleted,
    text,
    messageCount: messages.data?.length,
    resumedMessageCount: history.data?.length,
  })}\n`);
} finally {
  await server?.stop();
  await rm(workspace, { recursive: true, force: true });
}

async function startServer(executable: string, port: number): Promise<{
  baseUrl: string;
  stop(): Promise<void>;
}> {
  const child = Bun.spawn([executable, "paseo", "serve", "--port", String(port)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("listening on ")) {
    const result = await reader.read();
    if (result.done) {
      throw new Error(`Paseo facade exited before listening: ${(await stderr).slice(-4_000)}`);
    }
    output += decoder.decode(result.value, { stream: true });
  }
  reader.releaseLock();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      const exitCode = await child.exited;
      const diagnostics = await stderr;
      if (exitCode !== 0) {
        throw new Error(`Paseo facade exited with ${exitCode}: ${diagnostics.slice(-4_000)}`);
      }
    },
  };
}

async function availablePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}
