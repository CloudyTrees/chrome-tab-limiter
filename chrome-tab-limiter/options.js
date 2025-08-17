// Options page script for Tab Limiter extension

// Debug logging configuration
const OPTIONS_DEBUG_MODE = false;

function debugLog(...args) {
    if (OPTIONS_DEBUG_MODE) {
        console.log('[Tab Limiter Options]', ...args);
    }
}

// Privacy-focused error handling
function safeErrorLog(message, error) {
    if (OPTIONS_DEBUG_MODE) {
        console.error(message, error?.name || 'Unknown error');
    } else {
        console.error(message);
    }
}

// DOM elements
let exportButton, importButton, resetButton;
let confirmImportButton, cancelImportButton;
let confirmResetButton, cancelResetButton;
let importFile, backToPopupButton;
let exportStatus, importStatus, resetStatus;
let settingsPreview, importPreview, importPreviewSection;

// State management
let pendingImportData = null;
let isProcessing = false;

// Initialize options page when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    debugLog('Options page initializing...');
    
    // Get DOM elements
    initializeElements();
    
    // Set up event listeners
    setupEventListeners();
    
    // Load initial data
    await loadCurrentSettings();
    
    debugLog('Options page initialized');
});

// Initialize DOM elements
function initializeElements() {
    // Action buttons
    exportButton = document.getElementById('exportButton');
    importButton = document.getElementById('importButton');
    resetButton = document.getElementById('resetButton');
    
    // Confirmation buttons
    confirmImportButton = document.getElementById('confirmImportButton');
    cancelImportButton = document.getElementById('cancelImportButton');
    confirmResetButton = document.getElementById('confirmResetButton');
    cancelResetButton = document.getElementById('cancelResetButton');
    
    // File input and navigation
    importFile = document.getElementById('importFile');
    backToPopupButton = document.getElementById('backToPopup');
    
    // Status messages
    exportStatus = document.getElementById('exportStatus');
    importStatus = document.getElementById('importStatus');
    resetStatus = document.getElementById('resetStatus');
    
    // Preview sections
    settingsPreview = document.getElementById('settingsPreview');
    importPreview = document.getElementById('importPreview');
    importPreviewSection = document.getElementById('importPreviewSection');
}

// Set up event listeners
function setupEventListeners() {
    // Export functionality
    exportButton.addEventListener('click', handleExport);
    
    // Import functionality
    importButton.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', handleFileSelect);
    confirmImportButton.addEventListener('click', handleConfirmImport);
    cancelImportButton.addEventListener('click', handleCancelImport);
    
    // Reset functionality
    resetButton.addEventListener('click', handleResetRequest);
    confirmResetButton.addEventListener('click', handleConfirmReset);
    cancelResetButton.addEventListener('click', handleCancelReset);
    
    // Navigation
    backToPopupButton.addEventListener('click', () => {
        chrome.tabs.getCurrent(tab => {
            chrome.tabs.remove(tab.id);
        });
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboardShortcuts);
}

// Load and display current settings
async function loadCurrentSettings() {
    try {
        showStatusMessage(settingsPreview, 'Loading current settings...', 'info');
        
        const summary = await TabLimiterExportImport.getCurrentSettingsSummary();
        
        // Create elements safely to prevent XSS
        settingsPreview.innerHTML = '';
        
        const items = [
            { label: 'Default Tab Limit', value: summary.defaultLimit },
            { label: 'Window-specific Limits', value: summary.windowLimits },
            { label: 'Group-specific Limits', value: summary.groupLimits },
            { label: 'Total Custom Settings', value: summary.totalCustomSettings, highlight: true }
        ];
        
        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'setting-item';
            
            const label = document.createElement('label');
            label.textContent = item.label + ':';
            
            const span = document.createElement('span');
            span.className = item.highlight ? 'value highlight' : 'value';
            span.textContent = item.value;
            
            div.appendChild(label);
            div.appendChild(span);
            settingsPreview.appendChild(div);
        });
        
    } catch (error) {
        safeErrorLog('Error loading current settings', error);
        showStatusMessage(settingsPreview, 'Error loading settings', 'error');
    }
}

