import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import { hashJson } from "../../contracts/src/index.js";

const execFile = promisify(callback);

/**
 * Paths whose bytes never enter execution or its evidence: the console is an HTTP client
 * of the built operator, and tests, Markdown documentation and repository checks never run
 * inside an operation. Everything else (packages, plugin, studies, tasks, runtime scripts
 * and package metadata) is execution source.
 */
function isExecutionSource(path: string): boolean {
  return !(
    /^(?:[^/]+|(?:docs|design-system)\/.+)\.md$/u.test(path) ||
    /^(?:apps\/console|test|\.github)\//u.test(path) ||
    /^scripts\/(?:check-|test-)/u.test(path) ||
    [".gitignore", ".prettierignore", ".prettierrc.json", "eslint.config.mjs"].includes(path)
  );
}

/** Content identity of a commit's execution source; null when the commit is unavailable. */
export async function executionTree(root: string, commit: string): Promise<string | null> {
  if (!/^[a-f0-9]{40}$/u.test(commit)) return null;
  try {
    const listing = await execFile("git", ["ls-tree", "-r", "-z", "--full-tree", commit], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    return hashJson(
      listing.stdout
        .split("\0")
        .filter((entry) => entry && isExecutionSource(entry.slice(entry.indexOf("\t") + 1))),
    );
  } catch {
    return null;
  }
}

/** Whether two commits carry identical execution source. */
export async function sameExecutionSource(root: string, left: string, right: string) {
  if (left === right) return true;
  const [a, b] = await Promise.all([executionTree(root, left), executionTree(root, right)]);
  return a !== null && a === b;
}

/**
 * The path of one change record of `git status --porcelain=v2 -z`: a change, a rename or copy,
 * a merge conflict or an untracked file. The path can contain spaces and line breaks.
 */
const STATUS_CHANGE = /^(?:1 (?:\S+ ){7}|2 (?:\S+ ){8}|u (?:\S+ ){9}|\? )(.+)$/su;

/**
 * One repository admission rule for models, public development, controls and native capture.
 * Execution source must be clean, and HEAD must carry the frozen commit's exact execution
 * source; commits that touch only the console, tests or documentation never strand a run.
 */
export async function cleanImplementationCommit(root: string, expected?: string): Promise<string> {
  // One git process gives HEAD in a header and the changes in the order of git.
  const status = await execFile(
    "git",
    ["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all"],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  const fields = status.stdout.split("\0");
  let commit: string | null = null;
  const changes: string[][] = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]!;
    if (!entry) continue;
    if (entry.startsWith("# ")) {
      // The value is "(initial)" before the first commit.
      const oid = /^# branch\.oid ([a-f0-9]+)$/u.exec(entry);
      if (oid) commit = oid[1]!;
      continue;
    }
    const path = STATUS_CHANGE.exec(entry)?.[1];
    if (path === undefined)
      throw new Error(`Basalt cannot read this line of git status: ${JSON.stringify(entry)}`);
    // A rename or a copy carries its original path in the following field.
    changes.push(entry.startsWith("2 ") ? [path, fields[++index]!] : [path]);
  }
  if (commit === null)
    throw new Error(
      "Basalt runs only committed code. The repository has no commit. Commit the code. Then try again.",
    );
  for (const paths of changes) {
    const changed = paths.find(isExecutionSource);
    if (changed !== undefined)
      throw new Error(
        `Basalt runs only committed code. The file ${changed} has uncommitted changes. Commit or remove the changes. Then try again.`,
      );
  }
  if (expected !== undefined && commit !== expected) {
    const [frozen, current] = await Promise.all([
      executionTree(root, expected),
      executionTree(root, commit),
    ]);
    if (frozen === null || frozen !== current)
      throw new Error(
        "The Basalt code changed after this run started. Basalt continues a run only with the code that started it. Check out that commit, or start a new run.",
      );
  }
  return commit;
}
