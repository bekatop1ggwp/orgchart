import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
const publicFiles = ["index.html", "styles.css", "app.js", "api.js"];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(
  publicFiles.map(file => cp(resolve(root, file), resolve(output, file)))
);

console.log(`Built ${publicFiles.length} files into ${output}`);
