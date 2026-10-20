#!/usr/bin/env python3
# Generate or check THIRD-PARTY-LICENSES.md from `go list -m all`.
#
# Default mode exits 1 when the committed file differs from a fresh scan.
# --update rewrites the file. The scan downloads any module that is not
# already in the cache. It does not edit go.mod or go.sum.
import argparse
import hashlib
import json
import os
import subprocess
import sys

LICENSE_NAMES = (
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "LICENSE.rst",
    "LICENCE",
    "LICENCE.md",
    "LICENCE.txt",
    "COPYING",
    "COPYING.md",
    "COPYING.txt",
    "UNLICENSE",
    "UNLICENSE.md",
)

ROOT_SPDX = "AGPL-3.0-only"
# SHA-256 of https://www.gnu.org/licenses/agpl-3.0.txt. The root LICENSE must
# be that file byte for byte; "-only" is stated in NOTICE, not in the text.
ROOT_LICENSE_SHA256 = "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0"

# Licenses whose code may be combined into an AGPL-3.0-only work. MPL-2.0 is
# allowed through its section 3.3 only while no file carries Exhibit B.
AGPL_COMPATIBLE = {
    "0BSD",
    "AGPL-3.0",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSL-1.0",
    "ISC",
    "MIT",
    "MPL-2.0",
    "PostgreSQL",
    "Unlicense",
    "Zlib",
    "public-domain",
}

# (module, detected id) pairs reviewed by hand. Anything else outside
# AGPL_COMPATIBLE fails the check.
REVIEWED = {
    ("github.com/iris-contrib/schema", "NOASSERTION"): "无许可证文件；README.md 的 License 一节是 BSD-3-Clause。不被任何包导入。",
    ("github.com/opencontainers/go-digest", "CC-BY-SA-4.0"): "LICENSE.docs 只覆盖文档，代码是 Apache-2.0。只在集成测试中使用。",
    ("modernc.org/memory", "UNKNOWN"): "LICENSE-LOGO 只是 logo.png 的来源链接，不涉及代码。",
}

OUT_NAME = "THIRD-PARTY-LICENSES.md"
STAMP_NAME = os.path.join("tests", "licenses", "stamp.go")
STAMP_TMPL = """package licenses

// listStamp is the SHA-256 of THIRD-PARTY-LICENSES.md.
// scripts/check-third-party-licenses.py --update rewrites this constant so
// the test binary changes with the list. go test otherwise caches a pass
// without noticing edits to files outside this package.
const listStamp = "%s"
"""


def repo_root():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    if not os.path.isfile(os.path.join(root, "go.mod")):
        sys.exit("go.mod not found above scripts/")
    return root


