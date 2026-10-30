import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markdownRoots = ["README.md", "docs", "tasks"];
const mermaidVersion = "11.17.0";
const maxMarkdownBytes = 4 * 1024 * 1024;
const execOptions = {
  cwd: root,
  maxBuffer: 4 * 1024 * 1024,
  windowsHide: true,
};

async function main() {
  const markdownFiles = await collectMarkdownFiles();
  const linkFailures = [];
  const diagrams = [];

  for (const file of markdownFiles) {
    const source = await readRegularUtf8(file);
    linkFailures.push(...(await validateLocalLinks(file, source)));
    diagrams.push(...extractMermaid(file, source));
  }

  if (linkFailures.length > 0) {
    throw new Error(`Local Markdown link check failed:\n${linkFailures.join("\n")}`);
  }

  await renderMermaid(diagrams);
  process.stdout.write(
    `Docs check passed: ${markdownFiles.length} Markdown files, ${diagrams.length} Mermaid diagrams\n`,
  );
}

async function collectMarkdownFiles() {
  const files = [];
  for (const entry of markdownRoots) {
    const path = resolve(root, entry);
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new Error(`Documentation root cannot be a symbolic link: ${entry}`);
    if (info.isFile()) {
      if (path.endsWith(".md")) files.push(path);
      continue;
    }
    if (!info.isDirectory())
      throw new Error(`Documentation root is not a regular file or directory: ${entry}`);
    await collectMarkdownDirectory(path, files);
  }
  return files.sort();
}

async function collectMarkdownDirectory(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Documentation tree cannot contain a symbolic link: ${relative(root, path)}`);
    if (entry.isDirectory()) {
      await collectMarkdownDirectory(path, files);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
}

async function readRegularUtf8(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`Documentation file is not a regular file: ${relative(root, path)}`);
  if (info.size > maxMarkdownBytes)
    throw new Error(
      `Documentation file exceeds ${maxMarkdownBytes} bytes: ${relative(root, path)}`,
    );
  return readFile(path, "utf8");
}

async function validateLocalLinks(markdownFile, source) {
  const failures = [];
  const expression =
    /!?(?:\[[^\]]*\])\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  for (const match of source.matchAll(expression)) {
    const rawLink = match[1] ?? match[2];
    if (!rawLink || isExternalLink(rawLink)) continue;
    const { pathPart, fragment } = splitLink(rawLink);
    const target =
      pathPart.length === 0
        ? markdownFile
        : resolve(dirname(markdownFile), decodeLocalPath(pathPart));
    if (!isWithinRoot(target)) {
      failures.push(
        `${relative(root, markdownFile)}: local link escapes the repository: ${rawLink}`,
      );
      continue;
    }
    const targetInfo = await lstat(target).catch((error) =>
      error?.code === "ENOENT" ? undefined : Promise.reject(error),
    );
    if (
      !targetInfo ||
      targetInfo.isSymbolicLink() ||
      (!targetInfo.isFile() && !targetInfo.isDirectory())
    ) {
      failures.push(`${relative(root, markdownFile)}: unresolved local link: ${rawLink}`);
      continue;
    }
    if (fragment && targetInfo.isFile() && target.endsWith(".md")) {
      const targetText = await readRegularUtf8(target);
      if (!markdownAnchors(targetText).has(fragment)) {
        failures.push(`${relative(root, markdownFile)}: unresolved local anchor: ${rawLink}`);
      }
    }
  }
  return failures;
}

function isExternalLink(link) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link);
}

function splitLink(link) {
  const fragmentIndex = link.indexOf("#");
  const queryIndex = link.indexOf("?");
  const cutoff = [fragmentIndex, queryIndex]
    .filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), link.length);
  return {
    pathPart: link.slice(0, cutoff),
    fragment: fragmentIndex >= 0 ? decodeURIComponent(link.slice(fragmentIndex + 1)) : undefined,
  };
}

function decodeLocalPath(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    throw new Error(`Malformed percent escape in local Markdown link: ${path}`);
  }
}

function isWithinRoot(path) {
  const relation = relative(root, path);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`));
}

function markdownAnchors(source) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of source.split("\n")) {
    const match = /^(?: {0,3})(?:#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = githubAnchor(match[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function githubAnchor(value) {
  return value
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function extractMermaid(file, source) {
  const diagrams = [];
  const expression = /^```mermaid\s*\n([\s\S]*?)^```\s*$/gm;
  let ordinal = 0;
  for (const match of source.matchAll(expression)) {
    const definition = match[1].trim();
    if (definition.length === 0) throw new Error(`Empty Mermaid diagram: ${relative(root, file)}`);
    diagrams.push({ file, ordinal: ordinal++, definition });
  }
  return diagrams;
}

async function renderMermaid(diagrams) {
  const packagePath = resolve(root, "node_modules", "@mermaid-js", "mermaid-cli", "package.json");
  const packageText = await readRegularUtf8(packagePath).catch(() => {
    throw new Error(`Missing pinned Mermaid CLI ${mermaidVersion}; run npm install`);
  });
  const packageJson = JSON.parse(packageText);
  if (packageJson.version !== mermaidVersion) {
    throw new Error(`Expected Mermaid CLI ${mermaidVersion}, found ${String(packageJson.version)}`);
  }
  const cli = resolve(root, "node_modules", "@mermaid-js", "mermaid-cli", "src", "cli.js");
  const cliInfo = await lstat(cli).catch(() => undefined);
  if (!cliInfo || cliInfo.isSymbolicLink() || !cliInfo.isFile())
    throw new Error(`Pinned Mermaid CLI executable is unavailable: ${cli}`);

  const temporary = await mkdtemp(join(tmpdir(), "basalt-docs-check-"));
  try {
    for (const diagram of diagrams) {
      const digest = createHash("sha256").update(diagram.definition).digest("hex").slice(0, 16);
      const stem = `${basename(diagram.file, ".md")}-${diagram.ordinal}-${digest}`;
      const input = join(temporary, `${stem}.mmd`);
      const output = join(temporary, `${stem}.svg`);
      await writeFile(input, `${diagram.definition}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      try {
        await execFile(
          process.execPath,
          [cli, "--input", input, "--output", output, "--quiet"],
          execOptions,
        );
      } catch (error) {
        const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
        throw new Error(
          `Mermaid render failed for ${relative(root, diagram.file)} diagram ${diagram.ordinal + 1}${stderr ? `: ${stderr}` : ""}`,
          { cause: error },
        );
      }
      const outputInfo = await lstat(output).catch(() => undefined);
      if (
        !outputInfo ||
        outputInfo.isSymbolicLink() ||
        !outputInfo.isFile() ||
        outputInfo.size === 0
      ) {
        throw new Error(
          `Mermaid render produced no regular SVG: ${relative(root, diagram.file)} diagram ${diagram.ordinal + 1}`,
        );
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

await main();
