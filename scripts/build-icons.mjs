/**
 * Renders the app icons from desktop/build/icon.svg.
 *
 * The generated .ico/.icns/.png files are committed so a release build never depends on this step,
 * but the source of truth is the SVG: change that and re-run `npm run icons`.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const BUILD = path.join(import.meta.dirname, "..", "desktop", "build");
const SVG = path.join(BUILD, "icon.svg");

function render(size) {
  return sharp(SVG, { density: 600 }).resize(size, size).png().toBuffer();
}

async function writePngs() {
  await sharp(SVG, { density: 600 }).resize(1024, 1024).png().toFile(path.join(BUILD, "icon.png"));
  for (const size of [256, 512]) {
    await sharp(SVG, { density: 600 }).resize(size, size).png().toFile(path.join(BUILD, `icon-${size}.png`));
  }
}

async function writeIco() {
  // Windows picks by context; 1024 only bloats the file, so stop at 256.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map(render));
  fs.writeFileSync(path.join(BUILD, "icon.ico"), await pngToIco(pngs));
}

async function writeIcns() {
  // An ICNS is a magic header plus typed PNG chunks. `iconutil` only exists on macOS, so the
  // container is assembled directly and the same file works on every platform.
  const types = [
    ["icp4", 16], ["icp5", 32], ["icp6", 64],
    ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024],
  ];
  const chunks = [];
  for (const [type, size] of types) {
    const png = await render(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    chunks.push(Buffer.concat([header, png]));
  }
  const body = Buffer.concat(chunks);
  const magic = Buffer.alloc(8);
  magic.write("icns", 0, 4, "ascii");
  magic.writeUInt32BE(body.length + 8, 4);
  fs.writeFileSync(path.join(BUILD, "icon.icns"), Buffer.concat([magic, body]));
}

await writePngs();
await writeIco();
await writeIcns();
console.log("icons written to desktop/build");