def run(root, args):
    proc = subprocess.run(args, cwd=root, text=True, capture_output=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(proc.returncode)
    return proc.stdout


def parse_modules(raw):
    dec = json.JSONDecoder()
    i = 0
    mods = []
    while i < len(raw):
        while i < len(raw) and raw[i].isspace():
            i += 1
        if i >= len(raw):
            break
        obj, j = dec.raw_decode(raw, i)
        i = j
        mods.append(obj)
    return mods


def encode_module_path(path):
    encoded = []
    for char in path:
        if char.isupper():
            encoded.append("!")
            encoded.append(char.lower())
        else:
            encoded.append(char)
    return "".join(encoded)


def cache_dir(gomodcache, path, version):
    return os.path.join(gomodcache, "%s@%s" % (encode_module_path(path), version))


def restore_sum(root, before):
    path = os.path.join(root, "go.sum")
    if before is None:
        return
    with open(path, "rb") as fh:
        current = fh.read()
    if current != before:
        with open(path, "wb") as fh:
            fh.write(before)


def download_missing(root, specs):
    # `go mod download` can append zip sums. Put the original go.sum back so
    # a license check does not dirty the module file.
    sum_path = os.path.join(root, "go.sum")
    before = None
    if os.path.isfile(sum_path):
        with open(sum_path, "rb") as fh:
            before = fh.read()
    try:
        for start in range(0, len(specs), 40):
            proc = subprocess.run(
                ["go", "mod", "download"] + specs[start : start + 40],
                cwd=root,
                text=True,
                capture_output=True,
            )
            if proc.returncode != 0:
                sys.stderr.write(proc.stderr)
                sys.exit(proc.returncode)
    finally:
        restore_sum(root, before)


def module_sources(root, mods):
    # `go list -m` omits Dir for modules that are in the graph but not
    # imported by this build. The cache path is deterministic, so use that.
    gomodcache = run(root, ["go", "env", "GOMODCACHE"]).strip()
    missing = []
    sources = []
    for mod in mods:
        if mod.get("Main"):
            sources.append((mod, root))
            continue
        repl = mod.get("Replace")
        if repl and repl.get("Dir"):
            sources.append((mod, repl["Dir"]))
            continue
        version = mod.get("Version")
        if not version:
            sys.exit("module %s has no version" % mod.get("Path"))
        directory = cache_dir(gomodcache, mod["Path"], version)
        sources.append((mod, directory))
        if not os.path.isdir(directory):
            missing.append("%s@%s" % (mod["Path"], version))
    if missing:
        download_missing(root, missing)
        still = []
        for spec in missing:
            path, version = spec.rsplit("@", 1)
            if not os.path.isdir(cache_dir(gomodcache, path, version)):
                still.append(spec)
        if still:
            sys.exit("module source missing after download:\n" + "\n".join(still))
    return sources


def license_files(directory):
    if not directory or not os.path.isdir(directory):
        return []
    found = []
    seen = set()
    by_upper = {}
    for name in os.listdir(directory):
        if os.path.isfile(os.path.join(directory, name)):
            by_upper.setdefault(name.upper(), name)
    for name in LICENSE_NAMES:
        actual = by_upper.get(name.upper())
        if actual:
            found.append(actual)
            seen.add(actual)
    extra = []
    for name in sorted(by_upper.values()):
        if name in seen:
            continue
        upper = name.upper()
        if upper.startswith("LICENSE") or upper.startswith("LICENCE") or upper.startswith("COPYING") or upper.startswith("UNLICENSE"):
            extra.append(name)
    return found + extra


def read_text(path):
    with open(path, "rb") as fh:
        data = fh.read()
    return data, data.decode("utf-8", "replace")


def detect_one(text):
    # Classify from the header. Later clauses in MPL and Apache name other
    # licenses; searching the whole file marks those texts as GPL or AGPL.
    # Collapse whitespace so a wrapped ISC grant still matches.
    head = " ".join(text[:4000].split()).upper()
    if "MOZILLA PUBLIC LICENSE" in head:
        return "MPL-2.0" if "2.0" in head else "MPL"
    if "GNU AFFERO GENERAL PUBLIC LICENSE" in head:
        return "AGPL-3.0"
    if "GNU LESSER GENERAL PUBLIC LICENSE" in head:
        if "VERSION 2.1" in head:
            return "LGPL-2.1"
        if "VERSION 3" in head:
            return "LGPL-3.0"
        return "LGPL"
    if "GNU GENERAL PUBLIC LICENSE" in head:
        if "VERSION 3" in head:
            return "GPL-3.0"
        if "VERSION 2" in head:
            return "GPL-2.0"
        return "GPL"
    if "APACHE LICENSE" in head and "VERSION 2.0" in head:
        return "Apache-2.0"
    if "ATTRIBUTION-SHAREALIKE 4.0" in head:
        return "CC-BY-SA-4.0"
    if "PUBLIC DOMAIN" in head:
        return "public-domain"
    if "ZERO-CLAUSE BSD" in head or "BSD ZERO CLAUSE" in head or "0BSD" in text[:500]:
        return "0BSD"
    if "ISC LICENSE" in head or "INTERNET SYSTEMS CONSORTIUM" in head:
        return "ISC"
    if "MIT LICENSE" in head or "PERMISSION IS HEREBY GRANTED, FREE OF CHARGE" in head:
        return "MIT"
    if "POSTGRESQL LICENSE" in head or "POSTGRESQL DATABASE MANAGEMENT SYSTEM" in head:
        return "PostgreSQL"
    if "BOOST SOFTWARE LICENSE" in head:
        return "BSL-1.0"
    if "ZLIB LICENSE" in head or "THE ZLIB/LIBPNG LICENSE" in head:
        return "Zlib"
    if "THIS IS FREE AND UNENCUMBERED SOFTWARE RELEASED INTO THE PUBLIC DOMAIN" in head:
        return "Unlicense"
    if "REDISTRIBUTION AND USE IN SOURCE AND BINARY FORMS" in head:
        if "NEITHER THE NAME" in head:
            return "BSD-3-Clause"
        return "BSD-2-Clause"
    if "PERMISSION TO USE, COPY, MODIFY, AND/OR DISTRIBUTE THIS SOFTWARE FOR ANY PURPOSE" in head:
        return "ISC"
    if "PERMISSION TO USE, COPY, MODIFY, AND DISTRIBUTE THIS SOFTWARE FOR ANY PURPOSE" in head:
        return "ISC"
    return "UNKNOWN"


def classify(directory, names):
    if not names:
        return "NOASSERTION", "-", "-"
    ids = []
    digests = []
    for name in names:
        data, text = read_text(os.path.join(directory, name))
        ids.append(detect_one(text))
        digests.append(hashlib.sha256(data).hexdigest())
    # Keep order, drop duplicate SPDX ids.
    uniq = []
    for item in ids:
        if item not in uniq:
            uniq.append(item)
    return " AND ".join(uniq), ", ".join(names), ", ".join(digests)


def cell(value):
    return (value or "-").replace("|", "\\|")


def render(pairs):
    rows = []
    for mod, directory in pairs:
        names = license_files(directory) if directory else []
        license_id, filename, digest = classify(directory, names)
        if mod.get("Main"):
            if filename != "LICENSE" or digest != ROOT_LICENSE_SHA256:
                sys.exit("root LICENSE is not the unmodified GNU AGPL-3.0 text (sha256 %s)" % ROOT_LICENSE_SHA256)
            license_id = ROOT_SPDX
            version = "(main)"
        else:
            version = mod.get("Version") or "-"
        replace = "-"
        if mod.get("Replace"):
            replace = mod["Replace"].get("Path") or "-"
        rows.append((mod["Path"], version, license_id, filename, digest, replace))
    rows.sort(key=lambda row: row[0])
    main_path = next(mod["Path"] for mod, _ in pairs if mod.get("Main"))
    reviewed = []
    incompatible = []
    for path, version, license_id, _filename, _digest, _replace in rows:
        if path == main_path:
            continue
        for part in license_id.split(" AND "):
            if part in AGPL_COMPATIBLE:
                continue
            reason = REVIEWED.get((path, part))
            if reason:
                reviewed.append((path, version, part, reason))
            else:
                incompatible.append("%s %s: %s" % (path, version, part))
    if incompatible:
        sys.exit("licenses not known to be compatible with %s:\n%s" % (ROOT_SPDX, "\n".join(incompatible)))
    agpl = [row for row in rows if "AGPL" in row[2] and row[0] != main_path]
    lines = [
        "# Third-party licenses",
        "",
        "由 `scripts/check-third-party-licenses.py` 从 `go list -m all` 生成。不要手改。",
        "更新时运行 `scripts/check-third-party-licenses.py --update`，再提交结果。",
        "检查模式发现与重新扫描的结果不一致时退出码为 1。",
        "",
        "本清单只记录每个 Go 模块自己的许可证文件。它不是法律意见。",
        "podhub-go 本身是 `%s`，版权持有人 xxww，见根目录 `LICENSE` 与 `NOTICE`。" % ROOT_SPDX,
        "根目录 `LICENSE` 须与 gnu.org 的 AGPL-3.0 原文逐字节一致，否则脚本退出。",
        "",
        "## AGPL-3.0 兼容性",
        "",
        "每个模块的许可证须在下列集合内：%s。" % "、".join(sorted(AGPL_COMPATIBLE, key=str.lower)),
        "集合外的许可证只有逐条复核过的才放行，见下表；其余任何一条都会让脚本退出。",
        "",
        "| Module | Version | License | 复核结论 |",
        "| --- | --- | --- | --- |",
    ]
    if reviewed:
        for path, version, part, reason in reviewed:
            lines.append("| %s | %s | %s | %s |" % (cell(path), cell(version), cell(part), cell(reason)))
    else:
        lines.append("| - | - | - | - |")
    lines.extend(
        [
            "",
            "## AGPL 模块",
            "",
            "这些模块与本仓库同为 GNU AGPL-3.0。用户不购买 RelayKit 商业授权，它们按 AGPL-3.0 使用。说明见根目录 `NOTICE`。",
            "",
            "| Module | Version | Replace |",
            "| --- | --- | --- |",
        ]
    )
    if agpl:
        for path, version, _license_id, _filename, _digest, replace in agpl:
            lines.append("| %s | %s | %s |" % (cell(path), cell(version), cell(replace)))
    else:
        lines.append("| - | - | - |")
    lines.extend(
        [
            "",
            "## 全部模块",
            "",
            "| Module | Version | License | File | SHA-256 | Replace |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
    )
    for path, version, license_id, filename, digest, replace in rows:
        lines.append(
            "| %s | %s | %s | %s | %s | %s |"
            % (cell(path), cell(version), cell(license_id), cell(filename), cell(digest), cell(replace))
        )
    lines.append("")
    return "\n".join(lines)


def stamp_text(markdown):
    digest = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
    return STAMP_TMPL % digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="rewrite THIRD-PARTY-LICENSES.md")
    args = parser.parse_args()
    root = repo_root()
    mods = parse_modules(run(root, ["go", "list", "-m", "-json", "all"]))
    text = render(module_sources(root, mods))
    stamp = stamp_text(text)
    dest = os.path.join(root, OUT_NAME)
    stamp_path = os.path.join(root, STAMP_NAME)
    if args.update:
        with open(dest, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        with open(stamp_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(stamp)
        print("wrote %s" % OUT_NAME)
        return
    missing = [path for path in (dest, stamp_path) if not os.path.isfile(path)]
    if missing:
        sys.stderr.write("missing %s; run scripts/check-third-party-licenses.py --update\n" % ", ".join(missing))
        sys.exit(1)
    with open(dest, encoding="utf-8") as fh:
        current = fh.read()
    with open(stamp_path, encoding="utf-8") as fh:
        current_stamp = fh.read()
    if current == text and current_stamp == stamp:
        print("%s is current" % OUT_NAME)
        return
    sys.stderr.write("%s is stale. Run scripts/check-third-party-licenses.py --update\n" % OUT_NAME)
    import difflib

    diff = difflib.unified_diff(
        current.splitlines(keepends=True),
        text.splitlines(keepends=True),
        fromfile=OUT_NAME,
        tofile=OUT_NAME + ".fresh",
    )
    shown = 0
    for line in diff:
        sys.stderr.write(line)
        shown += 1
        if shown >= 80:
            sys.stderr.write("... diff truncated\n")
            break
    sys.exit(1)


if __name__ == "__main__":
    main()
