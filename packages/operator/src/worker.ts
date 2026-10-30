import { driveOperation } from "./driver.js";

const [root, operationId, token] = process.argv.slice(2);
if (!root || !operationId || !token)
  throw new Error("Operation worker requires its owned identity");
await driveOperation(root, operationId, token);
