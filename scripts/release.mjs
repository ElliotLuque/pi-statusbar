import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

const publishing = process.argv.includes("--publish");
const registry = "https://registry.npmjs.org/";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(args, capture = false) {
  return execFileSync(npm, args, { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
}

const manifest = JSON.parse(await readFile("package.json", "utf8"));
assert.ok(manifest.keywords.includes("pi-package"), "Gallery discovery requires the pi-package keyword");
assert.deepEqual(manifest.pi.extensions, ["./extensions/statusline/index.ts"]);
assert.ok(!manifest.private, "Package must be public");
for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
  assert.equal(manifest.peerDependencies[name], "*", `${name} must be a host-provided peer`);
  assert.ok(!manifest.dependencies?.[name], `Do not bundle ${name}`);
}
if (publishing) {
  try {
    console.log(`Publishing as ${run(["whoami", "--registry", registry], true).trim()}`);
  } catch {
    console.error("Publication blocked: authenticate with npm login, confirm package name/ownership, then rerun npm run release -- --publish. Never put tokens in source.");
    process.exit(1);
  }
}

run(["run", "check"]);
run(["test"]);
const [pack] = JSON.parse(run(["pack", "--dry-run", "--json", "--ignore-scripts"], true));
const files = pack.files.map(file => file.path);
for (const file of ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "extensions/statusline/index.ts", "extensions/statusline/render.ts", "extensions/statusline/quota.ts", "extensions/statusline/types.ts"]) {
  assert.ok(files.includes(file), `Missing package file: ${file}`);
}
assert.ok(files.every(file => ["package.json", "README.md", "LICENSE", "CHANGELOG.md"].includes(file) || /^extensions\/statusline\/[^/]+\.ts$/.test(file)), "Unexpected files in release tarball");
console.log(`Verified ${pack.name}@${pack.version}: ${files.length} files, ${pack.size} packed bytes.`);
if (!publishing) {
  console.log("Dry run only; NOT published. After npm login and confirming ownership, run npm run release -- --publish.");
  process.exit(0);
}

run(["publish", "--access", "public", "--registry", registry]);
let published;
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    published = JSON.parse(run(["view", `${manifest.name}@${manifest.version}`, "--json", "--registry", registry], true));
    break;
  } catch {
    if (attempt < 5) await wait(5000);
  }
}
assert.ok(published, "npm publish ran, but registry verification failed. Check npm before retrying; a version cannot be republished.");
assert.equal(published.version, manifest.version);
assert.ok(published.keywords?.includes("pi-package"));
assert.equal(published.pi?.extensions?.[0], "./extensions/statusline/index.ts");
console.log(`Published and registry-verified. Install with: pi install npm:${manifest.name}@${manifest.version}`);
console.log("Gallery indexing is asynchronous. Verify the listing at https://pi.dev/packages before declaring marketplace publication complete.");
