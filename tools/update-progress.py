#!/usr/bin/env python3
"""
Update progress tracking for Chrome extension components.
Usage: python tools/update-progress.py --component popup --status implemented
"""

import json
import argparse
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

# Try to import rich for better output (optional)
try:
    from rich.console import Console
    from rich.table import Table
    from rich.progress import Progress, BarColumn, TextColumn
    from rich.panel import Panel
    from rich import print as rprint
    console = Console()
    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False
    console = None

# ANSI color codes for fallback
GREEN = '\033[0;32m'
YELLOW = '\033[1;33m'
RED = '\033[0;31m'
BLUE = '\033[0;34m'
NC = '\033[0m'

def print_success(msg: str):
    if RICH_AVAILABLE:
        console.print(f"[green]✅[/green] {msg}")
    else:
        print(f"{GREEN}✅{NC} {msg}")

def print_warning(msg: str):
    if RICH_AVAILABLE:
        console.print(f"[yellow]⚠️[/yellow] {msg}")
    else:
        print(f"{YELLOW}⚠️{NC} {msg}")

def print_error(msg: str):
    if RICH_AVAILABLE:
        console.print(f"[red]❌[/red] {msg}")
    else:
        print(f"{RED}❌{NC} {msg}")

def print_info(msg: str):
    if RICH_AVAILABLE:
        console.print(f"[blue]ℹ️[/blue] {msg}")
    else:
        print(f"{BLUE}ℹ️{NC} {msg}")

