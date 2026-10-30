import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  buildHistory,
  buildHistoryPage,
  developmentFrames,
  type BuilderMessage,
} from "../packages/reporting/src/build-history.js";
import { lineDiff, MAX_DIFF_LINES } from "../packages/reporting/src/text-diff.js";
import { plannedBuild, SOURCE_PATH, WRITTEN_SOURCE } from "./build-history-fixture.js";

test("the final checkpoint keeps the complete conversation of the build", async () => {
  const { final, run } = await plannedBuild();
  assert.equal(final.point, "finished");
  assert.equal(run.status, "locally_eligible");
  const assistants = final.conversation.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 3, "Each turn keeps its assistant message");
  const answered = new Set(
    final.conversation.flatMap((message) => (message.role === "tool" ? [message.toolCallId] : [])),
  );
  for (const message of assistants)
    for (const call of message.role === "assistant" ? message.toolCalls : [])
      assert.ok(answered.has(call.id), `The result of ${call.id} stays in the conversation`);
  const responses = final.trace.filter(
    (event) => event.kind === "model_response" && event.data.kind === "assistant",
  );
  assert.deepEqual(
    assistants.map((message) => contentHash(stableJson(message))),
    responses.map((event) => event.data.responseHash),
    "Each saved message matches the hash of its model response",
  );
});

test("a verified history shows each change, each Luau error and each request", async () => {
  const { history } = await plannedBuild();
  assert.equal(history.sealedMatch, true);
  assert.deepEqual(history.notices, []);
  assert.equal(history.prompt.includes("Make the player faster."), true);
  assert.deepEqual(
    history.turns.map((turn) => [turn.number, turn.verified, turn.requestId !== null]),
    [
      [1, true, true],
      [2, true, true],
      [3, true, true],
    ],
  );
  assert.equal(history.turns[0]!.chargeUsd, 0.001);
  const [write, patch] = [history.turns[0]!.toolCalls[0]!, history.turns[1]!.toolCalls[0]!];
  assert.equal(write.change?.verified, true);
  assert.equal(write.change?.kind, "replaced");
  assert.deepEqual(
    write.change?.hunks?.[0]?.lines.filter((line) => line.kind !== "context"),
    [
      { kind: "removed", text: "local speed = 1" },
      { kind: "added", text: "local speed = 16" },
      { kind: "added", text: "local jump = 50" },
    ],
  );
  assert.equal(patch.change?.verified, true);
  assert.deepEqual([patch.change?.added, patch.change?.removed], [1, 1]);
  assert.deepEqual(history.turns[1]!.toolCalls[1]!.luauErrors, [
    `${SOURCE_PATH}:2: Type 'string' could not be converted into 'number'`,
  ]);
  const page = buildHistoryPage(history, 1);
  assert.equal(
    "content" in (page.turns[0]!.toolCalls[0]!.arguments as object),
    false,
    "A page shows the change, not the written text again",
  );
});

test("a write that does not match its traced hash shows no content", async () => {
  const { input } = await plannedBuild();
  // Change the written text after the build: the saved message no longer matches its hash.
  const conversation = structuredClone(input.checkpoint.conversation).map((message) =>
    message.role === "assistant" && message.toolCalls[0]?.id === "write-1"
      ? ({
          ...message,
          toolCalls: [
            {
              ...message.toolCalls[0]!,
              arguments: {
                ...(message.toolCalls[0]!.arguments as object),
                content: "--!strict\nreturn 'replaced'\n",
              },
            },
          ],
        } satisfies BuilderMessage)
      : message,
  );
  const history = buildHistory({ ...input, checkpoint: { ...input.checkpoint, conversation } });
  const write = history.turns[0]!.toolCalls[0]!;
  assert.equal(history.turns[0]!.verified, false);
  assert.equal(history.turns[0]!.text, null);
  assert.equal(write.change?.verified, false);
  assert.equal(write.change?.hunks, null);
  assert.equal(JSON.stringify(write.arguments).includes("replaced"), false);
  assert.equal(JSON.stringify(write.arguments).includes(WRITTEN_SOURCE), false);
  // The patch reads the text of the unverified write, so it cannot be verified either.
  assert.equal(history.turns[1]!.toolCalls[0]!.change?.verified, false);
  assert.equal(history.totals.unverifiedChanges, 2);
});

test("a turn that disagrees with the ledger gives no request link to it or later turns", async () => {
  const { input } = await plannedBuild();
  const requests = input.requests.map((request) =>
    request.ordinal === 2 ? { ...request, latencyMs: 999 } : request,
  );
  const history = buildHistory({ ...input, requests });
  assert.deepEqual(
    history.turns.map((turn) => turn.requestId !== null),
    [true, false, false],
  );
  assert.equal(history.turns[1]!.chargeUsd, null);
  assert.ok(history.notices.some((notice) => /no request link/u.test(notice)));
});

test("the image route can serve only the development frames that followed a development call of the build", () => {
  const image = (name: string) => {
    const dataBase64 = Buffer.from(name).toString("base64");
    return { hash: contentHash(Buffer.from(name)), mediaType: "image/png", dataBase64 };
  };
  const [context, own, foreign, late] = ["context", "own", "foreign", "late"].map(image);
  const frames = (evidenceId: string, images: Array<ReturnType<typeof image>>) => ({
    role: "user" as const,
    content: `Development frames for ${evidenceId}: frame. These are debugging observations.`,
    images,
  });
  const result = (id: string, name: string, evidenceId: string) => ({
    role: "tool" as const,
    toolCallId: id,
    name,
    content: JSON.stringify({ ok: true, evidenceId }),
  });
  const conversation: BuilderMessage[] = [
    { role: "user", content: "Make the player faster." },
    { role: "user", content: "Context of the repair.", images: [context!] },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "a", name: "development.run", arguments: {} }],
    },
    result("a", "development.run", "dev-1"),
    frames("dev-1", [own!]),
    // A frame message for an observation without a development call of this batch.
    frames("dev-2", [foreign!]),
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "b", name: "workspace.read", arguments: {} }],
    },
    result("b", "workspace.read", "dev-3"),
    frames("dev-3", [foreign!]),
    // The frames of an earlier call do not count after the next answer.
    { role: "assistant", content: "", toolCalls: [] },
    frames("dev-1", [late!]),
  ];
  assert.deepEqual([...developmentFrames(conversation).keys()], [own!.hash]);
});

test("a change above the line limit is too large to show", () => {
  const large = Array.from({ length: MAX_DIFF_LINES / 2 + 1 }, (_, index) => `line ${index}`);
  assert.equal(lineDiff(large.join("\n"), [...large, "end"].join("\n")).tooLarge, true);
  const diff = lineDiff("a\nb\nc\nd\n", "a\nc\nd\ne\n");
  assert.equal(diff.tooLarge, false);
  assert.deepEqual([diff.added, diff.removed], [1, 1]);
});
