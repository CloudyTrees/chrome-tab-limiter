#!/usr/bin/env python3
"""
Sync context between Claude chat and Claude Code sessions for Chrome extension.
Usage: python tools/sync-context.py --update "Completed popup UI implementation"
"""

import json
import argparse
from datetime import datetime
from pathlib import Path
import subprocess

# Try to import rich for better output (optional)
try:
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel
    from rich import print as rprint
    console = Console()
    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False
    console = None

def print_header(text):
    """Print a formatted header."""
    if RICH_AVAILABLE:
        console.print(Panel(text, style="bold blue"))
    else:
        print(f"\n{'='*50}")
        print(f"  {text}")
        print(f"{'='*50}")

def print_success(text):
    """Print success message."""
    if RICH_AVAILABLE:
        console.print(f"[green]✅[/green] {text}")
    else:
        print(f"✅ {text}")

def print_warning(text):
    """Print warning message."""
    if RICH_AVAILABLE:
        console.print(f"[yellow]⚠️[/yellow] {text}")
    else:
        print(f"⚠️  {text}")

def print_error(text):
    """Print error message."""
    if RICH_AVAILABLE:
        console.print(f"[red]❌[/red] {text}")
    else:
        print(f"❌ {text}")

def update_context(message, component=None, decision=None, question=None):
    """Update the shared context file."""
    context_path = Path(".meta/context.json")
    
    # Load existing context or create new
    if context_path.exists():
        with open(context_path) as f:
            context = json.load(f)
    else:
        print_warning("Creating new context file")
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
            "decisions": [],
            "current_context": {
                "open_questions": []
            }
        }
    
    # Update current context
    context["current_context"]["last_discussion"] = message
    context["current_context"]["updated_at"] = datetime.now().isoformat()
    
    if component:
        context["current_context"]["working_on"] = component
        print_success(f"Working on component: {component}")
    
    # Add decision if provided
    if decision:
        decision_entry = {
            "id": f"{len(context.get('decisions', [])) + 1:03d}",
            "date": datetime.now().strftime("%Y-%m-%d"),
            "decision": decision,
            "rationale": message,
            "made_by": "team"
        }
        if "decisions" not in context:
            context["decisions"] = []
        context["decisions"].append(decision_entry)
        print_success(f"Decision recorded: {decision}")
    
    # Add question if provided
    if question:
        if "open_questions" not in context["current_context"]:
            context["current_context"]["open_questions"] = []
        if question not in context["current_context"]["open_questions"]:
            context["current_context"]["open_questions"].append(question)
            print_success(f"Question added: {question}")
    
    # Save updated context
    context_path.parent.mkdir(exist_ok=True)
    with open(context_path, 'w') as f:
        json.dump(context, f, indent=2)
    
    print_success(f"Context updated: {message}")

def show_context():
    """Display current context for Chrome extension."""
    context_path = Path(".meta/context.json")
    
    if not context_path.exists():
        print_error("No context file found")
        return
    
    with open(context_path) as f:
        context = json.load(f)
    
    print_header("Current Context")
    
    current = context.get("current_context", {})
    
    if RICH_AVAILABLE:
        # Create a table for current status
        table = Table(title="Project Status", show_header=True)
        table.add_column("Field", style="cyan")
        table.add_column("Value", style="white")
        
        table.add_row("Project", context.get('project', {}).get('name', 'Not set'))
        table.add_row("Working on", current.get('working_on', 'Not set'))
        table.add_row("Last discussion", current.get('last_discussion', 'None')[:60] + "...")
        table.add_row("Updated", current.get('updated_at', 'Unknown'))
        table.add_row("Next component", current.get('next_component', 'Not set'))
        
        console.print(table)
    else:
        print(f"📦 Project: {context.get('project', {}).get('name', 'Not set')}")
        print(f"🔧 Working on: {current.get('working_on', 'Not set')}")
        print(f"💬 Last discussion: {current.get('last_discussion', 'None')}")
        print(f"🕐 Updated: {current.get('updated_at', 'Unknown')}")
        print(f"🎯 Next component: {current.get('next_component', 'Not set')}")
    
    # Show open questions
    questions = current.get("open_questions", [])
    if questions:
        print(f"\n❓ Open Questions ({len(questions)}):")
        for i, q in enumerate(questions, 1):
            print(f"  {i}. {q}")
    
    # Show recent decisions
    decisions = context.get("decisions", [])
    if decisions:
        print(f"\n📝 Recent Decisions ({len(decisions)} total):")
        for decision in decisions[-3:]:  # Show last 3 decisions
            print(f"  [{decision['id']}] {decision['decision']}")
            if decision.get('rationale'):
                print(f"       {decision['date']} - {decision['rationale'][:50]}...")

