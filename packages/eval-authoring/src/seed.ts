import { isLocalPlayerPath, type StudioCollectionPlan } from "../../contracts/src/index.js";
import type { EvalProposal } from "./compiler.js";

const SPAWN_POSITION = [0, 1, 18] as const;
const SPAWN_SIZE = [6, 1, 6] as const;
const AVATAR_CONTACT_MARGIN = 1.5;

export interface PublicScenePart {
  name: string;
  position: [number, number, number];
  size: [number, number, number];
  anchored: boolean;
  canCollide: boolean;
  transparency: number;
}

/** Declarative public geometry only. It cannot introduce evaluator code or hidden values. */
export interface PublicScene {
  parts: PublicScenePart[];
}

export function assertPublicScene(value: unknown): asserts value is PublicScene {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "parts" ||
    !Array.isArray((value as PublicScene).parts) ||
    (value as PublicScene).parts.length > 32
  )
    throw new Error("Public scene must contain at most 32 declared parts");
  const names = new Set(["Ground", "EvalSpawn"]);
  for (const part of (value as PublicScene).parts) {
    if (part && typeof part === "object" && !Array.isArray(part)) {
      if (part.name === "Ground" || part.name === "EvalSpawn")
        throw new Error(`Public scene must omit Basalt-supplied ${part.name}`);
      if (typeof part.name === "string" && names.has(part.name))
        throw new Error(`Public scene duplicates part ${part.name}`);
    }
    if (
      !part ||
      typeof part !== "object" ||
      Array.isArray(part) ||
      Object.keys(part).sort().join(",") !==
        "anchored,canCollide,name,position,size,transparency" ||
      typeof part.name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(part.name) ||
      !Array.isArray(part.position) ||
      part.position.length !== 3 ||
      !part.position.every(
        (number) =>
          typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 10_000,
      ) ||
      !Array.isArray(part.size) ||
      part.size.length !== 3 ||
      !part.size.every(
        (number) =>
          typeof number === "number" && Number.isFinite(number) && number > 0 && number <= 1_000,
      ) ||
      typeof part.anchored !== "boolean" ||
      typeof part.canCollide !== "boolean" ||
      typeof part.transparency !== "number" ||
      !Number.isFinite(part.transparency) ||
      part.transparency < 0 ||
      part.transparency > 1
    )
      throw new Error("Public scene contains an invalid or duplicate part");
    names.add(part.name);
  }
}

export function neutralWorkspacePaths(project: unknown): Set<string> {
  const paths = new Set<string>();
  if (!project || typeof project !== "object" || Array.isArray(project)) return paths;
  const tree = (project as Record<string, unknown>).tree;
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return paths;
  const workspace = (tree as Record<string, unknown>).Workspace;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return paths;
  for (const [name, node] of Object.entries(workspace)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) ||
      !node ||
      typeof node !== "object" ||
      Array.isArray(node)
    )
      continue;
    const className = (node as Record<string, unknown>).$className;
    if (className === "Part" || className === "SpawnLocation") paths.add("game.Workspace." + name);
  }
  return paths;
}

/** A planned post-spawn contact must not already be possible at the neutral spawn. */
export function assertNeutralInteractionClearance(
  project: unknown,
  plans: readonly StudioCollectionPlan[],
): void {
  const targets = new Set<string>();
  for (const plan of plans) {
    for (const scenario of plan.scenarios)
      for (const step of scenario.steps)
        if (step.action.kind === "move_to") targets.add(step.action.targetPath);
    for (const phase of plan.phases)
      if (phase.driver.kind === "character_reach_part") targets.add(phase.driver.targetPath);
  }
  if (targets.size === 0 || !project || typeof project !== "object") return;
  const tree = (project as { tree?: { Workspace?: Record<string, unknown> } }).tree;
  const workspace = tree?.Workspace;
  if (!workspace || typeof workspace !== "object") return;
  for (const target of targets) {
    if (!target.startsWith("game.Workspace.")) continue;
    const name = target.slice("game.Workspace.".length);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) || name === "EvalSpawn") continue;
    const node = workspace[name] as
      { $className?: unknown; $properties?: { CFrame?: unknown; Size?: unknown } } | undefined;
    if (node?.$className !== "Part") continue;
    const frame = node.$properties?.CFrame;
    const size = node.$properties?.Size;
    if (
      !Array.isArray(frame) ||
      frame.length !== 12 ||
      !Array.isArray(size) ||
      size.length !== 3 ||
      ![...frame.slice(0, 3), ...size].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    )
      continue;
    const center = frame as number[];
    const dimensions = size as number[];
    const horizontalContact = [0, 2].every(
      (axis) =>
        Math.abs(center[axis]! - SPAWN_POSITION[axis]!) <=
        (dimensions[axis]! + SPAWN_SIZE[axis]!) / 2 + AVATAR_CONTACT_MARGIN,
    );
    const partBottom = center[1]! - dimensions[1]! / 2;
    const partTop = center[1]! + dimensions[1]! / 2;
    const spawnBottom = SPAWN_POSITION[1] - SPAWN_SIZE[1] / 2;
    const avatarTop = SPAWN_POSITION[1] + SPAWN_SIZE[1] / 2 + 6;
    if (horizontalContact && partBottom <= avatarTop && partTop >= spawnBottom)
      throw new Error(
        `Neutral scene interaction target ${name} overlaps EvalSpawn's avatar contact area; place the supplied part farther from spawn so the planned interaction can be observed after baseline`,
      );
  }
}

