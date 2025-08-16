#!/usr/bin/env python3
"""
Prepare context and specifications for Claude Code handoff for Chrome extension.
Usage: python tools/handoff.py --component popup
"""

import json
import argparse
from pathlib import Path
from datetime import datetime

def get_component_files(component_name):
    """Map component names to expected files."""
    component_map = {
        "manifest": ["manifest.json"],
        "background": ["background.js", "utils/storage.js"],
        "popup": ["popup.html", "popup.js", "popup.css"],
        "content": ["content.js"],
        "options": ["options.html", "options.js", "options.css"],
        "full-extension": ["manifest.json", "background.js", "popup.html", "popup.js", "popup.css", "content.js"]
    }
    return component_map.get(component_name, [component_name])

def generate_environment_setup(component_name, spec):
    """Generate environment setup instructions for Chrome extension."""
    
    setup_instructions = f"""## Environment Setup

This is a Chrome extension project with vanilla JavaScript.

### Project Structure:
```
chrome-tab-limiter/
├── manifest.json       # Extension manifest
├── background.js       # Background service worker
├── popup.html         # Popup UI
├── popup.js           # Popup logic
├── popup.css          # Popup styling
├── content.js         # Content script (if needed)
├── options.html       # Options page (optional)
├── options.js         # Options logic
├── options.css        # Options styling
├── icons/            # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── utils/            # Utility modules
    └── storage.js    # Chrome storage API wrapper
```

### Setup Commands:
```bash
# Create project directory
mkdir -p chrome-tab-limiter/{{icons,utils}}
cd chrome-tab-limiter

# Initialize git (optional)
git init
```

### Chrome Extension Requirements:
- Manifest V3 format
- Service worker for background script
- Chrome APIs: tabs, storage, windows
- No external dependencies (vanilla JS only)"""
    
    return setup_instructions

def generate_development_workflow(component_name, spec):
    """Generate development workflow for Chrome extension."""
    
    workflow = """## Development Workflow

### 1. Load Extension in Chrome:
```bash
1. Open Chrome and navigate to chrome://extensions/
2. Enable "Developer mode" toggle
3. Click "Load unpacked"
4. Select the chrome-tab-limiter directory
```

### 2. Development Commands:
```bash
# No build step needed for vanilla JS
# Just edit files and reload extension in Chrome

# Watch for changes (optional, using any file watcher)
# fswatch -o . | xargs -n1 -I{} echo "Files changed, reload extension in Chrome"
```

### 3. Testing the Extension:
- Click the extension icon to open popup
- Try opening tabs beyond the limit
- Check that prompt appears correctly
- Verify tab closing functionality
- Test persistence of settings

### 4. Debugging:
- Right-click extension icon > "Inspect popup" for popup debugging
- Go to chrome://extensions/ > "Inspect views: service worker" for background script
- Use Chrome DevTools Console for debugging

### Core Functionality to Implement:
- [ ] Track number of open tabs in current window
- [ ] Store maximum tab limit in chrome.storage
- [ ] Monitor tab creation events
- [ ] Show prompt when limit exceeded
- [ ] Allow user to select tab to close
- [ ] Close selected tab and open new one
- [ ] Settings UI in popup"""
    
    return workflow

