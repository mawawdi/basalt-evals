import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import {
  EVIDENCE_CLASSES,
  isEvidenceClass,
  isPolarity,
  POLARITIES,
  type EvidenceClass,
  type Polarity,
} from "../../contracts/src/index.js";

export interface RubricNode {
  id: string;
  kind: "heading" | "paragraph" | "list_item" | "table" | "table_row" | "unsupported";
  role: "requirement" | "context" | "grading_metadata" | "unresolved";
  start: number;
  end: number;
  text: string;
  parentId: string | null;
  required: boolean;
}

export interface AuthoredClause {
  id: string;
  start: number;
  end: number;
  text: string;
}

/** Recognize explicit authority markers, not incidental mentions of optional features. */
export function authoredRequired(text: string, inherited = true, heading = false): boolean {
  const label = text
    .trim()
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/^(?:\*\*|__)(optional|required|mandatory)(\s*[:—-])?(?:\*\*|__)/iu, "$1$2");
  if (heading && /^optional(?:\s|$)/iu.test(label)) return false;
  if (
    /^(?:optional\s*[:—-]|\[optional\]|\(optional\)|optional(?: requirements| criteria| goals| extras)?$)/iu.test(
      label,
    )
  )
    return false;
  if (/^(?:required|mandatory)(?:\s|:|$)/iu.test(label)) return true;
  return inherited;
}

interface SyntaxNode {
  type: string;
  depth?: number;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SyntaxNode[];
}

function cellContents(cell: SyntaxNode): SyntaxNode {
  const first = cell.children?.[0],
    last = cell.children?.at(-1);
  return first && last
    ? { ...cell, position: { start: first.position!.start, end: last.position!.end } }
    : cell;
}

