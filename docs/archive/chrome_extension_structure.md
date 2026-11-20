# Chrome Extension Project Structure: "Limit and Choose Tabs"

## Project Root Directory
```
limit-and-choose-tabs/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── background/
│   └── background.js
├── content/
│   └── content.js
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## File Purposes Explained

### 1. `manifest.json` (Required - Extension Configuration)
**Purpose**: This is the heart of your extension. It tells Chrome what your extension does, what permissions it needs, and how it should behave.

**What it contains**:
- Extension metadata (name, version, description)
- Permissions your extension needs (like accessing tabs, storage)
- Entry points for different parts of your extension
- Icons and UI elements

### 2. `popup/` Directory (User Interface)
**Purpose**: Contains the popup that appears when users click your extension icon in the toolbar.

#### `popup.html`
- **Purpose**: The HTML structure of your extension's popup interface
- **Contains**: Buttons, forms, lists, or any UI elements users interact with

#### `popup.css` 
- **Purpose**: Styles your popup to make it look good
- **Contains**: Colors, fonts, layouts, animations

#### `popup.js`
- **Purpose**: Makes your popup interactive
- **Contains**: Event handlers for button clicks, communication with background scripts, DOM manipulation

### 3. `background/background.js` (Extension Brain)
**Purpose**: Runs continuously in the background while Chrome is open. This is where the main logic lives.

**What it does**:
- Listens for events (tab creation, closing, switching)
- Manages extension state and data
- Handles complex operations that don't need user interaction
- Communicates with popup and content scripts

### 4. `content/content.js` (Optional - Page Interaction)
**Purpose**: Runs on web pages to interact with their content. You might not need this for a tab management extension.

**What it does**:
- Can read and modify webpage content
- Inject custom behavior into existing pages
- Communicate with background script about page-specific events

### 5. `icons/` Directory (Visual Identity)
**Purpose**: Different sized icons for different contexts in Chrome.

- **icon16.png**: Toolbar icon (when extension is active)
- **icon32.png**: Extension management page
- **icon48.png**: Extension management page
- **icon128.png**: Chrome Web Store listing

### 6. `README.md` (Documentation)
**Purpose**: Explains what your extension does, how to install it, and how to use it.

## Development Workflow

1. **Start with `manifest.json`** - Define what your extension can do
2. **Create basic popup files** - Build the user interface
3. **Implement background script** - Add the core functionality
4. **Test locally** - Load unpacked extension in Chrome
5. **Iterate and improve** - Add features, fix bugs, improve UX

## Key Concepts for Beginners

### Permissions
Your extension needs to declare what Chrome APIs it wants to use. Common ones:
- `"tabs"` - Read and manipulate browser tabs
- `"storage"` - Save settings and data
- `"activeTab"` - Access the currently active tab

### Communication
Different parts of your extension communicate via message passing:
- Popup ↔ Background script
- Content script ↔ Background script
- Background script can access all Chrome APIs

### Event-Driven Architecture
Chrome extensions are event-driven. Your background script listens for events like:
- Tab created/closed/updated
- Extension icon clicked
- Browser startup/shutdown

## Next Steps
1. Create the project folder structure
2. Write a basic `manifest.json`
3. Create simple popup files
4. Test the extension loads in Chrome
5. Add functionality incrementally