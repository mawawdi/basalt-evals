"use client";
import { useMemo, useState, type ReactNode } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes } from "mdast";
import s from "./workbench.module.css";
import { ScrollRegion } from "./ui";

function render(node: Nodes, key: number, base: number): ReactNode {
  const children =
    "children" in node ? node.children.map((child, index) => render(child, index, base)) : null;
  switch (node.type) {
    case "text":
      return node.value;
    case "paragraph":
      return <p key={key}>{children}</p>;
    case "heading": {
      const Heading = (["h3", "h4", "h5", "h6"] as const)[
        Math.min(3, Math.max(0, node.depth - base))
      ]!;
      return <Heading key={key}>{children}</Heading>;
    }
    case "strong":
      return <strong key={key}>{children}</strong>;
    case "emphasis":
      return <em key={key}>{children}</em>;
    case "delete":
      return <del key={key}>{children}</del>;
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "code":
      return (
        <pre key={key} className={s.code}>
          <code>{node.value}</code>
        </pre>
      );
    case "blockquote":
      return <blockquote key={key}>{children}</blockquote>;
    case "list":
      return node.ordered ? (
        <ol key={key} start={node.start ?? 1}>
          {children}
        </ol>
      ) : (
        <ul key={key}>{children}</ul>
      );
    case "listItem":
      return (
        <li key={key}>
          {typeof node.checked === "boolean" && (
            <input
              type="checkbox"
              checked={node.checked}
              readOnly
              aria-label={node.checked ? "Checked item" : "Unchecked item"}
            />
          )}
          {children}
        </li>
      );
    case "break":
      return <br key={key} />;
    case "thematicBreak":
      return <hr key={key} />;
    case "link":
      return /^https?:\/\//u.test(node.url) ? (
        <a key={key} href={node.url} target="_blank" rel="noreferrer">
          {children}
        </a>
      ) : (
        <span key={key}>{children}</span>
      );
    case "image":
      return <span key={key}>{node.alt || "Image reference"}</span>;
    case "html":
      return <code key={key}>{node.value}</code>;
    case "table":
      return (
        <ScrollRegion label="Authored Markdown table" key={key}>
          <table>
            <thead>
              <tr>
                {node.children[0]?.children.map((cell, index) => (
                  <th key={index} scope="col">
                    {cell.children.map((child, i) => render(child, i, base))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{node.children.slice(1).map((row, index) => render(row, index, base))}</tbody>
          </table>
        </ScrollRegion>
      );
    case "tableRow":
      return <tr key={key}>{children}</tr>;
    case "tableCell":
      return <td key={key}>{children}</td>;
    default:
      return <span key={key}>{children}</span>;
  }
}

export function MarkdownText({ value }: { value: string }) {
  const document = useMemo(
    () => fromMarkdown(value, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
    [value],
  );
  const base = Math.min(
    ...document.children.filter((node) => node.type === "heading").map((node) => node.depth),
    6,
  );
  return (
    <div className={s.markdown}>
      {document.children.map((node, index) => render(node, index, base))}
    </div>
  );
}

export function MarkdownPreview({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Show formatted text</summary>
      {open && <MarkdownText value={value} />}
    </details>
  );
}
