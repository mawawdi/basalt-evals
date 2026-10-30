import type { PublicTask } from "./index.js";

/** The public task text delivered identically to evaluated builders. */
export function publicTaskInstructions(task: PublicTask): string {
  return [
    `Task: ${task.title}`,
    task.prompt,
    "Acceptance statements:",
    ...task.acceptance.map((statement) => `- ${statement}`),
    "Evidence preparation:",
    ...task.evidenceInstructions.map((statement) => `- ${statement}`),
    ...(task.roles.length > 0
      ? [
          `Observation tags: put the role id as a CollectionService tag on the object you create for that role. For example, game:GetService("CollectionService"):AddTag(instance, "${task.roles[0]!.id}"). Use the role id exactly, and keep the object's requested name separately; a tag is not its name.`,
          "Tag any created target, including an optional target. Zero or one permits the target to be absent; an untagged object cannot be identified by these observations. Tags select observation and interaction targets and disclose no private expected values.",
          ...task.roles.map(
            (role) =>
              `- Tag ${role.id}: class ${role.className}, scope ${role.scope}, cardinality ${role.cardinality === "exactly_one" ? "exactly one" : "zero or one"}.`,
          ),
        ]
      : []),
  ].join("\n");
}