def show_extension_status():
    """Show status of Chrome extension files."""
    print_header("Extension Files Status")
    
    extension_dir = Path("chrome-tab-limiter")
    if not extension_dir.exists():
        print_error("Extension directory not found")
        print("  Run: mkdir chrome-tab-limiter")
        return
    
    # Expected files for Chrome extension
    expected_files = {
        "manifest.json": "Extension manifest",
        "background.js": "Background service worker",
        "popup.html": "Popup UI HTML",
        "popup.js": "Popup JavaScript",
        "popup.css": "Popup styles",
        "content.js": "Content script (optional)",
        "options.html": "Options page (optional)",
        "utils/storage.js": "Storage utilities"
    }
    
    if RICH_AVAILABLE:
        table = Table(title="Extension Files", show_header=True)
        table.add_column("File", style="cyan")
        table.add_column("Status", style="white")
        table.add_column("Description", style="white")
        
        for file, desc in expected_files.items():
            file_path = extension_dir / file
            status = "✔" if file_path.exists() else "✗"
            color = "green" if file_path.exists() else "red"
            table.add_row(file, f"[{color}]{status}[/{color}]", desc)
        
        console.print(table)
    else:
        print("\nExtension Files:")
        for file, desc in expected_files.items():
            file_path = extension_dir / file
            status = "✔" if file_path.exists() else "✗"
            print(f"  {status} {file}: {desc}")
    
    # Check if extension can be loaded
    manifest_path = extension_dir / "manifest.json"
    if manifest_path.exists():
        try:
            with open(manifest_path) as f:
                manifest = json.load(f)
                print_success(f"\nManifest version: {manifest.get('manifest_version', 'Unknown')}")
                print_success(f"Extension name: {manifest.get('name', 'Unknown')}")
        except json.JSONDecodeError:
            print_error("\nManifest.json is not valid JSON")

def resolve_question(question_index):
    """Mark a question as resolved."""
    context_path = Path(".meta/context.json")
    
    if not context_path.exists():
        print_error("No context file found")
        return
    
    with open(context_path) as f:
        context = json.load(f)
    
    questions = context.get("current_context", {}).get("open_questions", [])
    
    if not questions:
        print_warning("No open questions")
        return
    
    if question_index < 1 or question_index > len(questions):
        print_error(f"Invalid question index. Valid range: 1-{len(questions)}")
        return
    
    resolved = questions.pop(question_index - 1)
    
    # Save updated context
    with open(context_path, 'w') as f:
        json.dump(context, f, indent=2)
    
    print_success(f"Resolved question: {resolved}")

def sync_from_cc(status_update):
    """Sync implementation status from Claude Code."""
    status_path = Path("progress/status.json")
    
    if not status_path.exists():
        # Create initial status file
        status_path.parent.mkdir(exist_ok=True)
        status = {
            "last_updated": datetime.now().isoformat(),
            "components": {}
        }
    else:
        with open(status_path) as f:
            status = json.load(f)
    
    # Update last modified
    status["last_updated"] = datetime.now().isoformat()
    
    # Parse status update (format: "component:status")
    if ":" in status_update:
        component, new_status = status_update.split(":", 1)
        if component not in status.get("components", {}):
            status["components"][component] = {}
        
        status["components"][component]["status"] = new_status
        status["components"][component]["notes"] = f"Updated by CC: {datetime.now().strftime('%Y-%m-%d')}"
        
        # Update progress based on status
        progress_map = {
            "not-started": 0,
            "in-progress": 50,
            "implemented": 80,
            "tested": 90,
            "complete": 100
        }
        if new_status in progress_map:
            status["components"][component]["progress_percentage"] = progress_map[new_status]
        
        print_success(f"Updated {component} status to: {new_status}")
    else:
        print_error("Invalid format. Use: component:status")
    
    # Save updated status
    with open(status_path, 'w') as f:
        json.dump(status, f, indent=2)

