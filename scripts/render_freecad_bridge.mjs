#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { renderFreeCadOpenScript } from "../freecad-bridge.js";

const target = process.argv[2];
if (!target) {
  throw new Error("usage: node scripts/render_freecad_bridge.mjs PATH/open_in_freecad.py");
}
await writeFile(path.resolve(target), renderFreeCadOpenScript(), "utf8");
console.log(path.resolve(target));
