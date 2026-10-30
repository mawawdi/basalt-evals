import { DIAGNOSTIC_CHANNEL_LIMIT } from "../../contracts/src/capabilities.js";
import {
  compareCodeUnits,
  type ScriptDiagnostic,
  type StudioEvidence,
  type StudioObservation,
} from "../../contracts/src/index.js";
import type {
  ScriptErrorCounts,
  ScriptErrorOrigin,
  SourceScript,
} from "../../contracts/src/source-analysis.js";

/**
 * The full names that the build scripts can have while the session runs. Studio copies the
 * scripts of these containers to each player or character. Every script also keeps its
 * authored name, because a ModuleScript can run where the build put it.
 */
export function buildScriptPaths(
  scripts: readonly SourceScript[],
  actorNames: readonly string[],
): Set<string> {
  const paths = new Set<string>();
  const copies: Array<[string, (actor: string, rest: string) => string[]]> = [
    [
      "StarterPlayer.StarterPlayerScripts.",
      (actor, rest) => [`Players.${actor}.PlayerScripts.${rest}`],
    ],
    ["StarterPlayer.StarterCharacterScripts.", (actor, rest) => [`Workspace.${actor}.${rest}`]],
    ["StarterGui.", (actor, rest) => [`Players.${actor}.PlayerGui.${rest}`]],
    [
      "StarterPack.",
      (actor, rest) => [`Players.${actor}.Backpack.${rest}`, `Workspace.${actor}.${rest}`],
    ],
  ];
  for (const script of scripts) {
    paths.add(script.dataModelPath);
    for (const [prefix, runtime] of copies) {
      if (!script.dataModelPath.startsWith(prefix)) continue;
      const rest = script.dataModelPath.slice(prefix.length);
      for (const actor of actorNames) for (const path of runtime(actor, rest)) paths.add(path);
    }
  }
  return paths;
}

/**
 * The script names in a stack trace. Studio writes a frame as `Path:12 function name`. The
 * older form is `Script 'Path', Line 12`.
 */
export function stackFramePaths(stackTrace: string): string[] {
  const paths: string[] = [];
  for (const raw of stackTrace.split(/\r?\n/u)) {
    const line = raw.trim();
    const legacy = /^Script '(.+)', Line [0-9]+/u.exec(line);
    const current = legacy ?? /^(.+?):[0-9]+(?:\s|$)/u.exec(line);
    if (current) paths.push(current[1]!);
  }
  return paths;
}

/**
 * Attribute one script error with fixed rules. A build path in the engine source or in a stack
 * frame gives `build`. A script outside the place gives `external`, unless its name is the end
 * of a build path: an unparented build script has that name.
 */
export function attributeScriptError(
  entry: ScriptDiagnostic,
  scripts: readonly SourceScript[],
  actorNames: readonly string[],
): ScriptErrorOrigin {
  const paths = buildScriptPaths(scripts, actorNames);
  return originFromPaths(entry, paths);
}

/** The actor names of the scenario reports of one observation, in code unit order. */
export function evidenceActorNames(evidence: StudioEvidence): string[] {
  return [
    ...new Set(
      evidence.scenarios.flatMap((scenario) =>
        scenario.reports.flatMap((report) => report.actors.map((actor) => actor.name)),
      ),
    ),
  ].sort(compareCodeUnits);
}

/**
 * The script errors of one observation, by origin. Each Studio context keeps one list of errors
 * that grows through its session, and each diagnostics fact copies that list. Thus the fact
 * with the most records of each context has all errors of the context. The phases run in one
 * client, and each report of a scenario is one context. Null without a diagnostics fact.
 */
export function evidenceScriptErrors(
  evidence: StudioEvidence,
  scripts: readonly SourceScript[],
): ScriptErrorCounts | null {
  type Diagnostics = Extract<StudioObservation, { kind: "diagnostics" }>;
  const isDiagnostics = (observation: StudioObservation): observation is Diagnostics =>
    observation.kind === "diagnostics";
  const contexts = [
    evidence.phases.flatMap((phase) => phase.observations.filter(isDiagnostics)),
    ...evidence.scenarios.flatMap((scenario) =>
      scenario.reports.map((report) =>
        report.steps.flatMap((step) => step.observations.filter(isDiagnostics)),
      ),
    ),
  ].filter((facts) => facts.length);
  if (!contexts.length) return null;
  const paths = buildScriptPaths(scripts, evidenceActorNames(evidence));
  const counts: ScriptErrorCounts = { build: 0, unknown: 0, external: 0, truncated: false };
  for (const facts of contexts) {
    const latest = facts.reduce((most, fact) =>
      fact.scriptErrors.length > most.scriptErrors.length ? fact : most,
    );
    if (latest.scriptErrors.length >= DIAGNOSTIC_CHANNEL_LIMIT) counts.truncated = true;
    for (const entry of latest.scriptErrors) counts[originFromPaths(entry, paths)] += 1;
  }
  return counts;
}

/** The same attribution with the build paths of `buildScriptPaths` made one time. */
export function originFromPaths(
  entry: ScriptDiagnostic,
  paths: ReadonlySet<string>,
): ScriptErrorOrigin {
  if (entry.source.kind === "script" && entry.source.inDataModel && paths.has(entry.source.path))
    return "build";
  if (stackFramePaths(entry.stackTrace).some((path) => paths.has(path))) return "build";
  if (entry.source.kind === "script" && !entry.source.inDataModel) {
    const detached = entry.source.path;
    for (const path of paths)
      if (path === detached || path.endsWith(`.${detached}`)) return "unknown";
    return "external";
  }
  return "unknown";
}
