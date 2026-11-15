// The parts of Electron's asar format that patch.mjs needs: read an archive, and write it back with files
// replaced or added. New contents go after the existing data, so every other file keeps its offset (the bytes
// a replaced file used stay behind, unused). Files kept in app.asar.unpacked are not touched.
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

// Layout: a pickle holding the header pickle's size, then the header pickle (payload size, string length,
// the header JSON, padding to 4 bytes), then the files' data.
export function readAsar(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw new Error(`${path} is not an asar archive.`);
  const headerSize = bytes.readUInt32LE(4);
  const jsonSize = bytes.readUInt32LE(12);
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString("utf8"));
  return { bytes, header, base: 8 + headerSize };
}

export function entryOf(archive, file) {
  let node = archive.header;
  for (const part of file.split("/")) {
    node = node.files?.[part];
    if (!node) return null;
  }
  return node;
}

export function readEntry(archive, file) {
  const entry = entryOf(archive, file);
  if (!entry || entry.files || entry.unpacked || entry.link || entry.offset === undefined)
    throw new Error(`${file} is not a file packed in the archive.`);
  const start = archive.base + Number(entry.offset);
  return archive.bytes.subarray(start, start + entry.size);
}

// Every file whose data is inside the archive, by path.
export function packedFiles(archive) {
  const found = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, path);
      else if (!child.unpacked && !child.link && child.offset !== undefined) found.push(path);
    }
  };
  walk(archive.header, "");
  return found;
}

const BLOCK = 4 * 1024 * 1024;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
function integrity(data) {
  const blocks = [];
  for (let start = 0; start < data.length; start += BLOCK) blocks.push(sha256(data.subarray(start, start + BLOCK)));
  return { algorithm: "SHA256", hash: sha256(data), blockSize: BLOCK, blocks: blocks.length ? blocks : [sha256(Buffer.alloc(0))] };
}

export function encodeAsar(header, data) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = Math.ceil(json.length / 4) * 4;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(4 + padded, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle, ...data]);
}

// The archive with `changes` ({ "dir/file": Buffer }) applied, as bytes.
export function withChanges(archive, changes) {
  const header = structuredClone(archive.header);
  const existing = archive.bytes.subarray(archive.base);
  const appended = [];
  let offset = existing.length;
  for (const [file, data] of Object.entries(changes)) {
    const parts = file.split("/");
    const name = parts.pop();
    let directory = header;
    for (const part of parts) {
      directory.files ??= {};
      directory = directory.files[part] ??= { files: {} };
      if (!directory.files) throw new Error(`${file}: ${part} is not a directory in the archive.`);
    }
    directory.files ??= {};
    const previous = directory.files[name];
    if (previous && (previous.files || previous.unpacked || previous.link)) throw new Error(`${file} cannot be replaced.`);
    directory.files[name] = { size: data.length, offset: String(offset), integrity: integrity(data) };
    appended.push(data);
    offset += data.length;
  }
  return encodeAsar(header, [existing, ...appended]);
}

export function writeAsar(archive, changes, path) {
  const temporary = `${path}.mobicodex-tmp`;
  writeFileSync(temporary, withChanges(archive, changes));
  renameSync(temporary, path);
}
