import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("Usage: node scripts/run-node-tests.mjs <directory> [...]");
  process.exit(2);
}

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const tests = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) tests.push(...await findTests(path));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) tests.push(path);
  }
  return tests;
}

const tests = (await Promise.all(roots.map((root) => findTests(resolve(root)))))
  .flat()
  .sort();

if (tests.length === 0) {
  console.error(`No *.test.js files found under: ${roots.join(", ")}`);
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...tests], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
