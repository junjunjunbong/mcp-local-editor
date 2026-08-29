import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
assert.match(html, /<button type="button">Ship it<\/button>/);
process.stdout.write("PASS: ChatGPT changed the local button label.\n");
