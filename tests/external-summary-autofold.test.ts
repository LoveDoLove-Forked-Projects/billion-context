import { strict as assert } from "node:assert";
import test, { afterEach, beforeEach } from "node:test";

import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { startServer, type ProxyOptions } from "../src/server.ts";
import { defaultConfig } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

/** Anthropomorphic main upstream: records request bodies, answers SSE ok. */
function startMainUpstream(): Promise<{ server: http.Server; url: string; bodies: unknown[] }> {
    return new Promise((resolve) => {
        const bodies: unknown[] = [];
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                try { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* ignore */ }
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1000}}}\n\n`);
                res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`);
                res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
                res.end();
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies }));
    });
}

/** External summary upstream: records calls, answers a valid openai summary JSON. */
function startSummaryUpstream(mode: "ok" | "fail"): Promise<{ server: http.Server; url: string; bodies: unknown[] }> {
    return new Promise((resolve) => {
        const bodies: unknown[] = [];
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                try { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* ignore */ }
                if (mode === "fail") {
                    res.writeHead(500, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "boom" }));
                    return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ choices: [{ message: { content: "SUMMARY: the user read system docs about wifi, ups, and gpu drivers; key facts retained." }, finish_reason: "stop" }] }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies }));
    });
}

function bigConversation(): unknown[] {
    const filler = "0123456789abcdef".repeat(280); // ~4.5KB ≈ 1.1K tokens per message
    const messages: unknown[] = [];
    for (let i = 0; i < 12; i++) {
        messages.push({ role: "user", content: [{ type: "text", text: `doc chunk ${i}: ${filler}` }] });
        messages.push({ role: "assistant", content: [{ type: "text", text: `ack ${i}` }] });
    }
    messages.push({ role: "user", content: [{ type: "text", text: "final question" }] });
    return messages;
}

async function postTurn(port: number, session: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": "k",
            "anthropic-version": "2023-06-01",
            "x-acp-session": session,
        },
        body: JSON.stringify({ model: "test-model", max_tokens: 1024, stream: true, messages: bigConversation() }),
    });
    const body = await res.text();
    return { status: res.status, body };
}

const servers: { close: () => Promise<void> }[] = [];
function trackClose(server: http.Server): void {
    servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve(undefined))) });
}

beforeEach(() => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
});
afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
});

test("auto-fold fires below the window via the external chain, and the model sees no nudge", async () => {
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("ok"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 8192 },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    // ~13K tokens of text, far below the 50K window — only the 8192 growth floor fires.
    const turn = await postTurn(port, "autofold-1");
    assert.equal(turn.status, 200);

    // The external chain did the folding (zero model involvement).
    assert.ok(sum.bodies.length >= 1, `expected external summary calls, got ${sum.bodies.length}`);

    // The forwarded history is folded…
    const forwarded = main.bodies.at(-1) as { messages?: { content?: unknown }[] };
    assert.ok(forwarded && Array.isArray(forwarded.messages), "main upstream received a body with messages");
    assert.ok(forwarded.messages.length < 25, `expected folded history, got ${forwarded.messages.length} messages`);
    const text = JSON.stringify(forwarded);
    // …and the nudge never reached the model (no advisory injection while auto-fold owns cadence).
    assert.ok(!text.includes("Context breakdown:"), "nudge leaked into the forwarded payload");

    // The folded block is tagged as external-chain work (compressCallId marker
    // → "⚡ext" in the panel), so preflight folds are observable as such.
    const status = await fetch(`http://127.0.0.1:${port}/__bili/plugin/status?conversationId=autofold-1`);
    if (status.status === 200) {
        const panel = ((await status.json()) as { panel?: string }).panel ?? "";
        assert.ok(panel.includes("⚡ext"), `panel should tag the external fold with ⚡ext, got:\n${panel}`);
    }
});

test("auto-fold off: no growth fold below the window (growthArmed only when engaged)", async () => {
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("ok"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"] },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    const turn = await postTurn(port, "autofold-off");
    assert.equal(turn.status, 200);
    assert.equal(sum.bodies.length, 0, "external chain must not fold when autoFold is off and the payload fits the window");
    const forwarded = main.bodies.at(-1) as { messages?: unknown[] };
    assert.equal(forwarded.messages?.length, 25, "history must be forwarded intact");
});

test("auto-fold fail-open: broken chain forwards the request instead of failing it", async () => {
    const main = await startMainUpstream(); trackClose(main.server);
    const sum = await startSummaryUpstream("fail"); trackClose(sum.server);
    const server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: main.url,
        routes: { [main.url]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 8192 },
        },
        namedProviders: { sum: { baseUrl: sum.url, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    trackClose(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    process.env.E2E_SUM_KEY = "k";

    const turn = await postTurn(port, "autofold-fail");
    assert.equal(turn.status, 200, "growth-fold failure must forward (fail-open), not fail the request");
    assert.ok(main.bodies.length >= 1, "payload reached the main upstream");
    const text = JSON.stringify(main.bodies.at(-1));
    assert.ok(text.includes("final question"), "forwarded payload kept the conversation tail");
});
