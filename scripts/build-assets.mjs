// Bundles everything in public/ into src/assets.gen.js so the Worker can serve the site itself.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, extname } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain; charset=utf-8" };
const root = new URL("../public/", import.meta.url).pathname;
const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files["/" + relative(root, p).replaceAll("\\", "/")] = { type: TYPES[extname(p)] || "application/octet-stream", body: readFileSync(p, "utf8") };
  }
})(root);
writeFileSync(new URL("../src/assets.gen.js", import.meta.url), "export default " + JSON.stringify(files) + ";\n");
console.log(`bundled ${Object.keys(files).length} files from public/`);
