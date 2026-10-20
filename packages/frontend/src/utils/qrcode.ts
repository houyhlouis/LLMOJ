// A QR code (ISO/IEC 18004) encoder for short texts such as otpauth:// URIs: byte mode, versions 1 to 40.

export type QrErrorCorrection = "L" | "M" | "Q" | "H";

const FORMAT_BITS: Record<QrErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Indexed by version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK: Record<QrErrorCorrection, number[]> = {
  L: [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30
  ],
  M: [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28
  ],
  Q: [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30
  ],
  H: [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30
  ]
};
const ERROR_CORRECTION_BLOCKS: Record<QrErrorCorrection, number[]> = {
  L: [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19,
    19, 20, 21, 22, 24, 25
  ],
  M: [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31,
    33, 35, 37, 38, 40, 43, 45, 47, 49
  ],
  Q: [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43,
    45, 48, 51, 53, 56, 59, 62, 65, 68
  ],
  H: [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48,
    51, 54, 57, 60, 63, 66, 70, 74, 77, 81
  ]
};

/* eslint-disable no-bitwise -- QR encoding is bit manipulation. */

// Modules available for data and error correction codewords, i.e. not used by function patterns.
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, level: QrErrorCorrection): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[level][version] * ERROR_CORRECTION_BLOCKS[level][version]
  );
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let position = version * 4 + 17 - 7; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

// GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = multiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, i) => (result[i] ^= multiply(coefficient, factor)));
  }
  return result;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

class QrSymbol {
  readonly size: number;

  readonly modules: boolean[][];

  private readonly reserved: boolean[][];

  constructor(
    readonly version: number,
    private readonly level: QrErrorCorrection
  ) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.drawFunctionPatterns();
  }

  private setFunction(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }

  private drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    for (const [x, y] of [
      [3, 3],
      [this.size - 4, 3],
      [3, this.size - 4]
    ])
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          if (x + dx >= 0 && x + dx < this.size && y + dy >= 0 && y + dy < this.size)
            this.setFunction(x + dx, y + dy, distance !== 2 && distance !== 4);
        }
    const positions = alignmentPositions(this.version);
    positions.forEach((x, i) =>
      positions.forEach((y, j) => {
        const corner =
          (i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0);
        if (corner) return;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      })
    );
    this.drawFormatBits(0);
    if (this.version >= 7) {
      let remainder = this.version;
      for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
      const bits = (this.version << 12) | remainder;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = this.size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.setFunction(a, b, dark);
        this.setFunction(b, a, dark);
      }
    }
  }

  drawFormatBits(mask: number) {
    const data = (FORMAT_BITS[this.level] << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
    this.setFunction(8, this.size - 8, true);
  }

  drawCodewords(codewords: number[]) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? this.size - 1 - vertical : vertical;
          if (!this.reserved[y][x] && i < codewords.length * 8) {
            this.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
    }
  }

  // Applying a mask twice removes it.
  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (!this.reserved[y][x] && MASKS[mask](x, y)) this.modules[y][x] = !this.modules[y][x];
  }

  penalty(): number {
    const { size, modules } = this;
    let result = 0;
    const line = (get: (i: number) => boolean) => {
      let score = 0;
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      // 1:1:3:1:1 finder-like patterns with four light modules on either side.
      const pattern = [true, false, true, true, true, false, true];
      for (let i = 0; i + 7 <= size; i++)
        if (pattern.every((dark, k) => get(i + k) === dark)) {
          const lightBefore = i >= 4 && [1, 2, 3, 4].every(k => !get(i - k));
          const lightAfter = i + 11 <= size && [7, 8, 9, 10].every(k => !get(i + k));
          if (lightBefore) score += 40;
          if (lightAfter) score += 40;
        }
      return score;
    };
    for (let i = 0; i < size; i++) {
      result += line(x => modules[i][x]);
      result += line(y => modules[y][i]);
    }
    let dark = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) dark++;
        if (
          x + 1 < size &&
          y + 1 < size &&
          modules[y][x] === modules[y][x + 1] &&
          modules[y][x] === modules[y + 1][x] &&
          modules[y][x] === modules[y + 1][x + 1]
        )
          result += 3;
      }
    return result + Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  }
}

export interface QrCode {
  version: number;
  mask: number;
  /** `modules[y][x]` is true for a dark module. */
  modules: boolean[][];
}

/** Encode text as UTF-8 bytes in the smallest version that fits. Throws if the text is too long. */
export function encodeQrCode(text: string, level: QrErrorCorrection = "M", forcedMask?: number): QrCode {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 1;
  const bitsNeeded = (v: number) => 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
  while (bitsNeeded(version) > dataCodewords(version, level) * 8)
    if (++version > 40) throw new RangeError("Text too long for a QR code");

  const capacity = dataCodewords(version, level) * 8;
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach(byte => append(byte, 8));
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, add error correction and interleave.
  const blockCount = ERROR_CORRECTION_BLOCKS[level][version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[level][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const divisor = reedSolomonDivisor(eccLength);
  const blocks: number[][] = [];
  for (let i = 0, offset = 0; i < blockCount; i++) {
    const block = data.slice(offset, offset + shortBlockLength - eccLength + (i < shortBlocks ? 0 : 1));
    offset += block.length;
    const ecc = reedSolomonRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0].length; i++)
    blocks.forEach((block, j) => {
      if (i !== shortBlockLength - eccLength || j >= shortBlocks) codewords.push(block[i]);
    });

  const symbol = new QrSymbol(version, level);
  symbol.drawCodewords(codewords);
  let mask = forcedMask;
  if (mask == null) {
    let lowest = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      symbol.applyMask(candidate);
      symbol.drawFormatBits(candidate);
      const penalty = symbol.penalty();
      if (penalty < lowest) {
        lowest = penalty;
        mask = candidate;
      }
      symbol.applyMask(candidate);
    }
  }
  symbol.applyMask(mask);
  symbol.drawFormatBits(mask);
  return { version, mask, modules: symbol.modules };
}

/* eslint-enable no-bitwise */
