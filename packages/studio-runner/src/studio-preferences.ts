// The isolated worker loads this module. It must not load the operation journal.
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { contentHash, hashJson } from "../../contracts/src/index.js";

const execFile = promisify(execFileCallback);

export const STUDIO_DEFAULTS_DOMAIN = "com.Roblox.RobloxStudio";
/** The settings file of Studio, relative to the home folder of its account. */
export const STUDIO_SETTINGS_FILE = "Library/Roblox/GlobalSettings_13.xml";
/** The plugin folder that `Studio.PluginsDir` must name, relative to the home folder. */
export const STUDIO_PLUGINS_DIRECTORY = ".local/share/basalt-evals/plugins";
/** The golden preferences template of a worker account, relative to its home folder. */
export const GOLDEN_DIRECTORY = ".local/share/basalt-evals/golden";
/** A preference key that looks like a credential. A template never contains one. */
const CREDENTIAL_KEY = /cookie|token|auth|session|login|password/i;
const MAX_PREFERENCES_BYTES = 4 * 1024 * 1024;

/** The result of the preference reset of one job. The signed manifest records it. */
export interface PreferencesReset {
  templateHash: string;
  reset: "applied" | "skipped_busy";
}

interface GoldenTemplate {
  schema: "basalt-evals/studio-preferences-template";
  templateHash: string;
  settingsHash: string;
  defaultsHash: string;
}

/** Studio's configured PluginsDir, not a guessed default, determines executed plugin bytes. */
export function configuredStudioPluginFile(settings: string, accountHome: string): string {
  const matches = [...settings.matchAll(/<QDir name="PluginsDir">([^<]+)<\/QDir>/g)];
  if (matches.length !== 1)
    throw new Error(
      "The Studio settings of the isolated Studio account do not give exactly one plugin folder. Set Studio.PluginsDir with the steps in docs/DEVELOPMENT.md.",
    );
  const directory = matches[0]![1]!;
  if (!directory.startsWith(`${accountHome}/`) || resolve(directory) !== directory)
    throw new Error(
      "The Studio plugin folder is outside the isolated Studio account. Set Studio.PluginsDir with the steps in docs/DEVELOPMENT.md.",
    );
  return resolve(directory, "BasaltEvalStudioPlugin.rbxmx");
}

