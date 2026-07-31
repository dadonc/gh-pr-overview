import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync, inflateSync } from 'node:zlib';

const execFileAsync = promisify(execFile);
const ICON_SIZES = [16, 32, 48, 96, 128];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_MEAN_CHANNEL_DIFFERENCE = 0.35;
const MAX_LARGE_DIFFERENCE_RATIO = 0.01;

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodeNeutralPng(content, label) {
  if (!content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} is not a PNG`);
  }

  let offset = PNG_SIGNATURE.length;
  let header;
  const imageData = [];
  while (offset < content.length) {
    if (offset + 12 > content.length) throw new Error(`${label} has a truncated PNG chunk`);
    const length = content.readUInt32BE(offset);
    const type = content.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > content.length) throw new Error(`${label} has a truncated ${type} chunk`);
    const data = content.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (length !== 13) throw new Error(`${label} has an invalid PNG header`);
      header = {
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        height: data.readUInt32BE(4),
        interlace: data[12],
        width: data.readUInt32BE(0),
      };
    } else if (type === 'IDAT') {
      imageData.push(data);
    }
    offset = end;
    if (type === 'IEND') break;
  }

  if (!header || imageData.length === 0) throw new Error(`${label} is missing PNG image data`);
  if (
    header.bitDepth !== 8 ||
    ![4, 6].includes(header.colorType) ||
    header.compression !== 0 ||
    header.filter !== 0 ||
    header.interlace !== 0
  ) {
    throw new Error(`${label} must be an 8-bit grayscale image with alpha`);
  }

  const bytesPerPixel = header.colorType === 4 ? 2 : 4;
  const stride = header.width * bytesPerPixel;
  const filtered = inflateSync(Buffer.concat(imageData));
  if (filtered.length !== header.height * (stride + 1)) {
    throw new Error(`${label} has an unexpected decoded PNG length`);
  }

  const pixels = Buffer.alloc(header.height * stride);
  let inputOffset = 0;
  for (let rowIndex = 0; rowIndex < header.height; rowIndex += 1) {
    const filterType = filtered[inputOffset];
    inputOffset += 1;
    if (filterType > 4) throw new Error(`${label} uses unsupported PNG filter ${filterType}`);
    const rowOffset = rowIndex * stride;
    const previousRowOffset = rowOffset - stride;
    for (let column = 0; column < stride; column += 1) {
      const left = column >= bytesPerPixel ? pixels[rowOffset + column - bytesPerPixel] : 0;
      const above = rowIndex > 0 ? pixels[previousRowOffset + column] : 0;
      const upperLeft = rowIndex > 0 && column >= bytesPerPixel
        ? pixels[previousRowOffset + column - bytesPerPixel]
        : 0;
      let predictor = 0;
      if (filterType === 1) predictor = left;
      else if (filterType === 2) predictor = above;
      else if (filterType === 3) predictor = Math.floor((left + above) / 2);
      else if (filterType === 4) predictor = paethPredictor(left, above, upperLeft);
      pixels[rowOffset + column] = (filtered[inputOffset] + predictor) & 0xff;
      inputOffset += 1;
    }
  }

  if (header.colorType === 4) return { ...header, pixels };

  const grayscaleAlphaPixels = Buffer.alloc(header.width * header.height * 2);
  for (let input = 0, output = 0; input < pixels.length; input += 4, output += 2) {
    if (pixels[input] !== pixels[input + 1] || pixels[input] !== pixels[input + 2]) {
      throw new Error(`${label} must use equal red, green, and blue channels`);
    }
    grayscaleAlphaPixels[output] = pixels[input];
    grayscaleAlphaPixels[output + 1] = pixels[input + 3];
  }
  return { ...header, pixels: grayscaleAlphaPixels };
}

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8);
  return chunk;
}

function encodeGrayscaleAlphaPng({ height, pixels, width }) {
  const bytesPerPixel = 2;
  const stride = width * bytesPerPixel;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const rowOffset = rowIndex * stride;
    const previousRowOffset = rowOffset - stride;
    let best;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let filterType = 0; filterType <= 4; filterType += 1) {
      const candidate = Buffer.alloc(stride + 1);
      candidate[0] = filterType;
      let score = 0;
      for (let column = 0; column < stride; column += 1) {
        const left = column >= bytesPerPixel ? pixels[rowOffset + column - bytesPerPixel] : 0;
        const above = rowIndex > 0 ? pixels[previousRowOffset + column] : 0;
        const upperLeft = rowIndex > 0 && column >= bytesPerPixel
          ? pixels[previousRowOffset + column - bytesPerPixel]
          : 0;
        let predictor = 0;
        if (filterType === 1) predictor = left;
        else if (filterType === 2) predictor = above;
        else if (filterType === 3) predictor = Math.floor((left + above) / 2);
        else if (filterType === 4) predictor = paethPredictor(left, above, upperLeft);
        const value = (pixels[rowOffset + column] - predictor) & 0xff;
        candidate[column + 1] = value;
        score += Math.min(value, 256 - value);
      }
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    best.copy(filtered, rowIndex * (stride + 1));
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 4;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(filtered, { level: 9 })),
    pngChunk('IEND'),
  ]);
}

function paletteErrors(source) {
  const chromaticColors = [...source.matchAll(/#[0-9a-f]{6}/gi)]
    .map(([color]) => color.toLowerCase())
    .filter((color) => color.slice(1, 3) !== color.slice(3, 5) ||
      color.slice(1, 3) !== color.slice(5, 7));
  const uniqueColors = [...new Set(chromaticColors)].sort();
  return uniqueColors.length === 0
    ? []
    : [`Disabled icon SVG palette must use neutral grayscale colors: ${uniqueColors.join(', ')}`];
}

function renderDifferenceError(size, checked, rendered) {
  if (checked.width !== size || checked.height !== size) {
    return `Disabled icon ${size}px PNG must be exactly ${size}x${size}`;
  }
  if (rendered.width !== size || rendered.height !== size ||
      rendered.pixels.length !== checked.pixels.length) {
    return `Disabled icon ${size}px SVG render has unexpected dimensions`;
  }

  let totalDifference = 0;
  let largeDifferences = 0;
  let maximumAlpha = 0;
  for (let index = 0; index < checked.pixels.length; index += 1) {
    const difference = Math.abs(checked.pixels[index] - rendered.pixels[index]);
    totalDifference += difference;
    if (difference > 3) largeDifferences += 1;
    if (index % 2 === 1) maximumAlpha = Math.max(maximumAlpha, checked.pixels[index]);
  }
  if (maximumAlpha === 0 || maximumAlpha === 255) {
    return `Disabled icon ${size}px PNG must preserve non-empty alpha dimming`;
  }

  const meanDifference = totalDifference / checked.pixels.length;
  const largeDifferenceRatio = largeDifferences / checked.pixels.length;
  if (
    meanDifference > MAX_MEAN_CHANNEL_DIFFERENCE ||
    largeDifferenceRatio > MAX_LARGE_DIFFERENCE_RATIO
  ) {
    return `Disabled icon ${size}px PNG differs from its SVG render ` +
      `(mean channel difference ${meanDifference.toFixed(3)}, ` +
      `${(largeDifferenceRatio * 100).toFixed(2)}% above tolerance)`;
  }
  return undefined;
}

async function renderSvg(sourcePath, size, renderedPath) {
  await execFileAsync('rsvg-convert', [
    '-w', String(size),
    '-h', String(size),
    '-o', renderedPath,
    sourcePath,
  ]);
}

export async function generateDisabledIcons({
  iconsDirectory = resolve('public/icon/disabled'),
  sourcePath = resolve('assets/icon-disabled.svg'),
} = {}) {
  const source = await readFile(sourcePath, 'utf8');
  const errors = paletteErrors(source);
  if (errors.length > 0) throw new Error(errors.join('\n'));

  await mkdir(iconsDirectory, { recursive: true });
  const renderDirectory = await mkdtemp(join(tmpdir(), 'generate-disabled-icons-render-'));
  try {
    for (const size of ICON_SIZES) {
      const renderedPath = join(renderDirectory, `${size}.png`);
      await renderSvg(sourcePath, size, renderedPath);
      const rendered = decodeNeutralPng(
        await readFile(renderedPath),
        `Disabled icon ${size}px SVG render`,
      );
      if (rendered.width !== size || rendered.height !== size) {
        throw new Error(`Disabled icon ${size}px SVG render has unexpected dimensions`);
      }
      await writeFile(
        join(iconsDirectory, `${size}.png`),
        encodeGrayscaleAlphaPng(rendered),
      );
    }
  } finally {
    await rm(renderDirectory, { force: true, recursive: true });
  }
}

export async function verifyDisabledIcons({
  iconsDirectory = resolve('public/icon/disabled'),
  sourcePath = resolve('assets/icon-disabled.svg'),
} = {}) {
  const errors = [];
  let source;
  try {
    source = await readFile(sourcePath, 'utf8');
  } catch (error) {
    return [`Unable to read disabled icon SVG: ${error instanceof Error ? error.message : String(error)}`];
  }
  errors.push(...paletteErrors(source));

  const renderDirectory = await mkdtemp(join(tmpdir(), 'verify-disabled-icons-render-'));
  try {
    for (const size of ICON_SIZES) {
      const renderedPath = join(renderDirectory, `${size}.png`);
      try {
        await renderSvg(sourcePath, size, renderedPath);
        const checked = decodeNeutralPng(
          await readFile(join(iconsDirectory, `${size}.png`)),
          `Disabled icon ${size}px PNG`,
        );
        const rendered = decodeNeutralPng(
          await readFile(renderedPath),
          `Disabled icon ${size}px SVG render`,
        );
        if (checked.colorType !== 4) {
          errors.push(`Disabled icon ${size}px PNG must use grayscale+alpha encoding`);
        }
        const differenceError = renderDifferenceError(size, checked, rendered);
        if (differenceError) errors.push(differenceError);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    await rm(renderDirectory, { force: true, recursive: true });
  }

  return errors;
}

async function main() {
  if (process.argv.includes('--write')) {
    await generateDisabledIcons();
    process.stdout.write('Generated disabled icon PNGs from the SVG with rsvg-convert\n');
  }
  const errors = await verifyDisabledIcons();
  if (errors.length > 0) {
    process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Verified disabled icon source and PNG renders\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
