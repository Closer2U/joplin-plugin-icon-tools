#!/usr/bin/env python3
"""
icon_tool.py — SVG colorizer + PNG exporter for hierarchical icon sets
----------------------------------------------------------------------
Dependency: pip install cairosvg

Output structure
----------------
  <out_dir>/
    svg/
      10-19/
        1st-level/   ← all 1st-level SVGs for that range, flat
        2nd-level/
        3rd-level/
        4th-level/
      20-29/…
    png/             ← identical structure, PNG only

Usage
-----
  # Process an entire source tree (recommended)
  python3 icon_tool.py process-tree ./source_icons --out-dir ./output
  # or if uv installed (pro: no need to install cairosvg or create .venv!)
  └─$ uv run --with cairosvg --no-project icon-tool.py  process-tree ../Icons-Joplin --out-dir .

  # Single-file colorization to a directory
  python3 icon_tool.py colorize path/to/icon.svg --out-dir ./output/TopLevel

  # Convert a directory of SVGs to PNGs (nested mirror)
  python3 icon_tool.py to-png ./output --scale 2

Color targets replaced (in order, non-destructively):
  1. fill="currentColor"   → decade color  (SecondLevel filled icons)
  2. stroke="currentColor" → decade color  (outline / dot icons)
  3. fill="#000000"        → decade color  (explicit black fills / text)
  4. bare <g> with no fill → <g fill="decade_color">  (TopLevel icon)

All other colors (status strokes/fills like #19F781) are left untouched.
"""

import argparse
import re
import sys
from pathlib import Path

# ── Palettes ──────────────────────────────────────────────────────────────────

DECADE_COLORS: dict[str, str] = {
    "10-19": "#fbf8cc",
    "20-29": "#fde4cf",
    "30-39": "#ffcfd2",
    "40-49": "#f1c0e8",
    "50-59": "#cfbaf0",
    "60-69": "#a3c4f3",
    "70-79": "#90dbf4",
    "80-89": "#98f5e1",
    "90-99": "#b9fbc0",
}

