// Chrome storage API wrapper for tab limiter extension

const DEFAULT_TAB_LIMIT = 10;

async function getTabLimit(windowId) {
    try {
        const key = `tabLimit_${windowId}`;
        const result = await chrome.storage.local.get([key, 'defaultTabLimit']);
        
        if (result[key] !== undefined) {
            return result[key];
        }
        
        return result.defaultTabLimit || DEFAULT_TAB_LIMIT;
    } catch (error) {
        console.error('Error getting tab limit');
        return DEFAULT_TAB_LIMIT;
    }
}

async function setTabLimit(windowId, limit) {
    try {
        const key = `tabLimit_${windowId}`;
        await chrome.storage.local.set({ [key]: limit });
        return true;
    } catch (error) {
        console.error('Error setting tab limit');
        return false;
    }
}

async function getDefaultLimit() {
    try {
        const result = await chrome.storage.local.get(['defaultTabLimit']);
        return result.defaultTabLimit || DEFAULT_TAB_LIMIT;
    } catch (error) {
        console.error('Error getting default limit');
        return DEFAULT_TAB_LIMIT;
    }
}

async function setDefaultLimit(limit) {
    try {
        await chrome.storage.local.set({ defaultTabLimit: limit });
        return true;
    } catch (error) {
        console.error('Error setting default limit');
        return false;
    }
}

async function removeWindowData(windowId) {
    try {
        const key = `tabLimit_${windowId}`;
        await chrome.storage.local.remove(key);
        return true;
    } catch (error) {
        console.error('Error removing window data');
        return false;
    }
}

// Tab Group support functions
async function getGroupLimit(windowId, groupId) {
    try {
        const key = groupId === -1 
            ? `groupLimit_${windowId}_ungrouped` 
            : `groupLimit_${windowId}_${groupId}`;
        const result = await chrome.storage.local.get([key, 'defaultTabLimit']);
        
        return result[key] || result.defaultTabLimit || DEFAULT_TAB_LIMIT;
    } catch (error) {
        console.error('Error getting group limit');
        return DEFAULT_TAB_LIMIT;
    }
}

async function setGroupLimit(windowId, groupId, limit) {
    try {
        const key = groupId === -1 
            ? `groupLimit_${windowId}_ungrouped` 
            : `groupLimit_${windowId}_${groupId}`;
        await chrome.storage.local.set({ [key]: limit });
        return true;
    } catch (error) {
        console.error('Error setting group limit');
        return false;
    }
}

async function getGroupLimits(windowId) {
    try {
        const result = await chrome.storage.local.get();
        const groupLimits = {};
        
        // Find all group limits for this window
        const prefix = `groupLimit_${windowId}_`;
        for (const [key, value] of Object.entries(result)) {
            if (key.startsWith(prefix)) {
                const groupPart = key.substring(prefix.length);
                const groupId = groupPart === 'ungrouped' ? -1 : parseInt(groupPart);
                groupLimits[groupId] = value;
            }
        }
        
        return groupLimits;
    } catch (error) {
        console.error('Error getting group limits');
        return {};
    }
}

async function removeGroupData(windowId, groupId) {
    try {
        const key = groupId === -1 
            ? `groupLimit_${windowId}_ungrouped` 
            : `groupLimit_${windowId}_${groupId}`;
        await chrome.storage.local.remove(key);
        return true;
    } catch (error) {
        console.error('Error removing group data');
        return false;
    }
}

async function removeAllGroupData(windowId) {
    try {
        const result = await chrome.storage.local.get();
        const keysToRemove = [];
        
        // Find all group limits for this window
        const prefix = `groupLimit_${windowId}_`;
        for (const key of Object.keys(result)) {
            if (key.startsWith(prefix)) {
                keysToRemove.push(key);
            }
        }
        
        if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
        }
        return true;
    } catch (error) {
        console.error('Error removing all group data');
        return false;
    }
}

export {
    getTabLimit,
    setTabLimit,
    getDefaultLimit,
    setDefaultLimit,
    removeWindowData,
    getGroupLimit,
    setGroupLimit,
    getGroupLimits,
    removeGroupData,
    removeAllGroupData,
    DEFAULT_TAB_LIMIT
};