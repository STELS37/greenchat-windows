// clients/ui/src/qr.ts — local QR Model 2 encoder for connector authentication links (T-452).
// Byte mode, ECC-M, versions 1..10. No network, canvas, third-party service or runtime dependency.

interface RsBlockSpec { count: number; total: number; data: number }

const RS_BLOCKS_M: readonly (readonly RsBlockSpec[])[] = [
  [{ count: 1, total: 26, data: 16 }],
  [{ count: 1, total: 44, data: 28 }],
  [{ count: 1, total: 70, data: 44 }],
  [{ count: 2, total: 50, data: 32 }],
  [{ count: 2, total: 67, data: 43 }],
  [{ count: 4, total: 43, data: 27 }],
  [{ count: 4, total: 49, data: 31 }],
  [{ count: 2, total: 60, data: 38 }, { count: 2, total: 61, data: 39 }],
  [{ count: 3, total: 58, data: 36 }, { count: 2, total: 59, data: 37 }],
  [{ count: 4, total: 69, data: 43 }, { count: 1, total: 70, data: 44 }],
];

const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

class BitBuffer {
  readonly bits: boolean[] = [];
  append(value: number, length: number): void {
    if (length < 0 || length > 31 || value >>> length !== 0) throw new RangeError("invalid QR bit field");
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push(((value >>> i) & 1) !== 0);
  }
  toBytes(): number[] {
    if (this.bits.length % 8 !== 0) throw new Error("QR bit stream is not byte-aligned");
    const out: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let value = 0;
      for (let j = 0; j < 8; j += 1) value = (value << 1) | (this.bits[i + j] ? 1 : 0);
      out.push(value);
    }
    return out;
  }
}

function blockList(version: number): RsBlockSpec[] {
  const specs = RS_BLOCKS_M[version - 1];
  if (!specs) throw new RangeError("unsupported QR version");
  return specs.flatMap((spec) => Array.from({ length: spec.count }, () => spec));
}

function dataCapacity(version: number): number {
  return blockList(version).reduce((sum, block) => sum + block.data, 0);
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= 10; version += 1) {
    const countBits = version <= 9 ? 8 : 16;
    if (byteLength >= 2 ** countBits) continue;
    if (4 + countBits + byteLength * 8 <= dataCapacity(version) * 8) return version;
  }
  throw new RangeError("QR payload is too large");
}

function makeDataCodewords(payload: Uint8Array, version: number): number[] {
  const capacityBits = dataCapacity(version) * 8;
  const bits = new BitBuffer();
  bits.append(0b0100, 4); // byte mode
  bits.append(payload.length, version <= 9 ? 8 : 16);
  for (const value of payload) bits.append(value, 8);
  bits.append(0, Math.min(4, capacityBits - bits.bits.length));
  while (bits.bits.length % 8 !== 0) bits.bits.push(false);
  const data = bits.toBytes();
  for (let pad = 0; data.length < capacityBits / 8; pad += 1) data.push(pad % 2 === 0 ? 0xec : 0x11);
  return data;
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j] ?? 0, root);
      if (j + 1 < result.length) result[j] ^= result[j + 1] ?? 0;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result = new Array<number>(degree).fill(0);
  for (const value of data) {
    const factor = value ^ (result.shift() ?? 0);
    result.push(0);
    for (let i = 0; i < divisor.length; i += 1) result[i] ^= gfMultiply(divisor[i] ?? 0, factor);
  }
  return result;
}

function interleaveCodewords(data: readonly number[], version: number): number[] {
  const blocks = blockList(version);
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;
  for (const block of blocks) {
    const part = data.slice(offset, offset + block.data);
    offset += block.data;
    dataBlocks.push(part);
    eccBlocks.push(rsRemainder(part, block.total - block.data));
  }
  if (offset !== data.length) throw new Error("QR block partition mismatch");
  const result: number[] = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i += 1) for (const block of dataBlocks) if (i < block.length) result.push(block[i] ?? 0);
  const maxEcc = Math.max(...eccBlocks.map((block) => block.length));
  for (let i = 0; i < maxEcc; i += 1) for (const block of eccBlocks) if (i < block.length) result.push(block[i] ?? 0);
  return result;
}

function formatBits(mask: number): number {
  const data = mask; // ECC-M has format value 00
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    default: throw new RangeError("invalid QR mask");
  }
}