// Handle export button click
async function handleExport() {
    if (isProcessing) return;
    
    try {
        isProcessing = true;
        exportButton.disabled = true;
        showStatusMessage(exportStatus, 'Exporting settings...', 'info');
        
        debugLog('Starting export process');
        
        // Export settings
        const exportData = await TabLimiterExportImport.exportSettings();
        
        // Generate filename and download
        const filename = TabLimiterExportImport.generateExportFilename();
        const success = TabLimiterExportImport.downloadAsJSON(exportData, filename);
        
        if (success) {
            showStatusMessage(exportStatus, `Settings exported to ${filename}`, 'success');
            debugLog('Export completed successfully');
        } else {
            throw new Error('Failed to download file');
        }
        
    } catch (error) {
        safeErrorLog('Error during export', error);
        showStatusMessage(exportStatus, 'Export failed: ' + error.message, 'error');
    } finally {
        isProcessing = false;
        exportButton.disabled = false;
        setTimeout(() => clearStatusMessage(exportStatus), 5000);
    }
}

// Handle file selection for import
async function handleFileSelect(event) {
    const file = event.target.files[0];
    
    if (!file) {
        handleCancelImport();
        return;
    }
    
    try {
        isProcessing = true;
        showStatusMessage(importStatus, 'Reading file...', 'info');
        
        // Read and parse JSON file
        const importData = await TabLimiterExportImport.readJSONFile(file);
        
        // Validate import data
        const validation = TabLimiterExportImport.validateImportData(importData);
        if (!validation.valid) {
            throw new Error(validation.error);
        }
        
        // Store for later confirmation
        pendingImportData = importData;
        
        // Show preview
        displayImportPreview(importData);
        
        // Show confirmation buttons
        showImportConfirmation();
        
        showStatusMessage(importStatus, 'File loaded successfully. Review and confirm import.', 'info');
        
    } catch (error) {
        safeErrorLog('Error reading import file', error);
        showStatusMessage(importStatus, 'Import failed: ' + error.message, 'error');
        handleCancelImport();
    } finally {
        isProcessing = false;
        // Clear file input
        importFile.value = '';
    }
}

// Display import preview
function displayImportPreview(importData) {
    try {
        const settings = importData.settings || {};
        const metadata = importData.metadata || {};
        
        // Create preview elements safely to prevent XSS
        importPreview.innerHTML = '';
        
        // Create header
        const headerDiv = document.createElement('div');
        headerDiv.className = 'preview-header';
        
        const h4 = document.createElement('h4');
        h4.textContent = 'Import Preview';
        headerDiv.appendChild(h4);
        
        const metaDiv = document.createElement('div');
        metaDiv.className = 'import-meta';
        
        const versionSpan = document.createElement('span');
        versionSpan.textContent = `Version: ${importData.version || 'Unknown'}`;
        metaDiv.appendChild(versionSpan);
        
        if (importData.exportDate) {
            const dateSpan = document.createElement('span');
            dateSpan.textContent = `Exported: ${new Date(importData.exportDate).toLocaleDateString()}`;
            metaDiv.appendChild(dateSpan);
        }
        
        headerDiv.appendChild(metaDiv);
        importPreview.appendChild(headerDiv);
        
        // Create content
        const contentDiv = document.createElement('div');
        contentDiv.className = 'preview-content';
        
        const items = [
            { label: 'Default Tab Limit', value: settings.defaultTabLimit || 'Not set' },
            { label: 'Window Limits', value: Object.keys(settings.windowLimits || {}).length },
            { label: 'Group Limits', value: Object.keys(settings.groupLimits || {}).length },
            { label: 'Total Settings', value: metadata.totalCustomLimits || 'Unknown', highlight: true }
        ];
        
        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'setting-item';
            
            const label = document.createElement('label');
            label.textContent = item.label + ':';
            
            const span = document.createElement('span');
            span.className = item.highlight ? 'value highlight' : 'value';
            span.textContent = item.value;
            
            div.appendChild(label);
            div.appendChild(span);
            contentDiv.appendChild(div);
        });
        
        importPreview.appendChild(contentDiv);
        
        // Create warning
        const warningDiv = document.createElement('div');
        warningDiv.className = 'import-warning';
        warningDiv.textContent = '⚠️ This will replace all your current settings. Make sure to export your current settings first if you want to keep them.';
        importPreview.appendChild(warningDiv);
        importPreviewSection.style.display = 'block';
        
    } catch (error) {
        safeErrorLog('Error displaying import preview', error);
        // Create error message safely\n        importPreview.innerHTML = '';\n        const errorDiv = document.createElement('div');\n        errorDiv.className = 'error';\n        errorDiv.textContent = 'Error displaying preview';\n        importPreview.appendChild(errorDiv);
    }
}

// Show import confirmation buttons
function showImportConfirmation() {
    importButton.style.display = 'none';
    confirmImportButton.style.display = 'inline-block';
    cancelImportButton.style.display = 'inline-block';
}

