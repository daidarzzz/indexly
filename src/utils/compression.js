import { gzipSync, decompressSync } from 'fflate';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const EXPORT_VERSION = 2;

function optimizePkg(pkg) {
  if (!pkg || !pkg.slug) return null;
  return [pkg.slug, pkg.name || pkg.slug, pkg.version || null, pkg.r2Url || null];
}

function restorePkg(p) {
  if (!Array.isArray(p) || !p[0]) return null;
  return { slug: String(p[0]), name: String(p[1] || p[0]), version: p[2] || null, r2Url: p[3] || null };
}

function optimizeItem(item) {
  const mapping = item.mapping;
  return {
    n: item.name,
    a: item.active,
    m: mapping ? [mapping.titleKey, mapping.subtitleKey, mapping.linkKey] : null,
    r: item.rawData,
    p: optimizePkg(item.pkg),
  };
}

export function buildExportPayload(indexes) {
  return {
    v: EXPORT_VERSION,
    d: indexes.map(optimizeItem),
  };
}

export function compressExport(indexes) {
  const payload = buildExportPayload(indexes);
  const jsonStr = JSON.stringify(payload);
  const originalBytes = encoder.encode(jsonStr);
  const compressed = gzipSync(originalBytes, { level: 9 });
  return {
    bytes: compressed,
    originalSize: originalBytes.length,
    compressedSize: compressed.length,
  };
}

export function decompressImport(bytes) {
  const decompressed = decompressSync(bytes);
  const jsonStr = decoder.decode(decompressed);
  return JSON.parse(jsonStr);
}

export function restoreExportPayload(payload) {
  if (!payload || !Array.isArray(payload.d)) return [];
  return payload.d.map(item => ({
    name: item.n,
    active: item.a,
    mapping: item.m ? { titleKey: item.m[0], subtitleKey: item.m[1], linkKey: item.m[2] } : null,
    rawData: item.r,
    pkg: restorePkg(item.p),
  }));
}

export function detectGzipFile(fileName) {
  return fileName.toLowerCase().endsWith('.gz') || fileName.toLowerCase().endsWith('.json.gz');
}

export function isGzipBytes(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function readFileAsBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}