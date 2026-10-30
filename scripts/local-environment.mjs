import { resolve } from "node:path";

/** Load local credentials before spawning servers or workers; exported values take precedence. */
export function loadLocalEnvironment(root) {
  try {
    process.loadEnvFile(resolve(root, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