def check_chrome():
    """Check if Chrome is available for testing."""
    import platform
    
    print_header("Chrome Check")
    
    # Try to detect Chrome installation
    system = platform.system()
    chrome_paths = {
        'Darwin': ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        'Linux': ['google-chrome', 'chromium-browser'],
        'Windows': ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
    }
    
    paths = chrome_paths.get(system, [])
    chrome_found = False
    
    for path in paths:
        try:
            if system == 'Windows':
                if Path(path).exists():
                    chrome_found = True
                    print_success(f"Chrome found at: {path}")
                    break
            else:
                result = subprocess.run([path, '--version'], capture_output=True, text=True)
                if result.returncode == 0:
                    chrome_found = True
                    print_success(f"Chrome found: {result.stdout.strip()}")
                    break
        except:
            continue
    
    if not chrome_found:
        print_warning("Chrome not found in standard locations")
        print("  Please ensure Chrome is installed for testing")
    
    # Check extension directory
    print("\n")
    show_extension_status()

def init_project():
    """Initialize Chrome extension project structure."""
    print_header("Initializing Chrome Extension Project")
    
    # Create directory structure
    dirs = [
        "chrome-tab-limiter",
        "chrome-tab-limiter/icons",
        "chrome-tab-limiter/utils",
        ".meta",
        "progress",
        "specs/components"
    ]
    
    for dir_path in dirs:
        Path(dir_path).mkdir(parents=True, exist_ok=True)
        print_success(f"Created directory: {dir_path}")
    
    # Create initial context
    context_path = Path(".meta/context.json")
    if not context_path.exists():
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
            "decisions": [],
            "current_context": {
                "open_questions": [],
                "working_on": "project-setup"
            }
        }
        with open(context_path, 'w') as f:
            json.dump(context, f, indent=2)
        print_success("Created initial context file")
    
    print("\n✅ Project initialized!")
    print("\nNext steps:")
    print("1. Run: python tools/handoff.py --component manifest")
    print("2. Share handoff with Claude Code")
    print("3. Implement components iteratively")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Sync context between Claude sessions for Chrome extension"
    )
    parser.add_argument("--update", "-u", help="Update context with message")
    parser.add_argument("--component", "-c", help="Set current component")
    parser.add_argument("--decision", "-d", help="Record a decision")
    parser.add_argument("--question", "-q", help="Add an open question")
    parser.add_argument("--show", "-s", action="store_true", help="Show current context")
    parser.add_argument("--resolve", "-r", type=int, help="Resolve question by number")
    parser.add_argument("--sync-cc", help="Sync status from CC (format: component:status)")
    parser.add_argument("--check-chrome", action="store_true", help="Check Chrome installation")
    parser.add_argument("--files", action="store_true", help="Show extension files status")
    parser.add_argument("--init", action="store_true", help="Initialize project structure")
    
    args = parser.parse_args()
    
    # Handle different commands
    if args.init:
        init_project()
    elif args.check_chrome:
        check_chrome()
    elif args.files:
        show_extension_status()
    elif args.show:
        show_context()
    elif args.resolve:
        resolve_question(args.resolve)
    elif args.sync_cc:
        sync_from_cc(args.sync_cc)
    elif args.update:
        update_context(
            args.update, 
            component=args.component, 
            decision=args.decision, 
            question=args.question
        )
    else:
        # If no arguments, show context and files
        show_context()
        print()
        show_extension_status()
