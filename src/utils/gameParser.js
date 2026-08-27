// src/utils/gameParser.js
export function parseGameJson(rawJson) {
  const sourceName = rawJson.name || "Fuente Desconocida";
  const downloads = rawJson.downloads || [];

  return downloads.map((item, index) => ({
    id: `${sourceName}-${index}`,
    source: sourceName,
    title: item.title || "Sin título",
    fileSize: item.fileSize ? item.fileSize.trim() : "Tamaño desconocido",
    uploadDate: item.uploadDate || "",
    // Mapeamos el primer enlace de 'uris' a una propiedad llamada 'link'
    link: item.uris && item.uris.length > 0 ? item.uris[0] : "",
  }));
}