def prepare_handoff(component_name, verbose=False):
    """Prepare a handoff package for Claude Code for Chrome extension."""
    
    # Check if component spec exists (create minimal spec if not)
    spec_path = Path(f"specs/components/{component_name}.json")
    if not spec_path.exists():
        # Create minimal spec for Chrome extension components
        print(f"⚠️  No spec found, creating minimal spec for {component_name}")
        spec = {
            "specification": {
                "purpose": f"Chrome extension component: {component_name}",
                "technology": {
                    "runtime": "Chrome Extension (Manifest V3)",
                    "language": "JavaScript"
                }
            },
            "cc_instructions": {
                "priority": 1,
                "estimated_effort": "1-2 hours",
                "file_outputs": get_component_files(component_name)
            }
        }
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        with open(spec_path, 'w') as f:
            json.dump(spec, f, indent=2)
    else:
        with open(spec_path) as f:
            spec = json.load(f)
    
    # Load current context
    context_path = Path(".meta/context.json")
    if context_path.exists():
        with open(context_path) as f:
            context = json.load(f)
    else:
        context = {
            "project": {
                "name": "chrome-tab-limiter",
                "description": "Chrome extension to limit number of open tabs",
                "tech_stack": {
                    "platform": "Chrome Extension",
                    "manifest": "V3",
                    "language": "JavaScript"
                }
            },
            "current_context": {}
        }
        context_path.parent.mkdir(exist_ok=True)
        with open(context_path, 'w') as f:
            json.dump(context, f, indent=2)
    
    # Load progress status
    status_path = Path("progress/status.json")
    if status_path.exists():
        with open(status_path) as f:
            status = json.load(f)
    else:
        status = {"components": {component_name: {"status": "not-started"}}}
    
    # Generate setup and workflow
    env_setup = generate_environment_setup(component_name, spec)
    dev_workflow = generate_development_workflow(component_name, spec)
    
    # Generate CC instructions
    instructions = f"""# Implementation Task: {component_name}

{env_setup}

## Project Context
```json
{json.dumps(context.get('project', {}), indent=2)}
```

## Component Specification
```json
{json.dumps(spec.get('specification', {}), indent=2)}
```

## Implementation Requirements
```json
{json.dumps(spec.get('cc_instructions', {}), indent=2)}
```

## Current Status
```json
{json.dumps(status.get('components', {}).get(component_name, {}), indent=2)}
```

{dev_workflow}

## Implementation Instructions for Claude Code

### Core Features to Implement:

1. **Tab Tracking (background.js)**:
   - Listen to tab creation/removal events
   - Track tab count per window
   - Check against user-defined limit

2. **Limit Enforcement**:
   - When limit exceeded, prevent new tab creation
   - Show prompt to select tab to close
   - Handle user selection

3. **User Interface (popup.html/js)**:
   - Input field for max tab limit
   - Save button to store preference
   - Current tab count display

4. **Storage (utils/storage.js)**:
   - Save/load max tab limit
   - Use chrome.storage.sync for cross-device sync

5. **Prompt Dialog**:
   - List all current tabs with titles
   - Allow selection of tab to close
   - Handle cancellation

### Manifest.json Structure:
```json
{{
  "manifest_version": 3,
  "name": "Tab Limiter",
  "version": "1.0",
  "description": "Limit the number of open tabs in a window",
  "permissions": [
    "tabs",
    "storage"
  ],
  "background": {{
    "service_worker": "background.js"
  }},
  "action": {{
    "default_popup": "popup.html",
    "default_icon": {{
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }}
  }},
  "icons": {{
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }}
}}
```

### File Structure to Create:
"""
    
    # Add file structure
    for file_path in spec['cc_instructions']['file_outputs']:
        instructions += f"- {file_path}\n"
    
    instructions += f"""

### Testing Checklist:
- [ ] Extension loads without errors
- [ ] Tab limit can be set and saved
- [ ] New tabs blocked when limit reached
- [ ] Prompt appears with tab list
- [ ] Selected tab closes correctly
- [ ] New tab opens after closing
- [ ] Settings persist across browser restarts

---
Generated: {datetime.now().isoformat()}
Component: {component_name}
Spec Version: {spec.get('meta', {}).get('version', '1.0')}
"""
    
    # Save to handoff file
    handoff_path = Path(f".meta/handoff_{component_name}.md")
    handoff_path.parent.mkdir(exist_ok=True)
    handoff_path.write_text(instructions)
    
    print(f"✅ Handoff prepared: {handoff_path}")
    print(f"📋 Component: {component_name}")
    print(f"📊 Current status: {status.get('components', {}).get(component_name, {}).get('status', 'unknown')}")
    print(f"🎯 Priority: {spec.get('cc_instructions', {}).get('priority', 'not set')}")
    print(f"⏱️  Estimated effort: {spec.get('cc_instructions', {}).get('estimated_effort', 'not specified')}")
    print()
    print("Next steps:")
    print("1. Open Claude Code")
    print(f"2. Share the contents of {handoff_path}")
    print("3. Let CC implement the component")
    
    if verbose:
        print("\n--- Handoff Content ---")
        print(instructions)
    
    return instructions

def list_components():
    """List available Chrome extension components."""
    # For Chrome extension, we have predefined components
    components = {
        "manifest": "Extension manifest configuration",
        "background": "Background service worker for tab management",
        "popup": "Popup UI for settings",
        "content": "Content script (if needed)",
        "options": "Options page (optional)",
        "full-extension": "Complete extension implementation"
    }
    
    print("📦 Available components:")
    for name, description in components.items():
        print(f"  - {name}: {description}")

def check_environment():
    """Check if Chrome browser is available for testing."""
    import subprocess
    import platform
    
    print("🔍 Checking environment:")
    
    # Check for Chrome/Chromium
    chrome_commands = {
        'Darwin': ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'chromium'],
        'Linux': ['google-chrome', 'chromium-browser', 'chromium'],
        'Windows': ['chrome.exe', 'chrome']
    }
    
    system = platform.system()
    commands = chrome_commands.get(system, ['google-chrome', 'chromium'])
    
    chrome_found = False
    for cmd in commands:
        try:
            subprocess.run([cmd, '--version'], capture_output=True, check=True)
            print(f"  ✅ Chrome/Chromium found: {cmd}")
            chrome_found = True
            break
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue
    
    if not chrome_found:
        print("  ⚠️  Chrome/Chromium not found in standard locations")
        print("     Please ensure Chrome is installed for testing")
    
    # Check for git (optional)
    try:
        subprocess.run(['git', '--version'], capture_output=True, check=True)
        print("  ✅ Git is installed (optional)")
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("  ℹ️  Git not found (optional for version control)")
    
    return chrome_found

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prepare handoff to Claude Code for Chrome extension")
    parser.add_argument("--component", "-c", help="Component name to handoff")
    parser.add_argument("--list", "-l", action="store_true", help="List available components")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show handoff content")
    parser.add_argument("--check", action="store_true", help="Check environment setup")
    
    args = parser.parse_args()
    
    if args.check:
        check_environment()
    elif args.list:
        list_components()
    elif args.component:
        prepare_handoff(args.component, args.verbose)
    else:
        print("Usage: python tools/handoff.py --component <name>")
        print("       python tools/handoff.py --list")
        print("       python tools/handoff.py --check")
        list_components()
