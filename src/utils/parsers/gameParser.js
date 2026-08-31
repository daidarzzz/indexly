// src/utils/parsers/gameParser.js — legacy parser for juegos format
export function parseGameJson(rawJson) {
  const sourceName = rawJson.name || "Fuente Desconocida";
  const downloads = rawJson.downloads || [];
  return downloads.map((item, index) => {
    const meta = {};
    if (item.fileSize && item.fileSize.trim()) meta["Tamaño"] = item.fileSize.trim();
    if (item.uploadDate && String(item.uploadDate).trim()) meta["UploadDate"] = String(item.uploadDate).trim();
    return {
      id: `${sourceName}-${index}`,
      source: sourceName,
      title: item.title || "Sin título",
      fileSize: item.fileSize ? item.fileSize.trim() : "Tamaño desconocido",
      uploadDate: item.uploadDate || "",
      link: item.uris && item.uris.length > 0 ? item.uris[0] : "",
      subtitle: "",
      meta,
      raw: item,
    };
  });
}
