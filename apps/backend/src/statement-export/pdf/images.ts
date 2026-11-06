import http from "http";
import https from "https";
import zlib from "zlib";
import { promises as dns } from "dns";
import { isIP } from "net";

import { isPublicAddress } from "../../common/public-address";

/* eslint-disable no-bitwise -- GIF's LZW codes, its packed flags and PNG's CRC are bit fields */

/**
 * Images in statements, for the PDF: data URIs and http(s) images on the public Internet. The server fetches them
 * for the viewer, so a statement's image can never make it reach this host or its private networks: every address a
 * name resolves to must be public, the connection is pinned to those addresses, and each redirect is checked again.
 * Sizes and time are bounded. PNG and JPEG are embedded as they are, a GIF's first frame as PNG, SVG drawn as vectors;
 * other formats (WebP, BMP, …) are listed as not included.
 */

export type ImageKind = "png" | "jpeg" | "svg";

export interface LoadedImage {
  kind: ImageKind;
  data: Buffer;
  /** In CSS pixels */
  width: number;
  height: number;
}

export interface ImageFailure {
  error: string;
}

export const IMAGE_LIMITS = {
  /** One image, as downloaded */
  bytes: 8 * 1024 * 1024,
  /** Every image of a document */
  totalBytes: 48 * 1024 * 1024,
  /** A decoded GIF frame */
  pixels: 25_000_000,
  images: 300,
  svgBytes: 2 * 1024 * 1024,
  timeout: 10_000,
  /** All images of a document are loaded within this, from the first request */
  deadline: 40_000,
  redirects: 3,
  concurrency: 4
};

class ImageError extends Error {}

function fail(message: string): never {
  throw new ImageError(message);
}

/** A data: URI's bytes */
export function parseDataUri(uri: string): Buffer | null {
  const match = /^data:([^,]*?),(.*)$/is.exec(uri.trim());
  if (!match) return null;
  try {
    if (/;base64$/i.test(match[1])) return Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    return Buffer.from(decodeURIComponent(match[2]), "utf8");
  } catch {
    return null;
  }
}

function svgLength(value: string | undefined): number | null {
  const match = /^\s*([\d.]+)\s*(px|pt|em|ex|in|cm|mm)?\s*$/i.exec(value ?? "");
  if (!match) return null;
  const number = Number(match[1]);
  const unit = (match[2] ?? "px").toLowerCase();
  const scale = { px: 1, pt: 4 / 3, em: 16, ex: 8, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[unit];
  return Number.isFinite(number) && number > 0 ? number * scale : null;
}

function jpegSize(data: Buffer): [number, number] | null {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = data.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return [data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5)];
    offset += 2 + length;
  }
  return null;
}

// ---- GIF (first frame) to PNG ----

function crc32(data: Buffer) {
  return zlib.crc32(data);
}

function pngChunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function lzwDecode(minimumCodeSize: number, data: Buffer, pixels: number): Uint8Array {
  const output = new Uint8Array(pixels);
  const clear = 1 << minimumCodeSize;
  const end = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let size = minimumCodeSize + 1;
  let mask = (1 << size) - 1;
  let next = clear + 2;
  let previous = -1;
  let first = 0;
  let bits = 0;
  let buffer = 0;
  let written = 0;
  for (let index = 0; index < data.length && written < pixels; index++) {
    buffer |= data[index] << bits;
    bits += 8;
    while (bits >= size && written < pixels) {
      const code = buffer & mask;
      buffer >>>= size;
      bits -= size;
      if (code === clear) {
        size = minimumCodeSize + 1;
        mask = (1 << size) - 1;
        next = clear + 2;
        previous = -1;
        continue;
      }
      if (code === end) return output;
      let top = 0;
      let current = code;
      if (previous === -1) {
        if (code >= clear) fail("GIF data is damaged");
        first = code;
        output[written++] = code;
        previous = code;
        continue;
      }
      if (code >= next) {
        if (code > next) fail("GIF data is damaged");
        stack[top++] = first;
        current = previous;
      }
      while (current > clear) {
        stack[top++] = suffix[current];
        current = prefix[current];
      }
      first = current;
      stack[top++] = current;
      while (top > 0 && written < pixels) output[written++] = stack[--top];
      if (next < 4096) {
        prefix[next] = previous;
        suffix[next] = first;
        next++;
        if (next > mask && size < 12) {
          size++;
          mask = (1 << size) - 1;
        }
      }
      previous = code;
    }
  }
  return output;
}

