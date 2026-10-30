import b from "./benchmark.module.css";
import g from "./outcome-grid.module.css";

/** The tone of a part. Pending uses the hatch of the spending ledger. */
type SplitTone = "solid" | "mid" | "light" | "outline" | "pending";

interface SplitPart {
  label: string;
  /** The stage of the part. Parts of one stage share one line of the key. */
  group?: string;
  /** Null when Basalt has no record of this part. */
  value: number | null;
  tone: SplitTone;
}

const toneClass: Record<SplitTone, string | undefined> = {
  solid: g.toneSolid,
  mid: g.toneMid,
  light: g.toneLight,
  outline: g.toneOutline,
  pending: g.tonePending,
};

/**
 * Separate measured parts of one build in proportion. A part without a record is a fixed
 * hatch, never a zero. The bar shows no total, because the parts can overlap. Only a measured
 * figure that a caller supplies is printed above it.
 */
export function SplitBar({
  caption,
  parts,
  format,
  figure,
}: {
  caption: string;
  parts: SplitPart[];
  format: (value: number) => string;
  figure?: { label: string; value: number | null; absent: string };
}) {
  const text = (value: number | null) => (value === null ? "Not recorded" : format(value));
  const name = (part: SplitPart) => (part.group ? `${part.group}: ${part.label}` : part.label);
  const groups: Array<{ name?: string; parts: SplitPart[] }> = [];
  for (const part of parts) {
    const last = groups.at(-1);
    if (last && last.name === part.group) last.parts.push(part);
    else groups.push({ name: part.group, parts: [part] });
  }
  // Flex shares under 1 leave free space, so the largest part gets a share of 1.
  const scale = Math.max(...parts.map((part) => part.value ?? 0));
  return (
    <div className={g.split}>
      {figure && (
        <p className={g.splitFigure} aria-hidden>
          {figure.label}{" "}
          <strong className={figure.value === null ? g.words : undefined}>
            {figure.value === null ? figure.absent : format(figure.value)}
          </strong>
        </p>
      )}
      <span className={g.splitBar} aria-hidden>
        {parts.map((part) =>
          part.value === null ? (
            <span key={name(part)} className={g.unrecorded} />
          ) : part.value > 0 ? (
            <span
              key={name(part)}
              className={toneClass[part.tone]}
              style={{ flexGrow: part.value / scale }}
            />
          ) : null,
        )}
      </span>
      <div className={g.splitKey} aria-hidden>
        {groups.map((group, index) => (
          <div className={g.splitRow} key={group.name ?? index}>
            {group.name && <span className={g.splitGroup}>{group.name}</span>}
            <ul>
              {group.parts.map((part) => (
                <li key={part.label}>
                  <span className={part.value === null ? g.unrecorded : toneClass[part.tone]} />
                  {part.label}{" "}
                  <strong className={part.value === null ? g.words : undefined}>
                    {text(part.value)}
                  </strong>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {/* A table cannot shrink below its content, so a hidden block clips it. */}
      <div className={b.visuallyHidden}>
        <table>
          <caption>{caption}</caption>
          <tbody>
            {figure && (
              <tr>
                <th scope="row">{figure.label}</th>
                <td>{figure.value === null ? figure.absent : format(figure.value)}</td>
              </tr>
            )}
            {parts.map((part) => (
              <tr key={name(part)}>
                <th scope="row">{name(part)}</th>
                <td>{text(part.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
