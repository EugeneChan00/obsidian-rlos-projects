// Publish a GitHub release for the version in manifest.json (BRAT installs from these assets).
// Usage: bump "version" in manifest.json and package.json, commit, push, then `npm run release`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("manifest.json", "utf8"));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

if (run("git", ["status", "--porcelain", "--", "src", "manifest.json", "package.json"])) {
  throw new Error("commit src/, manifest.json and package.json before releasing");
}
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const assets = ["main.js", "manifest.json", "styles.css"].filter((f) => existsSync(f));
execFileSync("gh", ["release", "create", version, ...assets, "--target", branch, "--title", version, "--generate-notes"], { stdio: "inherit" });
console.log(`released ${version} from ${branch}: ${assets.join(", ")}`);