/** One sentence for each problem of a template. An empty list accepts the template. */
export function preferencesTemplateProblems(input: {
  settings: string;
  defaults: string;
  home: string;
}): string[] {
  const problems: string[] = [];
  const keys = [
    ...[...input.defaults.matchAll(/<key>([^<]*)<\/key>/g)].map((match) => match[1]!),
    ...[...input.settings.matchAll(/\bname="([^"]*)"/g)].map((match) => match[1]!),
  ];
  for (const key of new Set(keys.filter((key) => CREDENTIAL_KEY.test(key))))
    problems.push(
      `The Studio preferences have the key "${key}", which looks like a credential. Remove it in the isolated account, then capture the template again.`,
    );
  const expected = resolve(input.home, STUDIO_PLUGINS_DIRECTORY);
  try {
    const directory = dirname(configuredStudioPluginFile(input.settings, input.home));
    if (directory !== expected)
      problems.push(
        `Studio loads plugins from ${directory}, not from ${expected}. Set Studio.PluginsDir with the steps in docs/DEVELOPMENT.md.`,
      );
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (
    !/<key>ApplePersistenceIgnoreState<\/key>\s*(?:<true\/>|<string>YES<\/string>)/u.test(
      input.defaults,
    )
  )
    problems.push(
      "Window restoration of Studio is on. Set ApplePersistenceIgnoreState to YES with the steps in docs/DEVELOPMENT.md.",
    );
  return problems;
}

/** Make each folder of the golden template path. No folder can be a symbolic link. */
async function goldenDirectory(home: string): Promise<string> {
  let directory = resolve(home);
  await assertSafeAbsoluteDirectory(directory);
  for (const part of GOLDEN_DIRECTORY.split("/")) {
    directory = resolve(directory, part);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertSafeAbsoluteDirectory(directory);
  }
  return directory;
}

/** Replace one file with complete bytes. A reader sees the old bytes or the new bytes. */
async function replaceFile(file: string, bytes: string | Uint8Array): Promise<void> {
  const temporary = resolve(dirname(file), `.${randomUUID()}.pending`);
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function exportDefaults(tool: string): Promise<string> {
  const { stdout } = await execFile(tool, ["export", STUDIO_DEFAULTS_DOMAIN, "-"], {
    timeout: 10_000,
    maxBuffer: MAX_PREFERENCES_BYTES,
  });
  return stdout;
}

/**
 * Capture the current Studio preferences of this account as its golden template. It refuses a
 * credential key, a wrong plugin folder and window restoration. It reads only the settings file
 * and the defaults domain of Studio. It never reads logs, plugins, cookies or the Keychain.
 */
export async function captureStudioPreferences(
  home: string,
  defaultsTool = "/usr/bin/defaults",
): Promise<{ templateHash: string }> {
  const settings = await readBoundedRegularFile(
    resolve(home, STUDIO_SETTINGS_FILE),
    MAX_PREFERENCES_BYTES,
    "Studio settings",
  );
  const defaults = Buffer.from(await exportDefaults(defaultsTool));
  const problems = preferencesTemplateProblems({
    settings: settings.toString("utf8"),
    defaults: defaults.toString("utf8"),
    home,
  });
  if (problems.length) throw new Error(problems.join(" "));
  const settingsHash = contentHash(settings);
  const defaultsHash = contentHash(defaults);
  const templateHash = hashJson({ settings: settingsHash, defaults: defaultsHash });
  const golden = await goldenDirectory(home);
  const files = resolve(golden, templateHash);
  await mkdir(files, { recursive: true, mode: 0o700 });
  await replaceFile(resolve(files, "GlobalSettings_13.xml"), settings);
  await replaceFile(resolve(files, "studio-defaults.plist"), defaults);
  const template: GoldenTemplate = {
    schema: "basalt-evals/studio-preferences-template",
    templateHash,
    settingsHash,
    defaultsHash,
  };
  // The pointer changes last, so a reader never sees a template without its files.
  await replaceFile(resolve(golden, "template.json"), JSON.stringify(template) + "\n");
  for (const entry of await readdir(golden, { withFileTypes: true }))
    if (entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name) && entry.name !== templateHash)
      await rm(resolve(golden, entry.name), { recursive: true, force: true });
  return { templateHash };
}

/** The verified golden template of this account. */
export async function readGoldenTemplate(home: string): Promise<{
  templateHash: string;
  settings: Buffer;
  defaultsFile: string;
}> {
  const golden = resolve(home, GOLDEN_DIRECTORY);
  try {
    await lstat(resolve(golden, "template.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "This Studio worker has no preferences template. Run studio template capture for this worker with the steps in docs/DEVELOPMENT.md.",
      );
    throw error;
  }
  const pointer = await readBoundedRegularFile(
    resolve(golden, "template.json"),
    4096,
    "Studio preferences template",
  );
  const template = JSON.parse(pointer.toString("utf8")) as GoldenTemplate;
  if (
    template.schema !== "basalt-evals/studio-preferences-template" ||
    !/^[a-f0-9]{64}$/u.test(template.templateHash) ||
    template.templateHash !==
      hashJson({ settings: template.settingsHash, defaults: template.defaultsHash })
  )
    throw new Error("The Studio preferences template is not valid. Capture it again.");
  const files = resolve(golden, template.templateHash);
  const settings = await readBoundedRegularFile(
    resolve(files, "GlobalSettings_13.xml"),
    MAX_PREFERENCES_BYTES,
    "template Studio settings",
  );
  const defaultsFile = resolve(files, "studio-defaults.plist");
  const defaults = await readBoundedRegularFile(
    defaultsFile,
    MAX_PREFERENCES_BYTES,
    "template Studio defaults",
  );
  if (
    contentHash(settings) !== template.settingsHash ||
    contentHash(defaults) !== template.defaultsHash
  )
    throw new Error("The files of the Studio preferences template changed. Capture it again.");
  return { templateHash: template.templateHash, settings, defaultsFile };
}

/** True if a Studio process of this account runs. This only reads the process list. */
export async function accountStudioRunning(uid: number): Promise<boolean> {
  // A numeric user ID never gets a short form in the process list, but a long name can.
  const { stdout } = await execFile("/bin/ps", ["-axww", "-o", "uid=,command="], {
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.split("\n").some((line) => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    return (
      !!match &&
      Number(match[1]) === uid &&
      match[2]!.includes("RobloxStudio.app/Contents/MacOS/RobloxStudio")
    );
  });
}

/**
 * Put the Studio preferences of this account back to its golden template before a job. The
 * controller requests a reset only when no other slot of the worker has a claim. The worker then
 * checks that no Studio process of the account runs. It imports the defaults domain and replaces
 * the settings file atomically. It never touches logs, plugins, cookies or the Keychain.
 */
export async function resetStudioPreferences(input: {
  home: string;
  requested: boolean;
  studioRunning: () => Promise<boolean>;
  defaultsTool?: string;
}): Promise<PreferencesReset> {
  const template = await readGoldenTemplate(input.home);
  if (!input.requested || (await input.studioRunning()))
    return { templateHash: template.templateHash, reset: "skipped_busy" };
  const tool = input.defaultsTool ?? "/usr/bin/defaults";
  await execFile(tool, ["import", STUDIO_DEFAULTS_DOMAIN, template.defaultsFile], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const settingsFile = resolve(input.home, STUDIO_SETTINGS_FILE);
  await assertSafeAbsoluteDirectory(dirname(settingsFile));
  await replaceFile(settingsFile, template.settings);
  // The preference cache of macOS can hold old values, so read the key back from the domain.
  const { stdout } = await execFile(
    tool,
    ["read", STUDIO_DEFAULTS_DOMAIN, "ApplePersistenceIgnoreState"],
    { timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  if (stdout.trim() !== "1")
    throw new Error(
      "After the reset, window restoration of Studio is still on. Capture the preferences template again.",
    );
  return { templateHash: template.templateHash, reset: "applied" };
}
