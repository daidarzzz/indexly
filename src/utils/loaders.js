// src/utils/loaders.js — parse various file formats into raw object for normalizer
import { parse as parseYaml } from "yaml";

function parseCsv(text, delimiter=",") {
  const lines = text.trim().split(/\r?\n/).filter(l=>l.trim());
  if (lines.length===0) return [];
  const headers = splitCsvLine(lines[0], delimiter).map(h=>h.trim());
  const rows = [];
  for (let i=1;i<lines.length;i++) {
    const vals = splitCsvLine(lines[i], delimiter);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] !== undefined ? vals[idx].trim() : ""; });
    // skip empty rows
    if (Object.values(obj).some(v=>v!=="")) rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line, delimiter) {
  const res = [];
  let cur = "";
  let inQuotes = false;
  for (let i=0;i<line.length;i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i+1]==='"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c===delimiter && !inQuotes) {
      res.push(cur); cur="";
    } else {
      cur += c;
    }
  }
  res.push(cur);
  return res.map(v=> v.startsWith('"') && v.endsWith('"') ? v.slice(1,-1).replace(/""/g,'"') : v);
}

function parseXml(text) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("XML inválido");
    // Find most frequent child element as array
    const root = doc.documentElement;
    const children = Array.from(root.children);
    if (children.length===0) return { name: root.tagName, items: [] };
    // Group by tag name
    const counts = {};
    children.forEach(c=> counts[c.tagName] = (counts[c.tagName]||0)+1);
    const mostCommon = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0];
    if (!mostCommon || counts[mostCommon] < 2) {
      // treat each child as item with its children as fields
      const items = children.map(el=> xmlElToObj(el));
      return { name: root.tagName, items };
    }
    const items = children.filter(c=>c.tagName===mostCommon).map(el=> xmlElToObj(el));
    return { name: root.tagName, items };
  } catch (e) { throw new Error("Error parsing XML: "+e.message); }
}

function xmlElToObj(el) {
  const obj = {};
  // attributes
  for (const attr of el.attributes || []) obj[attr.name] = attr.value;
  // child elements
  const childEls = Array.from(el.children);
  if (childEls.length>0) {
    childEls.forEach(child => {
      if (child.children.length===0) obj[child.tagName] = child.textContent.trim();
      else obj[child.tagName] = child.textContent.trim();
    });
  } else {
    const txt = el.textContent.trim();
    if (txt) obj["title"] = txt;
  }
  return obj;
}

export function parseFileContent(text, fileName) {
  const ext = fileName.split(".").pop().toLowerCase();
  if (ext==="csv") {
    const rows = parseCsv(text, ",");
    return { name: fileName.replace(/\.csv$/i,""), items: rows };
  }
  if (ext==="tsv") {
    const rows = parseCsv(text, "\t");
    return { name: fileName.replace(/\.tsv$/i,""), items: rows };
  }
  if (ext==="yaml" || ext==="yml") {
    const data = parseYaml(text);
    if (Array.isArray(data)) return { name: fileName.replace(/\.ya?ml$/i,""), items: data };
    if (data && typeof data==="object") return data;
    return { name: fileName.replace(/\.ya?ml$/i,""), items: [] };
  }
  if (ext==="xml") {
    return parseXml(text);
  }
  if (ext==="txt") {
    const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    const items = lines.map(title=>({ title }));
    return { name: fileName.replace(/\.txt$/i,""), items };
  }
  // default json
  return JSON.parse(text);
}