LEVEL_MAP: dict[str, str] = {
    "1": "1st-level",
    "2": "2nd-level",
    "3": "3rd-level",
    "4": "4th-level",
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def detect_level(stem: str) -> str:
    """'1-TopLevelBlack' → '1st-level', '4-folder-outline-done' → '4th-level'."""
    first = stem.lstrip("-")[0]
    level = LEVEL_MAP.get(first)
    if level is None:
        raise ValueError(f"Cannot determine level from filename stem '{stem}'. "
                         "Expected leading digit 1–4.")
    return level


def colorize_svg(svg_text: str, color: str) -> str:
    """Replace black/currentColor markers with the decade color."""
    result = svg_text
    result = result.replace('fill="currentColor"',   f'fill="{color}"')
    result = result.replace('stroke="currentColor"', f'stroke="{color}"')
    result = re.sub(r'fill="#000000"', f'fill="{color}"', result, flags=re.IGNORECASE)

    def add_fill_to_bare_g(m: re.Match) -> str:
        tag = m.group(0)
        if "fill=" not in tag:
            tag = tag.rstrip(">") + f' fill="{color}">'
        return tag

    result = re.sub(r"<g(?:\s[^>]*)?>", add_fill_to_bare_g, result, count=1)
    return result


# ── Core processing ───────────────────────────────────────────────────────────

def process_svg(
    svg_path: Path,
    svg_root: Path,
    png_root: Path,
    scale: float,
    svg_only: bool = False,
) -> int:
    """
    Write 9 colorized SVG variants (+ PNGs) for one template.

    Output paths:
      svg_root / <range> / <level> / <stem>-<range>.svg
      png_root / <range> / <level> / <stem>-<range>.png

    Returns number of SVGs written.
    """
    try:
        import cairosvg  # type: ignore
        _have_cairo = True
    except ImportError:
        _have_cairo = False
        if not svg_only:
            print("  ⚠  cairosvg not found — skipping PNG (pip install cairosvg)")

    try:
        level = detect_level(svg_path.stem)
    except ValueError as e:
        print(f"  SKIP: {e}")
        return 0

    svg_text = svg_path.read_text(encoding="utf-8")
    count = 0

    for range_label, color in DECADE_COLORS.items():
        colored  = colorize_svg(svg_text, color)
        out_stem = f"{svg_path.stem}-{range_label}"

        svg_dir = svg_root / range_label / level
        svg_dir.mkdir(parents=True, exist_ok=True)
        svg_out = svg_dir / f"{out_stem}.svg"
        svg_out.write_text(colored, encoding="utf-8")
        count += 1
        print(f"    SVG  {range_label}/{level}/{svg_out.name}  ({color})")

        if not svg_only and _have_cairo:
            png_dir = png_root / range_label / level
            png_dir.mkdir(parents=True, exist_ok=True)
            png_out = png_dir / f"{out_stem}.png"
            cairosvg.svg2png(
                url=str(svg_out.resolve()),
                write_to=str(png_out),
                scale=scale,
                background_color="transparent",
            )
            print(f"    PNG  {range_label}/{level}/{png_out.name}")

    return count


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_process_tree(args: argparse.Namespace) -> None:
    src_root = Path(args.src_dir)
    out_root = Path(args.out_dir)

    if not src_root.is_dir():
        sys.exit(f"ERROR: source directory not found: {src_root}")

    svgs = sorted(src_root.rglob("*.svg"))
    if not svgs:
        sys.exit(f"ERROR: no .svg files found under {src_root}")

    svg_root = out_root / "svg"
    png_root = out_root / "png"

    total = 0
    for svg_path in svgs:
        print(f"\n  ── {svg_path.relative_to(src_root)} ──")
        total += process_svg(svg_path, svg_root, png_root, args.scale, args.svg_only)

    print(f"\n✅  Done — {total} SVG variants → {svg_root}")
    if not args.svg_only:
        print(f"           {total} PNG variants  → {png_root}")


def cmd_colorize(args: argparse.Namespace) -> None:
    svg_path = Path(args.svg)
    if not svg_path.exists():
        sys.exit(f"ERROR: file not found: {svg_path}")

    out_root = Path(args.out_dir)
    print(f"\n  ── {svg_path.name} ──")
    n = process_svg(svg_path, out_root / "svg", out_root / "png", args.scale, args.svg_only)
    print(f"\n✅  {n} variants written to '{out_root}'")


def cmd_to_png(args: argparse.Namespace) -> None:
    """Convert all SVGs under <src_dir> to PNGs under <out_dir>, mirroring structure."""
    try:
        import cairosvg  # type: ignore
    except ImportError:
        sys.exit("ERROR: cairosvg not installed. Run: pip install cairosvg")

    src = Path(args.src_dir)
    out = Path(args.out_dir)

    if not src.is_dir():
        sys.exit(f"ERROR: directory not found: {src}")

    svgs = sorted(src.rglob("*.svg"))
    if not svgs:
        sys.exit(f"ERROR: no SVGs found under {src}")

    converted = 0
    for svg_path in svgs:
        rel      = svg_path.relative_to(src)
        png_path = out / rel.parent / (svg_path.stem + ".png")
        png_path.parent.mkdir(parents=True, exist_ok=True)
        cairosvg.svg2png(
            url=str(svg_path.resolve()),
            write_to=str(png_path),
            scale=args.scale,
            background_color="transparent",
        )
        print(f"  {rel}  →  {png_path.relative_to(out)}")
        converted += 1

    print(f"\n✅  {converted} PNGs written to '{out}'")


# ── CLI ───────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="icon_tool",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--scale", type=float, default=2.0,
                       help="PNG scale factor (default: 2 → retina)")
        p.add_argument("--svg-only", action="store_true",
                       help="Skip PNG export")

    # process-tree
    p_tree = sub.add_parser("process-tree",
                             help="Process an entire source icon tree (recommended)")
    p_tree.add_argument("src_dir", help="Root of the source icon directory")
    p_tree.add_argument("--out-dir", default="output",
                        help="Root output directory (default: ./output)")
    add_common(p_tree)

    # colorize
    p_col = sub.add_parser("colorize",
                            help="Colorize a single SVG template into range variants")
    p_col.add_argument("svg", help="Path to the template SVG")
    p_col.add_argument("--out-dir", default="output",
                       help="Output directory (default: ./output)")
    add_common(p_col)

    # to-png
    p_png = sub.add_parser("to-png",
                            help="Convert SVG tree to PNG tree, mirroring structure")
    p_png.add_argument("src_dir", help="Root SVG directory (e.g. output/svg)")
    p_png.add_argument("--out-dir", required=True,
                       help="Root PNG output directory (e.g. output/png)")
    p_png.add_argument("--scale", type=float, default=2.0,
                       help="PNG scale factor (default: 2)")

    return parser


def main() -> None:
    parser = build_parser()
    args   = parser.parse_args()
    {"process-tree": cmd_process_tree,
     "colorize":     cmd_colorize,
     "to-png":       cmd_to_png}[args.command](args)


if __name__ == "__main__":
    main()
