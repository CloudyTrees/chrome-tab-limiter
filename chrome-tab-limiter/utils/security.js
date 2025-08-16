// Security utilities for Tab Limiter extension

// Safe error handling to prevent information leakage
export class SecureErrorHandler {
    static handleError(error, context = '', userMessage = 'An error occurred') {
        // Log full error details for debugging (only in debug mode)
        if (DEBUG_MODE) {
            console.error(`[${context}]`, error);
        } else {
            // In production, log minimal information
            console.error(`Error in ${context}: ${error.name || 'Unknown error'}`);
        }
        
        // Return sanitized error for user display
        return {
            message: userMessage,
            safe: true
        };
    }
    
    static async safeAsyncOperation(operation, context, fallback = null) {
        try {
            return await operation();
        } catch (error) {
            this.handleError(error, context);
            return fallback;
        }
    }
    
    static sanitizeErrorMessage(error) {
        // Only return safe error messages to prevent information disclosure
        const safeErrors = {
            'TypeError': 'Invalid input provided',
            'ReferenceError': 'Resource not found',
            'NetworkError': 'Network connection failed',
            'SecurityError': 'Permission denied'
        };
        
        return safeErrors[error.name] || 'An unexpected error occurred';
    }
}

// Input validation utilities
export class InputValidator {
    static isValidTabId(tabId) {
        return Number.isSafeInteger(tabId) && tabId > 0;
    }
    
    static isValidWindowId(windowId) {
        return Number.isSafeInteger(windowId) && windowId > 0;
    }
    
    static isValidLimit(limit) {
        return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100;
    }
    
    static sanitizeMessage(message) {
        if (typeof message !== 'string') {
            return 'Invalid message';
        }
        
        // Remove potentially dangerous characters
        return message
            .replace(/[<>]/g, '') // Remove potential HTML
            .replace(/javascript:/gi, '') // Remove JS protocols
            .replace(/on\w+=/gi, '') // Remove event handlers
            .slice(0, 200); // Limit length
    }
}

// Constants for security
export const SECURITY_CONSTANTS = {
    MAX_URL_LENGTH: 2048,
    MAX_TITLE_LENGTH: 100,
    MAX_ERROR_MESSAGE_LENGTH: 200,
    ALLOWED_PROTOCOLS: ['http:', 'https:', 'chrome:', 'chrome-extension:', 'file:', 'ftp:'],
    RATE_LIMITS: {
        TAB_CREATION: { maxOps: 10, windowMs: 1000 },
        SELECTOR_OPEN: { maxOps: 3, windowMs: 5000 },
        STORAGE_WRITE: { maxOps: 20, windowMs: 1000 }
    }
};

// Global debug mode check (should be set in each file)
if (typeof DEBUG_MODE === 'undefined') {
    window.DEBUG_MODE = false;
}