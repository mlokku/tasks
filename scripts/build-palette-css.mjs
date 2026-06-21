import fs from 'node:fs';
import path from 'node:path';

const palettePath = path.resolve('palette.json');
const outputPath = path.resolve('static/css/palette.css');
const palette = JSON.parse(fs.readFileSync(palettePath, 'utf8'));

const kebab = (value) => value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);

function flatten(node, prefix = []) {
  return Object.entries(node).flatMap(([key, value]) => {
    const next = [...prefix, kebab(key)];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return flatten(value, next);
    }
    return [[next.join('-'), value]];
  });
}

function block(selector, mode) {
  const colors = palette[mode]?.color;
  if (!colors) {
    throw new Error(`Missing ${mode}.color in palette.json`);
  }

  const variables = flatten(colors)
    .map(([name, value]) => `  --color-${name}: ${value};`)
    .join('\n');

  return `${selector} {\n  color-scheme: ${mode === 'dark_mode' ? 'dark' : 'light'};\n${variables}\n}`;
}

const css = `/* Generated from palette.json. Run npm run build:palette after palette changes. */\n${block(':root', 'light_mode')}\n\n${block('.dark', 'dark_mode')}\n`;
fs.writeFileSync(outputPath, css);
