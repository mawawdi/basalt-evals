import "server-only";
import { resolve } from "node:path";
export const repositoryRoot = () =>
  resolve(
    process.env.BASALT_REPOSITORY_ROOT ?? process.cwd(),
    process.env.BASALT_REPOSITORY_ROOT ? "." : "../..",
  );
