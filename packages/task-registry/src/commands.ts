import { builderTaskView, discoverTaskDirectories, loadRegisteredTask } from "./index.js";

/** Pure command services keep process IO out of registry validation. */
export async function validateRegisteredTasks(root: string, selected: string[]) {
  const directories = selected.length ? selected : await discoverTaskDirectories(root);
  return Promise.all(
    directories.map(async (directory) => {
      const task = await loadRegisteredTask(root, directory);
      return {
        id: task.id,
        publicTaskHash: task.publicTaskHash,
        evaluatorHash: task.evaluatorHash,
        seedHash: task.seedHash,
      };
    }),
  );
}

export async function showPublicTask(root: string, directory: string) {
  return builderTaskView(await loadRegisteredTask(root, directory));
}
