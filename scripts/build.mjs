import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src", "sprinkler-sequence-card.js");
const output = resolve(root, "dist", "sprinkler-sequence-card.js");
const text = await readFile(source, "utf8");
if (!text.includes('const VERSION = "0.1.2"') || !text.includes('customElements.define(CARD_TAG')) {
  throw new Error("Source is missing its version or custom-element registration marker.");
}
await mkdir(dirname(output), { recursive: true });
await copyFile(source, output);
console.log(`Built ${output}`);
