# Icon generation and batch assignment for Joplin notebooks

The tool takes SVG-files as input and recursively applies a pre-defined color scheme, then exports them to PNG-files.

> [!TIP]
> A [*plugin*](joplin-plugin_auto-icon-assigner/README.md) that automatically applies these icons within the Joplin Desktop App is now available.

<div align="center" style="display:flex; flex-wrap:wrap; flex-direction: column; justify-content:center; align-items:flex-start;align-content:flex-start;">

<img style="flex-basis:auto" width="301" height="321" alt="1-4th" src="https://github.com/user-attachments/assets/f31ea635-0a1f-4ed9-b9e4-20e26a5bc699" />
<img style="flex-basis:auto" width="301" height="642" alt="4th" src="https://github.com/user-attachments/assets/b3e6133d-8b35-499b-8192-18258d8fdaa8" /> 

</div

  
</div>

## icon_tool.py 

### Usage
#### Preparations - Files and Folders

**Key rules the tool relies on:**

- **Folder names** are cosmetic — the tool recurses all subfolders, so naming is just for your own organisation.
- **Filename leading digit** (`1-`, `2-`, `3-`, `4-`) determines which level subfolder the output lands in. This is the only thing the tool actually parses.
- **SVG color targets** — templates must use one of these for the "to be colorized" elements:
  - `fill="currentColor"` — filled icons
  - `stroke="currentColor"` — outline icons
  - `fill="#000000"` — explicit black 
  - Bare `<g>` with no fill attribute (first `<g>` only)
- **Status/dot colors** (any other hardcoded hex like `#19F781`) are left untouched automatically.

#### The script
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
> Other icons need adjustment.

**Example Workflow:** <br>
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

<div align="center">

<pre align="center">

╭┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈╮
·  ＧＯ ＡＮＤ ＭＡＫＥ ＹＯＵＲ ＪＯＰＬＩＮ ＥＶＥＮ ＰＲＥＴＴＩＥＲ.    ·
╰┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈╯
</pre>

</div>
