import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceKeyCommand,
  type EvidenceKeyInput,
  type EvidenceKeyTarget,
} from "../packages/contracts/src/evidence-keys.js";

const press = (key: string, changes: Partial<EvidenceKeyInput> = {}) =>
  evidenceKeyCommand({
    key,
    shift: false,
    alt: false,
    ctrl: false,
    meta: false,
    defaultPrevented: false,
    target: "page",
    ...changes,
  });

test("the arrow keys step between criteria and Shift with an arrow steps between builds", () => {
  assert.deepEqual(press("ArrowLeft"), { kind: "criterion", step: -1 });
  assert.deepEqual(press("ArrowRight"), { kind: "criterion", step: 1 });
  assert.deepEqual(press("ArrowLeft", { shift: true }), { kind: "build", step: -1 });
  assert.deepEqual(press("ArrowRight", { shift: true }), { kind: "build", step: 1 });
  assert.deepEqual(press("Escape"), { kind: "results" });
});

test("only a key from the page becomes a command", () => {
  const targets: EvidenceKeyTarget[] = ["text", "owned", "overlay"];
  for (const target of targets)
    for (const key of ["ArrowLeft", "ArrowRight", "Escape"]) {
      assert.equal(press(key, { target }), null, `${key} in ${target}`);
      assert.equal(press(key, { target, shift: true }), null, `Shift ${key} in ${target}`);
    }
});

test("a key that an earlier listener used never becomes a command", () => {
  for (const key of ["ArrowLeft", "ArrowRight", "Escape"])
    assert.equal(press(key, { defaultPrevented: true }), null, key);
});

test("browser and system combinations with Alt, Control or Command stay with the browser", () => {
  for (const modifier of ["alt", "ctrl", "meta"] as const)
    for (const key of ["ArrowLeft", "ArrowRight", "Escape"]) {
      assert.equal(press(key, { [modifier]: true }), null, `${modifier} ${key}`);
      assert.equal(press(key, { [modifier]: true, shift: true }), null, `${modifier} Shift ${key}`);
    }
  assert.equal(press("Escape", { shift: true }), null, "Shift Escape is not All results");
});

test("other keys have no command", () => {
  for (const key of ["ArrowUp", "ArrowDown", "Enter", " ", "Tab", "k", "Home", "End"])
    assert.equal(press(key), null, key);
});
