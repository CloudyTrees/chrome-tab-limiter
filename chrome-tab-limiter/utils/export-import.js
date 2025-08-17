// Export/Import utility functions for Tab Limiter extension

// Debug logging configuration
const DEBUG_MODE = false;

function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log('[Tab Limiter Export/Import]', ...args);
    }
}

// Privacy-focused error handling
function safeErrorLog(message, error) {
    if (DEBUG_MODE) {
        console.error(message, error?.name || 'Unknown error');
    } else {
        console.error(message);
    }
}

// Export all extension settings to a JSON object
async function exportSettings() {
    try {
        debugLog('Starting settings export...');
        
        // Get all storage data
        const allData = await chrome.storage.local.get(null);
        
        // Organize data by type
        const exportData = {
            version: '1.0.0',
            exportDate: new Date().toISOString(),
            settings: {
                defaultTabLimit: allData.defaultTabLimit || 10,
                windowLimits: {},
                groupLimits: {}
            },
            metadata: {
                totalWindows: 0,
                totalGroups: 0,
                totalCustomLimits: 0
            }
        };
        
        let windowCount = 0;
        let groupCount = 0;
        let customLimitCount = 0;
        
        // Process all storage keys
        for (const [key, value] of Object.entries(allData)) {
            if (key.startsWith('tabLimit_')) {
                // Window-specific tab limits
                const windowId = key.replace('tabLimit_', '');
                exportData.settings.windowLimits[windowId] = value;
                windowCount++;
                customLimitCount++;
            } else if (key.startsWith('groupLimit_')) {
                // Group-specific tab limits
                exportData.settings.groupLimits[key] = value;
                groupCount++;
                customLimitCount++;
            }
        }
        
        // Update metadata
        exportData.metadata.totalWindows = windowCount;
        exportData.metadata.totalGroups = groupCount;
        exportData.metadata.totalCustomLimits = customLimitCount;
        
        debugLog('Export completed successfully', {
            windows: windowCount,
            groups: groupCount,
            customLimits: customLimitCount
        });
        
        return exportData;
        
    } catch (error) {
        safeErrorLog('Error exporting settings', error);
        throw new Error('Failed to export settings');
    }
}

// Import settings from a JSON object
async function importSettings(importData, options = {}) {
    try {
        debugLog('Starting settings import...');
        
        // Validate import data structure
        const validation = validateImportData(importData);
        if (!validation.valid) {
            throw new Error(`Invalid import data: ${validation.error}`);
        }
        
        const { replaceExisting = true, mergeLimits = false } = options;
        
        // Prepare data for storage
        const storageData = {};
        
        // Default tab limit
        if (importData.settings.defaultTabLimit) {
            storageData.defaultTabLimit = importData.settings.defaultTabLimit;
        }
        
        // Handle existing data based on options
        if (!replaceExisting || mergeLimits) {
            const existingData = await chrome.storage.local.get(null);
            
            if (mergeLimits) {
                // Merge with existing data, imported data takes precedence
                Object.assign(storageData, existingData);
            }
        }
        
        // Window limits
        if (importData.settings.windowLimits) {
            for (const [windowId, limit] of Object.entries(importData.settings.windowLimits)) {
                if (validateLimit(limit)) {
                    storageData[`tabLimit_${windowId}`] = limit;
                }
            }
        }
        
        // Group limits
        if (importData.settings.groupLimits) {
            for (const [groupKey, limit] of Object.entries(importData.settings.groupLimits)) {
                if (groupKey.startsWith('groupLimit_') && validateLimit(limit)) {
                    storageData[groupKey] = limit;
                }
            }
        }
        
        // Clear existing data if replacing
        if (replaceExisting && !mergeLimits) {
            await chrome.storage.local.clear();
        }
        
        // Save imported data
        await chrome.storage.local.set(storageData);
        
        debugLog('Import completed successfully');
        
        return {
            success: true,
            imported: {
                defaultLimit: !!importData.settings.defaultTabLimit,
                windowLimits: Object.keys(importData.settings.windowLimits || {}).length,
                groupLimits: Object.keys(importData.settings.groupLimits || {}).length
            }
        };
        
    } catch (error) {
        safeErrorLog('Error importing settings', error);
        throw error;
    }
}

