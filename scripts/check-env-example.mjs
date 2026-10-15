// Fails if the tracked .env.example contains a secret-looking value (keys belong in the gitignored .env).
import { readFileSync } from "node:fs";
const lines = readFileSync(new URL("../.env.example", import.meta.url), "utf8").split("\n");
const bad = lines.filter((l) => /^[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=.+/.test(l)).map((l) => l.split("=")[0]);
if (bad.length) { console.error(`Secret-looking values in .env.example: ${bad.join(", ")}. Move them to the gitignored .env.`); process.exit(1); }
console.log("env example clean");