// Hide import confirmation buttons
function hideImportConfirmation() {
    importButton.style.display = 'inline-block';
    confirmImportButton.style.display = 'none';
    cancelImportButton.style.display = 'none';
}

// Handle confirm import
async function handleConfirmImport() {
    if (!pendingImportData || isProcessing) return;
    
    try {
        isProcessing = true;
        confirmImportButton.disabled = true;
        showStatusMessage(importStatus, 'Importing settings...', 'info');
        
        debugLog('Starting import process');
        
        // Import the settings
        const result = await TabLimiterExportImport.importSettings(pendingImportData);
        
        if (result.success) {
            let message = 'Settings imported successfully!';
            
            // Add privacy notice if applicable
            if (result.privacyNotice && (result.privacyNotice.skippedWindowLimits > 0 || result.privacyNotice.skippedGroupLimits > 0)) {
                message += ` Note: ${result.privacyNotice.skippedWindowLimits + result.privacyNotice.skippedGroupLimits} window/group-specific limits were skipped for privacy protection.`;
            }
            
            showStatusMessage(importStatus, message, 'success');
            
            // Refresh current settings display
            await loadCurrentSettings();
            
            // Hide confirmation and preview
            handleCancelImport();
            
            debugLog('Import completed successfully');
        } else {
            throw new Error('Import process failed');
        }
        
    } catch (error) {
        safeErrorLog('Error during import', error);
        showStatusMessage(importStatus, 'Import failed: ' + error.message, 'error');
    } finally {
        isProcessing = false;
        confirmImportButton.disabled = false;
        setTimeout(() => clearStatusMessage(importStatus), 5000);
    }
}

// Handle cancel import
function handleCancelImport() {
    pendingImportData = null;
    hideImportConfirmation();
    importPreviewSection.style.display = 'none';
    clearStatusMessage(importStatus);
}

// Handle reset request
function handleResetRequest() {
    if (isProcessing) return;
    
    resetButton.style.display = 'none';
    confirmResetButton.style.display = 'inline-block';
    cancelResetButton.style.display = 'inline-block';
    
    showStatusMessage(resetStatus, 'Are you sure? This will delete ALL settings permanently.', 'warning');
}

// Handle confirm reset
async function handleConfirmReset() {
    if (isProcessing) return;
    
    try {
        isProcessing = true;
        confirmResetButton.disabled = true;
        showStatusMessage(resetStatus, 'Resetting all settings...', 'info');
        
        debugLog('Starting reset process');
        
        // Reset all settings
        await TabLimiterExportImport.resetAllSettings();
        
        showStatusMessage(resetStatus, 'All settings have been reset to defaults.', 'success');
        
        // Refresh current settings display
        await loadCurrentSettings();
        
        // Hide confirmation buttons
        handleCancelReset();
        
        debugLog('Reset completed successfully');
        
    } catch (error) {
        safeErrorLog('Error during reset', error);
        showStatusMessage(resetStatus, 'Reset failed: ' + error.message, 'error');
    } finally {
        isProcessing = false;
        confirmResetButton.disabled = false;
        setTimeout(() => clearStatusMessage(resetStatus), 5000);
    }
}

// Handle cancel reset
function handleCancelReset() {
    resetButton.style.display = 'inline-block';
    confirmResetButton.style.display = 'none';
    cancelResetButton.style.display = 'none';
    clearStatusMessage(resetStatus);
}

// Handle keyboard shortcuts
function handleKeyboardShortcuts(event) {
    // Escape key cancels any pending operations
    if (event.key === 'Escape') {
        if (pendingImportData) {
            handleCancelImport();
        } else if (confirmResetButton.style.display !== 'none') {
            handleCancelReset();
        }
    }
    
    // Ctrl/Cmd + E for export
    if ((event.ctrlKey || event.metaKey) && event.key === 'e') {
        event.preventDefault();
        if (!isProcessing) {
            handleExport();
        }
    }
    
    // Ctrl/Cmd + I for import
    if ((event.ctrlKey || event.metaKey) && event.key === 'i') {
        event.preventDefault();
        if (!isProcessing && !pendingImportData) {
            importFile.click();
        }
    }
}

// Show status message with type styling
function showStatusMessage(element, message, type = 'info') {
    if (!element) return;
    
    element.textContent = message;
    element.className = `status-message ${type}`;
}

// Clear status message
function clearStatusMessage(element) {
    if (!element) return;
    
    element.textContent = '';
    element.className = 'status-message';
}