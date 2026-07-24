import {
  VectorStoreCompatibilityError,
  VectorStoreCorruptionError,
  VectorValidationError,
} from "./errors";

export const VECTOR_BINARY_VERSION = 1;
export const VECTOR_BINARY_HEADER_BYTES = 24;

// ASCII "VAAVEC01": Vault Audit AI vector binary format, revision 01.
export const VECTOR_BINARY_MAGIC: readonly number[] = Object.freeze([
  0x56, 0x41, 0x41, 0x56, 0x45, 0x43, 0x30, 0x31,
]);

// Layout, all numeric fields little-endian:
// 0..7 magic, 8 version u32, 12 generation u32, 16 dimensions u32,
// 20 count u32, 24..EOF row-major count × dimensions float32 values.

const UINT32_MAX = 0xffff_ffff;

export interface DecodedVectorBinary {
  version: number;
  generation: number;
  dimensions: number;
  count: number;
  vectors: Float32Array;
}

export function vectorBinaryByteLength(
  count: number,
  dimensions: number,
): number {
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    count > UINT32_MAX ||
    !Number.isInteger(dimensions) ||
    dimensions <= 0 ||
    dimensions > UINT32_MAX
  ) {
    throw new VectorValidationError(
      "Vector binary count or dimensions are invalid.",
    );
  }

  const byteLength =
    VECTOR_BINARY_HEADER_BYTES + count * dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(byteLength)) {
    throw new VectorValidationError("Vector binary is too large.");
  }
  return byteLength;
}

export function encodeVectorBinary(
  generation: number,
  dimensions: number,
  count: number,
  vectors: Float32Array,
): ArrayBuffer {
  if (
    !Number.isInteger(generation) ||
    generation < 0 ||
    generation > UINT32_MAX
  ) {
    throw new VectorValidationError("Vector generation is out of range.");
  }
  if (!(vectors instanceof Float32Array)) {
    throw new VectorValidationError("Vectors must be a Float32Array.");
  }
  if (vectors.length !== count * dimensions) {
    throw new VectorValidationError(
      "Vector matrix length does not match its header.",
    );
  }

  const buffer = new ArrayBuffer(vectorBinaryByteLength(count, dimensions));
  const view = new DataView(buffer);
  for (let index = 0; index < VECTOR_BINARY_MAGIC.length; index++) {
    view.setUint8(index, VECTOR_BINARY_MAGIC[index]);
  }
  view.setUint32(8, VECTOR_BINARY_VERSION, true);
  view.setUint32(12, generation, true);
  view.setUint32(16, dimensions, true);
  view.setUint32(20, count, true);

  let offset = VECTOR_BINARY_HEADER_BYTES;
  for (let index = 0; index < vectors.length; index++) {
    const value = vectors[index];
    if (!Number.isFinite(value)) {
      throw new VectorValidationError("Vector matrix contains a non-finite value.");
    }
    view.setFloat32(offset, value, true);
    offset += Float32Array.BYTES_PER_ELEMENT;
  }
  return buffer;
}

export function decodeVectorBinary(buffer: ArrayBuffer): DecodedVectorBinary {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new VectorStoreCorruptionError(
      "Vector binary is not an ArrayBuffer.",
    );
  }
  if (buffer.byteLength < VECTOR_BINARY_HEADER_BYTES) {
    throw new VectorStoreCorruptionError("Vector binary header is truncated.");
  }

  const view = new DataView(buffer);
  for (let index = 0; index < VECTOR_BINARY_MAGIC.length; index++) {
    if (view.getUint8(index) !== VECTOR_BINARY_MAGIC[index]) {
      throw new VectorStoreCorruptionError("Vector binary magic is invalid.");
    }
  }

  const version = view.getUint32(8, true);
  if (version !== VECTOR_BINARY_VERSION) {
    throw new VectorStoreCompatibilityError(
      `Unsupported vector binary version: ${version}.`,
    );
  }

  const generation = view.getUint32(12, true);
  const dimensions = view.getUint32(16, true);
  const count = view.getUint32(20, true);
  if (dimensions === 0) {
    throw new VectorStoreCorruptionError(
      "Vector binary dimensions must be positive.",
    );
  }

  let expectedBytes: number;
  try {
    expectedBytes = vectorBinaryByteLength(count, dimensions);
  } catch {
    throw new VectorStoreCorruptionError("Vector binary header is invalid.");
  }
  if (buffer.byteLength !== expectedBytes) {
    throw new VectorStoreCorruptionError(
      "Vector binary byte length does not match its header.",
    );
  }

  const vectors = new Float32Array(count * dimensions);
  let offset = VECTOR_BINARY_HEADER_BYTES;
  for (let index = 0; index < vectors.length; index++) {
    const value = view.getFloat32(offset, true);
    if (!Number.isFinite(value)) {
      throw new VectorStoreCorruptionError(
        "Vector binary contains a non-finite value.",
      );
    }
    vectors[index] = value;
    offset += Float32Array.BYTES_PER_ELEMENT;
  }

  return { version, generation, dimensions, count, vectors };
}
