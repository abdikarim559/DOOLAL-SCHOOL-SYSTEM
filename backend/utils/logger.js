/**
 * Centralized Structured Logger for Doolaal School Management System
 * Production-ready, dependency-free logger supporting structured JSON logging,
 * correlation Request IDs, configurable log levels, and automatic secret redaction.
 */

'use strict';

const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

// Sensitive field keys to redact from logs
const SENSITIVE_KEYS = new Set([
    'password',
    'passwordhash',
    'otp',
    'token',
    'jwt',
    'authorization',
    'secret',
    'jwt_secret',
    'mongo_uri',
    'smtp_pass',
    'smtp_password',
    'cookie',
    'set-cookie'
]);

/**
 * Recursively sanitizes data to prevent leaking secrets, credentials, URIs, or tokens.
 */
function sanitize(data, depth = 0) {
    if (depth > 6) return '[MAX_DEPTH]';
    if (data === null || data === undefined) return data;

    if (typeof data === 'string') {
        // Redact MongoDB connection strings containing credentials
        let sanitized = data.replace(/mongodb(?:\+srv)?:\/\/[^@\s]+@[^\s/]+/gi, 'mongodb://[REDACTED_AUTH]@[HOST]');
        // Redact potential Bearer JWT tokens
        sanitized = sanitized.replace(/Bearer\s+eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/gi, 'Bearer [REDACTED_JWT]');
        // Redact standalone JWT tokens
        sanitized = sanitized.replace(/\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\b/g, '[REDACTED_JWT]');
        return sanitized;
    }

    if (typeof data === 'number' || typeof data === 'boolean') {
        return data;
    }

    if (data instanceof Error) {
        return {
            name: data.name,
            message: sanitize(data.message, depth + 1),
            ...(process.env.NODE_ENV !== 'production' && { stack: sanitize(data.stack, depth + 1) })
        };
    }

    if (Array.isArray(data)) {
        return data.map(item => sanitize(item, depth + 1));
    }

    if (typeof data === 'object') {
        const clean = {};
        for (const [key, val] of Object.entries(data)) {
            const lowerKey = key.toLowerCase();
            if (SENSITIVE_KEYS.has(lowerKey) || lowerKey.includes('password') || lowerKey.includes('secret') || lowerKey === 'otp') {
                clean[key] = '[REDACTED]';
            } else {
                clean[key] = sanitize(val, depth + 1);
            }
        }
        return clean;
    }

    return String(data);
}

class Logger {
    constructor(context = {}) {
        this.context = context;
    }

    /**
     * Determines whether the given level should be output based on LOG_LEVEL env var.
     */
    shouldLog(level) {
        const currentLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
        const configuredThreshold = LOG_LEVELS[currentLevel] !== undefined ? LOG_LEVELS[currentLevel] : LOG_LEVELS.info;
        const targetLevel = LOG_LEVELS[level] !== undefined ? LOG_LEVELS[level] : LOG_LEVELS.info;
        return targetLevel >= configuredThreshold;
    }

    /**
     * Formats and prints the log entry.
     */
    _output(levelUpper, levelLower, message, meta = {}) {
        if (!this.shouldLog(levelLower)) return;

        let cleanMeta = {};
        if (meta && typeof meta === 'object') {
            cleanMeta = sanitize(meta);
        } else if (meta !== undefined) {
            cleanMeta = { detail: sanitize(meta) };
        }

        const cleanContext = sanitize(this.context);
        const cleanMessage = typeof message === 'string' ? sanitize(message) : sanitize(String(message));

        // Extract requestId if supplied in meta, context, or top level
        const requestId = cleanMeta.requestId || cleanContext.requestId || undefined;
        if (cleanMeta.requestId) delete cleanMeta.requestId;

        const logEntry = {
            timestamp: new Date().toISOString(),
            level: levelUpper,
            message: cleanMessage,
            ...(requestId ? { requestId } : {}),
            ...cleanContext,
            ...cleanMeta
        };

        const serialized = JSON.stringify(logEntry);

        if (levelLower === 'error') {
            process.stderr.write(serialized + '\n');
        } else if (levelLower === 'warn') {
            process.stderr.write(serialized + '\n');
        } else {
            process.stdout.write(serialized + '\n');
        }

        return logEntry;
    }

    debug(message, meta) {
        return this._output('DEBUG', 'debug', message, meta);
    }

    info(message, meta) {
        return this._output('INFO', 'info', message, meta);
    }

    warn(message, meta) {
        return this._output('WARN', 'warn', message, meta);
    }

    error(message, meta) {
        return this._output('ERROR', 'error', message, meta);
    }

    /**
     * Returns a new Logger instance with bound contextual metadata (e.g., requestId).
     */
    child(context = {}) {
        return new Logger({ ...this.context, ...context });
    }
}

const rootLogger = new Logger();
rootLogger.sanitize = sanitize;
rootLogger.Logger = Logger;

module.exports = rootLogger;
