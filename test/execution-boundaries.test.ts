import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

test("execution dependencies stay acyclic with pure protocols and one model transport boundary", async () => {
  const paths = (await readdir("packages", { recursive: true }))
    .filter((path) => path.endsWith(".ts"))
    .map((path) => resolve("packages", path));
  const files = new Set(paths),
    edges = new Map<string, string[]>();
  for (const path of paths) {
    const name = relative(process.cwd(), path),
      source = await readFile(path, "utf8"),
      tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true),
      deps: string[] = [];
    for (const node of tree.statements) {
      if (
        !(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ||
        !node.moduleSpecifier ||
        !ts.isStringLiteral(node.moduleSpecifier)
      )
        continue;
      const target = node.moduleSpecifier.text;
      if (
        name.startsWith("packages/experiments/") &&
        !(
          ts.isImportDeclaration(node) &&
          node.importClause?.isTypeOnly &&
          target.endsWith("model-client/src/contracts.js")
        )
      )
        assert.ok(
          !/node:(?:fs|child_process|http|https|net)|(?:operator|agent-runtime|studio-runner|model-client)\/src/u.test(
            target,
          ),
          `${name} protocol must not own execution: ${target}`,
        );
      if (name.startsWith("packages/reporting/"))
        assert.ok(
          !/node:fs|(?:operator|studio-runner)\/src/u.test(target),
          `${name} reporting must stay pure: ${target}`,
        );
      if (name.startsWith("packages/eval-authoring/"))
        assert.ok(
          !/(?:agent-runtime|operator)\/src/u.test(target),
          `${name} authoring must remain below orchestration`,
        );
      if (!name.startsWith("packages/model-client/"))
        assert.ok(
          !/^(?:ai$|@ai-sdk\/|@openrouter\/)/u.test(target),
          `${name} leaked a provider SDK`,
        );
      if (
        ts.isImportDeclaration(node) &&
        (node.importClause?.isTypeOnly ||
          (!node.importClause?.name &&
            node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.every((item) => item.isTypeOnly)))
      )
        continue;
      if (ts.isExportDeclaration(node) && node.isTypeOnly) continue;
      const dependency = resolve(dirname(path), target.replace(/\.js$/u, ".ts"));
      if (files.has(dependency)) deps.push(dependency);
    }
    const walk = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "complete" &&
        !(
          name === "packages/studio-runner/src/index.ts" &&
          node.expression.expression.getText(tree) === "native"
        )
      )
        assert.ok(
          /^packages\/(?:agent-runtime|model-client)\//u.test(name),
          `${name} dispatches a model outside the bounded runtime`,
        );
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "OpenRouterModelClient"
      )
        assert.equal(
          name,
          "packages/operator/src/adapters.ts",
          "Provider construction belongs to the composition root",
        );
      ts.forEachChild(node, walk);
    };
    walk(tree);
    edges.set(path, deps);
  }
  const complete = new Set<string>(),
    stack: string[] = [];
  const visit = (path: string) => {
    assert.ok(
      !stack.includes(path),
      "Circular executable imports: " +
        [...stack, path].map((path) => relative(process.cwd(), path)).join(" → "),
    );
    if (complete.has(path)) return;
    stack.push(path);
    for (const dependency of edges.get(path)!) visit(dependency);
    stack.pop();
    complete.add(path);
  };
  for (const path of paths) visit(path);
  const scripts = (await readdir("scripts")).filter((path) => path.endsWith(".mjs"));
  for (const script of scripts) {
    const source = await readFile(resolve("scripts", script), "utf8");
    if (/\b(?:runNativeStudio|runIsolatedStudio)\(/u.test(source))
      assert.equal(
        script,
        "evals-worker-entry.mjs",
        "Native scripts cannot bypass the owned shared lane",
      );
  }
});

test("the API notes loader imports nothing from tasks, fixtures or the evaluator", async () => {
  // Follow every import, type imports too, from the loader of the builder notes.
  const seen = new Set<string>();
  const pending = [resolve("packages/agent-runtime/src/notes.ts")];
  while (pending.length) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const tree = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest);
    for (const node of tree.statements)
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".")
      )
        pending.push(resolve(dirname(path), node.moduleSpecifier.text.replace(/\.js$/u, ".ts")));
  }
  const reached = [...seen].map((path) => relative(process.cwd(), path));
  assert.ok(reached.includes("packages/agent-runtime/src/notes.ts"));
  for (const path of reached)
    assert.doesNotMatch(
      path,
      /^(?:tasks|studies|test)\/|fixture|evaluator|packages\/(?:task-registry|eval-authoring|graders|experiments|operator|studio-runner|development)\//u,
      `The API notes loader reaches ${path}`,
    );
});