/** A GIF's first frame as PNG */
export function gifToPng(data: Buffer): LoadedImage {
  if (data.length < 13) fail("GIF data is damaged");
  const width = data.readUInt16LE(6);
  const height = data.readUInt16LE(8);
  if (!width || !height || width * height > IMAGE_LIMITS.pixels) fail("The image is too large");
  let offset = 13;
  let palette: Buffer = null;
  if (data[10] & 0x80) {
    const size = 3 * (1 << ((data[10] & 7) + 1));
    palette = data.subarray(offset, offset + size);
    offset += size;
  }
  let transparent = -1;
  const rgba = new Uint8Array(width * height * 4);
  while (offset < data.length) {
    const block = data[offset++];
    if (block === 0x21) {
      const label = data[offset++];
      if (label === 0xf9 && data[offset] >= 4 && data[offset + 1] & 1) transparent = data[offset + 4];
      while (offset < data.length && data[offset]) offset += data[offset] + 1;
      offset++;
    } else if (block === 0x2c) {
      const left = data.readUInt16LE(offset);
      const top = data.readUInt16LE(offset + 2);
      const frameWidth = data.readUInt16LE(offset + 4);
      const frameHeight = data.readUInt16LE(offset + 6);
      const flags = data[offset + 8];
      offset += 9;
      let colors = palette;
      if (flags & 0x80) {
        const size = 3 * (1 << ((flags & 7) + 1));
        colors = data.subarray(offset, offset + size);
        offset += size;
      }
      if (!colors) fail("GIF data is damaged");
      const minimumCodeSize = data[offset++];
      if (minimumCodeSize < 2 || minimumCodeSize > 11) fail("GIF data is damaged");
      const parts: Buffer[] = [];
      while (offset < data.length && data[offset]) {
        parts.push(data.subarray(offset + 1, offset + 1 + data[offset]));
        offset += data[offset] + 1;
      }
      const indices = lzwDecode(minimumCodeSize, Buffer.concat(parts), frameWidth * frameHeight);
      // Interlaced rows come in four passes
      const rowOrder: number[] = [];
      if (flags & 0x40)
        for (const [start, step] of [
          [0, 8],
          [4, 8],
          [2, 4],
          [1, 2]
        ])
          for (let row = start; row < frameHeight; row += step) rowOrder.push(row);
      else for (let row = 0; row < frameHeight; row++) rowOrder.push(row);
      for (let sourceRow = 0; sourceRow < rowOrder.length; sourceRow++) {
        const y = top + rowOrder[sourceRow];
        if (y >= height) continue;
        for (let column = 0; column < frameWidth; column++) {
          const x = left + column;
          if (x >= width) continue;
          const index = indices[sourceRow * frameWidth + column];
          if (index === transparent || index * 3 + 2 >= colors.length) continue;
          const target = (y * width + x) * 4;
          rgba[target] = colors[index * 3];
          rgba[target + 1] = colors[index * 3 + 1];
          rgba[target + 2] = colors[index * 3 + 2];
          rgba[target + 3] = 255;
        }
      }
      return { kind: "png", data: encodePng(width, height, rgba), width, height };
    } else break;
  }
  return fail("GIF data is damaged");
}

/** What an image's bytes are, and its size */
export function identifyImage(data: Buffer): LoadedImage {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString("latin1", 12, 16) === "IHDR")
    return { kind: "png", data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    const size = jpegSize(data);
    if (!size) fail("JPEG data is damaged");
    return { kind: "jpeg", data, width: size[0], height: size[1] };
  }
  if (data.length > 6 && /^GIF8[79]a$/.test(data.toString("latin1", 0, 6))) return gifToPng(data);
  const head = data.toString("utf8", 0, Math.min(data.length, 4096)).replace(/^\ufeff/, "");
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    if (data.length > IMAGE_LIMITS.svgBytes) fail("The image is too large");
    const tag = /<svg[^>]*>/i.exec(head)?.[0] ?? "";
    const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
    const viewBox = attribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    let width = svgLength(attribute("width"));
    let height = svgLength(attribute("height"));
    if (viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
      if (!width && !height) [width, height] = [viewBox[2], viewBox[3]];
      else if (!width) width = (height * viewBox[2]) / viewBox[3];
      else if (!height) height = (width * viewBox[3]) / viewBox[2];
    }
    return { kind: "svg", data, width: width || 300, height: height || 150 };
  }
  if (data.length > 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP")
    fail("WebP images can't be included");
  return fail("The image format isn't supported");
}

