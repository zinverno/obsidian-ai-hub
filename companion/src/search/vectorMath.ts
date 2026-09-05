import { semanticSearchUnavailable } from "../mcp/errors.js";
const MIN_VECTOR_NORM = 1e-12;
const STORED_UNIT_NORM_TOLERANCE = 1e-4;

function vectorNorm(vector: Float32Array): number {
  let squared = 0;
  for (let index = 0; index < vector.length; index++) {
    const value = vector[index] ?? Number.NaN;
    if (!Number.isFinite(value)) throw semanticSearchUnavailable();
    squared += value * value;
  }
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm <= MIN_VECTOR_NORM) throw semanticSearchUnavailable();
  return norm;
}

export function normalizeQuery(vector: Float32Array, dimensions: number): Float32Array {
  if (vector.length !== dimensions) throw semanticSearchUnavailable();
  const norm = vectorNorm(vector);
  const result = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index++) result[index] = (vector[index] ?? 0) / norm;
  return result;
}

export function scoreVector(stored: Float32Array, query: Float32Array): number {
  if (stored.length !== query.length) throw semanticSearchUnavailable();
  const norm = vectorNorm(stored);
  if (Math.abs(norm - 1) > STORED_UNIT_NORM_TOLERANCE) throw semanticSearchUnavailable();
  let score = 0;
  for (let index = 0; index < stored.length; index++) score += (stored[index] ?? 0) * (query[index] ?? 0);
  if (!Number.isFinite(score)) throw semanticSearchUnavailable();
  return Math.max(-1, Math.min(1, score));
}

