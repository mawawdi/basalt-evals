#!/usr/bin/env node

import { resolve } from "node:path";
import { loadLocalEnvironment } from "../scripts/local-environment.mjs";

loadLocalEnvironment(resolve(import.meta.dirname, ".."));
await import("../dist/packages/cli/src/index.js");
