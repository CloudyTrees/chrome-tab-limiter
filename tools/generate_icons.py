#!/usr/bin/env python3
"""
Generate PNG icons for Chrome extension from SVG template.
This creates icon16.png, icon48.png, and icon128.png
"""

import base64
from pathlib import Path

# SVG template for the icon
SVG_TEMPLATE = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="{size}" height="{size}">
  <!-- Background circle -->
  <circle cx="64" cy="64" r="60" fill="#4285F4"/>

  <!-- Tab representation -->
  <g transform="translate(64, 64)">
    <!-- Main tab -->
    <rect x="-35" y="-25" width="50" height="35" rx="4" fill="white" opacity="0.95"/>

    <!-- Tab with limit indicator -->
    <rect x="-10" y="-15" width="45" height="35" rx="4" fill="white" opacity="0.7"/>

    <!-- Limit badge -->
    <circle cx="25" cy="-10" r="18" fill="#EA4335"/>
    <text x="25" y="-4" font-family="Arial, sans-serif" font-size="20" font-weight="bold" text-anchor="middle" fill="white">!</text>
  </g>

  <!-- Text (only for larger sizes) -->
  {text_element}
</svg>'''

def create_icons():
    """Create icon files for the Chrome extension."""

    # Create icons directory
    icons_dir = Path(".")
    # icons_dir.mkdir(parents=True, exist_ok=True)

    # Icon sizes needed for Chrome extension
    sizes = [16, 48, 128]

    for size in sizes:
        # Add text only for larger icons
        if size >= 48:
            text_element = '<text x="64" y="95" font-family="Arial, sans-serif" font-size="14" font-weight="bold" text-anchor="middle" fill="white">LIMIT</text>'
        else:
            text_element = ''

        # Generate SVG with specific size
        svg_content = SVG_TEMPLATE.format(size=size, text_element=text_element)

        # Save SVG file (for reference/editing)
        svg_path = icons_dir / f"icon{size}.svg"
        svg_path.write_text(svg_content)
        print(f"✅ Created {svg_path}")

        # Note: To convert SVG to PNG, you'll need to:
        # 1. Open the SVG in a browser
        # 2. Take a screenshot at exact size
        # Or use an online converter like:
        # - https://cloudconvert.com/svg-to-png
        # - https://convertio.co/svg-png/

    print("\n📝 Instructions to create PNG icons:")
    print("1. Open each SVG file in Chrome")
    print("2. Use Chrome DevTools to set exact viewport size")
    print("3. Take screenshot and save as PNG")
    print("\nAlternatively, use an online SVG to PNG converter")

    # Create a simple HTML file to help with conversion
    html_content = '''<!DOCTYPE html>
<html>
<head>
    <title>Icon Converter</title>
    <style>
        body {
            margin: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 20px;
            background: #f0f0f0;
        }
        .icon-box {
            margin: 20px;
            padding: 20px;
            background: white;
            border: 1px solid #ddd;
            text-align: center;
        }
        .icon-box h3 {
            margin-top: 0;
        }
        .instructions {
            background: #fffbea;
            padding: 15px;
            border: 1px solid #ffc107;
            border-radius: 4px;
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div class="instructions">
        <h2>How to save as PNG:</h2>
        <ol>
            <li>Right-click on each icon below</li>
            <li>Select "Save image as..."</li>
            <li>Save with the name shown (e.g., icon16.png)</li>
            <li>Make sure to save all three sizes</li>
        </ol>
    </div>

    <div class="icon-box">
        <h3>icon16.png (16x16)</h3>
        <img src="icon16.svg" width="16" height="16">
    </div>

    <div class="icon-box">
        <h3>icon48.png (48x48)</h3>
        <img src="icon48.svg" width="48" height="48">
    </div>

    <div class="icon-box">
        <h3>icon128.png (128x128)</h3>
        <img src="icon128.svg" width="128" height="128">
    </div>
</body>
</html>'''

    html_path = icons_dir / "converter.html"
    html_path.write_text(html_content)
    print(f"\n✅ Created {html_path}")
    print("   Open this file in Chrome to help convert SVG to PNG")

if __name__ == "__main__":
    create_icons()
    print("\n✨ Icon files created successfully!")
    print("\n⚠️  Note: Chrome requires PNG format for icons.")
    print("Please convert the SVG files to PNG using one of the methods above.")