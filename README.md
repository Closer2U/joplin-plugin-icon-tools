# Icon generation for Joplin Notebooks

The tool takes SVG-files as input and recursively applies a pre-defined color scheme, then exports them to PNG-files.

>[!INFO]
>A *plugin* that automatically applies these icons within the Joplin Desktop App is currently planned.

## icon_tool.py 

### Usage
```shell
  # Process an entire source tree (recommended)
  python3 icon_tool.py process-tree ./source_icons --out-dir ./output
  # or if uv installed (pro: no need to install cairosvg or create .venv!)
  └─$ uv run --with cairosvg --no-project icon-tool.py  process-tree ../Icons-Joplin --out-dir .

  # Single-file colorization to a directory
  python3 icon_tool.py colorize path/to/icon.svg --out-dir ./output/TopLevel

  # Convert a directory of SVGs to PNGs (nested mirror)
  python3 icon_tool.py to-png ./output --scale 2
```

>[!IMPORTANT]
> Tested for [Tabler Icons](https://tabler.io/icons).
> Other icons need adjustment. E.g. no color at all, then the <g>-Tag is set with a fill=""


Color targets replaced (in order, non-destructively):
  1. fill="currentColor"   → decade color  (SecondLevel filled icons)
  2. stroke="currentColor" → decade color  (outline / dot icons)
  3. fill="#000000"        → decade color  (explicit black fills / text)
  4. bare <g> with no fill → <g fill="decade_color">  (TopLevel icon)

All other colors (status strokes/fills like #19F781) are left untouched.

####  --- 26.05.2026 v2
`icon_resort.py` is now redundant for new runs — you only need it to re-sort files you generated with the old tool.Output now goes directly to the sorted structure in one shot:

```
output/
  svg/
    10-19/1st-level/…   20-29/1st-level/…   …
    10-19/2nd-level/…   20-29/2nd-level/…   …
    10-19/3rd-level/…   …
    10-19/4th-level/…   …
  png/                  ← identical structure
```

The `to-png` command signature also changed slightly — it now takes an explicit `--out-dir`:
```bash
python3 icon_tool.py to-png output/svg --out-dir output/png
```


## icon_resort.py

Handles resorting from Hierarchy based to Area based (for easier selecting when assigning new icons manually).
Is impemented in icon_tool.py Version 2.

```bash
# Move files (destructive — use on a copy first if unsure)
python3 icon_resort.py ./output --svg-out sorted_svg --png-out sorted_png

# Non-destructive copy
python3 icon_resort.py ./output --svg-out sorted_svg --png-out sorted_png --copy
```

***

>DISCLAIMER
>Both scripts were generated with support of an AI. 