function metadataLines(text: string): string[] {
  return text
    .trim()
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/\*\*|__/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Scales, weights, anchors, the evidence class, the polarity and sufficiency conditions are
 * grading metadata. They govern judgment and never become a scored requirement.
 */
function metadata(text: string): boolean {
  return metadataLines(text).every((line) =>
    /^(?:(?:minimum )?passing score|(?:scoring )?weight|scale|scoring scale|score\s+\d|anchors?\s*:|evidence class\s*:|polarity\s*:|insufficient evidence(?:\s+(?:when|if)\b|\s*:))/iu.test(
      line,
    ),
  );
}

/**
 * An evidence class, a polarity or a sufficiency condition inside requirement text is ambiguous
 * authority.
 */
function embeddedMetadata(text: string): boolean {
  return /\bevidence class\s*:|\bpolarity\s*:|\binsufficient evidence(?:\s+(?:when|if)\b|\s*:)/iu.test(
    text,
  );
}

/** Read the evidence class that one grading metadata passage sets, if any. */
export function authoredEvidenceClass(text: string): EvidenceClass | null {
  const values = new Set<EvidenceClass>();
  for (const line of metadataLines(text)) {
    const match = /^evidence class\s*:\s*(.*?)\s*\.?$/iu.exec(line);
    if (!match) continue;
    const value = match[1]!.toLowerCase();
    if (!isEvidenceClass(value))
      throw new Error(
        `Basalt does not know the evidence class ${JSON.stringify(match[1])}. Use one of these evidence classes: ${EVIDENCE_CLASSES.join(", ")}.`,
      );
    values.add(value);
  }
  if (values.size > 1)
    throw new Error(
      "One passage of the success criteria sets more than one evidence class. Keep one evidence class in each passage.",
    );
  return [...values][0] ?? null;
}

/** Read the polarity that one grading metadata passage sets, if any. */
export function authoredPolarity(text: string): Polarity | null {
  const values = new Set<Polarity>();
  for (const line of metadataLines(text)) {
    const match = /^polarity\s*:\s*(.*?)\s*\.?$/iu.exec(line);
    if (!match) continue;
    const value = match[1]!.toLowerCase();
    if (!isPolarity(value))
      throw new Error(
        `Basalt does not know the polarity ${JSON.stringify(match[1])}. Use one of these polarities: ${POLARITIES.join(", ")}.`,
      );
    values.add(value);
  }
  if (values.size > 1)
    throw new Error(
      "One passage of the success criteria sets more than one polarity. Keep one polarity in each passage.",
    );
  return [...values][0] ?? null;
}

/** One syntax tree preserves Markdown hierarchy and exact UTF-16 source spans. */
export function rubricDocument(text: string): RubricNode[] {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const nodes: RubricNode[] = [];
  const add = (
    syntax: SyntaxNode,
    kind: RubricNode["kind"],
    role: RubricNode["role"],
    parent: RubricNode | null,
    end?: number,
  ) => {
    const start = syntax.position?.start.offset;
    const stop = end ?? syntax.position?.end.offset;
    if (start === undefined || stop === undefined)
      throw new Error("Rubric passage lacks source offsets");
    const raw = text.slice(start, stop);
    const leading = raw.length - raw.trimStart().length;
    const node: RubricNode = {
      id: "passage-" + (nodes.length + 1),
      kind,
      // Grading metadata must stand alone. It never becomes part of a scored requirement.
      role: role === "requirement" && embeddedMetadata(raw) ? "unresolved" : role,
      start: start + leading,
      end: stop - (raw.length - raw.trimEnd().length),
      text: raw.trim(),
      parentId: parent?.id ?? null,
      required: authoredRequired(raw, parent?.required ?? true, role === "context"),
    };
    if (node.text) nodes.push(node);
    return node;
  };
  const visit = (children: SyntaxNode[], parent: RubricNode | null, anchors = false) => {
    const headings: Array<{ depth: number; node: RubricNode }> = [];
    let lead: RubricNode | null = null;
    for (let index = 0; index < children.length; index++) {
      const syntax = children[index]!;
      if (syntax.type === "heading") {
        const depth = syntax.depth!;
        while (headings.length && headings.at(-1)!.depth >= depth) headings.pop();
        const node = add(syntax, "heading", "context", headings.at(-1)?.node ?? parent);
        headings.push({ depth, node });
        lead = null;
        continue;
      }
      const scope = headings.at(-1)?.node ?? parent;
      if (syntax.type === "list") {
        const items = syntax.children ?? [];
        const numericAnchors =
          items.length >= 2 &&
          items.every((item) =>
            /^\s*[-*+]\s+\d+(?:\.\d+)?\s*:/u.test(
              text.slice(item.position!.start.offset, item.position!.end.offset),
            ),
          );
        visit(items, lead ?? scope, numericAnchors);
        lead = null;
      } else if (syntax.type === "listItem") {
        const contents = syntax.children ?? [];
        const nested = contents.find((child) => child.type === "list");
        const end = nested?.position?.start.offset ?? syntax.position?.end.offset;
        const raw = text.slice(syntax.position!.start.offset!, end);
        const node = add(
          syntax,
          "list_item",
          anchors || metadata(raw) ? "grading_metadata" : "requirement",
          scope,
          end,
        );
        if (nested) visit(contents.slice(contents.indexOf(nested)), node);
      } else if (syntax.type === "table") {
        const rows = syntax.children ?? [];
        const headerText = text.slice(
          rows[0]!.position!.start.offset,
          rows[0]!.position!.end.offset,
        );
        const anchors = /^\|?\s*(?:score|rating|points?)\s*\|/iu.test(headerText);
        // Requirement rows share column meanings, not one another's thresholds.
        const table = add(
          syntax,
          "table",
          "context",
          scope,
          anchors ? undefined : rows[0]!.position!.end.offset,
        );
        const headers =
          rows[0]!.children
            ?.map((cell) => cellContents(cell))
            .map((cell) =>
              text
                .slice(cell.position!.start.offset, cell.position!.end.offset)
                .trim()
                .replace(/\*\*|__/gu, "")
                .toLowerCase(),
            ) ?? [];
        const requiredColumn = headers.findIndex((header) =>
          ["required", "requiredness", "requirement type", "importance"].includes(header),
        );
        for (const [rowIndex, row] of rows.entries()) {
          const node = add(
            row,
            "table_row",
            rowIndex === 0 ? "context" : anchors ? "grading_metadata" : "requirement",
            table,
          );
          if (rowIndex > 0 && !anchors && requiredColumn >= 0) {
            const original = row.children?.[requiredColumn];
            const cell = original ? cellContents(original) : undefined;
            const label = cell
              ? text
                  .slice(cell.position!.start.offset, cell.position!.end.offset)
                  .trim()
                  .replace(/\*\*|__/gu, "")
                  .toLowerCase()
              : "";
            const optional =
              label === "optional" || (headers[requiredColumn] === "required" && label === "no");
            const required =
              ["required", "mandatory"].includes(label) ||
              (headers[requiredColumn] === "required" && label === "yes");
            if (optional || required) node.required = required;
            else if (cell) add(cell, "unsupported", "unresolved", node);
          }
        }
      } else if (syntax.type === "paragraph") {
        const raw = text.slice(syntax.position!.start.offset, syntax.position!.end.offset);
        const isLead = raw.trimEnd().endsWith(":") && children[index + 1]?.type === "list";
        const node = add(
          syntax,
          "paragraph",
          isLead ? "context" : metadata(raw) ? "grading_metadata" : "requirement",
          scope,
        );
        lead = isLead ? node : null;
      } else if (syntax.type === "blockquote") {
        visit(syntax.children ?? [], scope);
      } else if (syntax.type !== "thematicBreak" && syntax.type !== "definition") {
        add(syntax, "unsupported", "unresolved", scope);
      }
    }
  };
  visit(tree.children as SyntaxNode[], null);
  return nodes;
}

/** Clause boundaries aid coverage auditing; they do not assign AND/OR semantics. */
export function authoredClauses(text: string, start: number, id: string): AuthoredClause[] {
  const clauses: AuthoredClause[] = [];
  const boundaries = [
    ...text.matchAll(/(?:[.;!?](?=\s|$)|\s+(?:and|or|unless|except|provided that)\s+)/giu),
  ];
  let offset = 0;
  for (const end of [...boundaries.map((match) => match.index! + match[0].length), text.length]) {
    const raw = text.slice(offset, end);
    const trimmed = raw.trim();
    if (trimmed) {
      const begin = offset + raw.indexOf(trimmed);
      clauses.push({
        id: id + "-clause-" + (clauses.length + 1),
        start: start + begin,
        end: start + begin + trimmed.length,
        text: trimmed,
      });
    }
    offset = end;
  }
  return clauses;
}

/** Context includes scoped metadata, which remains authority but is not a scored criterion. */
export function rubricContext(document: RubricNode[], node: RubricNode): string[] {
  const ancestors: string[] = [];
  let parent = node.parentId;
  while (parent) {
    ancestors.unshift(parent);
    parent = document.find((candidate) => candidate.id === parent)?.parentId ?? null;
  }
  const scopes = new Set<string | null>([null, node.id, ...ancestors]);
  const metadataIds = document
    .filter(
      (candidate) =>
        candidate.role === "grading_metadata" &&
        (scopes.has(candidate.parentId) ||
          document.some(
            (table) =>
              table.id === candidate.parentId &&
              table.kind === "table" &&
              scopes.has(table.parentId),
          )),
    )
    .map((candidate) => candidate.id);
  return [...new Set([...ancestors, ...metadataIds])];
}