async function get(url: URL, deadline: number): Promise<{ status: number; location?: string; data?: Buffer }> {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) fail("Only http and https images");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await dns.lookup(hostname, { all: true }).catch(() => fail("The image's server wasn't found"));
  if (!records.length) fail("The image's server wasn't found");
  if (records.some(record => !isPublicAddress(record.address)))
    fail("The image is on a private network or this server");
  const timeout = Math.min(IMAGE_LIMITS.timeout, deadline - Date.now());
  if (timeout <= 0) fail("There was no time left to download the image");
  return await new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        headers: { "User-Agent": "LLMOJ statement download", Accept: "image/*" },
        lookup: (_name, options, callback) => {
          if ((options as { all?: boolean }).all)
            (callback as unknown as (error: Error | null, addresses: { address: string; family: number }[]) => void)(
              null,
              records
            );
          else callback(null, records[0].address, records[0].family);
        }
      },
      response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          resolve({ status: response.statusCode, location: response.headers.location });
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new ImageError(`The image's server answered ${response.statusCode}`));
          return;
        }
        const declared = Number(response.headers["content-length"]);
        if (declared > IMAGE_LIMITS.bytes) {
          request.destroy(new ImageError("The image is too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > IMAGE_LIMITS.bytes) request.destroy(new ImageError("The image is too large"));
          else chunks.push(chunk);
        });
        response.on("end", () => resolve({ status: 200, data: Buffer.concat(chunks) }));
        response.on("error", error => reject(error));
      }
    );
    const timer = setTimeout(() => request.destroy(new ImageError("The image took too long to download")), timeout);
    request.on("close", () => clearTimeout(timer));
    request.on("error", error =>
      reject(error instanceof ImageError ? error : new ImageError("The image couldn't be downloaded"))
    );
    request.end();
  });
}

/** Downloads one image from the public Internet, following at most a few redirects (each checked again) */
export async function downloadImage(address: string, deadline: number): Promise<Buffer> {
  let url = new URL(address);
  for (let redirect = 0; ; redirect++) {
    // eslint-disable-next-line no-await-in-loop -- each redirect is checked before it is followed
    const result = await get(url, deadline);
    if (result.data) return result.data;
    if (redirect >= IMAGE_LIMITS.redirects) fail("The image redirects too many times");
    url = new URL(result.location, url);
  }
}

/** Loads the images of one document, each address once, a few at a time, within the document's budget */
export class ImageLoader {
  private readonly results = new Map<string, Promise<LoadedImage | ImageFailure>>();

  private totalBytes = 0;

  private running = 0;

  private readonly waiting: (() => void)[] = [];

  private deadline: number = null;

  constructor(
    /** Tests replace the network */
    private readonly download: (url: string, deadline: number) => Promise<Buffer> = downloadImage
  ) {}

  private async slot<T>(work: () => Promise<T>) {
    if (this.running >= IMAGE_LIMITS.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async fetch(source: string): Promise<LoadedImage | ImageFailure> {
    try {
      let data: Buffer;
      if (/^data:/i.test(source.trim())) {
        data = parseDataUri(source);
        if (!data) fail("The data URI is damaged");
        if (data.length > IMAGE_LIMITS.bytes) fail("The image is too large");
      } else if (/^https?:\/\//i.test(source.trim())) {
        this.deadline ??= Date.now() + IMAGE_LIMITS.deadline;
        data = await this.slot(() => this.download(source.trim(), this.deadline));
      } else fail("Only images with a full http(s) address or a data URI can be included");
      this.totalBytes += data.length;
      if (this.totalBytes > IMAGE_LIMITS.totalBytes) fail("The statements' images are too large together");
      return identifyImage(data);
    } catch (error) {
      return { error: error instanceof ImageError ? error.message : "The image couldn't be downloaded" };
    }
  }

  load(source: string): Promise<LoadedImage | ImageFailure> {
    if (!this.results.has(source)) {
      this.results.set(
        source,
        this.results.size >= IMAGE_LIMITS.images
          ? Promise.resolve({ error: "The statements have too many images" })
          : this.fetch(source)
      );
    }
    return this.results.get(source);
  }
}
