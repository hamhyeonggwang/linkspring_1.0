import { listPackage, extractFile } from "@electron/asar";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root = "release/win-unpacked";
const asar = `${root}/resources/app.asar`;
const entries = listPackage(asar).map(p => p.replaceAll("\\", "/"));
const allowed = /^\/(main\.cjs|preload\.cjs|package\.json|BUILD-INFO\.json|THIRD-PARTY-NOTICES\.txt|사용안내\.md|renderer(?:\/.*)?|migrations(?:\/\d[^/]*\.sql)?)$/;
for (const path of entries) {
  assert(allowed.test(path), `Unexpected packaged file: ${path}`);
  assert(!/\.(sqlite|db|map)$|\/\.env|node_modules|ai-settings|smoke-result/i.test(path), `Private or development file packaged: ${path}`);
}
for (const path of ["main.cjs", "preload.cjs", "renderer/index.html", "THIRD-PARTY-NOTICES.txt"]) assert(extractFile(asar, path).length > 0);
const executable = await readFile(`${root}/LinkSpring.exe`);
const peOffset = executable.readUInt32LE(0x3c);
assert.equal(executable.toString("ascii", peOffset, peOffset + 4), "PE\0\0");
assert.equal(executable.readUInt16LE(peOffset + 4), 0x8664, "App must be Windows x64");
const installerName = "LinkSpring-Setup-1.0.0-x64.exe";
const installer = await readFile(`release/${installerName}`);
assert.equal(installer.toString("ascii", 0, 2), "MZ");
assert(installer.length > 50_000_000, "Full offline installer should include Electron");
const sha256 = createHash("sha256").update(installer).digest("hex");
await writeFile("release/SHA256SUMS.txt", `${sha256}  ${installerName}\n`);
const result = { installer: installerName, bytes: installer.length, sha256, packagedEntries: entries.length, asarBytes: (await stat(asar)).size, windowsArchitecture: "x64", packageAllowlist: "passed", windowsExecutionTest: "not performed on this macOS host" };
await writeFile("release/verification.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
