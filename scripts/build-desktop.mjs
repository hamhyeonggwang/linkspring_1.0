import { build } from "esbuild";
import { mkdir, copyFile, readdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
await mkdir("desktop-build/migrations", { recursive: true });
const built = await build({ entryPoints: { main: "desktop/main.ts", preload: "desktop/preload.ts" }, bundle: true, platform: "node", target: "node24", format: "cjs", outdir: "desktop-build", outExtension: { ".js": ".cjs" }, external: ["electron"], sourcemap: false, metafile: true });
for (const name of await readdir("drizzle")) if (name.endsWith(".sql")) await copyFile(`drizzle/${name}`, `desktop-build/migrations/${name}`);
const root = JSON.parse(await readFile("package.json", "utf8"));
await writeFile("desktop-build/package.json", JSON.stringify({ name: "linkspring-desktop", version: "1.0.0", main: "main.cjs", description: "이어:봄 — 비영리 서비스의 빈 일정과 대기자를 연결하는 로컬 업무 도구", author: "LinkSpring", private: true, license: "UNLICENSED" }, null, 2));
await writeFile("desktop-build/BUILD-INFO.json", JSON.stringify({ version: "1.0.0", electron: root.devDependencies.electron, builtAt: new Date().toISOString(), platform: "Windows x64" }, null, 2));
await copyFile("docs/Windows_사용안내.md", "desktop-build/사용안내.md");
execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "vite.desktop.config.ts"], { stdio: "inherit" });
const modules = [...Object.keys(built.metafile.inputs), ...JSON.parse(await readFile("desktop-build/renderer-modules.json", "utf8"))];
const roots = new Set();
for (const input of modules) {
  const normalized = resolve(input).replaceAll("\\", "/"), marker = "/node_modules/", index = normalized.lastIndexOf(marker);
  if (index < 0) continue;
  const parts = normalized.slice(index + marker.length).split("/");
  roots.add(normalized.slice(0, index + marker.length) + parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join("/"));
}
let notices = "Third-party notices for libraries included in LinkSpring. Electron and Chromium notices are also provided in the installation directory.\n";
for (const directory of [...roots].sort()) {
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const files = (await readdir(directory)).filter(name => /^(license|licence|copying|notice)(\.|$)/i.test(name));
  notices += `\n\n===== ${pkg.name} ${pkg.version} (${pkg.license || "see notice"}) =====\n`;
  for (const file of files) notices += await readFile(join(directory, file), "utf8");
  if (!files.length) {
    if (pkg.name === "react-remove-scroll-bar") notices += await readFile("vendor/react-remove-scroll-bar.LICENSE", "utf8");
    else throw new Error(`Missing third-party license: ${pkg.name}`);
  }
}
notices += "\n\n===== Vendored shadcn CSS =====\n" + await readFile("vendor/shadcn-tailwind-4.13.0.LICENSE.md", "utf8");
await writeFile("desktop-build/THIRD-PARTY-NOTICES.txt", notices);
