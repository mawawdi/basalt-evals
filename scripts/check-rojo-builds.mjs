import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { discoverProjectFiles } from "./discover-projects.mjs";

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "..");
const projects = await discoverProjectFiles(root);
const temporary = await mkdtemp(join(tmpdir(), "basalt-evals-rojo-"));

try {
  for (const [index, project] of projects.entries()) {
    const extension = project.startsWith("plugin/") ? ".rbxmx" : ".rbxlx";
    const output = join(
      temporary,
      `${index}-${basename(resolve(root, project), ".json")}${extension}`,
    );
    await execFile("rojo", ["build", project, "-o", output], {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const info = await lstat(output);
    if (!info.isFile() || info.size === 0)
      throw new Error(`Rojo produced no output for ${project}`);
    if (extension === ".rbxlx") {
      const xml = await readFile(output, "utf8");
      if (xml.includes('<Vector3 name="Position">'))
        throw new Error(
          `${project} serializes BasePart.Position, which Studio ignores when loading a place; use CFrame`,
        );
    }
  }
  process.stdout.write(`Rojo check passed: ${projects.length} temporary builds\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
