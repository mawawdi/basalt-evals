import assert from "node:assert/strict";
import test from "node:test";
import * as runtime from "../packages/agent-runtime/src/index.js";
import { BUILDER_TOOL_DEFINITIONS, toolDefinitions } from "../packages/agent-runtime/src/tools.js";
import {
  COMPACTION_INSTRUCTION,
  COMPACTION_SYSTEM_PROMPT,
  COMPACTION_TOOL,
} from "../packages/agent-runtime/src/compaction.js";
import { BUILDER_TOOL_NAMES, hashJson } from "../packages/contracts/src/index.js";
import { readHarnessRegistry } from "../packages/operator/src/config.js";

// The first two hashes come from the code at tag pre-pivot: the local and Studio tool sets kept
// their schemas. Each builder request hash includes the tool definitions and the compaction
// text, so a changed schema makes the stored requests of each paid build unverifiable.
const THIN_TOOLS_HASH = "e1347773be626e768fe09192a069d0ebf865adfa8dd971c2861ef691204204a7";
const PRODUCTION_TOOLS_HASH = "bc3ebc2e7a3cd8a7b68c6e408e2bbc20ae9db029483ea10a4ce5ba61be7ba9f2";
const ALL_TOOLS_HASH = "688cf376383d65a8356a3f2baa4d995808be059e9033424c19b644577eac4aa9";
const COMPACTION_HASH = "5a66122d5da1f6e9ed6efda41b2e1d4ef0555466f49235e94b508075e6485e80";

test("the builder tool definitions keep their frozen schemas", async () => {
  const { harnesses } = await readHarnessRegistry(process.cwd());
  const tools = (id: string) => toolDefinitions(harnesses.find((item) => item.id === id)!);
  assert.equal(hashJson(tools("thin")), THIN_TOOLS_HASH);
  assert.equal(hashJson(tools("production")), PRODUCTION_TOOLS_HASH);
  assert.equal(hashJson(BUILDER_TOOL_DEFINITIONS), ALL_TOOLS_HASH);
  assert.deepEqual(
    BUILDER_TOOL_DEFINITIONS.map((definition) => definition.name),
    BUILDER_TOOL_NAMES,
  );
});

test("the compaction request keeps its frozen text and answer tool", () => {
  assert.equal(
    hashJson({ COMPACTION_SYSTEM_PROMPT, COMPACTION_INSTRUCTION, COMPACTION_TOOL }),
    COMPACTION_HASH,
  );
});

test("the runtime package exports the tool definitions of the tools module", () => {
  assert.equal(runtime.BUILDER_TOOL_DEFINITIONS, BUILDER_TOOL_DEFINITIONS);
  assert.equal(runtime.toolDefinitions, toolDefinitions);
});
