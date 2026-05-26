#!/usr/bin/env python3
"""
icon_resort.py — Reorganize generated icon output into decade/level trees
-------------------------------------------------------------------------
Source (current):
  output/
    TopLevel/svg/*.svg          ThirdLevel/png/*.png
    SecondLevel-Status/svg/…    FourthLevel-Status-Dot/png/…   etc.

Target:
  sorted_svg/
    00-09/1st-level/*.svg
    00-09/2nd-level/*.svg
    …
    90-99/4th-level/*.svg

  sorted_png/
    00-09/1st-level/*.png
    …

Usage:
  python3 icon_resort.py <source_root> [--svg-out sorted_svg] [--png-out sorted_png] [--copy]

  By default files are MOVED.  Pass --copy to duplicate instead.
"""

import argparse
import re
import shutil
import sys
from pathlib import Path

# ── Constants ─────────────────────────────────────────────────────────────────

DECADE_RANGES = [
    "00-09", "10-19", "20-29", "30-39", "40-49",
    "50-59", "60-69", "70-79", "80-89", "90-99",
]

# Map filename prefix digit → level folder name
LEVEL_MAP = {
    "1": "1st-level",
    "2": "2nd-level",
    "3": "3rd-level",
    "4": "4th-level",
}

# Regex: capture the decade range embedded in the filename
RANGE_RE = re.compile(r"(\d{2}-\d{2})\.(svg|png)$", re.IGNORECASE)


def detect_range(filename: str) -> str | None:
    """Extract decade range from filename, e.g. '…-10-19.svg' → '10-19'."""
    m = RANGE_RE.search(filename)
    return m.group(1) if m else None


def detect_level(filename: str) -> str | None:
    """
    Detect level from the leading digit of the filename.
    e.g. '1-TopLevelBlack-10-19.svg' → '1st-level'
         '4-folder-outline-dot-done-20-29.png' → '4th-level'
    """
    stem = Path(filename).stem          # strip extension
    first_char = stem.lstrip("-")[0]    # first non-dash char
    return LEVEL_MAP.get(first_char)


def resort(src_root: Path, svg_out: Path, png_out: Path, copy: bool) -> None:
    transfer = shutil.copy2 if copy else shutil.move
    verb = "copied" if copy else "moved"

    svgs: list[Path] = sorted(src_root.rglob("*.svg"))
    pngs: list[Path] = sorted(src_root.rglob("*.png"))

    counts = {"svg": 0, "png": 0, "skip": 0}

    for files, out_root, ext in ((svgs, svg_out, "svg"), (pngs, png_out, "png")):
        for f in files:
            rng   = detect_range(f.name)
            level = detect_level(f.name)

            if rng not in DECADE_RANGES or level is None:
                print(f"  SKIP (unrecognised): {f.relative_to(src_root)}")
                counts["skip"] += 1
                continue

            dest_dir = out_root / rng / level
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / f.name

            if dest.exists() and not copy:
                # Already there — skip to avoid error on re-runs
                continue

            transfer(str(f), str(dest))
            counts[ext] += 1

    print(f"\n✅  {verb.capitalize()}:")
    print(f"    {counts['svg']} SVGs  →  {svg_out}")
    print(f"    {counts['png']} PNGs  →  {png_out}")
    if counts["skip"]:
        print(f"    {counts['skip']} files skipped (no recognisable range/level in name)")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="icon_resort",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("source_root", help="Root of the existing icon output tree")
    parser.add_argument("--svg-out", default="sorted_svg", help="SVG output root (default: sorted_svg)")
    parser.add_argument("--png-out", default="sorted_png", help="PNG output root (default: sorted_png)")
    parser.add_argument("--copy", action="store_true", help="Copy files instead of moving them")
    args = parser.parse_args()

    src = Path(args.source_root)
    if not src.is_dir():
        sys.exit(f"ERROR: source not found: {src}")

    resort(src, Path(args.svg_out), Path(args.png_out), args.copy)


if __name__ == "__main__":
    main()
