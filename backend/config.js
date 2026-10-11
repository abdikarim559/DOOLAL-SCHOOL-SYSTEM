/**
 * Centralized Configuration & Environment Validation for Doolaal School Management System
 * Production-ready environment validator enforcing strict production security,
 * deterministic test execution, and safe development fallbacks.
 *
 * Never prints actual secret values to stdout, stderr, or logs.
 */

'use strict';

const logger = require('./utils/logger');

// Known weak/placeholder secrets that must be rejected in production
const WEAK_SECRET_PLACEHOLDERS = new Set([
    'replace_with_a_strong_random_secret',
    'replace_with_a_strong_random_secret_at_least_32_characters',
    'secret',
    'jwtsecret',
    'password',
    'changeme',
    'admin',
    '123456',
    'supersecretkey12345',
    'supersecret_school_mvp_key_123'
]);

/**
 * Validates the provided environment object (defaults to process.env).
 *
 * @param {object} env - Environment variables key-value map.
 * @returns {{ valid: boolean, errors: string[], config: object }}
 */
function validateConfig(env = process.env) {
    const errors = [];

    // 1. NODE_ENV validation
    const nodeEnv = (env.NODE_ENV || 'development').trim().toLowerCase();
    const allowedEnvs = ['development', 'test', 'production'];
    if (!allowedEnvs.includes(nodeEnv)) {
        errors.push(`Invalid NODE_ENV: "${nodeEnv}". Allowed modes: ${allowedEnvs.join(', ')}.`);
    }

    const isProduction = nodeEnv === 'production';
    const isTest = nodeEnv === 'test';
    const isDevelopment = nodeEnv === 'development';

    // 2. PORT validation
    const rawPort = env.PORT || '5000';
    let port = 5000;
    if (typeof rawPort !== 'string' && typeof rawPort !== 'number') {
        errors.push('PORT must be a numeric value.');
    } else {
        const portStr = String(rawPort).trim();
        if (!/^\d+$/.test(portStr)) {
            errors.push(`PORT must be a positive integer, got "${portStr}".`);
        } else {
            port = parseInt(portStr, 10);
            if (port < 1 || port > 65535) {
                errors.push(`PORT must be between 1 and 65535, got ${port}.`);
            }
        }
    }

    // 3. MONGO_URI validation
    const mongoUri = (env.MONGO_URI || '').trim();
    if (!mongoUri) {
        errors.push('MONGO_URI is required.');
    } else if (!mongoUri.startsWith('mongodb://') && !mongoUri.startsWith('mongodb+srv://')) {
        errors.push('MONGO_URI must begin with "mongodb://" or "mongodb+srv://".');
    }

    // 4. JWT_SECRET validation
    const jwtSecret = (env.JWT_SECRET || '').trim();
    if (!jwtSecret) {
        errors.push('JWT_SECRET is required.');
    } else if (isProduction) {
        if (jwtSecret.length < 32) {
            errors.push('JWT_SECRET must be at least 32 characters in production.');
        }
        if (WEAK_SECRET_PLACEHOLDERS.has(jwtSecret.toLowerCase())) {
            errors.push('JWT_SECRET cannot be a known weak or template placeholder in production.');
        }
    }

    // 5. FRONTEND_ORIGIN validation
    const rawFrontendOrigin = (env.FRONTEND_ORIGIN || '').trim();
    let allowedOrigins = [];
    if (rawFrontendOrigin) {
        allowedOrigins = rawFrontendOrigin.split(',').map(o => o.trim()).filter(Boolean);
        if (isProduction && allowedOrigins.includes('*')) {
            errors.push('FRONTEND_ORIGIN cannot be "*" in production when authenticated access is used.');
        }
        for (const origin of allowedOrigins) {
            if (!/^https?:\/\//i.test(origin)) {
                errors.push(`Invalid FRONTEND_ORIGIN entry "${origin}". Must begin with http:// or https://.`);
            }
        }
    } else if (isProduction) {
        errors.push('FRONTEND_ORIGIN is required in production.');
    }

    // 6. SMTP configuration validation
    const smtpHost = (env.SMTP_HOST || '').trim();
    const rawSmtpPort = (env.SMTP_PORT || '587').toString().trim();
    const rawSmtpSecure = (env.SMTP_SECURE || 'false').toString().trim().toLowerCase();
    const smtpUser = (env.SMTP_USER || '').trim();
    const smtpPass = (env.SMTP_PASS || '').trim();
    const smtpFrom = (env.SMTP_FROM || '').trim();

    let smtpPort = 587;
    if (rawSmtpPort) {
        if (!/^\d+$/.test(rawSmtpPort)) {
            errors.push(`SMTP_PORT must be a valid integer, got "${rawSmtpPort}".`);
        } else {
            smtpPort = parseInt(rawSmtpPort, 10);
            if (smtpPort < 1 || smtpPort > 65535) {
                errors.push(`SMTP_PORT must be between 1 and 65535, got ${smtpPort}.`);
            }
        }
    }

    if (rawSmtpSecure && !['true', 'false'].includes(rawSmtpSecure)) {
        errors.push(`SMTP_SECURE must be "true" or "false", got "${rawSmtpSecure}".`);
    }

    // Production SMTP requirements: if in production, require real SMTP
    if (isProduction) {
        if (!smtpHost) {
            errors.push('SMTP_HOST is required in production.');
        }
        if (!smtpUser) {
            errors.push('SMTP_USER is required in production.');
        }
        if (!smtpPass) {
            errors.push('SMTP_PASS is required in production.');
        }
        if (!smtpFrom) {
            errors.push('SMTP_FROM is required in production.');
        } else if (!smtpFrom.includes('@')) {
            errors.push('SMTP_FROM must contain a valid email address with an "@" symbol.');
        }
    }

    // 7. LOG_LEVEL validation
    const logLevel = (env.LOG_LEVEL || (isProduction ? 'info' : 'info')).trim().toLowerCase();
    const allowedLogLevels = ['debug', 'info', 'warn', 'error'];
    if (!allowedLogLevels.includes(logLevel)) {
        errors.push(`Invalid LOG_LEVEL: "${logLevel}". Allowed levels: ${allowedLogLevels.join(', ')}.`);
    }

    const valid = errors.length === 0;

    const validatedConfig = {
        NODE_ENV: nodeEnv,
        isProduction,
        isTest,
        isDevelopment,
        PORT: port,
        HOST: env.HOST || '0.0.0.0',
        MONGO_URI: mongoUri,
        JWT_SECRET: jwtSecret,
        FRONTEND_ORIGIN: rawFrontendOrigin,
        allowedOrigins,
        SMTP_HOST: smtpHost,
        SMTP_PORT: smtpPort,
        SMTP_SECURE: rawSmtpSecure === 'true' || smtpPort === 465,
        SMTP_USER: smtpUser,
        SMTP_PASS: smtpPass,
        SMTP_FROM: smtpFrom || '"DOOLAL SCHOOL" <noreply@schoolsystem.com>',
        LOG_LEVEL: logLevel,
        ADMIN_INIT_PASSWORD: env.ADMIN_INIT_PASSWORD ? env.ADMIN_INIT_PASSWORD.trim() : ''
    };

    return {
        valid,
        errors,
        config: validatedConfig
    };
}

module.exports = {
    validateConfig
};
