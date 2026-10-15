import { copyFileSync, mkdirSync } from "node:fs";

const vault = process.env.RLOS_VAULT ?? "/Users/zzmc/exp/vault/rlos7";
const dest = `${vault}/.obsidian/plugins/rlos-projects`;
mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json"]) copyFileSync(f, `${dest}/${f}`);
console.log(`deployed to ${dest}`);