function penalty(matrix: readonly (readonly boolean[])[]): number {
  const size = matrix.length;
  let score = 0;
  const linePenalty = (line: readonly boolean[]): number => {
    let value = 0;
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) run += 1;
      else { if (run >= 5) value += 3 + run - 5; run = 1; }
    }
    if (run >= 5) value += 3 + run - 5;
    const text = line.map((bit) => bit ? "1" : "0").join("");
    for (let i = 0; i + 11 <= text.length; i += 1) {
      const window = text.slice(i, i + 11);
      if (window === "00001011101" || window === "10111010000") value += 40;
    }
    return value;
  };
  for (let y = 0; y < size; y += 1) score += linePenalty(matrix[y] ?? []);
  for (let x = 0; x < size; x += 1) score += linePenalty(matrix.map((row) => row[x] ?? false));
  for (let y = 0; y + 1 < size; y += 1) for (let x = 0; x + 1 < size; x += 1) {
    const value = matrix[y]?.[x] ?? false;
    if (value === matrix[y]?.[x + 1] && value === matrix[y + 1]?.[x] && value === matrix[y + 1]?.[x + 1]) score += 3;
  }
  const dark = matrix.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

function drawFormat(matrix: boolean[][], mask: number): void {
  const size = matrix.length;
  const bits = formatBits(mask);
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) matrix[i]![8] = bit(i);
  matrix[7]![8] = bit(6);
  matrix[8]![8] = bit(7);
  matrix[8]![7] = bit(8);
  for (let i = 9; i < 15; i += 1) matrix[8]![14 - i] = bit(i);
  for (let i = 0; i < 8; i += 1) matrix[8]![size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) matrix[size - 15 + i]![8] = bit(i);
  matrix[size - 8]![8] = true;
}

function buildMatrix(codewords: readonly number[], version: number): boolean[][] {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const functions = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFunction = (x: number, y: number, value: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y]![x] = value;
    functions[y]![x] = true;
  };
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(cx + dx, cy + dy, distance !== 2 && distance !== 4);
    }
  };
  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  for (const y of ALIGNMENT_POSITIONS[version - 1] ?? []) for (const x of ALIGNMENT_POSITIONS[version - 1] ?? []) {
    if (functions[y]?.[x]) continue;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  drawFormat(modules, 0);
  for (let i = 0; i < 15; i += 1) {
    // Mark all format modules as function modules after the placeholder was drawn.
    if (i <= 5) functions[i]![8] = true;
  }
  const formatCoordinates: Array<[number, number]> = [
    [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (const [x, y] of formatCoordinates) functions[y]![x] = true;
  for (let i = 0; i < 8; i += 1) functions[8]![size - 1 - i] = true;
  for (let i = 8; i < 15; i += 1) functions[size - 15 + i]![8] = true;
  functions[size - 8]![8] = true;
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const value = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, value);
      setFunction(b, a, value);
    }
  }
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = upward ? size - 1 - vertical : vertical;
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        if (functions[y]?.[x]) continue;
        const byte = codewords[bitIndex >>> 3] ?? 0;
        modules[y]![x] = ((byte >>> (7 - (bitIndex & 7))) & 1) !== 0;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
  let best: boolean[][] | null = null;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row) => [...row]);
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      if (!functions[y]?.[x] && maskBit(mask, x, y)) candidate[y]![x] = !candidate[y]![x];
    }
    drawFormat(candidate, mask);
    const candidatePenalty = penalty(candidate);
    if (candidatePenalty < bestPenalty) { bestPenalty = candidatePenalty; best = candidate; }
  }
  if (!best) throw new Error("QR mask selection failed");
  return best;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const payload = new TextEncoder().encode(text);
  const version = chooseVersion(payload.length);
  return buildMatrix(interleaveCodewords(makeDataCodewords(payload, version), version), version);
}

export function createQrSvg(text: string, label: string): SVGSVGElement {
  const matrix = encodeQrMatrix(text);
  const quiet = 4;
  const side = matrix.length + quiet * 2;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", `0 0 ${side} ${side}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("class", "gc-connector-qr");
  const background = document.createElementNS(ns, "rect");
  background.setAttribute("width", String(side));
  background.setAttribute("height", String(side));
  background.setAttribute("fill", "#fff");
  svg.append(background);
  let pathData = "";
  for (let y = 0; y < matrix.length; y += 1) for (let x = 0; x < matrix.length; x += 1) {
    if (matrix[y]?.[x]) pathData += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", pathData);
  path.setAttribute("fill", "#000");
  svg.append(path);
  return svg;
}
