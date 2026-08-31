import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const allowed = new Set([".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".svg"]);
const findings = [];
const rules = [
  ["Windows user path", /[A-Za-z]:\\Users\\[^\\\s]+/i],
  ["credential-like assignment", /(?:password|token|secret|api[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i],
  ["private IPv4 range", /\b(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}(?:\.\d{1,3}){2}\b/],
];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (allowed.has(extname(entry.name))) {
      if (full === fileURLToPath(import.meta.url)) continue;
      const text = await readFile(full, "utf8");
      for (const [name, pattern] of rules) if (pattern.test(text)) findings.push(`${relative(root, full)}: ${name}`);
    }
  }
}

await walk(root);
if (findings.length) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Privacy scan passed.");
}
