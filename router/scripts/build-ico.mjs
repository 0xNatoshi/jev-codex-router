#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length === 0) {
  throw new Error("usage: build-ico.mjs OUTPUT.ico INPUT.png...");
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const images = await Promise.all(inputs.map(async (input) => {
  const data = await readFile(input);
  if (data.length < 24 || !data.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`${input} is not a PNG image`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== height || width < 1 || width > 256) {
    throw new Error(`${input} must be square and between 1px and 256px`);
  }
  return { data, size: width };
}));

const headerSize = 6;
const directoryEntrySize = 16;
let payloadOffset = headerSize + directoryEntrySize * images.length;
const header = Buffer.alloc(payloadOffset);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

for (const [index, image] of images.entries()) {
  const entry = headerSize + index * directoryEntrySize;
  header.writeUInt8(image.size === 256 ? 0 : image.size, entry);
  header.writeUInt8(image.size === 256 ? 0 : image.size, entry + 1);
  header.writeUInt8(0, entry + 2);
  header.writeUInt8(0, entry + 3);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.data.length, entry + 8);
  header.writeUInt32LE(payloadOffset, entry + 12);
  payloadOffset += image.data.length;
}

await writeFile(output, Buffer.concat([header, ...images.map(({ data }) => data)]));
