import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import {
  recordStudioSequence,
  StudioMcpClient,
  studioViewportCapture,
} from "../packages/studio-runner/src/studio-mcp.js";
import { contentHash } from "../packages/contracts/src/index.js";
import { runNativeProcess } from "../packages/studio-runner/src/native-worker.js";
import { SequenceFrameStore } from "../packages/studio-runner/src/sequence-frames.js";
import { probeClock } from "../packages/studio-runner/src/sequence-timing.js";

test("long sequences persist original frames to disk one at a time", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-long-sequence-"));
  try {
    const store = new SequenceFrameStore(root);
    const small = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    const large = PNG.sync.write(new PNG({ width: 512, height: 256 }), { deflateLevel: 0 });
    assert.ok(large.length > 512 * 1024);
    for (let i = 0; i < 1180; i++)
      await store.append({
        bytes: i < 260 ? large : small,
        mediaType: "image/png",
        playerUserId: -1,
        studioId: "offline",
        startedAt: new Date(i * 500).toISOString(),
        endedAt: new Date(i * 500 + 20).toISOString(),
      });
    const frames = store.frames;
    assert.equal(frames.length, 1180);
    assert.ok(frames.reduce((total, frame) => total + frame.bytes, 0) > 128 * 1024 * 1024);
    assert.deepEqual(await readFile(resolve(root, frames[0]!.file)), large);
    assert.deepEqual(await readFile(resolve(root, frames.at(-1)!.file)), small);
    await assert.rejects(
      store.append({
        bytes: Buffer.from("invalid"),
        mediaType: "image/png",
        playerUserId: -1,
        studioId: "offline",
        startedAt: "",
        endedAt: "",
      }),
      /truncated/,
    );
    assert.equal(store.frames.length, 1180, "A failed new frame cannot discard earlier frames");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const placeFile = "BasaltEval-0123456789abcdef0123.rbxlx";
const sessionId = "studio-0123456789abcdef0123";

// These timers model normal bound scenario completion; hard Stop has separate tests.
function recordingLifecycle(ending?: AbortSignal) {
  const completion = new AbortController();
  const finish = () =>
    completion.abort({
      sessionId,
      scenarioId: "recorded",
      trialId: "trial-" + "a".repeat(24),
      runtimeHash: "b".repeat(64),
      completedAt: new Date().toISOString(),
      generation: 1,
    });
  ending?.addEventListener("abort", finish, { once: true });
  return {
    signal: new AbortController().signal,
    completion: { scenarioId: "recorded", signal: completion.signal },
    finish,
  };
}

// Real subprocess/stdio framing, entirely offline. No Roblox or provider executable is invoked.
function fixture(
  options: {
    mode?: string;
    bytes?: Buffer;
    mimeType?: string;
    timeout?: number;
    studiosMs?: number;
    studios?: unknown;
    studioId?: string;
    structured?: boolean;
    wrapped?: boolean;
    actorByStudio?: Record<string, number>;
    sessionByStudio?: Record<string, string>;
    captureDelayByStudio?: Record<string, number>;
    onCapture?: (count: number) => void;
    /** Called when a screen_capture request has its answer, with the Studio of the request. */
    onCaptured?: (count: number, studioId: string) => void;
    /** Hold the answers of the earlier screen_capture requests until this request starts. */
    holdAnswersUntilRequest?: number;
    /** After this many screen_capture requests, each request times out after 100 ms. */
    timeoutAfterCaptures?: number;
    /** The identity probe of each of these Studios gets its answer only after this time in ms. */
    lateProbeMs?: Record<string, number>;
    /** The time limit of each identity probe and Studio state request, in ms. */
    probeTimeout?: number;
    /** Each of these Studios reports Edit mode for this number of state requests. */
    editStates?: Record<string, number>;
  } = {},
) {
  const data = options.bytes ?? PNG.sync.write(new PNG({ width: 1279, height: 721 }));
  const entries = options.studios ?? [{ id: "chosen-studio", name: placeFile }];
  const listResult = options.structured
    ? { structuredContent: { studios: entries } }
    : {
        content: [
          { type: "text", text: JSON.stringify(options.wrapped ? { studios: entries } : entries) },
        ],
      };
  const source = `
    import readline from 'node:readline';
    const mode = ${JSON.stringify(options.mode ?? "ok")};
    const actorByStudio = ${JSON.stringify(options.actorByStudio ?? {})};
    const sessionByStudio = ${JSON.stringify(options.sessionByStudio ?? {})};
    const captureDelayByStudio = ${JSON.stringify(options.captureDelayByStudio ?? {})};
    const lateProbeMs = ${JSON.stringify(options.lateProbeMs ?? {})};
    const editStates = ${JSON.stringify(options.editStates ?? {})};
    let initialized = false;
    let discoveries = 0;
    let listings = 0;
    let captures = 0;
    const schema = (name) => ({name, inputSchema: {type:'object', properties: name === 'list_roblox_studios' ? {} : {studio_id:{type:'string'}, ...(name==='screen_capture' ? {capture_id:{type:'string'}} : {}), ...(name==='execute_luau' ? {code:{type:'string'},datamodel_type:{enum:['Edit','Client','Server'],type:'string'}} : {})}, required: name === 'list_roblox_studios' ? [] : ['studio_id', ...(name==='screen_capture' ? ['capture_id'] : []), ...(name==='execute_luau' ? ['code','datamodel_type'] : []), ...(mode==='unknown-required' && name==='screen_capture' ? ['camera'] : [])]}});
    const write = (id, result) => {
      const data = JSON.stringify({jsonrpc:'2.0',id,result})+'\\n';
      process.stdout.write(data.slice(0, 11)); process.stdout.write(data.slice(11));
    };
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'notifications/initialized') {initialized=true;return;}
      if (m.method === 'initialize') {
        if (mode === 'timeout') return;
        if (mode === 'malformed') {process.stdout.write('invalid\\n');return;}
        write(m.id, {protocolVersion: mode === 'protocol' ? 'bad' : '2025-11-25', capabilities:{tools:{}}, serverInfo:{name:'offline-fixture',version:'test'}});return;
      }
      if (!initialized) process.exit(12);
      if (m.method === 'tools/list') {
        listings++;
        if (mode === 'late-tools' && listings <= 2) {write(m.id, {tools:[]});return;}
        if (!m.params.cursor) write(m.id, {tools:[schema('list_roblox_studios')], nextCursor:'page2'});
        else write(m.id, {tools:[schema('get_studio_state'), schema('screen_capture'), ...(Object.keys(actorByStudio).length ? [schema('execute_luau')] : [])], ...(mode==='cursor-loop' ? {nextCursor:'page2'} : {})});
        return;
      }
      const name = m.params.name, args = m.params.arguments;
      if (name === 'list_roblox_studios') {
        discoveries++;
        if (mode === 'registering' && discoveries < 4) {
          const text = discoveries === 1 ? 'Unable to reach Roblox Studio right now.' : JSON.stringify({studios: discoveries === 2 ? [] : [{id:'chosen-studio',name:null}]});
          write(m.id, {isError:discoveries===1,content:[{type:'text',text}]}); return;
        }
        write(m.id, ${JSON.stringify(listResult)});return;
      }
      if (name === 'execute_luau') {
        const match = /BASALT_ACTOR_([a-f0-9]{24})=/.exec(args.code);
        if (!match || !args.code.includes('return "BASALT_ACTOR_') || args.datamodel_type !== 'Client' || !(args.studio_id in actorByStudio)) process.exit(17);
        const clocks = ':'+(Date.now()/1000+0.25).toFixed(6)+':'+(Date.now()/1000).toFixed(3);
        const answer = () => write(m.id, {content:[{type:'text',text:'BASALT_ACTOR_'+match[1]+'='+actorByStudio[args.studio_id]+':'+(sessionByStudio[args.studio_id] ?? ${JSON.stringify(sessionId)})+clocks}]});
        if (args.studio_id in lateProbeMs) setTimeout(answer, lateProbeMs[args.studio_id]); else answer();
        return;
      }
      if (Object.keys(actorByStudio).length && name === 'get_studio_state') {
        if (editStates[args.studio_id] > 0) {
          editStates[args.studio_id]--;
          write(m.id, {content:[{type:'text',text:'- Current Studio Mode: Edit\\n- Available DataModels: Edit'}]});return;
        }
        write(m.id, {content:[{type:'text',text:'- Current Studio Mode: Play\\n- Available DataModels: Client, Server\\n- Focused DataModel in the viewport: Client'}]});return;
      }
      if ((Object.keys(actorByStudio).length ? !(args.studio_id in actorByStudio) : args.studio_id !== ${JSON.stringify(options.studioId ?? "chosen-studio")}) || Object.keys(args).length !== (name==='screen_capture' ? 2 : 1)) process.exit(13);
      if (name === 'get_studio_state') {
        write(m.id, mode === 'disconnected' ? {isError:true,content:[{type:'text',text:'not connected'}]} : {content:[{type:'text',text:'Play Client is active'}]}); return;
      }
      if (name !== 'screen_capture') process.exit(14);
      if (!/^ScreenCapture_[a-f0-9]{20}$/.test(args.capture_id)) process.exit(15);
      captures++;
      if (mode === 'capture-timeout-after-three' && captures > 3) return;
      if (['closed-after-three','place-closed-after-three','capture-fails-after-three'].includes(mode) && captures > 3) {
        const text = mode === 'closed-after-three' ? 'Target is closed (HOST_INVOKE_ScreenCaptureTool_CaptureScreen_ToRequester, Client)' : mode === 'place-closed-after-three' ? 'Place is not open' : 'Unexpected screenshot failure';
        write(m.id, {isError:true,content:[{type:'text',text}]});return;
      }
      const image = {type:'image',mimeType:${JSON.stringify(options.mimeType ?? "image/png")},data:${JSON.stringify(data.toString("base64"))}};
      if (mode === 'bad-base64') image.data='not+base64';
      const result = {isError:mode==='image-error',content:mode==='no-image' ? [{type:'text',text:'capture unavailable'}] : mode==='two-images' ? [image,image] : [image]};
      if (args.studio_id in captureDelayByStudio) setTimeout(() => write(m.id, result), captureDelayByStudio[args.studio_id]);
      else write(m.id, result);
    });
  `;
  const client = new StudioMcpClient(
    process.execPath,
    ["--input-type=module", "-e", source],
    // A loaded host can start the fake process slowly. Only a test of a timeout sets a short one.
    options.timeout ?? 60_000,
    { toolsMs: 8_000, studiosMs: options.studiosMs ?? 10_000, pollMs: 20 },
  );
  const request = client.request.bind(client);
  const close = client.close.bind(client);
  let requested = 0;
  let answered = 0;
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  // A stop also ends a held answer.
  client.close = () => {
    release();
    close();
  };
  client.request = async (method, params, onTimeout) => {
    if (
      options.probeTimeout !== undefined &&
      method === "tools/call" &&
      (params.name === "execute_luau" || params.name === "get_studio_state")
    ) {
      const limits = client as unknown as { timeoutMs: number };
      const timeoutMs = limits.timeoutMs;
      limits.timeoutMs = options.probeTimeout;
      try {
        return await request(method, params, onTimeout);
      } finally {
        limits.timeoutMs = timeoutMs;
      }
    }
    if (method !== "tools/call" || params.name !== "screen_capture")
      return request(method, params, onTimeout);
    const count = ++requested;
    options.onCapture?.(count);
    if (count === options.holdAnswersUntilRequest) release();
    // The fake never answers this request, so the real timeout path of the client runs.
    if (count === (options.timeoutAfterCaptures ?? -1) + 1)
      (client as unknown as { timeoutMs: number }).timeoutMs = 100;
    const result = await request(method, params);
    if (count < (options.holdAnswersUntilRequest ?? 0)) await held;
    options.onCaptured?.(++answered, String((params.arguments as { studio_id: string }).studio_id));
    return result;
  };
  return client;
}

test("sequence capture pipelines slow screenshots without delaying the declared cadence", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-sequence-cadence-"));
  // A count of answers ends the recording, so the result does not depend on the host load.
  const lifecycle = recordingLifecycle(AbortSignal.timeout(60_000));
  try {
    const result = await recordStudioSequence({
      placeFile,
      sessionId,
      directory: resolve(root, "sequence"),
      expectedClients: 1,
      ...lifecycle,
      createClient: () =>
        fixture({
          // The first answer arrives only after the second request starts.
          holdAnswersUntilRequest: 2,
          onCaptured: (count) => count === 3 && lifecycle.finish(),
          studios: [{ id: "client-1", name: null }],
          actorByStudio: { "client-1": -1 },
        }),
    });
    assert.equal(result.status, "complete", result.reason ?? "");
    assert.ok(result.frames.length >= 3);
    assert.ok(
      Date.parse(result.frames[1]!.startedAt) <= Date.parse(result.frames[0]!.endedAt),
      "two bounded acquisitions should overlap instead of serializing capture and decoding",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sequence readiness waits for a retained frame from every actor and fires only once", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-sequence-ready-"));
  const directory = resolve(root, "sequence");
  const lifecycle = recordingLifecycle(AbortSignal.timeout(60_000));
  const answers = new Map<string, number>();
  let readyCount = 0;
  let readyAt = 0;
  let retained: Promise<string[]> | undefined;
  try {
    const result = await recordStudioSequence({
      placeFile,
      sessionId,
      directory,
      expectedClients: 2,
      ...lifecycle,
      onReady: () => {
        readyCount++;
        readyAt = Date.now();
        retained = readdir(directory);
      },
      createClient: () =>
        fixture({
          // Complete when each actor has two answers.
          onCaptured: (_, studioId) => {
            answers.set(studioId, (answers.get(studioId) ?? 0) + 1);
            if (answers.size === 2 && [...answers.values()].every((count) => count >= 2))
              lifecycle.finish();
          },
          bytes: PNG.sync.write(new PNG({ width: 16, height: 16 })),
          studios: [
            { id: "fast", name: null },
            { id: "slow", name: null },
          ],
          actorByStudio: { fast: -1, slow: -2 },
          // Actual first-frame acquisition duration from the retained live failure.
          captureDelayByStudio: { fast: 0, slow: 738 },
        }),
    });
    assert.equal(result.status, "complete", result.reason ?? "");
    assert.equal(readyCount, 1);
    const filesAtReadiness = await retained!;
    for (const userId of [-1, -2]) {
      const beforeReady = result.frames.filter(
        (frame) => frame.playerUserId === userId && Date.parse(frame.endedAt) <= readyAt,
      );
      assert.ok(beforeReady.some((frame) => filesAtReadiness.includes(frame.file)));
      assert.ok(result.frames.filter((frame) => frame.playerUserId === userId).length >= 2);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recorder failure or Stop before the first retained frame cannot release readiness", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-sequence-unready-"));
  try {
    for (const mode of ["image-error", "stop"]) {
      const abort = new AbortController();
      const failures: string[] = [];
      let ready = false;
      const timeout = setTimeout(() => abort.abort(), 60_000);
      try {
        const result = await recordStudioSequence({
          placeFile,
          sessionId,
          directory: resolve(root, mode),
          expectedClients: 1,
          ...recordingLifecycle(),
          signal: abort.signal,
          onReady: () => {
            ready = true;
          },
          onFailure: (reason) => {
            failures.push(reason);
            abort.abort();
          },
          createClient: () =>
            fixture({
              // A Stop arrives when the first screenshot request starts.
              ...(mode === "stop" ? { onCapture: () => abort.abort() } : { mode }),
              bytes: PNG.sync.write(new PNG({ width: 16, height: 16 })),
              studios: [{ id: "client", name: null }],
              actorByStudio: { client: -1 },
            }),
        });
        assert.equal(result.status, "incomplete");
        assert.equal(result.frames.length, 0);
        assert.equal(ready, false);
        assert.equal(failures.length, 1);
        assert.ok(abort.signal.aborted);
      } finally {
        clearTimeout(timeout);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one slow screenshot does not consume the next two scheduled actor slots", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-sequence-slow-"));
  const lifecycle = recordingLifecycle(AbortSignal.timeout(60_000));
  try {
    const result = await recordStudioSequence({
      placeFile,
      sessionId,
      directory: resolve(root, "sequence"),
      expectedClients: 1,
      ...lifecycle,
      createClient: () =>
        fixture({
          // The first two answers arrive only after the third request starts.
          holdAnswersUntilRequest: 3,
          onCaptured: (count) => count === 3 && lifecycle.finish(),
          studios: [{ id: "client-1", name: null }],
          actorByStudio: { "client-1": -1 },
        }),
    });
    assert.equal(result.status, "complete", result.reason ?? "");
    assert.ok(result.frames.length >= 3);
    const [first, second, third] = result.frames;
    assert.ok(
      Date.parse(third!.startedAt) <= Date.parse(first!.endedAt) &&
        Date.parse(third!.startedAt) <= Date.parse(second!.endedAt),
      "third request should not wait for the first response",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Play target closing after captured actor frames ends acquisition without hiding missing coverage", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-sequence-closed-"));
  const lifecycle = recordingLifecycle();
  try {
    const result = await recordStudioSequence({
      placeFile,
      sessionId,
      directory: resolve(root, "sequence"),
      expectedClients: 1,
      ...lifecycle,
      createClient: () =>
        fixture({
          mode: "closed-after-three",
          onCapture: (count) => count === 4 && lifecycle.finish(),
          studios: [{ id: "client-1", name: null }],
          actorByStudio: { "client-1": -1 },
        }),
    });
    assert.equal(result.status, "complete", result.reason ?? "");
    assert.equal(result.frames.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normal place closure is distinct from an unexpected capture failure, and both retain returned bytes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-sequence-retain-"));
  try {
    for (const mode of [
      "place-closed-after-three",
      "capture-fails-after-three",
      "capture-timeout-after-three",
    ]) {
      const directory = resolve(root, mode);
      const abort = new AbortController();
      const lifecycle = recordingLifecycle(abort.signal);
      const failures: string[] = [];
      const processDirectory = resolve(root, `${mode}-process`);
      await mkdir(processDirectory);
      // The real owned-process cancellation path, with Node standing in for Studio.
      // A 590-second declared scenario must stop when its recorder fails.
      const owned =
        mode === "capture-timeout-after-three"
          ? runNativeProcess({
              command: process.execPath,
              args: ["-e", "setInterval(() => {}, 1000)"],
              directory: processDirectory,
              timeoutMs: 590_000,
              signal: abort.signal,
            })
          : null;
      const result = await recordStudioSequence({
        placeFile,
        sessionId,
        directory,
        expectedClients: 1,
        ...lifecycle,
        onFailure: (reason) => {
          failures.push(reason);
          abort.abort();
        },
        createClient: () =>
          fixture({
            mode,
            ...(mode === "place-closed-after-three"
              ? { onCapture: (count: number) => count === 4 && lifecycle.finish() }
              : {}),
            ...(mode === "capture-timeout-after-three" ? { timeoutAfterCaptures: 3 } : {}),
            studios: [{ id: "client-1", name: null }],
            actorByStudio: { "client-1": -1 },
          }),
      });
      assert.equal(result.frames.length, 3);
      assert.equal(result.status, mode === "place-closed-after-three" ? "complete" : "incomplete");
      assert.equal(failures.length, mode === "place-closed-after-three" ? 0 : 1);
      assert.equal(abort.signal.aborted, mode !== "place-closed-after-three");
      if (failures.length) {
        assert.equal(
          result.reason,
          failures[0],
          "Cancellation must preserve the original acquisition error",
        );
        assert.match(
          result.reason!,
          mode === "capture-timeout-after-three" ? /timed out/ : /Unexpected screenshot failure/,
        );
      }
      if (owned)
        assert.equal(
          (await owned).reason,
          "aborted",
          "Recorder failure cannot leave the owned process running for its scenario duration",
        );
      for (const frame of result.frames)
        assert.equal(contentHash(await readFile(resolve(directory, frame.file))), frame.hash);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const players of [2, 8])
  test(`sequence recorder binds ${players} Play windows to player IDs with one MCP connection`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "basalt-sequence-mcp-"));
    const sequence = resolve(root, "native", "sequence", "scenario-attempt-01");
    const lifecycle = recordingLifecycle();
    try {
      const result = await recordStudioSequence({
        placeFile,
        sessionId,
        directory: sequence,
        expectedClients: players,
        ...lifecycle,
        createClient: () =>
          fixture({
            // Complete once every actor has two requested frames, independent of host load.
            onCapture: (count) => count === players * 2 && lifecycle.finish(),
            bytes: PNG.sync.write(new PNG({ width: 16, height: 16 })),
            studios: Array.from({ length: players }, (_, i) => ({
              id: `client-${i + 1}`,
              name: null,
            })),
            actorByStudio: Object.fromEntries(
              Array.from({ length: players }, (_, i) => [`client-${i + 1}`, -(i + 1)]),
            ),
          }),
      });
      assert.equal(result.status, "complete", result.reason ?? "");
      assert.deepEqual(
        [...new Set(result.frames.map((frame) => frame.playerUserId))].sort((a, b) => a - b),
        Array.from({ length: players }, (_, i) => i - players),
      );
      assert.ok(result.frames.length >= players * 2);
      // The identity probe of each client also reads its clocks. The fake Studio clock is
      // 250 ms ahead of the host clock, so each alignment interval contains -250 ms.
      assert.deepEqual(
        result.clockProbes.map((probe) => probe.playerUserId).sort((a, b) => a - b),
        Array.from({ length: players }, (_, i) => i - players),
      );
      for (const userId of new Set(result.clockProbes.map((probe) => probe.playerUserId))) {
        const clock = probeClock(
          result.clockProbes.filter((probe) => probe.playerUserId === userId),
        )!;
        assert.ok(
          Math.abs(clock.offsetMs + 250) <= clock.uncertaintyMs + 1,
          String(clock.offsetMs),
        );
      }
      for (const frame of result.frames) {
        assert.equal(contentHash(await readFile(resolve(sequence, frame.file))), frame.hash);
        assert.ok(Date.parse(frame.endedAt) >= Date.parse(frame.startedAt));
      }
      const transcript = JSON.parse(await readFile(resolve(sequence, "mcp.json"), "utf8"));
      // Larger actor sets legitimately roll initialization out of the bounded diagnostic tail.
      if (players === 2) {
        assert.equal(
          transcript.filter((entry: { method: string }) => entry.method === "initialize").length,
          1,
        );
        assert.equal(
          transcript.filter(
            (entry: { params: { name?: string } }) => entry.params.name === "execute_luau",
          ).length,
          players,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("sequence recorder ignores a different prepared session even when its Play name is absent", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-sequence-binding-"));
  const lifecycle = recordingLifecycle();
  try {
    const result = await recordStudioSequence({
      placeFile,
      sessionId,
      directory: resolve(root, "sequence"),
      expectedClients: 1,
      ...lifecycle,
      createClient: () =>
        fixture({
          onCapture: (count) => count === 2 && lifecycle.finish(),
          studios: [
            { id: "unrelated-client", name: null },
            { id: "prepared-client", name: null },
          ],
          actorByStudio: { "unrelated-client": -9, "prepared-client": -1 },
          sessionByStudio: { "unrelated-client": "studio-aaaaaaaaaaaaaaaaaaaa" },
        }),
    });
    assert.equal(result.status, "complete", result.reason ?? "");
    assert.ok(result.frames.length > 0);
    assert.ok(result.frames.every((frame) => frame.playerUserId === -1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Play client without a timely identity answer does not end the search, and its late answer is ignored", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-sequence-slow-probe-"));
  const lifecycle = recordingLifecycle();
  let client: StudioMcpClient | undefined;
  try {
    const result = await recordStudioSequence({
      placeFile,
      sessionId,
      directory: resolve(root, "sequence"),
      expectedClients: 1,
      ...lifecycle,
      createClient: () =>
        (client = fixture({
          onCapture: (count) => count === 3 && lifecycle.finish(),
          studios: [
            { id: "closing-client", name: null },
            { id: "prepared-client", name: null },
          ],
          actorByStudio: { "closing-client": -9, "prepared-client": -1 },
          sessionByStudio: { "closing-client": "studio-aaaaaaaaaaaaaaaaaaaa" },
          // The answer comes after the time limit of the probe, while the recording runs.
          lateProbeMs: { "closing-client": 300 },
          probeTimeout: 100,
        })),
    });
    assert.equal(result.status, "complete", result.reason ?? "");
    assert.ok(result.frames.length > 0);
    assert.ok(result.frames.every((frame) => frame.playerUserId === -1));
    const probes = client!.transcript.filter(
      (entry) => (entry.params as { name?: string } | undefined)?.name === "execute_luau",
    );
    assert.match(String(probes[0]!.error), /timed out after 100 ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the search probes a Play client of another run one time", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-sequence-foreign-"));
  const lifecycle = recordingLifecycle();
  let client: StudioMcpClient | undefined;
  try {
    const result = await recordStudioSequence({
      placeFile,
      sessionId,
      directory: resolve(root, "sequence"),
      expectedClients: 2,
      ...lifecycle,
      createClient: () =>
        (client = fixture({
          onCapture: (count) => count === 4 && lifecycle.finish(),
          studios: [
            { id: "other-lane-client", name: null },
            { id: "prepared-client-1", name: null },
            { id: "prepared-client-2", name: null },
          ],
          actorByStudio: {
            "other-lane-client": -9,
            "prepared-client-1": -1,
            "prepared-client-2": -2,
          },
          sessionByStudio: { "other-lane-client": "studio-aaaaaaaaaaaaaaaaaaaa" },
          // The second prepared client needs three more searches.
          editStates: { "prepared-client-2": 3 },
        })),
    });
    assert.equal(result.status, "complete", result.reason ?? "");
    const otherProbes = client!.transcript.filter(
      (entry) =>
        (entry.params as { name?: string; arguments?: { studio_id?: string } } | undefined)
          ?.arguments?.studio_id === "other-lane-client",
    );
    // One state request and one identity probe, in the first search only.
    assert.equal(otherProbes.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the capture check waits for Studio to advertise tools after proxy initialization", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-mcp-late-tools-"));
  const capture = studioViewportCapture(placeFile, () => fixture({ mode: "late-tools" }));
  try {
    await capture.check(root);
    const { transcript } = JSON.parse(await readFile(resolve(root, "mcp.json"), "utf8"));
    assert.equal(
      transcript.filter((entry: { method: string }) => entry.method === "tools/list").length,
      4,
    );
    assert.deepEqual(
      transcript
        .filter((entry: { method: string }) => entry.method === "tools/call")
        .map((entry: { params: { name: string } }) => entry.params.name),
      ["list_roblox_studios", "get_studio_state"],
    );
  } finally {
    capture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("viewport acquisition preserves arbitrary PNG/JPEG geometry and exact source bytes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-mcp-"));
  try {
    const size = { width: 1279, height: 721 };
    for (const mediaType of ["image/png", "image/jpeg"] as const) {
      const bytes =
        mediaType === "image/png"
          ? PNG.sync.write(new PNG(size))
          : jpeg.encode({ ...size, data: Buffer.alloc(size.width * size.height * 4, 255) }, 85)
              .data;
      const directory = resolve(root, mediaType.split("/")[1]!);
      await mkdir(directory);
      const capture = studioViewportCapture(placeFile, () =>
        fixture({ bytes, mimeType: mediaType }),
      );
      const actual = await capture.capture(directory);
      assert.deepEqual(actual, { bytes, mediaType });
      const metadata = JSON.parse(await readFile(resolve(directory, "mcp.json"), "utf8"));
      assert.equal(metadata.error, null);
      assert.equal(metadata.studioId, "chosen-studio");
      assert.equal(metadata.files[0].width, 1279);
      assert.equal(metadata.files[0].height, 721);
      assert.equal(metadata.files[0].hash, contentHash(bytes));
      assert.deepEqual(await readFile(resolve(directory, metadata.files[0].file)), bytes);
      assert.ok(!JSON.stringify(metadata).includes(bytes.toString("base64")));
      assert.equal(metadata.transcript.at(-1).params.name, "screen_capture");
      assert.match(metadata.captureId, /^ScreenCapture_[a-f0-9]{20}$/);
      assert.deepEqual(metadata.transcript.at(-1).params.arguments, {
        studio_id: "chosen-studio",
        capture_id: metadata.captureId,
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture failures retain response diagnostics and any image bytes; no fallback is called", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-mcp-"));
  try {
    for (const mode of [
      "unknown-required",
      "protocol",
      "disconnected",
      "no-image",
      "two-images",
      "bad-base64",
      "image-error",
      "malformed",
      "cursor-loop",
    ]) {
      const directory = resolve(root, mode);
      await mkdir(directory);
      await assert.rejects(
        studioViewportCapture(placeFile, () => fixture({ mode })).capture(directory),
      );
      const metadata = JSON.parse(await readFile(resolve(directory, "mcp.json"), "utf8"));
      assert.ok(metadata.error, mode);
      if (mode === "image-error" || mode === "two-images") assert.ok(metadata.files.length > 0);
      if (mode === "unknown-required" || mode === "disconnected")
        assert.ok(
          !metadata.transcript.some(
            (entry: { params: { name?: string } }) => entry.params.name === "screen_capture",
          ),
        );
    }
    const bad = resolve(root, "corrupt");
    await mkdir(bad);
    const bytes = Buffer.from("truncated image");
    await assert.rejects(
      studioViewportCapture(placeFile, () => fixture({ bytes })).capture(bad),
      /truncated/,
    );
    assert.deepEqual(await readFile(resolve(bad, "raw-1.png")), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP requests time out, close cleanly, and reject tools outside the capture allowlist", async () => {
  const client = fixture({ mode: "timeout", timeout: 100 });
  await assert.rejects(client.connect(), /timed out/);
  await assert.rejects(
    client.request("tools/call", { name: "execute_luau", arguments: {} }),
    /fixed read-only player identity/,
  );
  client.close();
  assert.throws(() => studioViewportCapture(""), /prepared Studio place/);
  assert.throws(() => studioViewportCapture("candidate.rbxlx"), /prepared Studio place/);
});

test("automatic Studio selection matches only the complete prepared name among multiple windows", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-auto-studio-"));
  try {
    const stem = placeFile.replace(/\.rbxlx$/, "");
    const names = [placeFile, stem, `/tmp/places/${placeFile}`, `Local file: ${placeFile} (Play)`];
    for (const [index, name] of names.entries()) {
      const directory = resolve(root, String(index));
      await mkdir(directory);
      const capture = studioViewportCapture(placeFile, () =>
        fixture({
          structured: index === 1,
          wrapped: index === 2,
          studios: [
            { id: "unrelated", name: "Other project" },
            { id: "saved-copy", name: `${stem}-copy.rbxlx` },
            { id: "longer-name", name: `${stem}0.rbxlx` },
            { id: "prefixed", name: `Other-${placeFile}` },
            { id: "chosen-studio", name },
          ],
        }),
      );
      await capture.capture(directory);
      const metadata = JSON.parse(await readFile(resolve(directory, "mcp.json"), "utf8"));
      assert.equal(metadata.placeFile, placeFile);
      assert.equal(metadata.studioId, "chosen-studio");
      assert.equal(
        metadata.transcript.filter(
          (entry: { params: { name?: string } }) => entry.params.name === "list_roblox_studios",
        ).length,
        1,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing, ambiguous and malformed Studio lists cannot trigger state or capture calls", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-auto-studio-"));
  const cases = [
    { studios: [], message: /No Studio window/ },
    { studios: [{ id: "wrong", name: "unrelated.rbxlx" }], message: /No Studio window/ },
    {
      studios: [{ id: "old", name: "BasaltEval-ffffffffffffffffffff.rbxlx" }],
      message: /No Studio window/,
    },
    {
      studios: [
        { id: "a", name: placeFile },
        { id: "b", name: placeFile },
      ],
      message: /Close the other Studio windows/,
    },
    {
      studios: [
        { id: "a", name: placeFile },
        { id: "a", name: "other" },
      ],
      message: /duplicate Studio/,
    },
    { studios: [{ id: 3, name: placeFile }], message: /Invalid/ },
    { studios: [{ id: "", name: placeFile }], message: /Invalid/ },
    { studios: [{ id: "a", name: null }], message: /No Studio window/ },
    { studios: { unexpected: [] }, message: /Invalid/ },
    { studios: "Select the first window", message: /Invalid/ },
  ];
  try {
    await Promise.all(
      cases.map(async (entry, index) => {
        const directory = resolve(root, String(index));
        await mkdir(directory);
        await assert.rejects(
          studioViewportCapture(placeFile, () =>
            fixture({ studios: entry.studios, studiosMs: 200 }),
          ).capture(directory),
          entry.message,
        );
        const metadata = JSON.parse(await readFile(resolve(directory, "mcp.json"), "utf8"));
        assert.equal(metadata.studioId, null);
        assert.ok(metadata.error);
        assert.deepEqual(metadata.files, []);
        const calls = metadata.transcript.filter(
          (item: { method: string }) => item.method === "tools/call",
        );
        assert.ok(
          calls.length >= 1 &&
            calls.every(
              (item: { params: { name: string } }) => item.params.name === "list_roblox_studios",
            ),
        );
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a place reopened under a new Studio ID is resolved again without cached targeting", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-auto-studio-"));
  let connection = 0;
  const capture = studioViewportCapture(placeFile, () => {
    const studioId = `instance-${++connection}`;
    return fixture({ studios: [{ id: studioId, name: placeFile }], studioId });
  });
  try {
    const preflight = resolve(root, "preflight");
    await mkdir(preflight);
    await capture.check(preflight);
    for (let index = 2; index <= 3; index++) {
      const directory = resolve(root, `capture-${index}`);
      await mkdir(directory);
      await capture.capture(directory);
      const metadata = JSON.parse(await readFile(resolve(directory, "mcp.json"), "utf8"));
      assert.equal(metadata.studioId, `instance-${index}`);
      assert.deepEqual(metadata.transcript.at(-1).params.arguments, {
        studio_id: `instance-${index}`,
        capture_id: metadata.captureId,
      });
    }
    assert.equal(connection, 3);
  } finally {
    capture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Studio registration can progress through unavailable, empty and unnamed before capture", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-registering-studio-"));
  const capture = studioViewportCapture(placeFile, () => fixture({ mode: "registering" }));
  try {
    const check = resolve(root, "check");
    await mkdir(check);
    await capture.check(check);
    const frame = resolve(root, "frame");
    await mkdir(frame);
    await capture.capture(frame);
    for (const directory of [check, frame]) {
      const metadata = JSON.parse(await readFile(resolve(directory, "mcp.json"), "utf8"));
      const calls = metadata.transcript.filter(
        (entry: { method: string }) => entry.method === "tools/call",
      );
      assert.equal(
        calls.filter(
          (entry: { params: { name: string } }) => entry.params.name === "list_roblox_studios",
        ).length,
        4,
      );
      assert.equal(
        calls.filter(
          (entry: { params: { name: string } }) => entry.params.name === "screen_capture",
        ).length,
        directory === frame ? 1 : 0,
      );
      assert.equal(metadata.studioId, "chosen-studio");
      assert.equal(metadata.error, null);
    }
  } finally {
    capture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unrelated unnamed Studio does not block a uniquely named prepared place", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-named-studio-"));
  const capture = studioViewportCapture(placeFile, () =>
    fixture({
      studios: [
        { id: "unrelated-studio", name: null },
        { id: "chosen-studio", name: placeFile },
      ],
    }),
  );
  try {
    await mkdir(resolve(root, "check"));
    await capture.check(resolve(root, "check"));
    const metadata = JSON.parse(await readFile(resolve(root, "check/mcp.json"), "utf8"));
    assert.equal(metadata.studioId, "chosen-studio");
    assert.equal(metadata.error, null);
    assert.equal(
      metadata.transcript.filter(
        (entry: { params: { name?: string } }) => entry.params.name === "list_roblox_studios",
      ).length,
      1,
    );
  } finally {
    capture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("solid-magenta renderer failures retain raw PNG/JPEG and cannot become capture receipts", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-magenta-frame-"));
  const frame = new PNG({ width: 40, height: 25 });
  for (let offset = 0; offset < frame.data.length; offset += 4) {
    frame.data.set([255, 0, 255, 255], offset);
  }
  try {
    for (const mediaType of ["image/png", "image/jpeg"] as const) {
      const bytes = mediaType === "image/png" ? PNG.sync.write(frame) : jpeg.encode(frame, 85).data;
      const directory = resolve(root, mediaType.split("/")[1]!);
      await mkdir(directory);
      await assert.rejects(
        studioViewportCapture(placeFile, () => fixture({ bytes, mimeType: mediaType })).capture(
          directory,
        ),
        /solid-magenta.*OpenGL/,
      );
      const metadata = JSON.parse(await readFile(resolve(directory, "mcp.json"), "utf8"));
      assert.match(metadata.error, /solid-magenta/);
      assert.equal(metadata.files[0].width, 40);
      assert.equal(metadata.files[0].height, 25);
      assert.equal(metadata.files[0].hash, contentHash(bytes));
      assert.deepEqual(await readFile(resolve(directory, metadata.files[0].file)), bytes);
      assert.equal(
        metadata.transcript.filter(
          (entry: { params: { name?: string } }) => entry.params.name === "screen_capture",
        ).length,
        1,
      );
    }
    // Magenta in a rendered scene is not the uniform readback failure signature.
    frame.data.set([200, 20, 200, 255], 0);
    const directory = resolve(root, "scene");
    await mkdir(directory);
    await studioViewportCapture(placeFile, () => fixture({ bytes: PNG.sync.write(frame) })).capture(
      directory,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
