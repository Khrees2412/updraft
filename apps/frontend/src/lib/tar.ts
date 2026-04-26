import type { FileEntry } from './upload-filter';

const BLOCK_SIZE = 512;

function writeString(buf: Uint8Array, offset: number, str: string, length: number): void {
  const bytes = new TextEncoder().encode(str);
  const n = Math.min(bytes.length, length);
  for (let i = 0; i < n; i += 1) buf[offset + i] = bytes[i]!;
}

function writeOctal(buf: Uint8Array, offset: number, value: number, length: number): void {
  const str = value.toString(8).padStart(length - 1, '0');
  writeString(buf, offset, str, length - 1);
}

function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i += 1) sum += header[i]!;
  return sum;
}

function buildHeader(path: string, size: number, mtime: number): Uint8Array {
  if (new TextEncoder().encode(path).length > 100) {
    throw new Error(`Path too long for ustar (>100 bytes): ${path}`);
  }
  const header = new Uint8Array(BLOCK_SIZE);
  writeString(header, 0, path, 100);
  writeOctal(header, 100, 0o644, 8);
  writeOctal(header, 108, 0, 8);
  writeOctal(header, 116, 0, 8);
  writeOctal(header, 124, size, 12);
  writeOctal(header, 136, Math.floor(mtime / 1000), 12);
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  header[156] = 0x30;
  writeString(header, 257, 'ustar', 6);
  writeString(header, 263, '00', 2);
  const sum = checksum(header);
  writeOctal(header, 148, sum, 8);
  header[155] = 0x20;
  return header;
}

function pad(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

export async function createTarBlob(entries: FileEntry[]): Promise<Blob> {
  const parts: ArrayBuffer[] = [];
  const now = Date.now();
  for (const entry of entries) {
    const buffer = await entry.file.arrayBuffer();
    const header = buildHeader(entry.relativePath, buffer.byteLength, now);
    parts.push(header.buffer as ArrayBuffer);
    parts.push(buffer);
    const padding = pad(buffer.byteLength);
    if (padding > 0) parts.push(new Uint8Array(padding).buffer as ArrayBuffer);
  }
  parts.push(new Uint8Array(BLOCK_SIZE * 2).buffer as ArrayBuffer);
  return new Blob(parts, { type: 'application/x-tar' });
}
