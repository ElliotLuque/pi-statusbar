import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

// Modes (npm requires 2FA or trusted publishing for every publish):
//   (none)     verify only
//   --stage    from your machine: upload to npm's staging area, then approve it with 2FA
//   --publish  from GitHub Actions only: publish directly via trusted publishing (OIDC)
const staging = process.argv.includes("--stage");
const publishing = process.argv.includes("--publish");
if (staging && publishing) {
  console.error("Use either --stage or --publish, not both.");
  process.exit(1);
}
const registry = "https://registry.npmjs.org/";
// Windows ships pnpm as a batch shim, which Node only runs through a shell. All arguments are fixed.
function run(args, capture = false) {
  return execFileSync("pnpm", args, { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", shell: process.platform === "win32" });
}

const manifest = JSON.parse(await readFile("package.json", "utf8"));
function isPublished() {
  try {
    return run(["view", `${manifest.name}@${manifest.version}`, "version", "--registry", registry], true).trim() === manifest.version;
  } catch {
    return false; // 404: not published yet.
  }
}
assert.ok(manifest.keywords.includes("pi-package"), "Gallery discovery requires the pi-package keyword");
assert.deepEqual(manifest.pi.extensions, ["./extensions/statusline/index.ts"]);
assert.ok(!manifest.private, "Package must be public");
assert.match(await readFile("CHANGELOG.md", "utf8"), new RegExp(`^## ${manifest.version.replaceAll(".", "\\.")} `, "m"), `CHANGELOG.md has no entry for ${manifest.version}`);
for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
  assert.equal(manifest.peerDependencies[name], "*", `${name} must be a host-provided peer`);
  assert.ok(!manifest.dependencies?.[name], `Do not bundle ${name}`);
}
if (publishing) {
  if (process.env.GITHUB_ACTIONS !== "true") {
    console.error("--publish runs in the GitHub release workflow (trusted publishing). From your machine, use pnpm release --stage.");
    process.exit(1);
  }
  const tag = process.env.GITHUB_REF_NAME;
  assert.equal(tag, `v${manifest.version}`, `Tag ${tag} does not match package.json version ${manifest.version}`);
  // Versions staged and approved by hand are already live; re-running for their tag is not an error.
  if (isPublished()) {
    console.log(`${manifest.name}@${manifest.version} is already on npm; nothing to publish.`);
    process.exit(0);
  }
} else if (staging) {
  try {
    console.log(`Staging as ${run(["whoami", "--registry", registry], true).trim()}`);
  } catch {
    console.error("Staging blocked: run pnpm login, then rerun pnpm release --stage. Never put tokens in source.");
    process.exit(1);
  }
}

run(["run", "check"]);
run(["test"]);
const pack = JSON.parse(run(["pack", "--dry-run", "--json"], true));
const files = pack.files.map(file => file.path);
const modules = ["index", "render", "quota", "codex", "poller", "preferences", "usage", "types"].map(name => `extensions/statusline/${name}.ts`);
for (const file of ["package.json", "README.md", "LICENSE", "CHANGELOG.md", ...modules]) {
  assert.ok(files.includes(file), `Missing package file: ${file}`);
}
assert.ok(files.every(file => ["package.json", "README.md", "LICENSE", "CHANGELOG.md"].includes(file) || /^extensions\/statusline\/[^/]+\.ts$/.test(file)), "Unexpected files in release tarball");
console.log(`Verified ${pack.name}@${pack.version}: ${files.length} files.`);
if (!publishing && !staging) {
  console.log("Verified only; NOT published. Release by pushing a v* tag, or locally with pnpm release --stage.");
  process.exit(0);
}
if (staging) {
  run(["stage", "publish", "--access", "public", "--registry", registry]);
  console.log(`Staged ${manifest.name}@${manifest.version}; it is NOT live yet.`);
  console.log("Approve it with 2FA: pnpm stage approve (or the Staged Packages tab on npmjs.com).");
  process.exit(0);
}

// Uses the GitHub Actions OIDC token; no npm token is stored anywhere.
// Tag checkouts are a detached HEAD, so skip pnpm's branch check; the tag/version check above replaces it.
try {
  run(["publish", "--access", "public", "--registry", registry, "--provenance", "--no-git-checks"]);
} catch {
  console.error([
    "Publish failed. If the log above shows \"Skipped OIDC ... 404\", npm has no matching trusted publisher.",
    `On npmjs.com: ${manifest.name} > Settings > Trusted Publisher > GitHub Actions with`,
    "user ElliotLuque, repository pi-statusbar, workflow release.yml, no environment, and \"npm publish\" allowed.",
  ].join("\n"));
  process.exit(1);
}
let published;
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    published = JSON.parse(run(["view", `${manifest.name}@${manifest.version}`, "--json", "--registry", registry], true));
    break;
  } catch {
    if (attempt < 5) await wait(5000);
  }
}
assert.ok(published, "pnpm publish ran, but registry verification failed. Check npmjs.com before retrying; a version cannot be republished.");
assert.equal(published.version, manifest.version);
assert.ok(published.keywords?.includes("pi-package"));
assert.equal(published.pi?.extensions?.[0], "./extensions/statusline/index.ts");
console.log(`Published and registry-verified. Install with: pi install npm:${manifest.name}@${manifest.version}`);
console.log("Gallery indexing is asynchronous. Verify the listing at https://pi.dev/packages before declaring marketplace publication complete.");
