// Export/Import utility functions for Tab Limiter extension

// Debug logging configuration
const EXPORT_DEBUG_MODE = false;

function debugLog(...args) {
    if (EXPORT_DEBUG_MODE) {
        console.log('[Tab Limiter Export/Import]', ...args);
    }
}

// Privacy-focused error handling
function safeErrorLog(message, error) {
    if (EXPORT_DEBUG_MODE) {
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
        
        // Organize data by type with privacy protection
        const exportData = {
            version: '1.0.0',
            exportDate: 'Privacy Protected', // Remove date/time entirely for privacy
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
        
        // Create anonymization maps for privacy protection
        const windowIdMap = new Map();
        const groupIdMap = new Map();
        
        // Process all storage keys with ID anonymization
        for (const [key, value] of Object.entries(allData)) {
            if (key.startsWith('tabLimit_')) {
                // Window-specific tab limits - anonymize window ID
                const realWindowId = key.replace('tabLimit_', '');
                
                // Create anonymized ID
                if (!windowIdMap.has(realWindowId)) {
                    windowIdMap.set(realWindowId, `window_${windowCount + 1}`);
                }
                const anonymizedWindowId = windowIdMap.get(realWindowId);
                
                exportData.settings.windowLimits[anonymizedWindowId] = value;
                windowCount++;
                customLimitCount++;
            } else if (key.startsWith('groupLimit_')) {
                // Group-specific tab limits - anonymize group ID
                const parts = key.split('_');
                if (parts.length >= 3) {
                    const realWindowId = parts[1];
                    const realGroupId = parts.slice(2).join('_');
                    
                    // Create anonymized IDs
                    if (!windowIdMap.has(realWindowId)) {
                        windowIdMap.set(realWindowId, `window_${windowIdMap.size + 1}`);
                    }
                    
                    if (!groupIdMap.has(realGroupId)) {
                        groupIdMap.set(realGroupId, `group_${groupIdMap.size + 1}`);
                    }
                    
                    const anonymizedKey = `groupLimit_${windowIdMap.get(realWindowId)}_${groupIdMap.get(realGroupId)}`;
                    exportData.settings.groupLimits[anonymizedKey] = value;
                    groupCount++;
                    customLimitCount++;
                }
            }
        }
        
        // Update metadata
        exportData.metadata.totalWindows = windowCount;
        exportData.metadata.totalGroups = groupCount;
        exportData.metadata.totalCustomLimits = customLimitCount;
        
        debugLog('Export completed successfully');
        
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
        
        // When merging (or not replacing), existing keys are kept because
        // chrome.storage.local.set() only writes the keys it is given;
        // imported values overwrite matching existing keys.

        // Privacy Notice: Window and group-specific limits are not imported
        // to protect user privacy. Only the default limit is restored.
        // Users can manually reconfigure window/group-specific limits if needed.
        
        // Skip importing window-specific limits for privacy protection
        let skippedWindowLimits = 0;
        let skippedGroupLimits = 0;
        
        if (importData.settings.windowLimits) {
            skippedWindowLimits = Object.keys(importData.settings.windowLimits).length;
        }
        
        if (importData.settings.groupLimits) {
            skippedGroupLimits = Object.keys(importData.settings.groupLimits).length;
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
                windowLimits: 0, // Privacy protected - not imported
                groupLimits: 0   // Privacy protected - not imported
            },
            privacyNotice: {
                skippedWindowLimits,
                skippedGroupLimits,
                message: 'Window and group-specific limits were not imported to protect your privacy. Only the default limit was restored.'
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
                if (!validateWindowId(windowId) || !validateLimit(limit)) {
                    return { valid: false, error: `Invalid window limit configuration` };
                }
            }
        }
        
        // Validate group limits if present
        if (data.settings.groupLimits) {
            if (typeof data.settings.groupLimits !== 'object') {
                return { valid: false, error: 'Invalid group limits format' };
            }
            
            for (const [groupKey, limit] of Object.entries(data.settings.groupLimits)) {
                if (!validateGroupKey(groupKey) || !validateLimit(limit)) {
                    return { valid: false, error: `Invalid group limit configuration` };
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

// Validate window ID format to prevent injection
function validateWindowId(windowId) {
    // Window IDs should be numeric strings or safe identifiers
    if (typeof windowId !== 'string') return false;
    
    // Prevent prototype pollution
    if (windowId === '__proto__' || windowId === 'constructor' || windowId === 'prototype') {
        return false;
    }
    
    // Allow only alphanumeric characters, dashes, and underscores
    const validPattern = /^[a-zA-Z0-9_-]+$/;
    return validPattern.test(windowId) && windowId.length <= 50;
}

// Validate group key format to prevent injection
function validateGroupKey(groupKey) {
    if (typeof groupKey !== 'string') return false;
    
    // Prevent prototype pollution
    if (groupKey === '__proto__' || groupKey === 'constructor' || groupKey === 'prototype') {
        return false;
    }
    
    // Must start with 'groupLimit_' and contain valid characters
    if (!groupKey.startsWith('groupLimit_')) return false;
    
    const validPattern = /^groupLimit_[a-zA-Z0-9_-]+$/;
    return validPattern.test(groupKey) && groupKey.length <= 100;
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
        
        // Clean up immediately after click
        URL.revokeObjectURL(url);
        
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
                const textContent = event.target.result;
                
                // Additional security: limit text content size
                if (textContent.length > 2 * 1024 * 1024) { // 2MB text limit
                    reject(new Error('File content too large'));
                    return;
                }
                
                // Parse JSON with potential prototype pollution protection
                const jsonData = JSON.parse(textContent);
                
                // Basic object structure validation
                if (jsonData && typeof jsonData === 'object' && !Array.isArray(jsonData)) {
                    resolve(jsonData);
                } else {
                    reject(new Error('Invalid file format - must be a JSON object'));
                }
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