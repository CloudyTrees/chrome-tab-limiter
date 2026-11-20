# Icon sources

Only the three PNGs in `extension/icons/` ship. This folder holds what they were made from:

- `generate_icons.py` writes `icon16.svg`, `icon48.svg`, `icon128.svg` and `converter.html` into the
  current folder, so run it from here: `cd tools/icons && python3 generate_icons.py`.
- `icon_generation.svg` is the design the generator is based on.
- `converter.html` only **previews** the three SVGs in a browser. Its "Save image as" instructions are
  wrong: saving an image under a `.png` name still writes SVG content. Do not use it to make the PNGs.

## Making the PNGs

Rasterize each SVG at its exact size with an SVG-to-PNG tool. For example, with `rsvg-convert`
(`brew install librsvg`), from this folder:

```bash
for size in 16 48 128; do
  rsvg-convert -w "$size" -h "$size" "icon$size.svg" -o "../../extension/icons/icon$size.png"
done
file ../../extension/icons/*.png     # each must say "PNG image data, <size> x <size>"
```

Any exporter that writes a real PNG at the same sizes works (Inkscape, ImageMagick built with SVG
support, a design tool). Check the result with `file`, as above. `tools/package.sh` ships only those
three PNGs.