class ProgressTracker:
    def __init__(self):
        self.status_file = Path("progress/status.json")
        self.backlog_file = Path("progress/backlog.json")
        self.status_data = self.load_status()
        self.backlog_data = self.load_backlog()
        
    def load_status(self) -> Dict:
        """Load current status from file."""
        if self.status_file.exists():
            with open(self.status_file) as f:
                return json.load(f)
        else:
            # Create default status for Chrome extension
            return {
                "project_started": datetime.now().strftime("%Y-%m-%d"),
                "last_updated": datetime.now().isoformat(),
                "overall_progress": 0,
                "phase": "development",
                "components": {},
                "milestones": []
            }
    
    def load_backlog(self) -> List:
        """Load backlog from file."""
        if self.backlog_file.exists():
            with open(self.backlog_file) as f:
                return json.load(f)
        return []
    
    def save_status(self):
        """Save status to file."""
        self.status_data["last_updated"] = datetime.now().isoformat()
        self.status_file.parent.mkdir(exist_ok=True, parents=True)
        with open(self.status_file, 'w') as f:
            json.dump(self.status_data, f, indent=2)
    
    def save_backlog(self):
        """Save backlog to file."""
        self.backlog_file.parent.mkdir(exist_ok=True, parents=True)
        with open(self.backlog_file, 'w') as f:
            json.dump(self.backlog_data, f, indent=2)
    
    def update_component(self, component: str, status: str, notes: Optional[str] = None):
        """Update the status of a Chrome extension component."""
        valid_statuses = ["not-started", "in-progress", "implemented", "tested", "complete"]
        
        if status not in valid_statuses:
            print_error(f"Invalid status. Valid options: {', '.join(valid_statuses)}")
            return False
        
        # Initialize component if it doesn't exist
        if component not in self.status_data["components"]:
            self.status_data["components"][component] = {
                "status": "not-started",
                "progress_percentage": 0,
                "implementation_complete": False,
                "tested": False,
                "notes": "",
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat()
            }
        
        # Update component status
        comp = self.status_data["components"][component]
        old_status = comp["status"]
        comp["status"] = status
        comp["updated_at"] = datetime.now().isoformat()
        
        if notes:
            comp["notes"] = notes
        
        # Update progress percentage based on status
        progress_map = {
            "not-started": 0,
            "in-progress": 50,
            "implemented": 80,
            "tested": 90,
            "complete": 100
        }
        comp["progress_percentage"] = progress_map.get(status, 0)
        
        # Update boolean flags
        comp["implementation_complete"] = status in ["implemented", "tested", "complete"]
        comp["tested"] = status in ["tested", "complete"]
        
        # Calculate overall progress
        self.calculate_overall_progress()
        
        # Save changes
        self.save_status()
        
        print_success(f"Updated {component}: {old_status} → {status}")
        return True
    
    def calculate_overall_progress(self):
        """Calculate overall Chrome extension progress."""
        if not self.status_data["components"]:
            self.status_data["overall_progress"] = 0
            return
        
        # Define core components and their weights for Chrome extension
        component_weights = {
            "manifest": 10,
            "background": 30,
            "popup": 25,
            "storage": 15,
            "ui": 20
        }
        
        total_weight = 0
        weighted_progress = 0
        
        for comp_name, comp_data in self.status_data["components"].items():
            # Use default weight if component not in predefined weights
            weight = component_weights.get(comp_name, 10)
            total_weight += weight
            weighted_progress += comp_data["progress_percentage"] * weight
        
        if total_weight > 0:
            self.status_data["overall_progress"] = int(weighted_progress / total_weight)
        else:
            self.status_data["overall_progress"] = 0
        
        # Update phase based on overall progress
        if self.status_data["overall_progress"] < 50:
            self.status_data["phase"] = "development"
        elif self.status_data["overall_progress"] < 90:
            self.status_data["phase"] = "testing"
        else:
            self.status_data["phase"] = "ready"
    
    def add_to_backlog(self, item: str, priority: str = "medium"):
        """Add an item to the Chrome extension backlog."""
        backlog_item = {
            "id": len(self.backlog_data) + 1,
            "description": item,
            "priority": priority,
            "created_at": datetime.now().isoformat(),
            "status": "pending"
        }
        self.backlog_data.append(backlog_item)
        self.save_backlog()
        print_success(f"Added to backlog: {item}")
    
    def generate_report(self):
        """Generate a Chrome extension progress report."""
        print("\n" + "="*60)
        print("  CHROME EXTENSION PROGRESS REPORT")
        print("="*60)
        
        # Overall progress
        if RICH_AVAILABLE:
            console.print(f"\n[bold]Extension:[/bold] Tab Limiter")
            console.print(f"[bold]Overall Progress:[/bold] {self.status_data['overall_progress']}%")
            console.print(f"[bold]Current Phase:[/bold] {self.status_data['phase'].upper()}")
            console.print(f"[bold]Last Updated:[/bold] {self.status_data['last_updated']}")
        else:
            print(f"\nExtension: Tab Limiter")
            print(f"Overall Progress: {self.status_data['overall_progress']}%")
            print(f"Current Phase: {self.status_data['phase'].upper()}")
            print(f"Last Updated: {self.status_data['last_updated']}")
        
        # Component status table
        if self.status_data["components"]:
            if RICH_AVAILABLE:
                table = Table(title="\nComponent Status", show_header=True)
                table.add_column("Component", style="cyan")
                table.add_column("Status", style="white")
                table.add_column("Progress", style="white")
                table.add_column("Implemented", style="white")
                table.add_column("Tested", style="white")
                
                for name, comp in self.status_data["components"].items():
                    table.add_row(
                        name,
                        comp["status"],
                        f"{comp['progress_percentage']}%",
                        "✔" if comp["implementation_complete"] else "✗",
                        "✔" if comp["tested"] else "✗"
                    )
                console.print(table)
            else:
                print("\nComponent Status:")
                print("-" * 60)
                for name, comp in self.status_data["components"].items():
                    impl = "✔" if comp["implementation_complete"] else "✗"
                    test = "✔" if comp["tested"] else "✗"
                    
                    print(f"  {name}:")
                    print(f"    Status: {comp['status']} ({comp['progress_percentage']}%)")
                    print(f"    Implemented: {impl} | Tested: {test}")
                    if comp.get("notes"):
                        print(f"    Notes: {comp['notes']}")
        else:
            print_warning("No components tracked yet")
        
        # Extension-specific checklist
        print("\n📋 Extension Requirements Checklist:")
        checklist = [
            ("Manifest V3 configured", "manifest" in self.status_data["components"]),
            ("Background service worker", "background" in self.status_data["components"]),
            ("Popup UI implemented", "popup" in self.status_data["components"]),
            ("Tab limit enforcement", self.status_data["overall_progress"] > 50),
            ("Chrome storage integration", "storage" in self.status_data["components"] or 
             any("storage" in comp.get("notes", "").lower() for comp in self.status_data["components"].values())),
            ("Extension tested in Chrome", self.status_data["phase"] in ["testing", "ready"])
        ]
        
        for requirement, completed in checklist:
            status = "✔" if completed else "○"
            print(f"  {status} {requirement}")
        
        # Backlog summary
        if self.backlog_data:
            pending_items = [item for item in self.backlog_data if item["status"] == "pending"]
            if pending_items:
                print(f"\n📋 Backlog Items: {len(pending_items)} pending")
                for item in pending_items[:3]:  # Show first 3
                    print(f"  - [{item['priority']}] {item['description']}")
                if len(pending_items) > 3:
                    print(f"  ... and {len(pending_items) - 3} more")
        
        # Milestones
        if self.status_data.get("milestones"):
            print("\n🎯 Milestones:")
            for milestone in self.status_data["milestones"]:
                status_icon = "✔" if milestone.get("completed") else "○"
                print(f"  {status_icon} {milestone['name']} - {milestone.get('target_date', 'TBD')}")
        
        # Next steps based on progress
        print("\n🚀 Next Steps:")
        if self.status_data["overall_progress"] < 20:
            print("  1. Create manifest.json with required permissions")
            print("  2. Implement background service worker")
            print("  3. Set up basic popup UI")
        elif self.status_data["overall_progress"] < 60:
            print("  1. Complete tab limit enforcement logic")
            print("  2. Implement tab selection prompt")
            print("  3. Add Chrome storage for settings")
        elif self.status_data["overall_progress"] < 90:
            print("  1. Test extension in Chrome")
            print("  2. Fix any bugs or issues")
            print("  3. Polish UI and user experience")
        else:
            print("  1. Package extension for distribution")
            print("  2. Create documentation")
            print("  3. Consider publishing to Chrome Web Store")
        
        print("\n" + "="*60 + "\n")
    
    def list_components(self):
        """List all Chrome extension components and their status."""
        if not self.status_data["components"]:
            print_warning("No components tracked yet")
            print("\nAvailable components to track:")
            print("  - manifest: Extension manifest configuration")
            print("  - background: Background service worker")
            print("  - popup: Popup UI and logic")
            print("  - content: Content scripts")
            print("  - storage: Chrome storage integration")
            print("  - ui: User interface components")
            return
        
        print("\n📦 Tracked Components:")
        for name, comp in self.status_data["components"].items():
            status_color = GREEN if comp["progress_percentage"] == 100 else YELLOW
            if not RICH_AVAILABLE:
                print(f"  {name}: {comp['status']} ({comp['progress_percentage']}%)")
            else:
                color = "green" if comp["progress_percentage"] == 100 else "yellow"
                console.print(f"  {name}: [{color}]{comp['status']}[/{color}] ({comp['progress_percentage']}%)")
    
    def add_milestone(self, name: str, target_date: str):
        """Add a Chrome extension development milestone."""
        if "milestones" not in self.status_data:
            self.status_data["milestones"] = []
        
        milestone = {
            "name": name,
            "target_date": target_date,
            "created_at": datetime.now().isoformat(),
            "completed": False
        }
        
        self.status_data["milestones"].append(milestone)
        self.save_status()
        print_success(f"Added milestone: {name} (target: {target_date})")