/** Name every unknown path at once. LocalPlayer paths are known; contracts bind them to clients. */
export function assertNeutralPathReferences(
  value: unknown,
  allowed: ReadonlySet<string>,
  roleIds: readonly string[],
): void {
  const unknown = new Set<string>();
  const visit = (item: unknown) => {
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object")
      for (const [key, child] of Object.entries(item)) {
        if (
          ["path", "targetPath", "barrierPath", "startPath", "endPath"].includes(key) &&
          typeof child === "string" &&
          child.startsWith("game.") &&
          !allowed.has(child) &&
          !isLocalPlayerPath(child)
        )
          unknown.add(child);
        visit(child);
      }
  };
  visit(value);
  const players = [...unknown].filter((path) => path.startsWith("game.Players."));
  const others = [...unknown].filter((path) => !path.startsWith("game.Players."));
  const errors = [
    ...(players.length
      ? [
          `A Player name is not stable, so Basalt reads a Player-owned object or attribute only through game.Players.LocalPlayer, in the client context of the actor that owns it: ${players.join(", ")}. For example, game.Players.LocalPlayer.leaderstats.Wins in the context of that actor.`,
        ]
      : []),
    ...(others.length
      ? [
          `Candidate instances require a public semantic role: ${others.join(", ")}. The neutral scene supplies only ${[...allowed].join(", ")}. The declared roles are ${roleIds.length ? roleIds.map((id) => `role.${id}`).join(", ") : "none"}. The public part can declare a new role for an object that the builder creates. The private part cannot add a role: use a declared role, observe another declared object, or bind the clause to human review.`,
        ]
      : []),
  ];
  if (errors.length) throw new Error(errors.join(" "));
}

/** One neutral workspace for arbitrary server, client and shared Luau modules. */
export function neutralRojoSeed(
  title: string,
  publicScene: PublicScene = { parts: [] },
): EvalProposal["seed"] {
  assertPublicScene(publicScene);
  const name = title.replace(/[^A-Za-z0-9]/gu, "").slice(0, 60) || "BasaltEval";
  return {
    project: {
      name,
      tree: {
        $className: "DataModel",
        Workspace: {
          $className: "Workspace",
          Ground: {
            $className: "Part",
            $properties: {
              Anchored: true,
              CFrame: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
              Size: [80, 1, 80],
            },
          },
          EvalSpawn: {
            $className: "SpawnLocation",
            $properties: {
              Anchored: true,
              Duration: 0,
              Enabled: true,
              Neutral: true,
              CFrame: [...SPAWN_POSITION, 1, 0, 0, 0, 1, 0, 0, 0, 1],
              Size: [...SPAWN_SIZE],
            },
          },
          ...Object.fromEntries(
            publicScene.parts.map((part) => [
              part.name,
              {
                $className: "Part",
                $properties: {
                  Anchored: part.anchored,
                  CanCollide: part.canCollide,
                  Transparency: part.transparency,
                  CFrame: [...part.position, 1, 0, 0, 0, 1, 0, 0, 0, 1],
                  Size: part.size,
                },
              },
            ]),
          ),
        },
        ReplicatedStorage: {
          $className: "ReplicatedStorage",
          Shared: { $path: "src/shared" },
        },
        ServerScriptService: {
          $className: "ServerScriptService",
          $path: "src/server",
        },
        StarterPlayer: {
          $className: "StarterPlayer",
          StarterPlayerScripts: {
            $className: "StarterPlayerScripts",
            $path: "src/client",
          },
        },
      },
    },
    sources: [
      { path: "src/server/Main.server.luau", text: "-- Server implementation starts here.\n" },
      { path: "src/client/Main.client.luau", text: "-- Client implementation starts here.\n" },
      { path: "src/shared/Placeholder.luau", text: "return {}\n" },
    ],
  };
}
