// src/utils/parsers/registry.js
import { parseGameJson } from "./gameParser.js";
import { normalizeJson } from "../normalizer.js";

export const parsers = {
  auto: (raw, fileName) => normalizeJson(raw, fileName),
  juegos: (raw) => parseGameJson(raw),
};

export function getParser(type) {
  return parsers[type] || parsers.auto;
}