def main():
    parser = argparse.ArgumentParser(description="Update Chrome extension progress tracking")
    parser.add_argument("--component", "-c", help="Component name to update")
    parser.add_argument("--status", "-s", help="New status for the component")
    parser.add_argument("--notes", "-n", help="Optional notes for the update")
    parser.add_argument("--report", "-r", action="store_true", help="Generate progress report")
    parser.add_argument("--list", "-l", action="store_true", help="List all components")
    parser.add_argument("--backlog", "-b", help="Add item to backlog")
    parser.add_argument("--priority", "-p", default="medium", help="Priority for backlog item")
    parser.add_argument("--milestone", "-m", help="Add a milestone")
    parser.add_argument("--target-date", "-t", help="Target date for milestone")
    
    args = parser.parse_args()
    
    tracker = ProgressTracker()
    
    # Handle different commands
    if args.report:
        tracker.generate_report()
    elif args.list:
        tracker.list_components()
    elif args.component and args.status:
        tracker.update_component(args.component, args.status, args.notes)
    elif args.backlog:
        tracker.add_to_backlog(args.backlog, args.priority)
    elif args.milestone:
        target = args.target_date or "TBD"
        tracker.add_milestone(args.milestone, target)
    else:
        # Default to showing report
        tracker.generate_report()

if __name__ == "__main__":
    main()