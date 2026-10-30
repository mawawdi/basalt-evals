const BLOCK = 512;

interface TarEntry {
  /** A relative path with "/" separators. */
  path: string;
  bytes: Uint8Array;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function put(header: Uint8Array, offset: number, width: number, value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > width) throw new Error(`A tar header field is too long: ${value}`);
  header.set(bytes, offset);
}

/** Split a path into the ustar name (100 bytes) and prefix (155 bytes) fields. */
function split(path: string): { name: string; prefix: string } {
  const size = (value: string) => new TextEncoder().encode(value).length;
  if (size(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.indexOf("/"); index > 0; index = path.indexOf("/", index + 1)) {
    const prefix = path.slice(0, index),
      name = path.slice(index + 1);
    if (size(prefix) <= 155 && size(name) <= 100 && name) return { name, prefix };
  }
  throw new Error(`The path is too long for a tar file: ${path}`);
}

function header(path: string, size: number, modifiedSeconds: number): Uint8Array {
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === ".." || !part))
    throw new Error(`A tar entry needs a safe relative path: ${path}`);
  const block = new Uint8Array(BLOCK);
  const { name, prefix } = split(path);
  put(block, 0, 100, name);
  put(block, 100, 8, octal(0o644, 8));
  put(block, 108, 8, octal(0, 8));
  put(block, 116, 8, octal(0, 8));
  put(block, 124, 12, octal(size, 12));
  put(block, 136, 12, octal(modifiedSeconds, 12));
  put(block, 148, 8, "        ");
  put(block, 156, 1, "0");
  put(block, 257, 6, "ustar\0");
  put(block, 263, 2, "00");
  put(block, 345, 155, prefix);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  put(block, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** A POSIX ustar archive of regular files. Readers create the parent folders. */
export function tarArchive(entries: TarEntry[], modifiedAt: Date): Uint8Array {
  const seconds = Math.floor(modifiedAt.getTime() / 1000);
  const blocks = entries.reduce((sum, entry) => sum + 1 + Math.ceil(entry.bytes.length / BLOCK), 2);
  const archive = new Uint8Array(blocks * BLOCK);
  let offset = 0;
  for (const entry of entries) {
    archive.set(header(entry.path, entry.bytes.length, seconds), offset);
    offset += BLOCK;
    archive.set(entry.bytes, offset);
    offset += Math.ceil(entry.bytes.length / BLOCK) * BLOCK;
  }
  return archive;
}