// Validate import data structure
function validateImportData(data) {
    try {
        // Check basic structure
        if (!data || typeof data !== 'object') {
            return { valid: false, error: 'Data must be an object' };
        }
        
        if (!data.settings || typeof data.settings !== 'object') {
            return { valid: false, error: 'Missing or invalid settings object' };
        }
        
        // Check version compatibility
        if (data.version && typeof data.version === 'string') {
            const version = data.version.split('.').map(Number);
            const currentVersion = [1, 0, 0]; // Current extension version
            
            if (version[0] > currentVersion[0]) {
                return { valid: false, error: 'Import data is from a newer version' };
            }
        }
        
        // Validate default limit if present
        if (data.settings.defaultTabLimit !== undefined) {
            if (!validateLimit(data.settings.defaultTabLimit)) {
                return { valid: false, error: 'Invalid default tab limit' };
            }
        }
        
        // Validate window limits if present
        if (data.settings.windowLimits) {
            if (typeof data.settings.windowLimits !== 'object') {
                return { valid: false, error: 'Invalid window limits format' };
            }
            
            for (const [windowId, limit] of Object.entries(data.settings.windowLimits)) {
                if (!validateLimit(limit)) {
                    return { valid: false, error: `Invalid limit for window ${windowId}` };
                }
            }
        }
        
        // Validate group limits if present
        if (data.settings.groupLimits) {
            if (typeof data.settings.groupLimits !== 'object') {
                return { valid: false, error: 'Invalid group limits format' };
            }
            
            for (const [groupKey, limit] of Object.entries(data.settings.groupLimits)) {
                if (!groupKey.startsWith('groupLimit_')) {
                    return { valid: false, error: `Invalid group limit key: ${groupKey}` };
                }
                
                if (!validateLimit(limit)) {
                    return { valid: false, error: `Invalid limit for group ${groupKey}` };
                }
            }
        }
        
        return { valid: true };
        
    } catch (error) {
        return { valid: false, error: 'Failed to validate import data' };
    }
}

// Validate a tab limit value
function validateLimit(limit) {
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100;
}

// Get current settings summary for display
async function getCurrentSettingsSummary() {
    try {
        const allData = await chrome.storage.local.get(null);
        
        const summary = {
            defaultLimit: allData.defaultTabLimit || 10,
            windowLimits: 0,
            groupLimits: 0,
            totalCustomSettings: 0
        };
        
        // Count different types of settings
        for (const key of Object.keys(allData)) {
            if (key.startsWith('tabLimit_')) {
                summary.windowLimits++;
                summary.totalCustomSettings++;
            } else if (key.startsWith('groupLimit_')) {
                summary.groupLimits++;
                summary.totalCustomSettings++;
            }
        }
        
        return summary;
        
    } catch (error) {
        safeErrorLog('Error getting settings summary', error);
        return {
            defaultLimit: 10,
            windowLimits: 0,
            groupLimits: 0,
            totalCustomSettings: 0
        };
    }
}

// Reset all extension settings
async function resetAllSettings() {
    try {
        debugLog('Resetting all settings...');
        
        // Clear all storage
        await chrome.storage.local.clear();
        
        // Set default values
        await chrome.storage.local.set({
            defaultTabLimit: 10
        });
        
        debugLog('All settings reset successfully');
        
        return { success: true };
        
    } catch (error) {
        safeErrorLog('Error resetting settings', error);
        throw new Error('Failed to reset settings');
    }
}

// Generate filename for export
function generateExportFilename() {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    return `tab-limiter-settings-${dateStr}-${timeStr}.json`;
}

// Download data as JSON file
function downloadAsJSON(data, filename) {
    try {
        const jsonString = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        // Clean up
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        
        return true;
        
    } catch (error) {
        safeErrorLog('Error downloading file', error);
        return false;
    }
}

// Read JSON file from file input
function readJSONFile(file) {
    return new Promise((resolve, reject) => {
        if (!file) {
            reject(new Error('No file provided'));
            return;
        }
        
        if (!file.name.toLowerCase().endsWith('.json')) {
            reject(new Error('Please select a JSON file'));
            return;
        }
        
        if (file.size > 1024 * 1024) { // 1MB limit
            reject(new Error('File is too large (max 1MB)'));
            return;
        }
        
        const reader = new FileReader();
        
        reader.onload = (event) => {
            try {
                const jsonData = JSON.parse(event.target.result);
                resolve(jsonData);
            } catch (error) {
                reject(new Error('Invalid JSON file'));
            }
        };
        
        reader.onerror = () => {
            reject(new Error('Failed to read file'));
        };
        
        reader.readAsText(file);
    });
}

// Enhanced HTML escaping for security
function escapeHtml(text) {
    if (typeof text !== 'string') {
        text = String(text);
    }
    
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Export all functions for use in options.js
window.TabLimiterExportImport = {
    exportSettings,
    importSettings,
    validateImportData,
    getCurrentSettingsSummary,
    resetAllSettings,
    generateExportFilename,
    downloadAsJSON,
    readJSONFile,
    escapeHtml
};