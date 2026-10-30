import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import {
  prepareWorkerKeyDirectory,
  runNativeStudio,
} from "./dist/packages/studio-runner/src/native-worker.js";
import {
  requestNativeCancellation,
  watchNativeCancellation,
} from "./dist/packages/studio-runner/src/cancellation.js";
import { captureStudioPreferences } from "./dist/packages/studio-runner/src/studio-preferences.js";
import { runStudioMcpKeeper } from "./dist/packages/studio-runner/src/studio-mcp-anchor.js";

// Usage:
//   worker-entry.mjs <user> run <session> <reset|keep> <record|plain>
//   worker-entry.mjs <user> cancel <session>
//   worker-entry.mjs <user> template-capture
//   worker-entry.mjs <user> mcp-anchor
const [expectedUser, action, ...rest] = process.argv.slice(2);
if (!expectedUser || userInfo().username !== expectedUser)
  throw new Error("The native worker must run as its configured macOS user");

if (action === "template-capture") {
  if (rest.length) throw new Error("The template capture takes no arguments");
  console.log(JSON.stringify(await captureStudioPreferences(homedir())));
} else if (action === "mcp-anchor") {
  if (rest.length) throw new Error("The Studio MCP anchor takes no arguments");
  const termination = new AbortController();
  process.on("SIGTERM", () => termination.abort());
  process.on("SIGHUP", () => termination.abort());
  await runStudioMcpKeeper({
    directory: await prepareWorkerKeyDirectory(homedir()),
    signal: termination.signal,
  });
} else {
  const [sessionDirectory, preferences, recording] = rest;
  if (
    !sessionDirectory ||
    !(
      (action === "cancel" && rest.length === 1) ||
      (action === "run" &&
        rest.length === 3 &&
        ["reset", "keep"].includes(preferences) &&
        ["record", "plain"].includes(recording))
    )
  )
    throw new Error("Unknown native worker action");
  const directory = resolve(sessionDirectory);
  if (!directory.startsWith(resolve(homedir(), "BasaltTrials") + "/"))
    throw new Error(
      "The native worker session must be inside its account's BasaltTrials directory",
    );
  if (action === "cancel") {
    await requestNativeCancellation(directory);
    console.log("Cancellation recorded for the prepared session");
  } else {
    const cancellation = await watchNativeCancellation(directory);
    const termination = new AbortController();
    const stop = () => termination.abort(new Error("Native worker termination requested"));
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);
    try {
      const keyDirectory = await prepareWorkerKeyDirectory(homedir());
      const receipt = await runNativeStudio({
        sessionDirectory: directory,
        entryFile: resolve(import.meta.dirname, "packages/studio-runner/native-entry.luau"),
        keyFile: resolve(keyDirectory, "signing-key.pem"),
        resetPreferences: preferences === "reset",
        screenRecording: recording === "record",
        mcpAnchorKeeper: {
          command: process.execPath,
          args: [import.meta.filename, expectedUser, "mcp-anchor"],
        },
        signal: AbortSignal.any([termination.signal, cancellation.signal]),
      });
      console.log(
        `status=${receipt.manifest.status} artifacts=${receipt.manifest.artifacts.length}`,
      );
      if (receipt.manifest.failure) console.error(receipt.manifest.failure);
      if (receipt.manifest.status !== "complete") process.exitCode = 1;
    } finally {
      cancellation.close();
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
    }
  }
}
