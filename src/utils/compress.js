// src/utils/compress.js — gzip via native CompressionStream + sniff

export function hasCompressionSupport() {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

export async function compressJsonToBlob(jsonStr) {
  if (!hasCompressionSupport()) {
    return new Blob([jsonStr], { type: "application/json" });
  }
  const input = new Blob([jsonStr], { type: "application/json" });
  const cs = new CompressionStream("gzip");
  const compressed = await new Response(input.stream().pipeThrough(cs)).blob();
  return compressed;
}

export async function decompressBlobToText(blob) {
  // sniff gzip magic bytes 1f 8b
  const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const isGzip = header.length === 2 && header[0] === 0x1f && header[1] === 0x8b;
  if (isGzip) {
    if (!hasCompressionSupport()) throw new Error("Backup comprimido (.gz) — tu navegador no soporta descompresión. Usa un navegador moderno.");
    const ds = new DecompressionStream("gzip");
    const decompressed = await new Response(blob.stream().pipeThrough(ds)).text();
    return decompressed;
  }
  // not gzip -> assume plain text
  return await blob.text();
}

// Helper for import file sniff + decode to parsed JSON object
export async function decodeBackupFile(file) {
  // file is File/Blob
  const text = await decompressBlobToText(file);
  const parsed = JSON.parse(text);
  return parsed;
}
