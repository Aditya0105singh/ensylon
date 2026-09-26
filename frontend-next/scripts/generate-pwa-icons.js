// One-off script: rasterizes the AlertLens brand mark into the PNG icon
// sizes a web app manifest needs. Run with `node scripts/generate-pwa-icons.js`.
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

// Same mark as components/AlertLensMark.tsx, on a solid background square
// (the transparent original disappears against a phone home screen).
const svg = `
<svg width="512" height="512" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <rect width="32" height="32" rx="6" fill="#0f172a"/>
  <circle cx="14" cy="14" r="9.5" stroke="rgb(249 115 22)" stroke-width="2.5" fill="none"/>
  <path d="M9.5 14.5l2.5 0 1.75-4 2.25 7.5 1.75-3.5h2.25"
        stroke="rgb(249 115 22)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M21.5 21.5l6 6" stroke="rgb(249 115 22)" stroke-width="3" stroke-linecap="round"/>
</svg>`;

const outDir = path.join(__dirname, "..", "public", "icons-pwa");
fs.mkdirSync(outDir, { recursive: true });

const sizes = [192, 512];

async function run() {
  for (const size of sizes) {
    const buf = Buffer.from(svg);
    await sharp(buf, { density: 384 })
      .resize(size, size)
      .png()
      .toFile(path.join(outDir, `icon-${size}.png`));
    console.log(`wrote icon-${size}.png`);
  }
  // Maskable variant: same art but with safe-zone padding (icon content
  // kept inside the inner ~80% so Android's circular/squircle mask never
  // clips the lens ring).
  const maskableSvg = `
<svg width="512" height="512" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <rect width="32" height="32" fill="#0f172a"/>
  <g transform="translate(3.5 3.5) scale(0.78)">
    <circle cx="14" cy="14" r="9.5" stroke="rgb(249 115 22)" stroke-width="2.5" fill="none"/>
    <path d="M9.5 14.5l2.5 0 1.75-4 2.25 7.5 1.75-3.5h2.25"
          stroke="rgb(249 115 22)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M21.5 21.5l6 6" stroke="rgb(249 115 22)" stroke-width="3" stroke-linecap="round"/>
  </g>
</svg>`;
  await sharp(Buffer.from(maskableSvg), { density: 384 })
    .resize(512, 512)
    .png()
    .toFile(path.join(outDir, "icon-512-maskable.png"));
  console.log("wrote icon-512-maskable.png");
}

run();
