import { rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const packagesDir = join(root, "packages");

for (const name of readdirSync(packagesDir)) {
  const pkg = join(packagesDir, name);
  for (const target of ["dist", "tsconfig.tsbuildinfo"]) {
    const path = join(pkg, target);
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    console.log("removed", path);
  }
}
