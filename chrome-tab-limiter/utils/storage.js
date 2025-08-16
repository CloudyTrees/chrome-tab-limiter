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

export {
    getTabLimit,
    setTabLimit,
    getDefaultLimit,
    setDefaultLimit,
    removeWindowData,
    DEFAULT_TAB_LIMIT
};