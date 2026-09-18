"""Package the reviewed local installer, README and source without local data/keys.

Run from the repository root after desktop:dist and desktop:verify.
Python is used only to prepare a submission ZIP, never to run the installed app.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import zipfile

root = Path.cwd()
version = json.loads((root / "package.json").read_text())["desktopVersion"]
installer = f"LinkSpring-Setup-{version}-x64.exe"
release = root / "release"
bundle = release / f"LinkSpring-Submission-{version}"
bundle.mkdir(parents=True, exist_ok=True)
verification = json.loads((release / "verification.json").read_text())
assert verification["installer"] == installer
assert hashlib.sha256((release / installer).read_bytes()).hexdigest() == verification["sha256"]

for filename in [installer, "SHA256SUMS.txt", "verification.json"]:
    shutil.copy2(release / filename, bundle / filename)
shutil.copy2(root / "README.md", bundle / "README.md")
shutil.copytree(root / "docs", bundle / "docs", dirs_exist_ok=True)
shutil.copy2(root / "docs/제출_안내.md", bundle / "먼저_읽어주세요.md")

# The current working copy includes new implementation files, unlike git archive HEAD.
paths = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0")
files = sorted({p for p in paths if p and (root / p).is_file() and not (root / p).is_symlink()
                and Path(p).suffix.lower() not in {".exe", ".zip", ".sqlite", ".db", ".pem", ".log"}
                and not any(x.startswith(".env") and x != ".env.example" for x in Path(p).parts)
                and not any(x in {".git", "node_modules", "release", "desktop-build", "desktop-test-output"} for x in Path(p).parts)})
secrets = [v.encode() for k, v in os.environ.items() if k in {"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"} and len(v) > 10]
manifest = []
source = bundle / f"LinkSpring-Source-{version}.zip"
with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        content = (root / name).read_bytes()
        assert not any(secret in content for secret in secrets), "Credential detected; refusing source packaging"
        archive.writestr(f"linkspring-{version}/{name}", content)
        manifest.append({"file": name, "sha256": hashlib.sha256(content).hexdigest()})
(bundle / "source-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))

for target in [root / "README.md", bundle / "README.md"]:
    for link in re.findall(r"!?\[[^\]]*\]\(([^)]+)\)", target.read_text()):
        if not link.startswith(("https://", "http://", "#")):
            assert (target.parent / link.split("#")[0]).exists(), f"Missing README attachment: {link}"
for file in bundle.rglob("*"):
    if file.is_file():
        assert not any(secret in file.read_bytes() for secret in secrets), "Credential detected in bundle"
output = release / f"LinkSpring-Submission-{version}.zip"
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(bundle.rglob("*")):
        if file.is_file():
            archive.write(file, file.relative_to(release))
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
print(json.dumps({"zip": str(output), "bytes": output.stat().st_size, "sourceFiles": len(files),
                  "screenshots": len(list((bundle / "docs/screenshots").glob("*.png"))),
                  "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "readmeLinks": "passed", "credentialScan": "passed"}, ensure_ascii=False, indent=2))
