<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Eval Console boundary

- Keep this app loopback-only. The operator POST accepts only registered identifiers
  and starts the tracked CLI in a detached local worker; the browser never sends
  paths, secrets, commands, rubric content, or executable code to that launcher.
- Eval authoring stores two-input drafts and compiled revisions by content hash.
  Preparation is quoted and bounded; executable compiled revisions may enter
  the task registry; reference testing is explicit and separate. Registration never creates a Git commit.
- Derive metrics from immutable source artifacts in `packages/experiments`.
- Keep credentials and filesystem access in server modules. Expose only verified,
  allowlisted asset keys; never accept browser-supplied filesystem paths.
- Preserve the visible development-set and expert-count limitations. Pending or
  interrupted runs cannot look like completed, free or safe decisions.
- After UI changes, run the production build and `npm run console:test`, then
  inspect its desktop and mobile screenshots.
