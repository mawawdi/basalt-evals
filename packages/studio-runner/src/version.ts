import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
// The outer app's short version is a packaging placeholder (0.0.0.1).
// Roblox ships the runtime release in its bundled installer metadata.
const studioInfo =
  "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudioInstaller.app/Contents/Info.plist";

/** Bind a new native trial to the app actually installed on this Mac. */
export async function installedStudioVersion(): Promise<string> {
  if (process.platform !== "darwin")
    throw new Error("Basalt can start Studio only on macOS. Use a Mac for this run.");
  const { stdout } = await execFile(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print CFBundleShortVersionString", studioInfo],
    { timeout: 5_000, maxBuffer: 1_024 },
  );
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(version))
    throw new Error(
      "Basalt cannot read a valid version number from the installed Studio. Install Studio again. Then try again.",
    );
  return version;
}
