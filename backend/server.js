require('dotenv').config();
const crypto = require('crypto');
const logger = require('./utils/logger');

// ---------------------------------------------------------------------------
// Process-level unhandled exception & rejection handlers (STEP 9)
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
    logger.error('Fatal uncaught exception occurred', {
        category: 'uncaughtException',
        error: err.message,
        name: err.name
    });
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    logger.error('Unhandled promise rejection occurred', {
        category: 'unhandledRejection',
        error: errorMsg
    });
});

// ---------------------------------------------------------------------------
// Centralized configuration validation (P1 #6 STEP 2)
// Enforces environment modes, port ranges, and required production secrets.
// ---------------------------------------------------------------------------
const { validateConfig } = require('./config');
const REQUIRED_ENV = ['JWT_SECRET', 'MONGO_URI'];
const configValidation = validateConfig(process.env);
if (!configValidation.valid) {
    logger.error('[CONFIG ERROR] Configuration validation failed', {
        errors: configValidation.errors
    });
    console.error(
        '\n[CONFIG ERROR] Configuration validation failed:\n' +
        configValidation.errors.map((k) => `  - ${k}`).join('\n') +
        '\n\nCreate or update .env file in the project root. See .env.example for reference.\n'
    );
    process.exit(1);
}
const config = configValidation.config;
// ---------------------------------------------------------------------------

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const {
    connectDB,
    User,
    Student,
    Teacher,
    Class,
    Attendance,
    AcademicYear,
    Term,
    Subject,
    ClassSubject,
    Exam,
    Mark,
    Setting,
    TimetableSlot,
    Notice
} = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;

// ---------------------------------------------------------------------------
// REQUEST CORRELATION ID MIDDLEWARE (STEP 2)
// Generates or validates/sanitizes X-Request-ID and attaches req.requestId
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
    let requestId = req.headers['x-request-id'];
    // Validate supplied request ID: safe length (1-64 chars) and safe characters (alphanumeric, -, _)
    if (typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(requestId.trim())) {
        requestId = requestId.trim();
    } else {
        requestId = crypto.randomUUID();
    }
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    next();
});

// ---------------------------------------------------------------------------
// REQUEST LOGGING MIDDLEWARE (STEP 3)
// Logs safe HTTP method, path, response status, duration, and correlation ID.
// Never logs passwords, OTPs, JWTs, Authorization headers, or credentials.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
    const startTime = Date.now();
    res.on('finish', () => {
        const durationMs = Date.now() - startTime;
        logger.info('Request completed', {
            requestId: req.requestId,
            method: req.method,
            path: req.originalUrl || req.path,
            status: res.statusCode,
            durationMs
        });
    });
    next();
});

// ---------------------------------------------------------------------------
// SECURITY HEADERS (Helmet)
// Configured to permit required CDN resources (FontAwesome, Google Fonts, ChartJS)
// ---------------------------------------------------------------------------
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

// ---------------------------------------------------------------------------
// CORS HARDENING
// Production: restricts access to origins listed in FRONTEND_ORIGIN.
// Development: permits localhost and 127.0.0.1 on any port.
// ---------------------------------------------------------------------------
const allowedOrigins = process.env.FRONTEND_ORIGIN
    ? process.env.FRONTEND_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
    : [];

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (curl, mobile apps, same-origin SPA navigation)
        if (!origin) return callback(null, true);

        // If FRONTEND_ORIGIN is specified, strictly check allowlist
        if (allowedOrigins.length > 0) {
            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(new Error('CORS request blocked by security policy'));
        }

        // Development mode fallback (no FRONTEND_ORIGIN set): allow localhost and 127.0.0.1 on any port
        if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
            return callback(null, true);
        }

        return callback(new Error('CORS request blocked by security policy'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));

// ---------------------------------------------------------------------------
// REQUEST BODY PARSING
// Limit JSON request payloads to 100kb to protect against large payload DoS
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ---------------------------------------------------------------------------
// RATE LIMITING
// Note: Using default in-memory store. Counters reset on server restart.
// For multi-instance production deployments, a shared store (e.g., Redis) is required.
// ---------------------------------------------------------------------------
const baseLimiterOpts = {
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Please try again later.' },
    validate: { xForwardedForHeader: false }
};

// Global API Limiter: 100 requests per 15 minutes per IP
const apiLimiter = rateLimit({
    ...baseLimiterOpts,
    windowMs: 15 * 60 * 1000,
    max: 100,
    skip: () => process.env.NODE_ENV === 'test'
});

// OTP Send Limiter (IP-based): 5 requests per 15 minutes per IP
const otpSendLimiter = rateLimit({
    ...baseLimiterOpts,
    windowMs: 15 * 60 * 1000,
    max: 5
});

// OTP Send Limiter (Email-based): 5 requests per 15 minutes per email
const otpSendEmailLimiter = rateLimit({
    ...baseLimiterOpts,
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => {
        return (req.body && typeof req.body.email === 'string') ? req.body.email.trim().toLowerCase() : '';
    },
    skip: (req) => !req.body || typeof req.body.email !== 'string' || !req.body.email.trim(),
    validate: false
});

// OTP Verify Limiter (IP-based): 10 attempts per 15 minutes per IP
const otpVerifyLimiter = rateLimit({
    ...baseLimiterOpts,
    windowMs: 15 * 60 * 1000,
    max: 10
});

// OTP Verify Limiter (Email-based): 10 attempts per 15 minutes per email
const otpVerifyEmailLimiter = rateLimit({
    ...baseLimiterOpts,
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => {
        return (req.body && typeof req.body.email === 'string') ? req.body.email.trim().toLowerCase() : '';
    },
    skip: (req) => !req.body || typeof req.body.email !== 'string' || !req.body.email.trim(),
    validate: false
});

// Apply global API rate limit to all /api/ routes
app.use('/api', apiLimiter);

// Connect to MongoDB
connectDB();

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// SMTP & Email Transporter Configuration
// ---------------------------------------------------------------------------
let transporter = null;
let isSmtpConfigured = false;

// Initialize Transporter: prioritize production SMTP if SMTP_HOST is defined in .env
if (process.env.SMTP_HOST) {
    const smtpPort = parseInt(process.env.SMTP_PORT, 10) || 587;
    const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465;

    const transportConfig = {
        host: process.env.SMTP_HOST,
        port: smtpPort,
        secure: smtpSecure
    };

    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        transportConfig.auth = {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        };
    }

    transporter = nodemailer.createTransport(transportConfig);
    isSmtpConfigured = true;

    // Verify SMTP connection on startup without sending test emails or leaking credentials
    transporter.verify((err) => {
        if (err) {
            logger.error('[SMTP ERROR] Failed to connect to SMTP server', { category: 'smtp_verify', error: err.message });
        } else {
            logger.info('[SMTP] Transporter verified and ready to deliver production messages');
        }
    });
} else {
    // Development / Test email fallback
    // In dev mode without SMTP_HOST, use an Ethereal test account or local fallback
    logger.info('[EMAIL] No SMTP_HOST configured. Initializing development email fallback');
    nodemailer.createTestAccount((err, account) => {
        if (err) {
            logger.error('[EMAIL ERROR] Failed to create test account', { category: 'smtp_test_account', error: err.message });
            return;
        }
        transporter = nodemailer.createTransport({
            host: account.smtp.host,
            port: account.smtp.port,
            secure: account.smtp.secure,
            auth: {
                user: account.user,
                pass: account.pass
            }
        });
        logger.info('[EMAIL] Development test transporter ready');
    });
}

/**
 * Sends a 6-digit OTP verification email via SMTP (or development test fallback).
 * Returns { success: boolean, messageId?: string, error?: string }.
 * SECURITY: Never logs the plaintext OTP or credentials to logs or API responses.
 */
async function sendEmailOTP(email, otp) {
    const fromAddress = process.env.SMTP_FROM || '"DOOLAL SCHOOL" <noreply@schoolsystem.com>';
    const subject = 'Your Doolaal School Login Verification Code';

    const plainText = 
`DOOLAL SCHOOL MANAGEMENT SYSTEM
==================================================
Your 6-digit verification code is: ${otp}

This code will expire in 5 minutes.

SECURITY NOTICE:
Do not share this code with anyone. Doolaal School staff will never ask for your verification code.

If you did not request this login code, please contact your school administrator.
`;

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f9; margin: 0; padding: 20px; }
    .container { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 36px 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
    .header { text-align: center; margin-bottom: 24px; }
    .logo-text { font-size: 20px; font-weight: 700; color: #1e293b; letter-spacing: 0.5px; }
    .title { font-size: 15px; color: #475569; margin: 8px 0 0 0; }
    .otp-box { background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 8px; text-align: center; padding: 20px; margin: 24px 0; }
    .otp-code { font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #2563eb; }
    .expiry { font-size: 13px; color: #64748b; margin-top: 8px; }
    .security-note { background: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 14px; border-radius: 4px; font-size: 13px; color: #991b1b; line-height: 1.5; margin-top: 24px; }
    .footer { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 28px; border-top: 1px solid #f1f5f9; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-text">DOOLAL SCHOOL MANAGEMENT SYSTEM</div>
      <p class="title">Login Verification Code</p>
    </div>
    <p style="color: #334155; font-size: 14px; line-height: 1.6;">Hello,</p>
    <p style="color: #334155; font-size: 14px; line-height: 1.6;">Use the following 6-digit verification code to complete your login:</p>
    <div class="otp-box">
      <div class="otp-code">${otp}</div>
      <div class="expiry">Expires in 5 minutes</div>
    </div>
    <div class="security-note">
      <strong>Security Notice:</strong> Never share this code with anyone. School staff will never ask for your verification code.
    </div>
    <div class="footer">
      &copy; DOOLAL SCHOOL. All rights reserved.<br>
      This is an automated system email. Please do not reply to this message.
    </div>
  </div>
</body>
</html>`;

    if (!transporter) {
        // Fallback if transporter is still initializing or in test environment
        logger.info('[EMAIL] OTP dispatched for recipient', { email, operation: 'send_otp' });
        if (process.env.NODE_ENV !== 'production') {
            logger.info(`[DEV OTP] ==========================================`);
            logger.info(`[DEV OTP]  Email : ${email}`);
            logger.info(`[DEV OTP]  Code  : ${otp}`);
            logger.info(`[DEV OTP] ==========================================`);
        }
        return { success: true, messageId: 'dev-fallback' };
    }

    try {
        const info = await transporter.sendMail({
            from: fromAddress,
            to: email,
            subject,
            text: plainText,
            html: htmlContent
        });

        logger.info('[EMAIL] OTP verification email dispatched', { email, messageId: info.messageId });
        if (nodemailer.getTestMessageUrl && info) {
            const previewUrl = nodemailer.getTestMessageUrl(info);
            if (previewUrl) {
                logger.info('[DEV OTP] ==========================================');
                logger.info(`[DEV OTP]  Email : ${email}`);
                logger.info(`[DEV OTP]  Code  : ${otp}`);
                logger.info(`[DEV OTP]  Preview: ${previewUrl}`);
                logger.info('[DEV OTP] ==========================================');
            }
        }
        return { success: true, messageId: info.messageId };
    } catch(err) {
        logger.error('[EMAIL ERROR] Email send failed for recipient', { email, error: err.message, category: 'smtp_send_failure' });
        return { success: false, error: err.message };
    }
}

// ---------------------------------------------------------------------------
// INPUT VALIDATION HELPERS
// ---------------------------------------------------------------------------

/**
 * Validates a string field.
 * @param {*}      value      — the raw value from req.body
 * @param {string} fieldName  — human-readable label for error messages
 * @param {object} [opts]
 * @param {boolean} [opts.required=true]
 * @param {number}  [opts.maxLength=200]
 * @returns {{ value: string, error: string|null }}
 */
function validateString(value, fieldName, { required = true, maxLength = 200 } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) return { value: null, error: `${fieldName} is required` };
        return { value: '', error: null };
    }
    if (typeof value !== 'string') {
        return { value: null, error: `${fieldName} must be a string` };
    }
    const trimmed = value.trim();
    if (required && trimmed.length === 0) {
        return { value: null, error: `${fieldName} cannot be blank` };
    }
    if (trimmed.length > maxLength) {
        return { value: null, error: `${fieldName} is too long (max ${maxLength} characters)` };
    }
    return { value: trimmed, error: null };
}

/**
 * Validates that a value is a valid MongoDB ObjectId string.
 */
function validateObjectId(value, fieldName) {
    if (!value || typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) {
        return { value: null, error: `${fieldName} must be a valid ID` };
    }
    return { value: value.trim(), error: null };
}

/**
 * Validates that a value belongs to an explicit allowed set.
 */
function validateEnum(value, fieldName, allowed) {
    if (!value || !allowed.includes(value)) {
        return { value: null, error: `${fieldName} must be one of: ${allowed.join(', ')}` };
    }
    return { value, error: null };
}

/**
 * Validates that a value is a positive finite number within bounds.
 */
function validatePositiveNumber(value, fieldName, { min = 1, max = 10000, required = true } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) return { value: null, error: `${fieldName} is required` };
        return { value: null, error: null };
    }
    const num = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'boolean' || isNaN(num) || !Number.isFinite(num)) {
        return { value: null, error: `${fieldName} must be a valid number` };
    }
    if (num < min) {
        return { value: null, error: `${fieldName} must be greater than 0` };
    }
    if (num > max) {
        return { value: null, error: `${fieldName} cannot exceed ${max}` };
    }
    return { value: num, error: null };
}

/**
 * Validates a date string has the format YYYY-MM-DD and is a real calendar date.
 * Rejects malformed formats, impossible dates (e.g. 2024-13-45), and empty values.
 */
function validateDateString(value, fieldName) {
    if (!value || typeof value !== 'string') {
        return { value: null, error: `${fieldName} is required` };
    }
    const trimmed = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return { value: null, error: `${fieldName} must be in YYYY-MM-DD format` };
    }
    // Verify it is an actual calendar date (e.g. reject 2024-13-01, 2024-02-30)
    const [year, month, day] = trimmed.split('-').map(Number);
    const dateObj = new Date(trimmed);
    if (
        isNaN(dateObj.getTime()) ||
        dateObj.getUTCFullYear() !== year ||
        dateObj.getUTCMonth() + 1 !== month ||
        dateObj.getUTCDate() !== day
    ) {
        return { value: null, error: `${fieldName} is not a valid calendar date` };
    }
    return { value: trimmed, error: null };
}

/**
 * Validates a basic email address format and normalises it to lowercase.
 */
function validateEmail(value) {
    if (!value || typeof value !== 'string') {
        return { value: null, error: 'Email is required' };
    }
    const trimmed = value.trim().toLowerCase();
    // Basic structural check — not a strict RFC test, just catches obvious garbage
    if (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return { value: null, error: 'A valid email address is required' };
    }
    return { value: trimmed, error: null };
}

/**
 * Escapes regex special characters in user-supplied search strings.
 * Prevents ReDoS by ensuring user input is treated as a literal pattern.
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the first error message from a list of validation results,
 * or null if all passed.
 */
function firstError(...results) {
    for (const r of results) {
        if (r.error) return r.error;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Authentication middleware — verifies the JWT and attaches req.user
// ---------------------------------------------------------------------------
const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logger.warn('Authentication failed: missing token', {
            requestId: req.requestId,
            method: req.method,
            path: req.originalUrl || req.path,
            status: 401,
            reason: 'missing token'
        });
        return res.sendStatus(401);
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        logger.warn('Authentication failed: missing token', {
            requestId: req.requestId,
            method: req.method,
            path: req.originalUrl || req.path,
            status: 401,
            reason: 'missing token'
        });
        return res.sendStatus(401);
    }

    // SECURITY: lock to HS256 — prevents alg:none / RS256 confusion attacks
    jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
        if (err) {
            const reason = err.name === 'TokenExpiredError' ? 'expired token' : 'invalid token';
            logger.warn(`Authentication failed: ${reason}`, {
                requestId: req.requestId,
                method: req.method,
                path: req.originalUrl || req.path,
                status: 401,
                reason
            });
            // 401 = token missing/expired/invalid; 403 is reserved for valid token but forbidden role
            return res.status(401).json({ message: 'Invalid or expired authentication token.' });
        }
        req.user = user;
        next();
    });
};

// ---------------------------------------------------------------------------
// RBAC middleware factory — call after authenticateJWT
// Usage: authorizeRoles('admin', 'teacher')
// Returns 403 if req.user.role is not in the allowed list.
// ---------------------------------------------------------------------------
const VALID_ROLES = ['admin', 'teacher', 'student'];
const authorizeRoles = (...roles) => (req, res, next) => {
    const userRole = req.user && req.user.role;
    // Reject entirely unknown roles embedded in old/tampered tokens
    if (!VALID_ROLES.includes(userRole)) {
        logger.warn('Authorization failed: invalid role', {
            requestId: req.requestId,
            method: req.method,
            path: req.originalUrl || req.path,
            status: 403,
            authenticatedRole: userRole || 'unknown',
            requiredRoles: roles
        });
        return res.status(403).json({ message: 'Invalid role' });
    }
    if (!roles.includes(userRole)) {
        logger.warn('Authorization failed: forbidden role', {
            requestId: req.requestId,
            method: req.method,
            path: req.originalUrl || req.path,
            status: 403,
            authenticatedRole: userRole,
            requiredRoles: roles
        });
        return res.status(403).json({
            message: `Access denied. Required role(s): ${roles.join(', ')}. Your role: ${userRole}`
        });
    }
    next();
};

// ---------------------------------------------------------------------------
// AUTH ROUTES
// ---------------------------------------------------------------------------

// 1. Request OTP
// SECURITY: Only pre-registered users (admin-provisioned) may log in.
// Unknown emails are rejected — automatic self-registration is disabled.
app.post('/api/send-otp', otpSendLimiter, otpSendEmailLimiter, async (req, res) => {
    try {
        // Validate + normalise email — only accept this field, ignore everything else
        const emailResult = validateEmail(req.body.email);
        if (emailResult.error) return res.status(400).json({ message: emailResult.error });
        const email = emailResult.value;

        // SECURITY: explicitly select otp+otpExpires — they are hidden by default (select:false)
        const user = await User.findOne({ email }).select('+otp +otpExpires');
        if (!user) {
            logger.warn('OTP request for unregistered email', { requestId: req.requestId, status: 403 });
            // Do NOT create an account or send a real OTP.
            return res.status(403).json({
                message: 'This email is not registered. Contact the school administrator to create your account.'
            });
        }

        if (user.status === 'inactive') {
            logger.warn('OTP request for inactive account', { requestId: req.requestId, email, status: 403 });
            return res.status(403).json({
                message: 'This account has been deactivated. Contact the school administrator.'
            });
        }

        // Generate 6-digit OTP using cryptographically secure random generation
        const otp = crypto.randomInt(100000, 1000000).toString();
        // Hash the OTP before storing for security.
        const salt = bcrypt.genSaltSync(10);
        const hashedOtp = bcrypt.hashSync(otp, salt);

        // Expire in 5 minutes
        user.otp = hashedOtp;
        user.otpExpires = new Date(Date.now() + 5 * 60000);
        await user.save();

        const delivery = await sendEmailOTP(email, otp);
        if (!delivery || !delivery.success) {
            // Roll back the OTP if delivery failed so user is not stuck with an unreceived active OTP
            user.otp = undefined;
            user.otpExpires = undefined;
            await user.save();
            logger.error('SMTP email delivery failure during send-otp', {
                requestId: req.requestId,
                operation: 'send_otp_email',
                status: 503
            });
            return res.status(503).json({
                message: 'Failed to send verification email. Please try again later.'
            });
        }

        logger.info('OTP email dispatched successfully', { requestId: req.requestId, status: 200 });
        res.json({ message: 'OTP sent to your email' });
    } catch (err) {
        logger.error('Error during send-otp execution', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred', requestId: req.requestId });
    }
});

// 2. Verify OTP
app.post('/api/verify-otp', otpVerifyLimiter, otpVerifyEmailLimiter, async (req, res) => {
    try {
        // Accept only email and otp — strip everything else
        const emailResult = validateEmail(req.body.email);
        if (emailResult.error) return res.status(400).json({ message: emailResult.error });
        const email = emailResult.value;

        const otpRaw = req.body.otp;
        if (!otpRaw || typeof otpRaw !== 'string' || !/^\d{6}$/.test(otpRaw.trim())) {
            return res.status(400).json({ message: 'A valid 6-digit OTP is required' });
        }
        const otp = otpRaw.trim();

        // SECURITY: explicitly select otp+otpExpires — they are hidden by default (select:false)
        const user = await User.findOne({ email }).select('+otp +otpExpires');
        if (!user) {
            logger.warn('OTP verification failed: no user found', { requestId: req.requestId, status: 401 });
            return res.status(401).json({ message: 'Invalid or expired OTP' });
        }

        if (user.status === 'inactive') {
            logger.warn('OTP verification for inactive account', { requestId: req.requestId, email, status: 403 });
            return res.status(403).json({
                message: 'This account has been deactivated. Contact the school administrator.'
            });
        }

        if (!user.otp || !user.otpExpires) {
            logger.warn('OTP verification failed: no active OTP', { requestId: req.requestId, status: 401, reason: 'invalid or expired OTP' });
            return res.status(401).json({ message: 'Invalid or expired OTP' });
        }

        if (new Date() > user.otpExpires) {
            user.otp = undefined;
            user.otpExpires = undefined;
            await user.save();
            logger.warn('OTP verification failed: OTP expired', { requestId: req.requestId, status: 401, reason: 'expired OTP' });
            return res.status(401).json({ message: 'OTP has expired' });
        }

        if (bcrypt.compareSync(otp, user.otp)) {
            // Valid OTP — role comes from the trusted server-side DB record, not from the request
            user.otp = undefined;
            user.otpExpires = undefined;
            await user.save();

            const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
            logger.info('User successfully authenticated via OTP', { requestId: req.requestId, role: user.role });
            res.json({ token, role: user.role });
        } else {
            logger.warn('OTP verification failed: invalid OTP code', { requestId: req.requestId, status: 401, reason: 'invalid OTP' });
            res.status(401).json({ message: 'Invalid OTP' });
        }
    } catch (err) {
        logger.error('Error during verify-otp execution', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred', requestId: req.requestId });
    }
});

// ---------------------------------------------------------------------------
// DASHBOARD ROUTES
// ---------------------------------------------------------------------------

// --- DASHBOARD OVERVIEW ---
app.get('/api/dashboard', authenticateJWT, async (req, res) => {
    try {
        const data = {
            students: await Student.countDocuments(),
            teachers: await Teacher.countDocuments(),
            classes: await Class.countDocuments()
        };
        res.json(data);
    } catch(err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// --- DASHBOARD ENHANCED STATS ---
app.get('/api/dashboard/stats', authenticateJWT, async (req, res) => {
    try {
        const students = await Student.countDocuments();
        const teachers = await Teacher.countDocuments();
        const classes = await Class.countDocuments();

        // Calculate attendance percentage for today
        const date = new Date().toISOString().split('T')[0];
        const attendanceRecords = await Attendance.find({ date });
        let attendancePercent = 0;
        if (attendanceRecords.length > 0) {
            const presentCount = attendanceRecords.filter(a => a.status === 'Present').length;
            attendancePercent = Math.round((presentCount / attendanceRecords.length) * 100);
        } else {
            attendancePercent = 100; // default if none taken
        }

        // Gender distribution
        const maleCount = await Student.countDocuments({ gender: 'Male' });
        const femaleCount = await Student.countDocuments({ gender: 'Female' });

        res.json({
            students,
            teachers,
            classes,
            attendancePercent,
            genderDistribution: { male: maleCount, female: femaleCount }
        });
    } catch(err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// --- DASHBOARD ATTENDANCE CHART ---
app.get('/api/dashboard/attendance-chart', authenticateJWT, async (req, res) => {
    try {
        // Simple logic for the last 5 days
        const labels = [];
        const data = [];
        for (let i = 4; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const records = await Attendance.find({ date: dateStr });
            
            let percent = 0;
            if (records.length > 0) {
                const present = records.filter(a => a.status === 'Present').length;
                percent = Math.round((present / records.length) * 100);
            }
            
            labels.push(d.toLocaleDateString('en-US', { weekday: 'short' }));
            data.push(percent);
        }
        res.json({ labels, data });
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// ---------------------------------------------------------------------------
// GLOBAL SEARCH
// ReDoS fix: escape user input before building the RegExp.
// ---------------------------------------------------------------------------
app.get('/api/search', authenticateJWT, async (req, res) => {
    try {
        const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (raw.length < 2) return res.json({ students: [], teachers: [], classes: [] });
        // Hard cap on query length to prevent excessive DB work
        if (raw.length > 100) return res.status(400).json({ message: 'Search query is too long' });

        // SECURITY: Escape regex special characters to prevent ReDoS
        const safe = escapeRegex(raw);
        const regex = new RegExp(safe, 'i');

        const students = await Student.find({ $or: [{ full_name: regex }, { id_number: regex }] }).limit(5);
        const teachers = await Teacher.find({ $or: [{ name: regex }, { subject: regex }] }).limit(5);
        const classes = await Class.find({ name: regex }).limit(5);

        res.json({ students, teachers, classes });
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// ---------------------------------------------------------------------------
// STUDENTS CRUD
// ---------------------------------------------------------------------------

// READ: admin, teacher, student (student role restricted to own record only for privacy)
app.get('/api/students', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        if (req.user.role === 'student') {
            const myStudentId = await resolveStudentIdForUser(req.user);
            if (!myStudentId) {
                return res.json([]);
            }
            const student = await Student.findById(myStudentId);
            if (!student) {
                return res.json([]);
            }
            const obj = student.toObject();
            obj.id = obj._id.toString();
            return res.json([obj]);
        }

        const students = await Student.find();
        res.json(students.map(s => {
            const obj = s.toObject();
            obj.id = obj._id.toString();
            return obj;
        }));
    } catch(err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// WRITE: admin only
// MASS ASSIGNMENT PROTECTION: explicit field allowlist — only these 5 fields are accepted
app.post('/api/students', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const fullNameR  = validateString(req.body.full_name,  'Full name',  { maxLength: 150 });
        const idNumberR  = validateString(req.body.id_number,  'ID number',  { maxLength: 50  });
        const classNameR = validateString(req.body.class_name, 'Class name', { maxLength: 100 });
        const genderR    = validateEnum(req.body.gender, 'Gender', ['Male', 'Female']);
        const contactR   = validateString(req.body.contact,    'Contact',    { maxLength: 50  });

        const err = firstError(fullNameR, idNumberR, classNameR, genderR, contactR);
        if (err) return res.status(400).json({ message: err });

        // Only these explicitly extracted fields are written to the database
        const student = await Student.create({
            full_name:  fullNameR.value,
            id_number:  idNumberR.value,
            class_name: classNameR.value,
            gender:     genderR.value,
            contact:    contactR.value
        });
        res.json({ id: student._id });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'A student with this ID number already exists.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// UPDATE: admin only
// MASS ASSIGNMENT PROTECTION: explicit field allowlist
app.put('/api/students/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Student ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const fullNameR  = validateString(req.body.full_name,  'Full name',  { maxLength: 150 });
        const idNumberR  = validateString(req.body.id_number,  'ID number',  { maxLength: 50  });
        const classNameR = validateString(req.body.class_name, 'Class name', { maxLength: 100 });
        const genderR    = validateEnum(req.body.gender, 'Gender', ['Male', 'Female']);
        const contactR   = validateString(req.body.contact,    'Contact',    { maxLength: 50  });

        const err = firstError(fullNameR, idNumberR, classNameR, genderR, contactR);
        if (err) return res.status(400).json({ message: err });

        const existingStudent = await Student.findById(idR.value);
        if (!existingStudent) return res.status(404).json({ message: 'Student not found' });

        // Only these explicitly extracted fields are written to the database
        await Student.findByIdAndUpdate(idR.value, {
            full_name:  fullNameR.value,
            id_number:  idNumberR.value,
            class_name: classNameR.value,
            gender:     genderR.value,
            contact:    contactR.value
        });
        res.json({ updated: 1 });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'A student with this ID number already exists.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// DELETE: admin only
app.delete('/api/students/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Student ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const student = await Student.findById(idR.value);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        const attendanceCount = await Attendance.countDocuments({ student_id: idR.value });
        if (attendanceCount > 0) {
            return res.status(409).json({
                success: false,
                message: 'Cannot delete student with existing attendance records.'
            });
        }

        await Student.findByIdAndDelete(idR.value);
        res.json({ deleted: 1 });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// TEACHERS CRUD
// ---------------------------------------------------------------------------

// READ: admin, teacher, student
app.get('/api/teachers', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const teachers = await Teacher.find();
        res.json(teachers.map(t => {
            const obj = t.toObject();
            obj.id = obj._id.toString();
            return obj;
        }));
    } catch(err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// WRITE: admin only
// MASS ASSIGNMENT PROTECTION: explicit field allowlist — only name, subject, phone accepted
app.post('/api/teachers', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const nameR    = validateString(req.body.name,    'Name',    { maxLength: 150 });
        const subjectR = validateString(req.body.subject, 'Subject', { maxLength: 100 });
        const phoneR   = validateString(req.body.phone,   'Phone',   { maxLength: 30  });

        const err = firstError(nameR, subjectR, phoneR);
        if (err) return res.status(400).json({ message: err });

        // Only these explicitly extracted fields are written to the database
        const teacher = await Teacher.create({
            name:    nameR.value,
            subject: subjectR.value,
            phone:   phoneR.value
        });
        res.json({ id: teacher._id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// UPDATE: admin only
// MASS ASSIGNMENT PROTECTION: explicit field allowlist
app.put('/api/teachers/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Teacher ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const nameR    = validateString(req.body.name,    'Name',    { maxLength: 150 });
        const subjectR = validateString(req.body.subject, 'Subject', { maxLength: 100 });
        const phoneR   = validateString(req.body.phone,   'Phone',   { maxLength: 30  });

        const err = firstError(nameR, subjectR, phoneR);
        if (err) return res.status(400).json({ message: err });

        const teacher = await Teacher.findById(idR.value);
        if (!teacher) return res.status(404).json({ message: 'Teacher not found' });

        // Only these explicitly extracted fields are written to the database
        await Teacher.findByIdAndUpdate(idR.value, {
            name:    nameR.value,
            subject: subjectR.value,
            phone:   phoneR.value
        });
        res.json({ updated: 1 });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// DELETE: admin only
app.delete('/api/teachers/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Teacher ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const teacher = await Teacher.findById(idR.value);
        if (!teacher) return res.status(404).json({ message: 'Teacher not found' });

        // Unassign classes referencing this teacher to prevent dangling references
        await Class.updateMany({ teacher_id: idR.value }, { $set: { teacher_id: null } });

        // Unassign class-subject teaching assignments referencing this teacher
        await ClassSubject.updateMany({ teacher_id: idR.value }, { $set: { teacher_id: null } });

        await Teacher.findByIdAndDelete(idR.value);
        res.json({ deleted: 1 });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// CLASSES CRUD
// ---------------------------------------------------------------------------

// READ: admin, teacher, student
app.get('/api/classes', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const classes = await Class.find().populate('teacher_id');
        res.json(classes.map(c => {
            const obj = c.toObject();
            obj.id = obj._id.toString();
            obj.teacher_name = c.teacher_id ? c.teacher_id.name : null;
            return obj;
        }));
    } catch(err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// WRITE: admin only
// Validates name and teacher_id (ObjectId); all other fields are ignored
app.post('/api/classes', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const nameR = validateString(req.body.name, 'Class name', { maxLength: 100 });
        if (nameR.error) return res.status(400).json({ message: nameR.error });

        // teacher_id is optional — validate only when provided and non-empty
        let teacherIdValue = null;
        const rawTeacherId = req.body.teacher_id;
        if (rawTeacherId && rawTeacherId !== '') {
            const tidR = validateObjectId(rawTeacherId, 'Teacher ID');
            if (tidR.error) return res.status(400).json({ message: tidR.error });
            const teacher = await Teacher.findById(tidR.value);
            if (!teacher) return res.status(404).json({ message: 'Referenced teacher not found' });
            teacherIdValue = tidR.value;
        }

        // Only name and teacher_id are written to the database
        const cls = await Class.create({
            name:       nameR.value,
            teacher_id: teacherIdValue
        });
        res.json({ id: cls._id });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'A class with this name already exists.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// UPDATE: admin only
// MASS ASSIGNMENT PROTECTION: explicit field allowlist (name, teacher_id)
app.put('/api/classes/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Class ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const nameR = validateString(req.body.name, 'Class name', { maxLength: 100 });
        if (nameR.error) return res.status(400).json({ message: nameR.error });

        const existingClass = await Class.findById(idR.value);
        if (!existingClass) return res.status(404).json({ message: 'Class not found' });

        // teacher_id is optional — validate only when provided and non-empty
        let teacherIdValue = null;
        const rawTeacherId = req.body.teacher_id;
        if (rawTeacherId !== undefined && rawTeacherId !== null && rawTeacherId !== '') {
            const tidR = validateObjectId(rawTeacherId, 'Teacher ID');
            if (tidR.error) return res.status(400).json({ message: tidR.error });
            const teacher = await Teacher.findById(tidR.value);
            if (!teacher) return res.status(404).json({ message: 'Referenced teacher not found' });
            teacherIdValue = tidR.value;
        }

        // Only explicitly validated fields are updated
        await Class.findByIdAndUpdate(idR.value, {
            name:       nameR.value,
            teacher_id: teacherIdValue
        });
        res.json({ updated: 1 });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'A class with this name already exists.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// DELETE: admin only
app.delete('/api/classes/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Class ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const cls = await Class.findById(idR.value);
        if (!cls) return res.status(404).json({ message: 'Class not found' });

        const classSubjectCount = await ClassSubject.countDocuments({ class_id: idR.value });
        if (classSubjectCount > 0) {
            return res.status(409).json({
                success: false,
                message: 'Cannot delete class with existing subject assignments.'
            });
        }

        await Class.findByIdAndDelete(idR.value);
        res.json({ deleted: 1 });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// ATTENDANCE
// ---------------------------------------------------------------------------

// READ: admin, teacher (students cannot view full attendance records)
// Supports optional filters: date, class_id, class_name
app.get('/api/attendance', authenticateJWT, authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
        // Validate and sanitise the date query param — default to today if absent
        let date;
        if (req.query.date) {
            const dateR = validateDateString(req.query.date, 'date');
            if (dateR.error) return res.status(400).json({ message: dateR.error });
            date = dateR.value;
        } else {
            date = new Date().toISOString().split('T')[0];
        }

        const studentQuery = {};
        if (req.query.class_id) {
            const cidR = validateObjectId(req.query.class_id, 'Class ID');
            if (cidR.error) return res.status(400).json({ message: cidR.error });
            const cls = await Class.findById(cidR.value);
            if (!cls) return res.status(404).json({ message: 'Class not found' });
            studentQuery.class_name = cls.name;
        } else if (req.query.class_name && typeof req.query.class_name === 'string') {
            studentQuery.class_name = req.query.class_name.trim();
        }

        const students = await Student.find(studentQuery);
        const studentIds = students.map(s => s._id);
        const attendanceRecords = await Attendance.find({ date, student_id: { $in: studentIds } });
        
        res.json(students.map(student => {
            const att = attendanceRecords.find(a => a.student_id.toString() === student._id.toString());
            return {
                id: student._id.toString(),
                id_number: student.id_number,
                full_name: student.full_name,
                class_name: student.class_name,
                status: att ? att.status : null,
                att_id: att ? att._id.toString() : null
            };
        }));
    } catch(err) {
        logger.error('Error fetching attendance', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// Supported application statuses (P3 Enhanced Attendance)
const VALID_ATTENDANCE_STATUSES = ['Present', 'Absent', 'Late', 'Excused'];

// WRITE SINGLE: admin, teacher
app.post('/api/attendance', authenticateJWT, authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
        const sidR = validateObjectId(req.body.student_id, 'Student ID');
        if (sidR.error) return res.status(400).json({ message: sidR.error });

        const student = await Student.findById(sidR.value);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        const statusR = validateEnum(req.body.status, 'Status', VALID_ATTENDANCE_STATUSES);
        if (statusR.error) return res.status(400).json({ message: statusR.error });

        const dateR = validateDateString(req.body.date, 'Date');
        if (dateR.error) return res.status(400).json({ message: dateR.error });
        const attDate = dateR.value;

        const existing = await Attendance.findOne({ student_id: sidR.value, date: attDate });
        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'Attendance already recorded for this student on this date.'
            });
        }

        const newAtt = await Attendance.create({
            student_id: sidR.value,
            date:       attDate,
            status:     statusR.value
        });
        res.status(201).json({
            _id:        newAtt._id.toString(),
            id:         newAtt._id.toString(),
            inserted:   true,
            student_id: sidR.value,
            date:       attDate,
            status:     statusR.value
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'Attendance already recorded for this student on this date.'
            });
        }
        logger.error('Error creating attendance record', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// BATCH WRITE: admin, teacher (e.g. Mark All Present with individual overrides)
app.post('/api/attendance/batch', authenticateJWT, authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
        const dateR = validateDateString(req.body.date, 'Date');
        if (dateR.error) return res.status(400).json({ message: dateR.error });
        const attDate = dateR.value;

        if (!Array.isArray(req.body.records) || req.body.records.length === 0) {
            return res.status(400).json({ message: 'Records array is required and cannot be empty' });
        }
        if (req.body.records.length > 500) {
            return res.status(400).json({ message: 'Batch size exceeds maximum limit of 500 records' });
        }

        // Validate all records before saving to maintain integrity
        const bulkOps = [];
        for (const item of req.body.records) {
            const sidR = validateObjectId(item.student_id, 'Student ID');
            if (sidR.error) return res.status(400).json({ message: `Invalid student ID: ${item.student_id}` });
            const statusR = validateEnum(item.status, 'Status', VALID_ATTENDANCE_STATUSES);
            if (statusR.error) return res.status(400).json({ message: `Invalid status "${item.status}" for student ${item.student_id}` });

            bulkOps.push({
                updateOne: {
                    filter: { student_id: sidR.value, date: attDate },
                    update: { $set: { status: statusR.value } },
                    upsert: true
                }
            });
        }

        await Attendance.bulkWrite(bulkOps);
        logger.info('Batch attendance saved successfully', { requestId: req.requestId, date: attDate, count: bulkOps.length });
        res.json({ success: true, count: bulkOps.length, updated_count: bulkOps.length, date: attDate });
    } catch (err) {
        logger.error('Error saving batch attendance', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// UPDATE SINGLE: admin, teacher
app.put('/api/attendance/:id', authenticateJWT, authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Attendance ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const statusR = validateEnum(req.body.status, 'Status', VALID_ATTENDANCE_STATUSES);
        if (statusR.error) return res.status(400).json({ message: statusR.error });

        const att = await Attendance.findById(idR.value);
        if (!att) return res.status(404).json({ message: 'Attendance record not found' });

        await Attendance.findByIdAndUpdate(idR.value, { status: statusR.value });
        res.json({ updated: true, _id: att._id.toString(), id: att._id.toString(), status: statusR.value });
    } catch (err) {
        logger.error('Error updating attendance record', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// STUDENT ATTENDANCE HISTORY & STATS: admin, teacher, student (own record only)
app.get('/api/attendance/student/:studentId', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const sidR = validateObjectId(req.params.studentId, 'Student ID');
        if (sidR.error) return res.status(400).json({ message: sidR.error });

        // Enforce student IDOR privacy
        if (req.user.role === 'student') {
            const myStudentId = await resolveStudentIdForUser(req.user);
            if (!myStudentId || myStudentId !== sidR.value) {
                return res.status(403).json({ message: 'Access denied. Students may only view their own attendance.' });
            }
        }

        const student = await Student.findById(sidR.value);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        const records = await Attendance.find({ student_id: student._id }).sort({ date: -1 });
        const totalDays = records.length;
        const presentCount = records.filter(r => r.status === 'Present').length;
        const lateCount = records.filter(r => r.status === 'Late').length;
        const absentCount = records.filter(r => r.status === 'Absent').length;
        const excusedCount = records.filter(r => r.status === 'Excused').length;

        // Attended days = Present + Late
        const attendanceRate = totalDays > 0 ? Number((((presentCount + lateCount) / totalDays) * 100).toFixed(2)) : 0;

        res.json({
            student: {
                id: student._id.toString(),
                id_number: student.id_number,
                full_name: student.full_name,
                class_name: student.class_name
            },
            summary: {
                total_days: totalDays,
                total_records: totalDays,
                present: presentCount,
                late: lateCount,
                absent: absentCount,
                excused: excusedCount,
                attendance_rate: attendanceRate,
                attendance_rate_percent: attendanceRate
            },
            records: records.map(r => ({
                id: r._id.toString(),
                date: r.date,
                status: r.status
            }))
        });
    } catch (err) {
        logger.error('Error fetching student attendance summary', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// CLASS ATTENDANCE SUMMARY & DATE-RANGE REPORT: admin, teacher
app.get('/api/attendance/summary/class/:classId', authenticateJWT, authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
        let cls = null;
        const rawClassParam = String(req.params.classId || '').trim();
        if (mongoose.Types.ObjectId.isValid(rawClassParam)) {
            cls = await Class.findById(rawClassParam);
        }
        if (!cls) {
            cls = await Class.findOne({ name: rawClassParam });
        }
        if (!cls) {
            const hasStudentsInClass = await Student.exists({ class_name: rawClassParam });
            if (hasStudentsInClass) {
                cls = { _id: null, name: rawClassParam };
            }
        }
        if (!cls) return res.status(404).json({ message: 'Class not found' });

        const query = {};
        if (req.query.start_date || req.query.startDate) {
            const sVal = req.query.start_date || req.query.startDate;
            const sR = validateDateString(sVal, 'Start Date');
            if (sR.error) return res.status(400).json({ message: sR.error });
            query.$gte = sR.value;
        }
        if (req.query.end_date || req.query.endDate) {
            const eVal = req.query.end_date || req.query.endDate;
            const eR = validateDateString(eVal, 'End Date');
            if (eR.error) return res.status(400).json({ message: eR.error });
            query.$lte = eR.value;
        }

        const students = await Student.find({ class_name: cls.name }).sort({ id_number: 1 });
        const studentIds = students.map(s => s._id);

        const attQuery = { student_id: { $in: studentIds } };
        if (Object.keys(query).length > 0) {
            attQuery.date = query;
        }

        const records = await Attendance.find(attQuery);
        const distinctDates = [...new Set(records.map(r => r.date))];

        const studentSummaries = students.map(st => {
            const sRecords = records.filter(r => r.student_id.toString() === st._id.toString());
            const total = sRecords.length;
            const p = sRecords.filter(r => r.status === 'Present').length;
            const l = sRecords.filter(r => r.status === 'Late').length;
            const a = sRecords.filter(r => r.status === 'Absent').length;
            const e = sRecords.filter(r => r.status === 'Excused').length;
            const rate = total > 0 ? Number((((p + l) / total) * 100).toFixed(2)) : 0;
            return {
                student_id: st._id.toString(),
                id_number: st.id_number,
                full_name: st.full_name,
                total_days: total,
                present: p,
                late: l,
                absent: a,
                excused: e,
                attendance_rate: rate,
                attendance_rate_percent: rate
            };
        });

        const overallTotalDays = studentSummaries.reduce((sum, s) => sum + s.total_days, 0);
        const overallAttended = studentSummaries.reduce((sum, s) => sum + s.present + s.late, 0);
        const averageRate = overallTotalDays > 0 ? Number(((overallAttended / overallTotalDays) * 100).toFixed(2)) : 0;

        res.json({
            class_id: cls._id ? cls._id.toString() : null,
            class_name: cls.name,
            date_range: {
                start_date: req.query.start_date || req.query.startDate || null,
                end_date: req.query.end_date || req.query.endDate || null
            },
            total_students: students.length,
            total_records: records.length,
            recorded_school_days: distinctDates.length,
            average_rate: averageRate,
            attendance_rate_percent: averageRate,
            students: studentSummaries
        });
    } catch (err) {
        logger.error('Error fetching class attendance summary', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// ===========================================================================
// ACADEMIC FOUNDATION (P2 #1)
// Academic Years, Terms, Subjects, and Class-Subject Relationships
// ===========================================================================

const VALID_ACADEMIC_YEAR_STATUSES = ['active', 'closed'];
const VALID_TERM_STATUSES = ['active', 'closed'];
const VALID_SUBJECT_STATUSES = ['active', 'inactive'];
const VALID_CLASS_SUBJECT_STATUSES = ['active', 'inactive'];

// ---------------------------------------------------------------------------
// 1. ACADEMIC YEARS
// ---------------------------------------------------------------------------

// READ: all authenticated roles (admin, teacher, student)
app.get('/api/academic-years', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const query = {};
        if (req.query.status && VALID_ACADEMIC_YEAR_STATUSES.includes(req.query.status)) {
            query.status = req.query.status;
        }
        const years = await AcademicYear.find(query).sort({ start_date: -1 });
        res.json(years.map(y => {
            const obj = y.toObject();
            obj.id = obj._id.toString();
            return obj;
        }));
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// READ single: all authenticated roles
app.get('/api/academic-years/:id', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Academic Year ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const year = await AcademicYear.findById(idR.value);
        if (!year) return res.status(404).json({ message: 'Academic year not found' });

        const obj = year.toObject();
        obj.id = obj._id.toString();
        res.json(obj);
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// CREATE: admin only
app.post('/api/academic-years', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const nameR = validateString(req.body.name, 'Academic year name', { maxLength: 100 });
        if (nameR.error) return res.status(400).json({ message: nameR.error });

        const startR = validateDateString(req.body.start_date, 'Start date');
        if (startR.error) return res.status(400).json({ message: startR.error });

        const endR = validateDateString(req.body.end_date, 'End date');
        if (endR.error) return res.status(400).json({ message: endR.error });

        if (endR.value < startR.value) {
            return res.status(400).json({ message: 'End date must not be before start date' });
        }

        const rawStatus = req.body.status !== undefined ? req.body.status : 'active';
        const statusR = validateEnum(rawStatus, 'Status', VALID_ACADEMIC_YEAR_STATUSES);
        if (statusR.error) return res.status(400).json({ message: statusR.error });

        // Enforce single active academic year rule
        if (statusR.value === 'active') {
            const existingActive = await AcademicYear.findOne({ status: 'active' });
            if (existingActive) {
                return res.status(409).json({
                    success: false,
                    message: 'Another academic year is already active. Please close it first.'
                });
            }
        }

        const year = await AcademicYear.create({
            name: nameR.value,
            start_date: startR.value,
            end_date: endR.value,
            status: statusR.value
        });

        const obj = year.toObject();
        obj.id = obj._id.toString();
        res.status(201).json(obj);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'An academic year with this name already exists.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// UPDATE: admin only
app.put('/api/academic-years/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Academic Year ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const existing = await AcademicYear.findById(idR.value);
        if (!existing) return res.status(404).json({ message: 'Academic year not found' });

        const nameR = req.body.name !== undefined ? validateString(req.body.name, 'Academic year name', { maxLength: 100 }) : { value: existing.name };
        if (nameR.error) return res.status(400).json({ message: nameR.error });

        const startR = req.body.start_date !== undefined ? validateDateString(req.body.start_date, 'Start date') : { value: existing.start_date };
        if (startR.error) return res.status(400).json({ message: startR.error });

        const endR = req.body.end_date !== undefined ? validateDateString(req.body.end_date, 'End date') : { value: existing.end_date };
        if (endR.error) return res.status(400).json({ message: endR.error });

        if (endR.value < startR.value) {
            return res.status(400).json({ message: 'End date must not be before start date' });
        }

        const rawStatus = req.body.status !== undefined ? req.body.status : existing.status;
        const statusR = validateEnum(rawStatus, 'Status', VALID_ACADEMIC_YEAR_STATUSES);
        if (statusR.error) return res.status(400).json({ message: statusR.error });

        // Enforce single active academic year rule if setting to active
        if (statusR.value === 'active' && existing.status !== 'active') {
            const otherActive = await AcademicYear.findOne({ status: 'active', _id: { $ne: idR.value } });
            if (otherActive) {
                return res.status(409).json({
                    success: false,
                    message: 'Another academic year is already active. Please close it first.'
                });
            }
        }

        await AcademicYear.findByIdAndUpdate(idR.value, {
            name: nameR.value,
            start_date: startR.value,
            end_date: endR.value,
            status: statusR.value
        });

        res.json({ updated: 1 });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'An academic year with this name already exists.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// DELETE: admin only
app.delete('/api/academic-years/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Academic Year ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const year = await AcademicYear.findById(idR.value);
        if (!year) return res.status(404).json({ message: 'Academic year not found' });

        const termsCount = await Term.countDocuments({ academic_year_id: idR.value });
        if (termsCount > 0) {
            return res.status(409).json({
                success: false,
                message: 'Cannot delete academic year with existing terms.'
            });
        }

        const csCount = await ClassSubject.countDocuments({ academic_year_id: idR.value });
        if (csCount > 0) {
            return res.status(409).json({
                success: false,
                message: 'Cannot delete academic year with existing class subject assignments.'
            });
        }

        await AcademicYear.findByIdAndDelete(idR.value);
        res.json({ deleted: 1 });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// 2. TERMS
// ---------------------------------------------------------------------------

// READ: all authenticated roles
app.get('/api/terms', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const query = {};
        if (req.query.academic_year_id) {
            const ayR = validateObjectId(req.query.academic_year_id, 'Academic Year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            query.academic_year_id = ayR.value;
        }
        const terms = await Term.find(query).populate('academic_year_id', 'name status').sort({ start_date: 1 });
        res.json(terms.map(t => {
            const obj = t.toObject();
            obj.id = obj._id.toString();
            obj.academic_year_name = t.academic_year_id ? t.academic_year_id.name : null;
            return obj;
        }));
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// READ single: all authenticated roles
app.get('/api/terms/:id', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Term ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const term = await Term.findById(idR.value).populate('academic_year_id', 'name status');
        if (!term) return res.status(404).json({ message: 'Term not found' });

        const obj = term.toObject();
        obj.id = obj._id.toString();
        obj.academic_year_name = term.academic_year_id ? term.academic_year_id.name : null;
        res.json(obj);
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// CREATE: admin only
app.post('/api/terms', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const nameR = validateString(req.body.name, 'Term name', { maxLength: 100 });
        if (nameR.error) return res.status(400).json({ message: nameR.error });

        const ayR = validateObjectId(req.body.academic_year_id, 'Academic year ID');
        if (ayR.error) return res.status(400).json({ message: ayR.error });

        const startR = validateDateString(req.body.start_date, 'Start date');
        if (startR.error) return res.status(400).json({ message: startR.error });

        const endR = validateDateString(req.body.end_date, 'End date');
        if (endR.error) return res.status(400).json({ message: endR.error });

        if (endR.value < startR.value) {
            return res.status(400).json({ message: 'End date must not be before start date' });
        }

        const rawStatus = req.body.status !== undefined ? req.body.status : 'active';
        const statusR = validateEnum(rawStatus, 'Status', VALID_TERM_STATUSES);
        if (statusR.error) return res.status(400).json({ message: statusR.error });

        // Referenced academic year must exist
        const year = await AcademicYear.findById(ayR.value);
        if (!year) return res.status(404).json({ message: 'Referenced academic year not found' });

        // Term dates must be within academic year bounds
        if (startR.value < year.start_date || endR.value > year.end_date) {
            return res.status(400).json({ message: 'Term dates must be within the academic year date range.' });
        }

        const term = await Term.create({
            name: nameR.value,
            academic_year_id: ayR.value,
            start_date: startR.value,
            end_date: endR.value,
            status: statusR.value
        });

        const obj = term.toObject();
        obj.id = obj._id.toString();
        res.status(201).json(obj);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'A term with this name already exists in this academic year.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// UPDATE: admin only
app.put('/api/terms/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Term ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const existing = await Term.findById(idR.value);
        if (!existing) return res.status(404).json({ message: 'Term not found' });

        const nameR = req.body.name !== undefined ? validateString(req.body.name, 'Term name', { maxLength: 100 }) : { value: existing.name };
        if (nameR.error) return res.status(400).json({ message: nameR.error });

        const ayR = req.body.academic_year_id !== undefined ? validateObjectId(req.body.academic_year_id, 'Academic year ID') : { value: existing.academic_year_id.toString() };
        if (ayR.error) return res.status(400).json({ message: ayR.error });

        const startR = req.body.start_date !== undefined ? validateDateString(req.body.start_date, 'Start date') : { value: existing.start_date };
        if (startR.error) return res.status(400).json({ message: startR.error });

        const endR = req.body.end_date !== undefined ? validateDateString(req.body.end_date, 'End date') : { value: existing.end_date };
        if (endR.error) return res.status(400).json({ message: endR.error });

        if (endR.value < startR.value) {
            return res.status(400).json({ message: 'End date must not be before start date' });
        }

        const rawStatus = req.body.status !== undefined ? req.body.status : existing.status;
        const statusR = validateEnum(rawStatus, 'Status', VALID_TERM_STATUSES);
        if (statusR.error) return res.status(400).json({ message: statusR.error });

        // Referenced academic year must exist
        const year = await AcademicYear.findById(ayR.value);
        if (!year) return res.status(404).json({ message: 'Referenced academic year not found' });

        // Term dates must be within academic year bounds
        if (startR.value < year.start_date || endR.value > year.end_date) {
            return res.status(400).json({ message: 'Term dates must be within the academic year date range.' });
        }

        await Term.findByIdAndUpdate(idR.value, {
            name: nameR.value,
            academic_year_id: ayR.value,
            start_date: startR.value,
            end_date: endR.value,
            status: statusR.value
        });

        res.json({ updated: 1 });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'A term with this name already exists in this academic year.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// DELETE: admin only
app.delete('/api/terms/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Term ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const term = await Term.findById(idR.value);
        if (!term) return res.status(404).json({ message: 'Term not found' });

        const examCount = await Exam.countDocuments({ term_id: idR.value });
        if (examCount > 0) {
            return res.status(409).json({
                success: false,
                message: 'Cannot delete term with existing exams.'
            });
        }

        await Term.findByIdAndDelete(idR.value);
        res.json({ deleted: 1 });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// 3. SUBJECTS
// ---------------------------------------------------------------------------

// READ: all authenticated roles
app.get('/api/subjects', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const subjects = await Subject.find().sort({ name: 1 });
        res.json(subjects.map(s => {
            const obj = s.toObject();
            obj.id = obj._id.toString();
            return obj;
        }));
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// READ single: all authenticated roles
app.get('/api/subjects/:id', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Subject ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const subject = await Subject.findById(idR.value);
        if (!subject) return res.status(404).json({ message: 'Subject not found' });

        const obj = subject.toObject();
        obj.id = obj._id.toString();
        res.json(obj);
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// CREATE: admin only
app.post('/api/subjects', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const nameR = validateString(req.body.name, 'Subject name', { maxLength: 100 });
        if (nameR.error) return res.status(400).json({ message: nameR.error });

        const codeR = validateString(req.body.code, 'Subject code', { maxLength: 20 });
        if (codeR.error) return res.status(400).json({ message: codeR.error });

        const descR = validateString(req.body.description, 'Description', { required: false, maxLength: 500 });
        if (descR.error) return res.status(400).json({ message: descR.error });

        const rawStatus = req.body.status !== undefined ? req.body.status : 'active';
        const statusR = validateEnum(rawStatus, 'Status', VALID_SUBJECT_STATUSES);
        if (statusR.error) return res.status(400).json({ message: statusR.error });

        const subject = await Subject.create({
            name: nameR.value,
            code: codeR.value.toUpperCase(),
            description: descR.value || '',
            status: statusR.value
        });

        const obj = subject.toObject();
        obj.id = obj._id.toString();
        res.status(201).json(obj);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'A subject with this code already exists.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// UPDATE: admin only
app.put('/api/subjects/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Subject ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const existing = await Subject.findById(idR.value);
        if (!existing) return res.status(404).json({ message: 'Subject not found' });

        const nameR = req.body.name !== undefined ? validateString(req.body.name, 'Subject name', { maxLength: 100 }) : { value: existing.name };
        if (nameR.error) return res.status(400).json({ message: nameR.error });

        const codeR = req.body.code !== undefined ? validateString(req.body.code, 'Subject code', { maxLength: 20 }) : { value: existing.code };
        if (codeR.error) return res.status(400).json({ message: codeR.error });

        const descR = req.body.description !== undefined ? validateString(req.body.description, 'Description', { required: false, maxLength: 500 }) : { value: existing.description };
        if (descR.error) return res.status(400).json({ message: descR.error });

        const rawStatus = req.body.status !== undefined ? req.body.status : existing.status;
        const statusR = validateEnum(rawStatus, 'Status', VALID_SUBJECT_STATUSES);
        if (statusR.error) return res.status(400).json({ message: statusR.error });

        await Subject.findByIdAndUpdate(idR.value, {
            name: nameR.value,
            code: codeR.value.toUpperCase(),
            description: descR.value || '',
            status: statusR.value
        });

        res.json({ updated: 1 });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'A subject with this code already exists.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// DELETE: admin only
app.delete('/api/subjects/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Subject ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const subject = await Subject.findById(idR.value);
        if (!subject) return res.status(404).json({ message: 'Subject not found' });

        const csCount = await ClassSubject.countDocuments({ subject_id: idR.value });
        if (csCount > 0) {
            return res.status(409).json({
                success: false,
                message: 'Cannot delete subject assigned to classes.'
            });
        }

        await Subject.findByIdAndDelete(idR.value);
        res.json({ deleted: 1 });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// 4. CLASS SUBJECTS (Relationship between Class, Subject, Academic Year, Teacher)
// ---------------------------------------------------------------------------

// READ: all authenticated roles
app.get('/api/class-subjects', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const query = {};
        if (req.query.class_id) {
            const cR = validateObjectId(req.query.class_id, 'Class ID');
            if (cR.error) return res.status(400).json({ message: cR.error });
            query.class_id = cR.value;
        }
        if (req.query.subject_id) {
            const sR = validateObjectId(req.query.subject_id, 'Subject ID');
            if (sR.error) return res.status(400).json({ message: sR.error });
            query.subject_id = sR.value;
        }
        if (req.query.academic_year_id) {
            const ayR = validateObjectId(req.query.academic_year_id, 'Academic Year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            query.academic_year_id = ayR.value;
        }
        if (req.query.teacher_id) {
            const tR = validateObjectId(req.query.teacher_id, 'Teacher ID');
            if (tR.error) return res.status(400).json({ message: tR.error });
            query.teacher_id = tR.value;
        }

        const assignments = await ClassSubject.find(query)
            .populate('class_id', 'name')
            .populate('subject_id', 'name code')
            .populate('academic_year_id', 'name status')
            .populate('teacher_id', 'name subject phone')
            .sort({ createdAt: -1 });

        res.json(assignments.map(cs => {
            const obj = cs.toObject();
            obj.id = obj._id.toString();
            obj.class_name = cs.class_id ? cs.class_id.name : null;
            obj.subject_name = cs.subject_id ? cs.subject_id.name : null;
            obj.subject_code = cs.subject_id ? cs.subject_id.code : null;
            obj.academic_year_name = cs.academic_year_id ? cs.academic_year_id.name : null;
            obj.teacher_name = cs.teacher_id ? cs.teacher_id.name : null;
            return obj;
        }));
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// READ single: all authenticated roles
app.get('/api/class-subjects/:id', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Class Subject ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const cs = await ClassSubject.findById(idR.value)
            .populate('class_id', 'name')
            .populate('subject_id', 'name code')
            .populate('academic_year_id', 'name status')
            .populate('teacher_id', 'name subject phone');

        if (!cs) return res.status(404).json({ message: 'Class subject assignment not found' });

        const obj = cs.toObject();
        obj.id = obj._id.toString();
        obj.class_name = cs.class_id ? cs.class_id.name : null;
        obj.subject_name = cs.subject_id ? cs.subject_id.name : null;
        obj.subject_code = cs.subject_id ? cs.subject_id.code : null;
        obj.academic_year_name = cs.academic_year_id ? cs.academic_year_id.name : null;
        obj.teacher_name = cs.teacher_id ? cs.teacher_id.name : null;
        res.json(obj);
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// CREATE: admin only
app.post('/api/class-subjects', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const classR = validateObjectId(req.body.class_id, 'Class ID');
        if (classR.error) return res.status(400).json({ message: classR.error });

        const subR = validateObjectId(req.body.subject_id, 'Subject ID');
        if (subR.error) return res.status(400).json({ message: subR.error });

        const ayR = validateObjectId(req.body.academic_year_id, 'Academic year ID');
        if (ayR.error) return res.status(400).json({ message: ayR.error });

        let teacherIdValue = null;
        if (req.body.teacher_id && req.body.teacher_id !== '') {
            const tR = validateObjectId(req.body.teacher_id, 'Teacher ID');
            if (tR.error) return res.status(400).json({ message: tR.error });
            const teacher = await Teacher.findById(tR.value);
            if (!teacher) return res.status(404).json({ message: 'Referenced teacher not found' });
            teacherIdValue = tR.value;
        }

        const rawStatus = req.body.status !== undefined ? req.body.status : 'active';
        const statusR = validateEnum(rawStatus, 'Status', VALID_CLASS_SUBJECT_STATUSES);
        if (statusR.error) return res.status(400).json({ message: statusR.error });

        // Verify referenced Class, Subject, AcademicYear exist
        const cls = await Class.findById(classR.value);
        if (!cls) return res.status(404).json({ message: 'Referenced class not found' });

        const sub = await Subject.findById(subR.value);
        if (!sub) return res.status(404).json({ message: 'Referenced subject not found' });

        const ay = await AcademicYear.findById(ayR.value);
        if (!ay) return res.status(404).json({ message: 'Referenced academic year not found' });

        const cs = await ClassSubject.create({
            class_id: classR.value,
            subject_id: subR.value,
            academic_year_id: ayR.value,
            teacher_id: teacherIdValue,
            status: statusR.value
        });

        const obj = cs.toObject();
        obj.id = obj._id.toString();
        res.status(201).json(obj);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'This subject is already assigned to this class for this academic year.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// UPDATE: admin only
app.put('/api/class-subjects/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Class Subject ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const existing = await ClassSubject.findById(idR.value);
        if (!existing) return res.status(404).json({ message: 'Class subject assignment not found' });

        const updateData = {};

        // teacher_id can be updated or unassigned (null)
        if (req.body.teacher_id !== undefined) {
            if (req.body.teacher_id === null || req.body.teacher_id === '') {
                updateData.teacher_id = null;
            } else {
                const tR = validateObjectId(req.body.teacher_id, 'Teacher ID');
                if (tR.error) return res.status(400).json({ message: tR.error });
                const teacher = await Teacher.findById(tR.value);
                if (!teacher) return res.status(404).json({ message: 'Referenced teacher not found' });
                updateData.teacher_id = tR.value;
            }
        }

        // status can be updated
        if (req.body.status !== undefined) {
            const statusR = validateEnum(req.body.status, 'Status', VALID_CLASS_SUBJECT_STATUSES);
            if (statusR.error) return res.status(400).json({ message: statusR.error });
            updateData.status = statusR.value;
        }

        // optional reassignments of class, subject, or academic year
        if (req.body.class_id !== undefined) {
            const classR = validateObjectId(req.body.class_id, 'Class ID');
            if (classR.error) return res.status(400).json({ message: classR.error });
            const cls = await Class.findById(classR.value);
            if (!cls) return res.status(404).json({ message: 'Referenced class not found' });
            updateData.class_id = classR.value;
        }

        if (req.body.subject_id !== undefined) {
            const subR = validateObjectId(req.body.subject_id, 'Subject ID');
            if (subR.error) return res.status(400).json({ message: subR.error });
            const sub = await Subject.findById(subR.value);
            if (!sub) return res.status(404).json({ message: 'Referenced subject not found' });
            updateData.subject_id = subR.value;
        }

        if (req.body.academic_year_id !== undefined) {
            const ayR = validateObjectId(req.body.academic_year_id, 'Academic year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            const ay = await AcademicYear.findById(ayR.value);
            if (!ay) return res.status(404).json({ message: 'Referenced academic year not found' });
            updateData.academic_year_id = ayR.value;
        }

        await ClassSubject.findByIdAndUpdate(idR.value, updateData);
        res.json({ updated: 1 });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'This subject is already assigned to this class for this academic year.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// DELETE: admin only
app.delete('/api/class-subjects/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Class Subject ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const cs = await ClassSubject.findById(idR.value);
        if (!cs) return res.status(404).json({ message: 'Class subject assignment not found' });

        await ClassSubject.findByIdAndDelete(idR.value);
        res.json({ deleted: 1 });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ===========================================================================
// 5. EXAM MANAGEMENT (P2 #2)
// CRUD, Integrity, Relational checks, Validation, and Filtering
// ===========================================================================

const VALID_EXAM_TYPES = ['Midterm', 'Final', 'Quiz', 'Assignment', 'Other'];
const VALID_EXAM_STATUSES = ['active', 'inactive'];

// READ: all authenticated roles (admin, teacher, student)
app.get('/api/exams', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const query = {};

        if (req.query.academic_year_id) {
            const ayR = validateObjectId(req.query.academic_year_id, 'Academic Year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            query.academic_year_id = ayR.value;
        }

        if (req.query.term_id) {
            const tR = validateObjectId(req.query.term_id, 'Term ID');
            if (tR.error) return res.status(400).json({ message: tR.error });
            query.term_id = tR.value;
        }

        if (req.query.class_id) {
            const cR = validateObjectId(req.query.class_id, 'Class ID');
            if (cR.error) return res.status(400).json({ message: cR.error });
            query.class_id = cR.value;
        }

        if (req.query.subject_id) {
            const sR = validateObjectId(req.query.subject_id, 'Subject ID');
            if (sR.error) return res.status(400).json({ message: sR.error });
            query.subject_id = sR.value;
        }

        if (req.query.status) {
            const stR = validateEnum(req.query.status, 'Status', VALID_EXAM_STATUSES);
            if (stR.error) return res.status(400).json({ message: stR.error });
            query.status = stR.value;
        }

        if (req.query.type) {
            const typeR = validateEnum(req.query.type, 'Exam type', VALID_EXAM_TYPES);
            if (typeR.error) return res.status(400).json({ message: typeR.error });
            query.type = typeR.value;
        }

        const exams = await Exam.find(query)
            .populate('academic_year_id', 'name status')
            .populate('term_id', 'name start_date end_date')
            .populate('class_id', 'name')
            .populate('subject_id', 'name code')
            .sort({ exam_date: -1, createdAt: -1 });

        res.json(exams.map(e => {
            const obj = e.toObject();
            obj.id = obj._id.toString();
            obj.academic_year_name = e.academic_year_id ? e.academic_year_id.name : null;
            obj.term_name = e.term_id ? e.term_id.name : null;
            obj.class_name = e.class_id ? e.class_id.name : null;
            obj.subject_name = e.subject_id ? e.subject_id.name : null;
            obj.subject_code = e.subject_id ? e.subject_id.code : null;
            return obj;
        }));
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// READ single: all authenticated roles
app.get('/api/exams/:id', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Exam ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const exam = await Exam.findById(idR.value)
            .populate('academic_year_id', 'name status')
            .populate('term_id', 'name start_date end_date')
            .populate('class_id', 'name')
            .populate('subject_id', 'name code');

        if (!exam) return res.status(404).json({ message: 'Exam not found' });

        const obj = exam.toObject();
        obj.id = obj._id.toString();
        obj.academic_year_name = exam.academic_year_id ? exam.academic_year_id.name : null;
        obj.term_name = exam.term_id ? exam.term_id.name : null;
        obj.class_name = exam.class_id ? exam.class_id.name : null;
        obj.subject_name = exam.subject_id ? exam.subject_id.name : null;
        obj.subject_code = exam.subject_id ? exam.subject_id.code : null;
        res.json(obj);
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// CREATE: admin only
app.post('/api/exams', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const nameR = validateString(req.body.name, 'Exam name', { maxLength: 100 });
        if (nameR.error) return res.status(400).json({ message: nameR.error });

        const typeR = validateEnum(req.body.type, 'Exam type', VALID_EXAM_TYPES);
        if (typeR.error) return res.status(400).json({ message: typeR.error });

        const ayR = validateObjectId(req.body.academic_year_id, 'Academic year ID');
        if (ayR.error) return res.status(400).json({ message: ayR.error });

        const termR = validateObjectId(req.body.term_id, 'Term ID');
        if (termR.error) return res.status(400).json({ message: termR.error });

        const classR = validateObjectId(req.body.class_id, 'Class ID');
        if (classR.error) return res.status(400).json({ message: classR.error });

        const subR = validateObjectId(req.body.subject_id, 'Subject ID');
        if (subR.error) return res.status(400).json({ message: subR.error });

        const dateR = validateDateString(req.body.exam_date, 'Exam date');
        if (dateR.error) return res.status(400).json({ message: dateR.error });

        const marksR = validatePositiveNumber(req.body.total_marks, 'Total marks');
        if (marksR.error) return res.status(400).json({ message: marksR.error });

        const rawStatus = req.body.status !== undefined ? req.body.status : 'active';
        const statusR = validateEnum(rawStatus, 'Status', VALID_EXAM_STATUSES);
        if (statusR.error) return res.status(400).json({ message: statusR.error });

        // Verify referenced records exist
        const ay = await AcademicYear.findById(ayR.value);
        if (!ay) return res.status(404).json({ message: 'Referenced academic year not found' });

        const term = await Term.findById(termR.value);
        if (!term) return res.status(404).json({ message: 'Referenced term not found' });

        // Term must belong to selected academic year
        if (term.academic_year_id.toString() !== ayR.value) {
            return res.status(400).json({ message: 'Selected term does not belong to the selected academic year' });
        }

        const cls = await Class.findById(classR.value);
        if (!cls) return res.status(404).json({ message: 'Referenced class not found' });

        const sub = await Subject.findById(subR.value);
        if (!sub) return res.status(404).json({ message: 'Referenced subject not found' });

        // Verify ClassSubject relationship exists for selected class, subject, and academic year
        const cs = await ClassSubject.findOne({
            class_id: classR.value,
            subject_id: subR.value,
            academic_year_id: ayR.value
        });
        if (!cs) {
            return res.status(400).json({ message: 'Selected subject is not assigned to this class for the selected academic year.' });
        }

        const exam = await Exam.create({
            name: nameR.value,
            type: typeR.value,
            academic_year_id: ayR.value,
            term_id: termR.value,
            class_id: classR.value,
            subject_id: subR.value,
            exam_date: dateR.value,
            total_marks: marksR.value,
            status: statusR.value
        });

        const obj = exam.toObject();
        obj.id = obj._id.toString();
        res.status(201).json(obj);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'An exam with this name already exists for this class, subject, and term.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// UPDATE: admin only
app.put('/api/exams/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Exam ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const existing = await Exam.findById(idR.value);
        if (!existing) return res.status(404).json({ message: 'Exam not found' });

        const updateData = {};

        if (req.body.name !== undefined) {
            const nameR = validateString(req.body.name, 'Exam name', { maxLength: 100 });
            if (nameR.error) return res.status(400).json({ message: nameR.error });
            updateData.name = nameR.value;
        }

        if (req.body.type !== undefined) {
            const typeR = validateEnum(req.body.type, 'Exam type', VALID_EXAM_TYPES);
            if (typeR.error) return res.status(400).json({ message: typeR.error });
            updateData.type = typeR.value;
        }

        if (req.body.exam_date !== undefined) {
            const dateR = validateDateString(req.body.exam_date, 'Exam date');
            if (dateR.error) return res.status(400).json({ message: dateR.error });
            updateData.exam_date = dateR.value;
        }

        if (req.body.total_marks !== undefined) {
            const marksR = validatePositiveNumber(req.body.total_marks, 'Total marks');
            if (marksR.error) return res.status(400).json({ message: marksR.error });
            updateData.total_marks = marksR.value;
        }

        if (req.body.status !== undefined) {
            const statusR = validateEnum(req.body.status, 'Status', VALID_EXAM_STATUSES);
            if (statusR.error) return res.status(400).json({ message: statusR.error });
            updateData.status = statusR.value;
        }

        if (req.body.academic_year_id !== undefined) {
            const ayR = validateObjectId(req.body.academic_year_id, 'Academic year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            updateData.academic_year_id = ayR.value;
        }

        if (req.body.term_id !== undefined) {
            const termR = validateObjectId(req.body.term_id, 'Term ID');
            if (termR.error) return res.status(400).json({ message: termR.error });
            updateData.term_id = termR.value;
        }

        if (req.body.class_id !== undefined) {
            const classR = validateObjectId(req.body.class_id, 'Class ID');
            if (classR.error) return res.status(400).json({ message: classR.error });
            updateData.class_id = classR.value;
        }

        if (req.body.subject_id !== undefined) {
            const subR = validateObjectId(req.body.subject_id, 'Subject ID');
            if (subR.error) return res.status(400).json({ message: subR.error });
            updateData.subject_id = subR.value;
        }

        // Integrity verification on target references
        const effectiveAY = updateData.academic_year_id || existing.academic_year_id.toString();
        const effectiveTerm = updateData.term_id || existing.term_id.toString();
        const effectiveClass = updateData.class_id || existing.class_id.toString();
        const effectiveSubject = updateData.subject_id || existing.subject_id.toString();

        if (updateData.academic_year_id || updateData.term_id || updateData.class_id || updateData.subject_id) {
            const ay = await AcademicYear.findById(effectiveAY);
            if (!ay) return res.status(404).json({ message: 'Referenced academic year not found' });

            const term = await Term.findById(effectiveTerm);
            if (!term) return res.status(404).json({ message: 'Referenced term not found' });

            if (term.academic_year_id.toString() !== effectiveAY) {
                return res.status(400).json({ message: 'Selected term does not belong to the selected academic year' });
            }

            const cls = await Class.findById(effectiveClass);
            if (!cls) return res.status(404).json({ message: 'Referenced class not found' });

            const sub = await Subject.findById(effectiveSubject);
            if (!sub) return res.status(404).json({ message: 'Referenced subject not found' });

            const cs = await ClassSubject.findOne({
                class_id: effectiveClass,
                subject_id: effectiveSubject,
                academic_year_id: effectiveAY
            });
            if (!cs) {
                return res.status(400).json({ message: 'Selected subject is not assigned to this class for the selected academic year.' });
            }
        }

        await Exam.findByIdAndUpdate(idR.value, updateData);
        res.json({ updated: 1 });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'An exam with this name already exists for this class, subject, and term.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// DELETE: admin only
app.delete('/api/exams/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Exam ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const exam = await Exam.findById(idR.value);
        if (!exam) return res.status(404).json({ message: 'Exam not found' });

        // Referential integrity: prevent deletion of exams with recorded marks
        const marksCount = await Mark.countDocuments({ exam_id: idR.value });
        if (marksCount > 0) return res.status(409).json({ message: 'Cannot delete exam with recorded marks. Delete marks first.' });

        await Exam.findByIdAndDelete(idR.value);
        res.json({ deleted: 1 });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// MARKS MANAGEMENT ENDPOINTS (P2 #3)
// ---------------------------------------------------------------------------

// LIST: all authenticated roles, filterable by exam_id, student_id, exam.class_id, exam.subject_id
app.get('/api/marks', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const query = {};

        if (req.query.exam_id) {
            const eR = validateObjectId(req.query.exam_id, 'Exam ID');
            if (eR.error) return res.status(400).json({ message: eR.error });
            query.exam_id = eR.value;
        }

        if (req.query.student_id) {
            const sR = validateObjectId(req.query.student_id, 'Student ID');
            if (sR.error) return res.status(400).json({ message: sR.error });
            query.student_id = sR.value;
        }

        let marks = await Mark.find(query)
            .populate({
                path: 'exam_id',
                select: 'name type total_marks exam_date class_id subject_id academic_year_id term_id',
                populate: [
                    { path: 'class_id', select: 'name' },
                    { path: 'subject_id', select: 'name code' },
                    { path: 'academic_year_id', select: 'name' },
                    { path: 'term_id', select: 'name' }
                ]
            })
            .populate('student_id', 'full_name id_number class_name')
            .sort({ createdAt: -1 });

        // Server-side filtering by class_id or subject_id (via populated exam)
        if (req.query.class_id) {
            const cR = validateObjectId(req.query.class_id, 'Class ID');
            if (cR.error) return res.status(400).json({ message: cR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.class_id && m.exam_id.class_id._id.toString() === cR.value);
        }

        if (req.query.subject_id) {
            const sR = validateObjectId(req.query.subject_id, 'Subject ID');
            if (sR.error) return res.status(400).json({ message: sR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.subject_id && m.exam_id.subject_id._id.toString() === sR.value);
        }

        res.json(marks.map(m => {
            const obj = m.toObject();
            obj.id = obj._id.toString();
            obj.exam_name = m.exam_id ? m.exam_id.name : null;
            obj.exam_type = m.exam_id ? m.exam_id.type : null;
            obj.exam_total_marks = m.exam_id ? m.exam_id.total_marks : null;
            obj.student_name = m.student_id ? m.student_id.full_name : null;
            obj.student_id_number = m.student_id ? m.student_id.id_number : null;
            obj.class_name = m.exam_id && m.exam_id.class_id ? m.exam_id.class_id.name : null;
            obj.subject_name = m.exam_id && m.exam_id.subject_id ? m.exam_id.subject_id.name : null;
            obj.subject_code = m.exam_id && m.exam_id.subject_id ? m.exam_id.subject_id.code : null;
            obj.academic_year_name = m.exam_id && m.exam_id.academic_year_id ? m.exam_id.academic_year_id.name : null;
            obj.term_name = m.exam_id && m.exam_id.term_id ? m.exam_id.term_id.name : null;
            return obj;
        }));
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// READ single: all authenticated roles
app.get('/api/marks/:id', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Mark ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const mark = await Mark.findById(idR.value)
            .populate({
                path: 'exam_id',
                select: 'name type total_marks exam_date class_id subject_id academic_year_id term_id',
                populate: [
                    { path: 'class_id', select: 'name' },
                    { path: 'subject_id', select: 'name code' },
                    { path: 'academic_year_id', select: 'name' },
                    { path: 'term_id', select: 'name' }
                ]
            })
            .populate('student_id', 'full_name id_number class_name');

        if (!mark) return res.status(404).json({ message: 'Mark not found' });

        const obj = mark.toObject();
        obj.id = obj._id.toString();
        obj.exam_name = mark.exam_id ? mark.exam_id.name : null;
        obj.exam_total_marks = mark.exam_id ? mark.exam_id.total_marks : null;
        obj.student_name = mark.student_id ? mark.student_id.full_name : null;
        obj.student_id_number = mark.student_id ? mark.student_id.id_number : null;
        res.json(obj);
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// CREATE: admin only
app.post('/api/marks', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const examR = validateObjectId(req.body.exam_id, 'Exam ID');
        if (examR.error) return res.status(400).json({ message: examR.error });

        const studentR = validateObjectId(req.body.student_id, 'Student ID');
        if (studentR.error) return res.status(400).json({ message: studentR.error });

        // marks_obtained validated as number >= 0
        const moR = validatePositiveNumber(req.body.marks_obtained, 'Marks obtained', { min: 0 });
        if (moR.error) return res.status(400).json({ message: moR.error });

        // Optional remarks
        let remarksVal = '';
        if (req.body.remarks !== undefined && req.body.remarks !== null && req.body.remarks !== '') {
            const remR = validateString(req.body.remarks, 'Remarks', { required: false, maxLength: 500 });
            if (remR.error) return res.status(400).json({ message: remR.error });
            remarksVal = remR.value;
        }

        // Verify referenced exam exists
        const exam = await Exam.findById(examR.value);
        if (!exam) return res.status(404).json({ message: 'Referenced exam not found' });

        // Verify referenced student exists
        const student = await Student.findById(studentR.value);
        if (!student) return res.status(404).json({ message: 'Referenced student not found' });

        // Marks obtained cannot exceed the exam's total_marks
        if (moR.value > exam.total_marks) {
            return res.status(400).json({ message: `Marks obtained (${moR.value}) cannot exceed exam total marks (${exam.total_marks})` });
        }

        const mark = await Mark.create({
            exam_id: examR.value,
            student_id: studentR.value,
            marks_obtained: moR.value,
            remarks: remarksVal
        });

        const obj = mark.toObject();
        obj.id = obj._id.toString();
        res.status(201).json(obj);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'This student already has marks recorded for this exam.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// UPDATE: admin only
app.put('/api/marks/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Mark ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const existing = await Mark.findById(idR.value);
        if (!existing) return res.status(404).json({ message: 'Mark not found' });

        const updateData = {};

        if (req.body.exam_id !== undefined) {
            const examR = validateObjectId(req.body.exam_id, 'Exam ID');
            if (examR.error) return res.status(400).json({ message: examR.error });
            updateData.exam_id = examR.value;
        }

        if (req.body.student_id !== undefined) {
            const studentR = validateObjectId(req.body.student_id, 'Student ID');
            if (studentR.error) return res.status(400).json({ message: studentR.error });
            updateData.student_id = studentR.value;
        }

        if (req.body.marks_obtained !== undefined) {
            const moR = validatePositiveNumber(req.body.marks_obtained, 'Marks obtained', { min: 0 });
            if (moR.error) return res.status(400).json({ message: moR.error });
            updateData.marks_obtained = moR.value;
        }

        if (req.body.remarks !== undefined) {
            if (req.body.remarks === null || req.body.remarks === '') {
                updateData.remarks = '';
            } else {
                const remR = validateString(req.body.remarks, 'Remarks', { required: false, maxLength: 500 });
                if (remR.error) return res.status(400).json({ message: remR.error });
                updateData.remarks = remR.value;
            }
        }

        // Integrity checks on referenced records
        const effectiveExamId = updateData.exam_id || existing.exam_id.toString();
        const effectiveStudentId = updateData.student_id || existing.student_id.toString();

        if (updateData.exam_id) {
            const exam = await Exam.findById(updateData.exam_id);
            if (!exam) return res.status(404).json({ message: 'Referenced exam not found' });
        }

        if (updateData.student_id) {
            const student = await Student.findById(updateData.student_id);
            if (!student) return res.status(404).json({ message: 'Referenced student not found' });
        }

        // Validate marks_obtained against exam total_marks
        if (updateData.marks_obtained !== undefined) {
            const exam = await Exam.findById(effectiveExamId);
            if (exam && updateData.marks_obtained > exam.total_marks) {
                return res.status(400).json({ message: `Marks obtained (${updateData.marks_obtained}) cannot exceed exam total marks (${exam.total_marks})` });
            }
        }

        await Mark.findByIdAndUpdate(idR.value, updateData);
        res.json({ updated: 1 });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ success: false, message: 'This student already has marks recorded for this exam.' });
        }
        res.status(400).json({ error: err.message });
    }
});

// DELETE: admin only
app.delete('/api/marks/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Mark ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const mark = await Mark.findById(idR.value);
        if (!mark) return res.status(404).json({ message: 'Mark not found' });

        await Mark.findByIdAndDelete(idR.value);
        res.json({ deleted: 1 });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ===========================================================================
// 6. RESULTS MANAGEMENT (P2 #4)
// Dynamic calculation from Marks, grading, subject and term aggregation
// ===========================================================================

/**
 * Centralized Grading Scale Helper (P2 #4)
 * Scale:
 *  90 – 100  : A+
 *  80 – 89.99: A
 *  70 – 79.99: B
 *  60 – 69.99: C
 *  50 – 59.99: D
 *   0 – 49.99: F
 *
 *  Pass: percentage >= 50
 *  Fail: percentage < 50
 */
function calculateGrade(percentage) {
    if (typeof percentage !== 'number' || isNaN(percentage) || percentage < 0) {
        return { grade: 'N/A', status: 'N/A', is_pass: false };
    }
    const pct = Math.round(percentage * 100) / 100;
    let grade = 'F';
    if (pct >= 90) grade = 'A+';
    else if (pct >= 80) grade = 'A';
    else if (pct >= 70) grade = 'B';
    else if (pct >= 60) grade = 'C';
    else if (pct >= 50) grade = 'D';
    else grade = 'F';

    const is_pass = pct >= 50;
    const status = is_pass ? 'Pass' : 'Fail';
    return { grade, status, is_pass };
}

/**
 * Calculates percentage rounded to 2 decimal places.
 * Prevents division by zero.
 */
function calculatePercentage(obtained, possible) {
    if (!possible || possible <= 0) return 0;
    const pct = (obtained / possible) * 100;
    return Math.round(pct * 100) / 100;
}

/**
 * Resolves student ID corresponding to authenticated user for student-ownership RBAC.
 */
async function resolveStudentIdForUser(user) {
    if (!user || user.role !== 'student') return null;
    if (user.student_id) return user.student_id.toString();
    if (user.id) {
        const dbUser = await User.findById(user.id);
        if (dbUser) {
            if (dbUser.student_id) return dbUser.student_id.toString();
            if (dbUser.username) {
                const byIdNumber = await Student.findOne({ id_number: dbUser.username });
                if (byIdNumber) return byIdNumber._id.toString();
            }
        }
    }
    const byId = await Student.findById(user.id);
    if (byId) return byId._id.toString();
    if (user.username) {
        const byIdNumber = await Student.findOne({ id_number: user.username });
        if (byIdNumber) return byIdNumber._id.toString();
    }
    return null;
}

/**
 * Verifies student access permission for Results.
 * Admin and Teacher have read access.
 * Student role is restricted to viewing ONLY their own results.
 */
async function checkStudentResultAccess(req, targetStudentId) {
    if (req.user.role === 'admin' || req.user.role === 'teacher') {
        return { allowed: true };
    }
    if (req.user.role === 'student') {
        const myStudentId = await resolveStudentIdForUser(req.user);
        if (!myStudentId || myStudentId !== targetStudentId.toString()) {
            return {
                allowed: false,
                status: 403,
                message: 'Access denied. Students may only view their own results.'
            };
        }
        return { allowed: true, studentId: myStudentId };
    }
    return { allowed: false, status: 403, message: 'Invalid role' };
}

// 1. LIST RESULTS: all authenticated roles (student restricted to own results)
app.get('/api/results', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const query = {};

        // If student role, enforce restriction to own student record
        if (req.user.role === 'student') {
            const myStudentId = await resolveStudentIdForUser(req.user);
            if (!myStudentId) {
                return res.status(403).json({ message: 'Access denied. Student record not linked.' });
            }
            if (req.query.student_id && req.query.student_id !== myStudentId) {
                return res.status(403).json({ message: 'Access denied. Students may only view their own results.' });
            }
            query.student_id = myStudentId;
        } else if (req.query.student_id) {
            const sR = validateObjectId(req.query.student_id, 'Student ID');
            if (sR.error) return res.status(400).json({ message: sR.error });
            query.student_id = sR.value;
        }

        if (req.query.exam_id) {
            const eR = validateObjectId(req.query.exam_id, 'Exam ID');
            if (eR.error) return res.status(400).json({ message: eR.error });
            query.exam_id = eR.value;
        }

        let marks = await Mark.find(query)
            .populate({
                path: 'exam_id',
                select: 'name type total_marks exam_date class_id subject_id academic_year_id term_id',
                populate: [
                    { path: 'class_id', select: 'name' },
                    { path: 'subject_id', select: 'name code' },
                    { path: 'academic_year_id', select: 'name' },
                    { path: 'term_id', select: 'name' }
                ]
            })
            .populate('student_id', 'full_name id_number class_name')
            .sort({ createdAt: -1 });

        // Server-side filtering by class_id, subject_id, academic_year_id, term_id
        if (req.query.class_id) {
            const cR = validateObjectId(req.query.class_id, 'Class ID');
            if (cR.error) return res.status(400).json({ message: cR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.class_id && m.exam_id.class_id._id.toString() === cR.value);
        }

        if (req.query.subject_id) {
            const subR = validateObjectId(req.query.subject_id, 'Subject ID');
            if (subR.error) return res.status(400).json({ message: subR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.subject_id && m.exam_id.subject_id._id.toString() === subR.value);
        }

        if (req.query.academic_year_id) {
            const ayR = validateObjectId(req.query.academic_year_id, 'Academic Year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.academic_year_id && m.exam_id.academic_year_id._id.toString() === ayR.value);
        }

        if (req.query.term_id) {
            const tR = validateObjectId(req.query.term_id, 'Term ID');
            if (tR.error) return res.status(400).json({ message: tR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.term_id && m.exam_id.term_id._id.toString() === tR.value);
        }

        const results = marks.map(m => {
            const totalMarks = m.exam_id ? m.exam_id.total_marks : 0;
            const marksObtained = m.marks_obtained;
            const percentage = calculatePercentage(marksObtained, totalMarks);
            const { grade, status, is_pass } = calculateGrade(percentage);

            return {
                id: m._id.toString(),
                mark_id: m._id.toString(),
                student_id: m.student_id ? m.student_id._id.toString() : null,
                student_name: m.student_id ? m.student_id.full_name : null,
                student_id_number: m.student_id ? m.student_id.id_number : null,
                student_class_name: m.student_id ? m.student_id.class_name : null,
                class_id: m.exam_id && m.exam_id.class_id ? m.exam_id.class_id._id.toString() : null,
                class_name: m.exam_id && m.exam_id.class_id ? m.exam_id.class_id.name : null,
                subject_id: m.exam_id && m.exam_id.subject_id ? m.exam_id.subject_id._id.toString() : null,
                subject_name: m.exam_id && m.exam_id.subject_id ? m.exam_id.subject_id.name : null,
                subject_code: m.exam_id && m.exam_id.subject_id ? m.exam_id.subject_id.code : null,
                exam_id: m.exam_id ? m.exam_id._id.toString() : null,
                exam_name: m.exam_id ? m.exam_id.name : null,
                exam_type: m.exam_id ? m.exam_id.type : null,
                exam_date: m.exam_id ? m.exam_id.exam_date : null,
                academic_year_id: m.exam_id && m.exam_id.academic_year_id ? m.exam_id.academic_year_id._id.toString() : null,
                academic_year_name: m.exam_id && m.exam_id.academic_year_id ? m.exam_id.academic_year_id.name : null,
                term_id: m.exam_id && m.exam_id.term_id ? m.exam_id.term_id._id.toString() : null,
                term_name: m.exam_id && m.exam_id.term_id ? m.exam_id.term_id.name : null,
                marks_obtained: marksObtained,
                total_marks: totalMarks,
                percentage,
                grade,
                status,
                is_pass,
                remarks: m.remarks || ''
            };
        });

        res.json(results);
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 2. STUDENT RESULTS SUMMARY: all authenticated roles (student restricted to own results)
app.get('/api/results/student/:studentId', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const sR = validateObjectId(req.params.studentId, 'Student ID');
        if (sR.error) return res.status(400).json({ message: sR.error });

        const access = await checkStudentResultAccess(req, sR.value);
        if (!access.allowed) {
            return res.status(access.status).json({ message: access.message });
        }

        const student = await Student.findById(sR.value);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        const query = { student_id: sR.value };
        if (req.query.exam_id) {
            const eR = validateObjectId(req.query.exam_id, 'Exam ID');
            if (eR.error) return res.status(400).json({ message: eR.error });
            query.exam_id = eR.value;
        }

        let marks = await Mark.find(query)
            .populate({
                path: 'exam_id',
                select: 'name type total_marks exam_date class_id subject_id academic_year_id term_id',
                populate: [
                    { path: 'class_id', select: 'name' },
                    { path: 'subject_id', select: 'name code' },
                    { path: 'academic_year_id', select: 'name' },
                    { path: 'term_id', select: 'name' }
                ]
            })
            .sort({ createdAt: -1 });

        if (req.query.class_id) {
            const cR = validateObjectId(req.query.class_id, 'Class ID');
            if (cR.error) return res.status(400).json({ message: cR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.class_id && m.exam_id.class_id._id.toString() === cR.value);
        }

        if (req.query.subject_id) {
            const subR = validateObjectId(req.query.subject_id, 'Subject ID');
            if (subR.error) return res.status(400).json({ message: subR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.subject_id && m.exam_id.subject_id._id.toString() === subR.value);
        }

        if (req.query.academic_year_id) {
            const ayR = validateObjectId(req.query.academic_year_id, 'Academic Year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.academic_year_id && m.exam_id.academic_year_id._id.toString() === ayR.value);
        }

        if (req.query.term_id) {
            const tR = validateObjectId(req.query.term_id, 'Term ID');
            if (tR.error) return res.status(400).json({ message: tR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.term_id && m.exam_id.term_id._id.toString() === tR.value);
        }

        let totalObtained = 0;
        let totalPossible = 0;

        const examResults = marks.map(m => {
            const totalMarks = m.exam_id ? m.exam_id.total_marks : 0;
            const marksObtained = m.marks_obtained;
            totalObtained += marksObtained;
            totalPossible += totalMarks;
            const percentage = calculatePercentage(marksObtained, totalMarks);
            const { grade, status, is_pass } = calculateGrade(percentage);

            return {
                id: m._id.toString(),
                mark_id: m._id.toString(),
                exam_id: m.exam_id ? m.exam_id._id.toString() : null,
                exam_name: m.exam_id ? m.exam_id.name : null,
                exam_type: m.exam_id ? m.exam_id.type : null,
                exam_date: m.exam_id ? m.exam_id.exam_date : null,
                class_id: m.exam_id && m.exam_id.class_id ? m.exam_id.class_id._id.toString() : null,
                class_name: m.exam_id && m.exam_id.class_id ? m.exam_id.class_id.name : null,
                subject_id: m.exam_id && m.exam_id.subject_id ? m.exam_id.subject_id._id.toString() : null,
                subject_name: m.exam_id && m.exam_id.subject_id ? m.exam_id.subject_id.name : null,
                subject_code: m.exam_id && m.exam_id.subject_id ? m.exam_id.subject_id.code : null,
                academic_year_id: m.exam_id && m.exam_id.academic_year_id ? m.exam_id.academic_year_id._id.toString() : null,
                academic_year_name: m.exam_id && m.exam_id.academic_year_id ? m.exam_id.academic_year_id.name : null,
                term_id: m.exam_id && m.exam_id.term_id ? m.exam_id.term_id._id.toString() : null,
                term_name: m.exam_id && m.exam_id.term_id ? m.exam_id.term_id.name : null,
                marks_obtained: marksObtained,
                total_marks: totalMarks,
                percentage,
                grade,
                status,
                is_pass,
                remarks: m.remarks || ''
            };
        });

        const overallPercentage = calculatePercentage(totalObtained, totalPossible);
        const { grade: overallGrade, status: overallStatus, is_pass: overallPass } = totalPossible > 0
            ? calculateGrade(overallPercentage)
            : { grade: 'N/A', status: 'No Marks', is_pass: false };

        res.json({
            student: {
                id: student._id.toString(),
                full_name: student.full_name,
                id_number: student.id_number,
                class_name: student.class_name
            },
            totals: {
                exams_count: examResults.length,
                total_obtained: totalObtained,
                total_possible: totalPossible,
                percentage: overallPercentage,
                grade: overallGrade,
                status: overallStatus,
                is_pass: overallPass
            },
            exam_results: examResults
        });
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 3. STUDENT SUBJECT RESULT: all authenticated roles (student restricted to own results)
app.get('/api/results/student/:studentId/subject/:subjectId', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const sR = validateObjectId(req.params.studentId, 'Student ID');
        if (sR.error) return res.status(400).json({ message: sR.error });

        const subR = validateObjectId(req.params.subjectId, 'Subject ID');
        if (subR.error) return res.status(400).json({ message: subR.error });

        const access = await checkStudentResultAccess(req, sR.value);
        if (!access.allowed) {
            return res.status(access.status).json({ message: access.message });
        }

        const student = await Student.findById(sR.value);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        const subject = await Subject.findById(subR.value);
        if (!subject) return res.status(404).json({ message: 'Subject not found' });

        let marks = await Mark.find({ student_id: sR.value })
            .populate({
                path: 'exam_id',
                select: 'name type total_marks exam_date class_id subject_id academic_year_id term_id',
                populate: [
                    { path: 'class_id', select: 'name' },
                    { path: 'subject_id', select: 'name code' },
                    { path: 'academic_year_id', select: 'name' },
                    { path: 'term_id', select: 'name' }
                ]
            })
            .sort({ createdAt: -1 });

        // Filter for this specific subject
        marks = marks.filter(m => m.exam_id && m.exam_id.subject_id && m.exam_id.subject_id._id.toString() === subR.value);

        if (req.query.academic_year_id) {
            const ayR = validateObjectId(req.query.academic_year_id, 'Academic Year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.academic_year_id && m.exam_id.academic_year_id._id.toString() === ayR.value);
        }

        if (req.query.term_id) {
            const tR = validateObjectId(req.query.term_id, 'Term ID');
            if (tR.error) return res.status(400).json({ message: tR.error });
            marks = marks.filter(m => m.exam_id && m.exam_id.term_id && m.exam_id.term_id._id.toString() === tR.value);
        }

        let totalObtained = 0;
        let totalPossible = 0;

        const examsList = marks.map(m => {
            const tMarks = m.exam_id ? m.exam_id.total_marks : 0;
            const mObt = m.marks_obtained;
            totalObtained += mObt;
            totalPossible += tMarks;
            const pct = calculatePercentage(mObt, tMarks);
            const { grade, status, is_pass } = calculateGrade(pct);

            return {
                id: m._id.toString(),
                exam_id: m.exam_id ? m.exam_id._id.toString() : null,
                exam_name: m.exam_id ? m.exam_id.name : null,
                exam_type: m.exam_id ? m.exam_id.type : null,
                exam_date: m.exam_id ? m.exam_id.exam_date : null,
                academic_year_name: m.exam_id && m.exam_id.academic_year_id ? m.exam_id.academic_year_id.name : null,
                term_name: m.exam_id && m.exam_id.term_id ? m.exam_id.term_id.name : null,
                marks_obtained: mObt,
                total_marks: tMarks,
                percentage: pct,
                grade,
                status,
                is_pass
            };
        });

        const percentage = calculatePercentage(totalObtained, totalPossible);
        const { grade, status, is_pass } = totalPossible > 0
            ? calculateGrade(percentage)
            : { grade: 'N/A', status: 'No Marks', is_pass: false };

        res.json({
            student: {
                id: student._id.toString(),
                full_name: student.full_name,
                id_number: student.id_number,
                class_name: student.class_name
            },
            subject: {
                id: subject._id.toString(),
                name: subject.name,
                code: subject.code
            },
            total_obtained: totalObtained,
            total_possible: totalPossible,
            percentage,
            grade,
            status,
            is_pass,
            exams_count: examsList.length,
            exams: examsList
        });
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 4. STUDENT TERM RESULT: all authenticated roles (student restricted to own results)
app.get('/api/results/student/:studentId/term/:termId', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const sR = validateObjectId(req.params.studentId, 'Student ID');
        if (sR.error) return res.status(400).json({ message: sR.error });

        const tR = validateObjectId(req.params.termId, 'Term ID');
        if (tR.error) return res.status(400).json({ message: tR.error });

        const access = await checkStudentResultAccess(req, sR.value);
        if (!access.allowed) {
            return res.status(access.status).json({ message: access.message });
        }

        const student = await Student.findById(sR.value);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        const term = await Term.findById(tR.value).populate('academic_year_id', 'name');
        if (!term) return res.status(404).json({ message: 'Term not found' });

        const marks = await Mark.find({ student_id: sR.value })
            .populate({
                path: 'exam_id',
                select: 'name type total_marks exam_date class_id subject_id academic_year_id term_id',
                populate: [
                    { path: 'subject_id', select: 'name code' }
                ]
            })
            .sort({ createdAt: 1 });

        // Filter for this term
        const termMarks = marks.filter(m => m.exam_id && m.exam_id.term_id && m.exam_id.term_id.toString() === tR.value);

        // Group by subject_id
        const subjectMap = new Map();
        for (const m of termMarks) {
            if (!m.exam_id || !m.exam_id.subject_id) continue;
            const subId = m.exam_id.subject_id._id.toString();
            if (!subjectMap.has(subId)) {
                subjectMap.set(subId, {
                    subject_id: subId,
                    subject_name: m.exam_id.subject_id.name,
                    subject_code: m.exam_id.subject_id.code,
                    total_obtained: 0,
                    total_possible: 0,
                    exams: []
                });
            }
            const sGroup = subjectMap.get(subId);
            const tMarks = m.exam_id.total_marks || 0;
            const mObt = m.marks_obtained;
            sGroup.total_obtained += mObt;
            sGroup.total_possible += tMarks;
            const pct = calculatePercentage(mObt, tMarks);
            const { grade, status, is_pass } = calculateGrade(pct);
            sGroup.exams.push({
                exam_id: m.exam_id._id.toString(),
                exam_name: m.exam_id.name,
                exam_type: m.exam_id.type,
                marks_obtained: mObt,
                total_marks: tMarks,
                percentage: pct,
                grade,
                status,
                is_pass
            });
        }

        let totalObtained = 0;
        let totalPossible = 0;
        let passCount = 0;
        let failCount = 0;

        const subjectResults = Array.from(subjectMap.values()).map(sub => {
            const pct = calculatePercentage(sub.total_obtained, sub.total_possible);
            const { grade, status, is_pass } = sub.total_possible > 0
                ? calculateGrade(pct)
                : { grade: 'N/A', status: 'No Marks', is_pass: false };

            totalObtained += sub.total_obtained;
            totalPossible += sub.total_possible;

            if (is_pass) passCount++;
            else failCount++;

            return {
                subject_id: sub.subject_id,
                subject_name: sub.subject_name,
                subject_code: sub.subject_code,
                total_obtained: sub.total_obtained,
                total_possible: sub.total_possible,
                percentage: pct,
                grade,
                status,
                is_pass,
                exams_count: sub.exams.length,
                exams: sub.exams
            };
        });

        const overallPercentage = calculatePercentage(totalObtained, totalPossible);
        const { grade: overallGrade } = totalPossible > 0
            ? calculateGrade(overallPercentage)
            : { grade: 'N/A' };

        let overallStatus = 'No Marks';
        if (subjectResults.length > 0) {
            overallStatus = failCount === 0 ? 'Pass' : 'Fail';
        }

        res.json({
            student: {
                id: student._id.toString(),
                full_name: student.full_name,
                id_number: student.id_number,
                class_name: student.class_name
            },
            academic_year: {
                id: term.academic_year_id ? term.academic_year_id._id.toString() : null,
                name: term.academic_year_id ? term.academic_year_id.name : null
            },
            term: {
                id: term._id.toString(),
                name: term.name
            },
            subjects_count: subjectResults.length,
            total_obtained: totalObtained,
            total_possible: totalPossible,
            overall_percentage: overallPercentage,
            grade: overallGrade,
            pass_count: passCount,
            fail_count: failCount,
            overall_status: overallStatus,
            subject_results: subjectResults
        });
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// ===========================================================================
// REPORTS MANAGEMENT APIs (P2 #5)
// Dynamically derived from Marks and Results — NO persistent collection.
// Source of truth: Mark model.
// Grading logic reused from calculateGrade() and calculatePercentage().
// ===========================================================================

// 1. STUDENT REPORT: GET /api/reports/student/:studentId
// Query params: academic_year_id, term_id
// RBAC: Admin and Teacher full read; Student restricted to own report.
app.get('/api/reports/student/:studentId', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const sR = validateObjectId(req.params.studentId, 'Student ID');
        if (sR.error) return res.status(400).json({ message: sR.error });

        const access = await checkStudentResultAccess(req, sR.value);
        if (!access.allowed) {
            return res.status(access.status).json({ message: access.message });
        }

        const student = await Student.findById(sR.value);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        let ayInfo = null;
        if (req.query.academic_year_id) {
            const ayR = validateObjectId(req.query.academic_year_id, 'Academic Year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            const ayDoc = await AcademicYear.findById(ayR.value);
            if (!ayDoc) return res.status(404).json({ message: 'Academic Year not found' });
            ayInfo = { id: ayDoc._id.toString(), name: ayDoc.name };
        }

        let termInfo = null;
        if (req.query.term_id) {
            const tR = validateObjectId(req.query.term_id, 'Term ID');
            if (tR.error) return res.status(400).json({ message: tR.error });
            const termDoc = await Term.findById(tR.value);
            if (!termDoc) return res.status(404).json({ message: 'Term not found' });
            termInfo = { id: termDoc._id.toString(), name: termDoc.name };
        }

        const query = { student_id: sR.value };
        const marks = await Mark.find(query)
            .populate({
                path: 'exam_id',
                select: 'name type total_marks exam_date class_id subject_id academic_year_id term_id',
                populate: [
                    { path: 'class_id', select: 'name' },
                    { path: 'subject_id', select: 'name code' },
                    { path: 'academic_year_id', select: 'name' },
                    { path: 'term_id', select: 'name' }
                ]
            })
            .sort({ createdAt: 1 });

        // Filter marks in-memory
        let filteredMarks = marks.filter(m => m.exam_id);
        if (req.query.academic_year_id) {
            filteredMarks = filteredMarks.filter(m => m.exam_id.academic_year_id && m.exam_id.academic_year_id._id.toString() === req.query.academic_year_id);
        }
        if (req.query.term_id) {
            filteredMarks = filteredMarks.filter(m => m.exam_id.term_id && m.exam_id.term_id._id.toString() === req.query.term_id);
        }

        // Infer academic year / term if not passed as query but present in marks
        if (!ayInfo && filteredMarks.length > 0 && filteredMarks[0].exam_id.academic_year_id) {
            ayInfo = {
                id: filteredMarks[0].exam_id.academic_year_id._id.toString(),
                name: filteredMarks[0].exam_id.academic_year_id.name
            };
        }
        if (!termInfo && filteredMarks.length > 0 && filteredMarks[0].exam_id.term_id) {
            termInfo = {
                id: filteredMarks[0].exam_id.term_id._id.toString(),
                name: filteredMarks[0].exam_id.term_id.name
            };
        }

        // Group by subject
        const subjectMap = new Map();
        for (const m of filteredMarks) {
            const sub = m.exam_id.subject_id;
            const subId = sub ? sub._id.toString() : 'unknown';
            if (!subjectMap.has(subId)) {
                subjectMap.set(subId, {
                    subject_id: sub ? subId : null,
                    subject_name: sub ? sub.name : 'Unknown Subject',
                    subject_code: sub ? sub.code : '',
                    marks_obtained: 0,
                    total_marks: 0,
                    exams: []
                });
            }
            const sGroup = subjectMap.get(subId);
            const tMarks = m.exam_id.total_marks || 0;
            const mObt = m.marks_obtained;
            sGroup.marks_obtained += mObt;
            sGroup.total_marks += tMarks;

            const examPct = calculatePercentage(mObt, tMarks);
            const { grade: examGrade, status: examStatus, is_pass: examPass } = calculateGrade(examPct);

            sGroup.exams.push({
                exam_id: m.exam_id._id.toString(),
                exam_name: m.exam_id.name,
                exam_type: m.exam_id.type,
                exam_date: m.exam_id.exam_date || '',
                marks_obtained: mObt,
                total_marks: tMarks,
                percentage: examPct,
                grade: examGrade,
                status: examStatus,
                is_pass: examPass,
                remarks: m.remarks || ''
            });
        }

        let totalObtained = 0;
        let totalPossible = 0;
        let passedSubjects = 0;
        let failedSubjects = 0;
        let totalExamsCount = 0;

        const subjectsList = Array.from(subjectMap.values()).map(sub => {
            const pct = calculatePercentage(sub.marks_obtained, sub.total_marks);
            const { grade, status, is_pass } = sub.total_marks > 0
                ? calculateGrade(pct)
                : { grade: 'N/A', status: 'No Marks', is_pass: false };

            totalObtained += sub.marks_obtained;
            totalPossible += sub.total_marks;
            totalExamsCount += sub.exams.length;

            if (is_pass) passedSubjects++;
            else failedSubjects++;

            return {
                subject_id: sub.subject_id,
                subject_name: sub.subject_name,
                subject_code: sub.subject_code,
                marks_obtained: sub.marks_obtained,
                total_marks: sub.total_marks,
                percentage: pct,
                grade,
                status,
                is_pass,
                exams_count: sub.exams.length,
                exams: sub.exams
            };
        });

        const overallPercentage = calculatePercentage(totalObtained, totalPossible);
        const { grade: overallGrade } = totalPossible > 0
            ? calculateGrade(overallPercentage)
            : { grade: 'N/A' };

        let overallStatus = 'No Marks';
        if (subjectsList.length > 0) {
            overallStatus = failedSubjects === 0 ? 'Pass' : 'Fail';
        }

        res.json({
            student: {
                id: student._id.toString(),
                full_name: student.full_name,
                id_number: student.id_number,
                class_name: student.class_name
            },
            academic_year: ayInfo,
            term: termInfo,
            summary: {
                total_obtained: totalObtained,
                total_possible: totalPossible,
                overall_percentage: overallPercentage,
                overall_grade: overallGrade,
                overall_status: overallStatus,
                subjects_count: subjectsList.length,
                passed_subjects: passedSubjects,
                failed_subjects: failedSubjects,
                exams_count: totalExamsCount
            },
            subjects: subjectsList
        });
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 2. CLASS REPORT: GET /api/reports/class/:classId
// Query params: academic_year_id, term_id, subject_id
// RBAC: Admin & Teacher only. Students get 403.
app.get('/api/reports/class/:classId', authenticateJWT, authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
        const cR = validateObjectId(req.params.classId, 'Class ID');
        if (cR.error) return res.status(400).json({ message: cR.error });

        const classDoc = await Class.findById(cR.value);
        if (!classDoc) return res.status(404).json({ message: 'Class not found' });

        let ayInfo = null;
        if (req.query.academic_year_id) {
            const ayR = validateObjectId(req.query.academic_year_id, 'Academic Year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            const ayDoc = await AcademicYear.findById(ayR.value);
            if (!ayDoc) return res.status(404).json({ message: 'Academic Year not found' });
            ayInfo = { id: ayDoc._id.toString(), name: ayDoc.name };
        }

        let termInfo = null;
        if (req.query.term_id) {
            const tR = validateObjectId(req.query.term_id, 'Term ID');
            if (tR.error) return res.status(400).json({ message: tR.error });
            const termDoc = await Term.findById(tR.value);
            if (!termDoc) return res.status(404).json({ message: 'Term not found' });
            termInfo = { id: termDoc._id.toString(), name: termDoc.name };
        }

        let subjectInfo = null;
        if (req.query.subject_id) {
            const subR = validateObjectId(req.query.subject_id, 'Subject ID');
            if (subR.error) return res.status(400).json({ message: subR.error });
            const subDoc = await Subject.findById(subR.value);
            if (!subDoc) return res.status(404).json({ message: 'Subject not found' });
            subjectInfo = { id: subDoc._id.toString(), name: subDoc.name, code: subDoc.code };
        }

        // Find students belonging to this class
        const studentsInClass = await Student.find({ class_name: classDoc.name }).sort({ full_name: 1 });
        const studentMap = new Map();
        for (const s of studentsInClass) {
            studentMap.set(s._id.toString(), {
                student_id: s._id.toString(),
                full_name: s.full_name,
                id_number: s.id_number,
                total_obtained: 0,
                total_possible: 0,
                has_marks: false
            });
        }

        // Find exams for this class (with filters)
        const examQuery = { class_id: cR.value };
        if (req.query.academic_year_id) examQuery.academic_year_id = req.query.academic_year_id;
        if (req.query.term_id) examQuery.term_id = req.query.term_id;
        if (req.query.subject_id) examQuery.subject_id = req.query.subject_id;

        const exams = await Exam.find(examQuery)
            .populate('subject_id', 'name code')
            .populate('academic_year_id', 'name')
            .populate('term_id', 'name');

        const examIds = exams.map(e => e._id);
        const marks = examIds.length > 0
            ? await Mark.find({ exam_id: { $in: examIds } }).populate('exam_id')
            : [];

        // Aggregate marks by student and by subject
        const subjectStatsMap = new Map();

        for (const m of marks) {
            if (!m.exam_id) continue;
            const sid = m.student_id ? m.student_id.toString() : null;
            if (!sid) continue;

            const tMarks = m.exam_id.total_marks || 0;
            const mObt = m.marks_obtained;

            // Student level
            if (!studentMap.has(sid)) {
                studentMap.set(sid, {
                    student_id: sid,
                    full_name: 'Student',
                    id_number: '',
                    total_obtained: 0,
                    total_possible: 0,
                    has_marks: true
                });
            }
            const sRec = studentMap.get(sid);
            sRec.total_obtained += mObt;
            sRec.total_possible += tMarks;
            sRec.has_marks = true;

            // Subject level
            const sub = m.exam_id.subject_id;
            const subId = sub ? (sub._id ? sub._id.toString() : sub.toString()) : 'unknown';
            if (!subjectStatsMap.has(subId)) {
                const subDoc = exams.find(e => e.subject_id && (e.subject_id._id || e.subject_id).toString() === subId)?.subject_id;
                subjectStatsMap.set(subId, {
                    subject_id: subId,
                    subject_name: subDoc?.name || 'Subject',
                    subject_code: subDoc?.code || '',
                    total_obtained: 0,
                    total_possible: 0,
                    student_scores: []
                });
            }
            const subStat = subjectStatsMap.get(subId);
            subStat.total_obtained += mObt;
            subStat.total_possible += tMarks;
            const pct = calculatePercentage(mObt, tMarks);
            subStat.student_scores.push(pct);
        }

        // Build student performance list
        const studentPerformance = [];
        let totalClassObtained = 0;
        let totalClassPossible = 0;
        let passCount = 0;
        let failCount = 0;
        let studentsWithMarks = 0;
        const validPercentages = [];

        for (const sRec of studentMap.values()) {
            if (sRec.has_marks && sRec.total_possible > 0) {
                studentsWithMarks++;
                totalClassObtained += sRec.total_obtained;
                totalClassPossible += sRec.total_possible;
                const percentage = calculatePercentage(sRec.total_obtained, sRec.total_possible);
                validPercentages.push(percentage);
                const { grade, status, is_pass } = calculateGrade(percentage);

                if (is_pass) passCount++;
                else failCount++;

                studentPerformance.push({
                    student_id: sRec.student_id,
                    full_name: sRec.full_name,
                    id_number: sRec.id_number,
                    total_obtained: sRec.total_obtained,
                    total_possible: sRec.total_possible,
                    percentage,
                    grade,
                    status,
                    is_pass
                });
            } else {
                studentPerformance.push({
                    student_id: sRec.student_id,
                    full_name: sRec.full_name,
                    id_number: sRec.id_number,
                    total_obtained: 0,
                    total_possible: 0,
                    percentage: 0,
                    grade: 'N/A',
                    status: 'No Marks',
                    is_pass: false
                });
            }
        }

        const avgPercentage = validPercentages.length > 0
            ? Math.round((validPercentages.reduce((a, b) => a + b, 0) / validPercentages.length) * 100) / 100
            : 0;
        const highestPercentage = validPercentages.length > 0 ? Math.max(...validPercentages) : 0;
        const lowestPercentage = validPercentages.length > 0 ? Math.min(...validPercentages) : 0;

        // Subject performance list
        const subjectPerformance = Array.from(subjectStatsMap.values()).map(sub => {
            const avgPct = sub.student_scores.length > 0
                ? Math.round((sub.student_scores.reduce((a, b) => a + b, 0) / sub.student_scores.length) * 100) / 100
                : 0;
            const highPct = sub.student_scores.length > 0 ? Math.max(...sub.student_scores) : 0;
            const lowPct = sub.student_scores.length > 0 ? Math.min(...sub.student_scores) : 0;
            const pCount = sub.student_scores.filter(p => p >= 50).length;
            const fCount = sub.student_scores.filter(p => p < 50).length;

            return {
                subject_id: sub.subject_id,
                subject_name: sub.subject_name,
                subject_code: sub.subject_code,
                total_obtained: sub.total_obtained,
                total_possible: sub.total_possible,
                average_percentage: avgPct,
                highest_percentage: highPct,
                lowest_percentage: lowPct,
                pass_count: pCount,
                fail_count: fCount,
                marks_count: sub.student_scores.length
            };
        });

        res.json({
            class: {
                id: classDoc._id.toString(),
                name: classDoc.name
            },
            academic_year: ayInfo,
            term: termInfo,
            subject: subjectInfo,
            summary: {
                total_students: studentsInClass.length,
                students_with_marks: studentsWithMarks,
                total_obtained: totalClassObtained,
                total_possible: totalClassPossible,
                average_percentage: avgPercentage,
                highest_percentage: highestPercentage,
                lowest_percentage: lowestPercentage,
                pass_count: passCount,
                fail_count: failCount
            },
            subject_performance: subjectPerformance,
            student_performance: studentPerformance
        });
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 3. TERM REPORT: GET /api/reports/term/:termId
// Query params: class_id
// RBAC: Admin & Teacher only. Students get 403.
app.get('/api/reports/term/:termId', authenticateJWT, authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
        const tR = validateObjectId(req.params.termId, 'Term ID');
        if (tR.error) return res.status(400).json({ message: tR.error });

        const termDoc = await Term.findById(tR.value).populate('academic_year_id', 'name');
        if (!termDoc) return res.status(404).json({ message: 'Term not found' });

        let classInfo = null;
        if (req.query.class_id) {
            const cR = validateObjectId(req.query.class_id, 'Class ID');
            if (cR.error) return res.status(400).json({ message: cR.error });
            const classDoc = await Class.findById(cR.value);
            if (!classDoc) return res.status(404).json({ message: 'Class not found' });
            classInfo = { id: classDoc._id.toString(), name: classDoc.name };
        }

        const examQuery = { term_id: tR.value };
        if (req.query.class_id) examQuery.class_id = req.query.class_id;

        const exams = await Exam.find(examQuery)
            .populate('class_id', 'name')
            .populate('subject_id', 'name code');

        const examIds = exams.map(e => e._id);
        const marks = examIds.length > 0
            ? await Mark.find({ exam_id: { $in: examIds } })
                .populate('exam_id')
                .populate('student_id', 'full_name id_number class_name')
            : [];

        // Aggregate by student to compute student totals across term
        const studentMap = new Map();
        const subjectMap = new Map();
        const classMap = new Map();

        let totalObtained = 0;
        let totalPossible = 0;

        for (const m of marks) {
            if (!m.exam_id) continue;
            const tMarks = m.exam_id.total_marks || 0;
            const mObt = m.marks_obtained;
            totalObtained += mObt;
            totalPossible += tMarks;

            // Student grouping
            const sid = m.student_id ? m.student_id._id.toString() : 'unknown';
            if (!studentMap.has(sid)) {
                studentMap.set(sid, {
                    student_id: sid,
                    full_name: m.student_id?.full_name || 'Student',
                    id_number: m.student_id?.id_number || '',
                    class_name: m.student_id?.class_name || (m.exam_id.class_id?.name || ''),
                    total_obtained: 0,
                    total_possible: 0
                });
            }
            const sRec = studentMap.get(sid);
            sRec.total_obtained += mObt;
            sRec.total_possible += tMarks;

            // Subject grouping
            const sub = m.exam_id.subject_id;
            const subId = sub ? sub._id.toString() : 'unknown';
            if (!subjectMap.has(subId)) {
                subjectMap.set(subId, {
                    subject_id: subId,
                    subject_name: sub ? sub.name : 'Unknown',
                    subject_code: sub ? sub.code : '',
                    total_obtained: 0,
                    total_possible: 0,
                    exam_count: new Set(),
                    student_scores: []
                });
            }
            const subStat = subjectMap.get(subId);
            subStat.total_obtained += mObt;
            subStat.total_possible += tMarks;
            subStat.exam_count.add(m.exam_id._id.toString());
            subStat.student_scores.push(calculatePercentage(mObt, tMarks));

            // Class grouping
            const cls = m.exam_id.class_id;
            const clsId = cls ? cls._id.toString() : 'unknown';
            if (!classMap.has(clsId)) {
                classMap.set(clsId, {
                    class_id: clsId,
                    class_name: cls ? cls.name : 'Unknown',
                    total_obtained: 0,
                    total_possible: 0,
                    students: new Set(),
                    scores: []
                });
            }
            const cStat = classMap.get(clsId);
            cStat.total_obtained += mObt;
            cStat.total_possible += tMarks;
            cStat.students.add(sid);
            cStat.scores.push(calculatePercentage(mObt, tMarks));
        }

        // Student statistics
        let passCount = 0;
        let failCount = 0;
        const studentPercentages = [];

        for (const sRec of studentMap.values()) {
            if (sRec.total_possible > 0) {
                const pct = calculatePercentage(sRec.total_obtained, sRec.total_possible);
                studentPercentages.push(pct);
                if (pct >= 50) passCount++;
                else failCount++;
            }
        }

        const avgPercentage = studentPercentages.length > 0
            ? Math.round((studentPercentages.reduce((a, b) => a + b, 0) / studentPercentages.length) * 100) / 100
            : 0;
        const highestPercentage = studentPercentages.length > 0 ? Math.max(...studentPercentages) : 0;
        const lowestPercentage = studentPercentages.length > 0 ? Math.min(...studentPercentages) : 0;

        // Class performance summary
        const classPerformance = Array.from(classMap.values()).map(c => {
            const cAvgPct = c.scores.length > 0
                ? Math.round((c.scores.reduce((a, b) => a + b, 0) / c.scores.length) * 100) / 100
                : 0;
            const cPass = c.scores.filter(p => p >= 50).length;
            const cFail = c.scores.filter(p => p < 50).length;
            return {
                class_id: c.class_id,
                class_name: c.class_name,
                students_count: c.students.size,
                total_obtained: c.total_obtained,
                total_possible: c.total_possible,
                average_percentage: cAvgPct,
                pass_count: cPass,
                fail_count: cFail
            };
        });

        // Subject performance summary
        const subjectPerformance = Array.from(subjectMap.values()).map(sub => {
            const subAvg = sub.student_scores.length > 0
                ? Math.round((sub.student_scores.reduce((a, b) => a + b, 0) / sub.student_scores.length) * 100) / 100
                : 0;
            const subPass = sub.student_scores.filter(p => p >= 50).length;
            const subFail = sub.student_scores.filter(p => p < 50).length;
            return {
                subject_id: sub.subject_id,
                subject_name: sub.subject_name,
                subject_code: sub.subject_code,
                exams_count: sub.exam_count.size,
                total_obtained: sub.total_obtained,
                total_possible: sub.total_possible,
                average_percentage: subAvg,
                pass_count: subPass,
                fail_count: subFail
            };
        });

        res.json({
            term: {
                id: termDoc._id.toString(),
                name: termDoc.name
            },
            academic_year: {
                id: termDoc.academic_year_id ? termDoc.academic_year_id._id.toString() : null,
                name: termDoc.academic_year_id ? termDoc.academic_year_id.name : null
            },
            class: classInfo,
            summary: {
                number_of_students: studentMap.size,
                number_of_subjects: subjectMap.size,
                number_of_exams: exams.length,
                total_obtained: totalObtained,
                total_possible: totalPossible,
                average_percentage: avgPercentage,
                highest_percentage: highestPercentage,
                lowest_percentage: lowestPercentage,
                pass_count: passCount,
                fail_count: failCount
            },
            class_performance: classPerformance,
            subject_performance: subjectPerformance
        });
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 4. EXAM REPORT: GET /api/reports/exam/:examId
// RBAC: Admin & Teacher only. Students get 403.
app.get('/api/reports/exam/:examId', authenticateJWT, authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
        const eR = validateObjectId(req.params.examId, 'Exam ID');
        if (eR.error) return res.status(400).json({ message: eR.error });

        const exam = await Exam.findById(eR.value)
            .populate('class_id', 'name')
            .populate('subject_id', 'name code')
            .populate('academic_year_id', 'name')
            .populate('term_id', 'name');

        if (!exam) return res.status(404).json({ message: 'Exam not found' });

        const marks = await Mark.find({ exam_id: eR.value })
            .populate('student_id', 'full_name id_number class_name')
            .sort({ marks_obtained: -1 });

        const totalStudentsInClass = exam.class_id
            ? await Student.countDocuments({ class_name: exam.class_id.name })
            : 0;

        let highestMark = 0;
        let lowestMark = 0;
        let sumMarks = 0;
        let passCount = 0;
        let failCount = 0;

        const studentRows = marks.map(m => {
            const obt = m.marks_obtained;
            sumMarks += obt;
            const pct = calculatePercentage(obt, exam.total_marks);
            const { grade, status, is_pass } = calculateGrade(pct);

            if (is_pass) passCount++;
            else failCount++;

            return {
                student_id: m.student_id ? m.student_id._id.toString() : null,
                student_name: m.student_id ? m.student_id.full_name : 'Unknown',
                id_number: m.student_id ? m.student_id.id_number : '',
                class_name: m.student_id ? m.student_id.class_name : (exam.class_id?.name || ''),
                marks_obtained: obt,
                total_marks: exam.total_marks,
                percentage: pct,
                grade,
                status,
                is_pass,
                remarks: m.remarks || ''
            };
        });

        if (marks.length > 0) {
            const obtValues = marks.map(m => m.marks_obtained);
            highestMark = Math.max(...obtValues);
            lowestMark = Math.min(...obtValues);
        }

        const avgMark = marks.length > 0
            ? Math.round((sumMarks / marks.length) * 100) / 100
            : 0;
        const avgPercentage = calculatePercentage(avgMark, exam.total_marks);

        res.json({
            exam: {
                id: exam._id.toString(),
                name: exam.name,
                type: exam.type,
                exam_date: exam.exam_date,
                total_marks: exam.total_marks,
                academic_year: {
                    id: exam.academic_year_id ? exam.academic_year_id._id.toString() : null,
                    name: exam.academic_year_id ? exam.academic_year_id.name : null
                },
                term: {
                    id: exam.term_id ? exam.term_id._id.toString() : null,
                    name: exam.term_id ? exam.term_id.name : null
                },
                class: {
                    id: exam.class_id ? exam.class_id._id.toString() : null,
                    name: exam.class_id ? exam.class_id.name : null
                },
                subject: {
                    id: exam.subject_id ? exam.subject_id._id.toString() : null,
                    name: exam.subject_id ? exam.subject_id.name : null,
                    code: exam.subject_id ? exam.subject_id.code : null
                }
            },
            performance: {
                number_of_students: totalStudentsInClass > 0 ? totalStudentsInClass : marks.length,
                number_with_marks: marks.length,
                highest_mark: highestMark,
                lowest_mark: lowestMark,
                average_mark: avgMark,
                average_percentage: avgPercentage,
                pass_count: passCount,
                fail_count: failCount
            },
            students: studentRows
        });
    } catch (err) {
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// ---------------------------------------------------------------------------
// HEALTH CHECK ENDPOINT (P1 #6 STEP 10)
// Minimal, production-safe liveness and database connectivity check.
// Does NOT leak MongoDB URIs, credentials, environment variables, or stack traces.
// Returns 200 { status: 'ok', database: 'connected' } when DB is ready.
// Returns 503 { status: 'error', database: 'disconnected' } when DB is unreachable.
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
    const isDbConnected = mongoose.connection.readyState === 1;
    if (isDbConnected) {
        return res.status(200).json({
            status: 'ok',
            database: 'connected'
        });
    }
    return res.status(503).json({
        status: 'error',
        database: 'disconnected'
    });
});

// ===========================================================================
// USER MANAGEMENT APIs (P2 #6)
// Admin-only endpoints for managing users, roles, account status, and linkages.
// Passwords and OTP secrets are never leaked in API responses.
// ===========================================================================

// 1. LIST USERS: GET /api/users
// Supports optional filters: role, status, search (username or email).
app.get('/api/users', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const query = {};

        if (req.query.role) {
            const roleR = validateEnum(req.query.role, 'Role', ['admin', 'teacher', 'student']);
            if (roleR.error) return res.status(400).json({ message: roleR.error });
            query.role = roleR.value;
        }

        if (req.query.status) {
            const statusR = validateEnum(req.query.status, 'Status', ['active', 'inactive']);
            if (statusR.error) return res.status(400).json({ message: statusR.error });
            if (statusR.value === 'inactive') {
                query.status = 'inactive';
            } else {
                query.status = { $ne: 'inactive' };
            }
        }

        if (req.query.search && typeof req.query.search === 'string') {
            const sTrim = req.query.search.trim().slice(0, 50);
            if (sTrim.length > 0) {
                const escaped = escapeRegex(sTrim);
                query.$or = [
                    { username: new RegExp(escaped, 'i') },
                    { email: new RegExp(escaped, 'i') }
                ];
            }
        }

        const users = await User.find(query)
            .select('-password -otp -otpExpires')
            .populate('student_id', '_id full_name id_number class_name')
            .populate('teacher_id', '_id name subject phone')
            .sort({ createdAt: -1 });

        const result = users.map(u => {
            const obj = u.toObject();
            obj.id = obj._id.toString();
            obj.status = obj.status || 'active';
            delete obj.password;
            delete obj.otp;
            delete obj.otpExpires;
            return obj;
        });

        res.json(result);
    } catch (err) {
        logger.error('Error fetching users', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 2. VIEW SINGLE USER: GET /api/users/:id
app.get('/api/users/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'User ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const user = await User.findById(idR.value)
            .select('-password -otp -otpExpires')
            .populate('student_id', '_id full_name id_number class_name')
            .populate('teacher_id', '_id name subject phone');

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const obj = user.toObject();
        obj.id = obj._id.toString();
        obj.status = obj.status || 'active';
        delete obj.password;
        delete obj.otp;
        delete obj.otpExpires;

        res.json(obj);
    } catch (err) {
        logger.error('Error fetching user', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 3. CREATE USER: POST /api/users
// Creates a new user with strict field allowlist and validation.
app.post('/api/users', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const usernameR = validateString(req.body.username, 'Username', { maxLength: 50 });
        const emailR = validateEmail(req.body.email);
        const roleR = validateEnum(req.body.role, 'Role', ['admin', 'teacher', 'student']);

        const err = firstError(usernameR, emailR, roleR);
        if (err) return res.status(400).json({ message: err });

        let status = 'active';
        if (req.body.status !== undefined && req.body.status !== null && req.body.status !== '') {
            const statusR = validateEnum(req.body.status, 'Status', ['active', 'inactive']);
            if (statusR.error) return res.status(400).json({ message: statusR.error });
            status = statusR.value;
        }

        // Validate optional password (min 6 characters)
        let hashedPassword;
        if (req.body.password !== undefined && req.body.password !== null && req.body.password !== '') {
            if (typeof req.body.password !== 'string' || req.body.password.trim().length < 6) {
                return res.status(400).json({ message: 'Password must be at least 6 characters long' });
            }
            if (req.body.password.length > 100) {
                return res.status(400).json({ message: 'Password is too long (max 100 characters)' });
            }
            const salt = bcrypt.genSaltSync(10);
            hashedPassword = bcrypt.hashSync(req.body.password, salt);
        }

        // Validate role-specific linkages
        let studentId = null;
        let teacherId = null;

        if (roleR.value === 'student') {
            if (req.body.student_id) {
                const sR = validateObjectId(req.body.student_id, 'Student ID');
                if (sR.error) return res.status(400).json({ message: sR.error });
                const studentExists = await Student.findById(sR.value);
                if (!studentExists) return res.status(400).json({ message: 'Selected student does not exist' });
                const existingLink = await User.findOne({ student_id: sR.value });
                if (existingLink) {
                    return res.status(409).json({ message: 'This student is already linked to another user account' });
                }
                studentId = sR.value;
            }
        } else if (roleR.value === 'teacher') {
            if (req.body.teacher_id) {
                const tR = validateObjectId(req.body.teacher_id, 'Teacher ID');
                if (tR.error) return res.status(400).json({ message: tR.error });
                const teacherExists = await Teacher.findById(tR.value);
                if (!teacherExists) return res.status(400).json({ message: 'Selected teacher does not exist' });
                const existingLink = await User.findOne({ teacher_id: tR.value });
                if (existingLink) {
                    return res.status(409).json({ message: 'This teacher is already linked to another user account' });
                }
                teacherId = tR.value;
            }
        }

        // Check unique username
        const existingUsername = await User.findOne({ username: usernameR.value });
        if (existingUsername) {
            return res.status(409).json({ message: 'A user with this username already exists' });
        }

        // Check unique email
        const existingEmail = await User.findOne({ email: emailR.value });
        if (existingEmail) {
            return res.status(409).json({ message: 'A user with this email address already exists' });
        }

        const newUser = await User.create({
            username: usernameR.value,
            email: emailR.value,
            role: roleR.value,
            password: hashedPassword,
            status,
            student_id: studentId,
            teacher_id: teacherId
        });

        const created = await User.findById(newUser._id)
            .select('-password -otp -otpExpires')
            .populate('student_id', '_id full_name id_number class_name')
            .populate('teacher_id', '_id name subject phone');

        const obj = created.toObject();
        obj.id = obj._id.toString();
        delete obj.password;
        delete obj.otp;
        delete obj.otpExpires;

        logger.info('User created successfully', {
            requestId: req.requestId,
            createdUserId: obj.id,
            role: obj.role
        });

        res.status(201).json(obj);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ message: 'A user with duplicate unique fields already exists' });
        }
        logger.error('Error creating user', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 4. UPDATE USER: PUT /api/users/:id
// Updates permitted user fields. Protects against last active admin demotion/deactivation.
app.put('/api/users/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'User ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const targetUser = await User.findById(idR.value);
        if (!targetUser) {
            return res.status(404).json({ message: 'User not found' });
        }

        const isSelf = req.user.id === targetUser._id.toString();

        // Prevent admin from demoting or deactivating themselves
        if (isSelf) {
            if (req.body.role && req.body.role !== 'admin') {
                return res.status(400).json({ message: 'Administrators cannot demote their own account' });
            }
            if (req.body.status && req.body.status === 'inactive') {
                return res.status(400).json({ message: 'Administrators cannot deactivate their own account' });
            }
        }

        // Last active admin protection: prevent demoting or deactivating the last active admin
        const targetCurrentStatus = targetUser.status || 'active';
        const willBeInactive = req.body.status === 'inactive';
        const willBeDemoted = req.body.role && req.body.role !== 'admin';

        if (targetUser.role === 'admin' && targetCurrentStatus === 'active' && (willBeInactive || willBeDemoted)) {
            const activeAdminCount = await User.countDocuments({ role: 'admin', status: { $ne: 'inactive' } });
            if (activeAdminCount <= 1) {
                return res.status(400).json({ message: 'Cannot demote or deactivate the last active administrator' });
            }
        }

        // Validate and update fields
        if (req.body.username !== undefined) {
            const usernameR = validateString(req.body.username, 'Username', { maxLength: 50 });
            if (usernameR.error) return res.status(400).json({ message: usernameR.error });
            const duplicateUser = await User.findOne({ username: usernameR.value, _id: { $ne: targetUser._id } });
            if (duplicateUser) {
                return res.status(409).json({ message: 'A user with this username already exists' });
            }
            targetUser.username = usernameR.value;
        }

        if (req.body.email !== undefined) {
            const emailR = validateEmail(req.body.email);
            if (emailR.error) return res.status(400).json({ message: emailR.error });
            const duplicateEmail = await User.findOne({ email: emailR.value, _id: { $ne: targetUser._id } });
            if (duplicateEmail) {
                return res.status(409).json({ message: 'A user with this email address already exists' });
            }
            targetUser.email = emailR.value;
        }

        if (req.body.role !== undefined) {
            const roleR = validateEnum(req.body.role, 'Role', ['admin', 'teacher', 'student']);
            if (roleR.error) return res.status(400).json({ message: roleR.error });
            targetUser.role = roleR.value;
        }

        if (req.body.status !== undefined) {
            const statusR = validateEnum(req.body.status, 'Status', ['active', 'inactive']);
            if (statusR.error) return res.status(400).json({ message: statusR.error });
            targetUser.status = statusR.value;
        }

        // Handle role-specific linkages
        const effectiveRole = targetUser.role;

        if (effectiveRole === 'student') {
            if (req.body.student_id !== undefined) {
                if (!req.body.student_id) {
                    targetUser.student_id = null;
                } else {
                    const sR = validateObjectId(req.body.student_id, 'Student ID');
                    if (sR.error) return res.status(400).json({ message: sR.error });
                    const studentExists = await Student.findById(sR.value);
                    if (!studentExists) return res.status(400).json({ message: 'Selected student does not exist' });
                    const duplicateLink = await User.findOne({ student_id: sR.value, _id: { $ne: targetUser._id } });
                    if (duplicateLink) {
                        return res.status(409).json({ message: 'This student is already linked to another user account' });
                    }
                    targetUser.student_id = sR.value;
                }
            }
            targetUser.teacher_id = null;
        } else if (effectiveRole === 'teacher') {
            if (req.body.teacher_id !== undefined) {
                if (!req.body.teacher_id) {
                    targetUser.teacher_id = null;
                } else {
                    const tR = validateObjectId(req.body.teacher_id, 'Teacher ID');
                    if (tR.error) return res.status(400).json({ message: tR.error });
                    const teacherExists = await Teacher.findById(tR.value);
                    if (!teacherExists) return res.status(400).json({ message: 'Selected teacher does not exist' });
                    const duplicateLink = await User.findOne({ teacher_id: tR.value, _id: { $ne: targetUser._id } });
                    if (duplicateLink) {
                        return res.status(409).json({ message: 'This teacher is already linked to another user account' });
                    }
                    targetUser.teacher_id = tR.value;
                }
            }
            targetUser.student_id = null;
        } else if (effectiveRole === 'admin') {
            targetUser.student_id = null;
            targetUser.teacher_id = null;
        }

        await targetUser.save();

        const updated = await User.findById(targetUser._id)
            .select('-password -otp -otpExpires')
            .populate('student_id', '_id full_name id_number class_name')
            .populate('teacher_id', '_id name subject phone');

        const obj = updated.toObject();
        obj.id = obj._id.toString();
        delete obj.password;
        delete obj.otp;
        delete obj.otpExpires;

        logger.info('User updated successfully', {
            requestId: req.requestId,
            userId: obj.id,
            role: obj.role,
            status: obj.status
        });

        res.json(obj);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ message: 'A user with duplicate unique fields already exists' });
        }
        logger.error('Error updating user', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 5. RESET USER PASSWORD: POST /api/users/:id/reset-password
// Dedicated endpoint for admin-initiated password resets.
app.post('/api/users/:id/reset-password', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'User ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const targetUser = await User.findById(idR.value).select('+password +otp +otpExpires');
        if (!targetUser) {
            return res.status(404).json({ message: 'User not found' });
        }

        const pwdRaw = req.body.password;
        if (!pwdRaw || typeof pwdRaw !== 'string' || pwdRaw.trim().length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters long' });
        }
        if (pwdRaw.length > 100) {
            return res.status(400).json({ message: 'Password is too long (max 100 characters)' });
        }

        const salt = bcrypt.genSaltSync(10);
        targetUser.password = bcrypt.hashSync(pwdRaw, salt);
        targetUser.otp = undefined;
        targetUser.otpExpires = undefined;

        await targetUser.save();

        logger.info('User password reset successfully', {
            requestId: req.requestId,
            targetUserId: targetUser._id.toString(),
            adminId: req.user.id
        });

        res.json({ message: 'Password reset successfully' });
    } catch (err) {
        logger.error('Error resetting password', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 6. TOGGLE STATUS: PATCH /api/users/:id/status
app.patch('/api/users/:id/status', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'User ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const targetUser = await User.findById(idR.value);
        if (!targetUser) {
            return res.status(404).json({ message: 'User not found' });
        }

        const statusR = validateEnum(req.body.status, 'Status', ['active', 'inactive']);
        if (statusR.error) return res.status(400).json({ message: statusR.error });

        const isSelf = req.user.id === targetUser._id.toString();
        if (isSelf && statusR.value === 'inactive') {
            return res.status(400).json({ message: 'Administrators cannot deactivate their own account' });
        }

        // Last active admin protection
        const currentStatus = targetUser.status || 'active';
        if (targetUser.role === 'admin' && currentStatus === 'active' && statusR.value === 'inactive') {
            const activeAdminCount = await User.countDocuments({ role: 'admin', status: { $ne: 'inactive' } });
            if (activeAdminCount <= 1) {
                return res.status(400).json({ message: 'Cannot demote or deactivate the last active administrator' });
            }
        }

        targetUser.status = statusR.value;
        await targetUser.save();

        const updated = await User.findById(targetUser._id)
            .select('-password -otp -otpExpires')
            .populate('student_id', '_id full_name id_number class_name')
            .populate('teacher_id', '_id name subject phone');

        const obj = updated.toObject();
        obj.id = obj._id.toString();
        delete obj.password;
        delete obj.otp;
        delete obj.otpExpires;

        logger.info('User status updated successfully', {
            requestId: req.requestId,
            userId: obj.id,
            status: obj.status
        });

        res.json(obj);
    } catch (err) {
        logger.error('Error updating user status', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// 7. PERMANENT DELETION PROTECTION: DELETE /api/users/:id
// Refuses permanent deletion to preserve audit trails and school records.
app.delete('/api/users/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    res.status(400).json({
        message: 'Permanent deletion of user accounts is disabled to preserve audit history. Deactivate the user account instead.'
    });
});

// ===========================================================================
// SCHOOL OPERATIONS (P3 PACKAGE A)
// Module 2: School Profile & Operational Settings
// Module 3: Timetable & Class Schedule Management
// Module 4: Notice Board & Announcements
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. SCHOOL PROFILE & OPERATIONAL SETTINGS
// ---------------------------------------------------------------------------

// GET SETTINGS: all authenticated users can view school profile & operational settings
app.get('/api/settings', authenticateJWT, async (req, res) => {
    try {
        let setting = await Setting.findOne()
            .populate('default_academic_year_id', '_id name status')
            .populate('default_term_id', '_id name status');

        if (!setting) {
            setting = await Setting.create({});
        }

        const obj = setting.toObject();
        obj.id = obj._id.toString();
        res.json(obj);
    } catch (err) {
        logger.error('Error fetching school settings', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// UPDATE SETTINGS: admin only
app.put('/api/settings', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        let setting = await Setting.findOne();
        if (!setting) {
            setting = await Setting.create({});
        }

        // Validate text fields if provided
        if (req.body.school_name !== undefined) {
            const nameR = validateString(req.body.school_name, 'School Name', { maxLength: 120 });
            if (nameR.error) return res.status(400).json({ message: nameR.error });
            setting.school_name = nameR.value;
        }

        if (req.body.school_motto !== undefined) {
            const mottoR = validateString(req.body.school_motto, 'School Motto', { maxLength: 200, required: false });
            if (mottoR.error) return res.status(400).json({ message: mottoR.error });
            setting.school_motto = mottoR.value || '';
        }

        if (req.body.school_address !== undefined) {
            const addrR = validateString(req.body.school_address, 'School Address', { maxLength: 300, required: false });
            if (addrR.error) return res.status(400).json({ message: addrR.error });
            setting.school_address = addrR.value || '';
        }

        if (req.body.school_phone !== undefined) {
            const phoneR = validateString(req.body.school_phone, 'School Phone', { maxLength: 50, required: false });
            if (phoneR.error) return res.status(400).json({ message: phoneR.error });
            setting.school_phone = phoneR.value || '';
        }

        if (req.body.school_email !== undefined) {
            const emailR = validateEmail(req.body.school_email);
            if (emailR.error) return res.status(400).json({ message: emailR.error });
            setting.school_email = emailR.value;
        }

        if (req.body.logo_url !== undefined) {
            if (typeof req.body.logo_url === 'string' && req.body.logo_url.length > 500) {
                return res.status(400).json({ message: 'Logo URL is too long (max 500 characters)' });
            }
            setting.logo_url = req.body.logo_url ? req.body.logo_url.trim() : '';
        }

        if (req.body.min_attendance_percent !== undefined) {
            const val = Number(req.body.min_attendance_percent);
            if (isNaN(val) || val < 0 || val > 100) {
                return res.status(400).json({ message: 'Minimum attendance percentage must be a number between 0 and 100' });
            }
            setting.min_attendance_percent = val;
        }

        if (req.body.default_academic_year_id !== undefined) {
            if (!req.body.default_academic_year_id) {
                setting.default_academic_year_id = null;
            } else {
                const ayR = validateObjectId(req.body.default_academic_year_id, 'Academic Year ID');
                if (ayR.error) return res.status(400).json({ message: ayR.error });
                const ayExists = await AcademicYear.findById(ayR.value);
                if (!ayExists) return res.status(400).json({ message: 'Referenced academic year does not exist' });
                setting.default_academic_year_id = ayR.value;
            }
        }

        if (req.body.default_term_id !== undefined) {
            if (!req.body.default_term_id) {
                setting.default_term_id = null;
            } else {
                const termR = validateObjectId(req.body.default_term_id, 'Term ID');
                if (termR.error) return res.status(400).json({ message: termR.error });
                const termExists = await Term.findById(termR.value);
                if (!termExists) return res.status(400).json({ message: 'Referenced term does not exist' });
                setting.default_term_id = termR.value;
            }
        }

        await setting.save();

        const updated = await Setting.findById(setting._id)
            .populate('default_academic_year_id', '_id name status')
            .populate('default_term_id', '_id name status');

        const obj = updated.toObject();
        obj.id = obj._id.toString();

        logger.info('School settings updated successfully', { requestId: req.requestId, adminId: req.user.id });
        res.json(obj);
    } catch (err) {
        logger.error('Error updating school settings', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// ---------------------------------------------------------------------------
// 2. TIMETABLE & CLASS SCHEDULE MANAGEMENT
// ---------------------------------------------------------------------------

const VALID_DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TIME_FORMAT_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Helper to check if two time ranges [startA, endA] and [startB, endB] overlap
function timesOverlap(startA, endA, startB, endB) {
    return startA < endB && endA > startB;
}

// LIST TIMETABLE SLOTS: admin, teacher, student
app.get('/api/timetable', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const query = {};

        if (req.query.class_id) {
            const cidR = validateObjectId(req.query.class_id, 'Class ID');
            if (cidR.error) return res.status(400).json({ message: cidR.error });
            query.class_id = cidR.value;
        }

        if (req.query.teacher_id) {
            const tidR = validateObjectId(req.query.teacher_id, 'Teacher ID');
            if (tidR.error) return res.status(400).json({ message: tidR.error });
            query.teacher_id = tidR.value;
        }

        if (req.query.academic_year_id) {
            const ayR = validateObjectId(req.query.academic_year_id, 'Academic Year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            query.academic_year_id = ayR.value;
        }

        if (req.query.day_of_week) {
            const dayR = validateEnum(req.query.day_of_week, 'Day of week', VALID_DAYS_OF_WEEK);
            if (dayR.error) return res.status(400).json({ message: dayR.error });
            query.day_of_week = dayR.value;
        }

        if (req.query.status) {
            const stR = validateEnum(req.query.status, 'Status', ['active', 'inactive']);
            if (stR.error) return res.status(400).json({ message: stR.error });
            query.status = stR.value;
        } else {
            query.status = 'active'; // default active slots
        }

        const slots = await TimetableSlot.find(query)
            .populate('class_id', '_id name')
            .populate('subject_id', '_id name code')
            .populate('teacher_id', '_id name subject phone')
            .populate('academic_year_id', '_id name status')
            .sort({ day_of_week: 1, start_time: 1 });

        const dayOrder = { 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4, 'Friday': 5, 'Saturday': 6, 'Sunday': 7 };
        const sorted = slots.map(s => {
            const obj = s.toObject();
            obj.id = obj._id.toString();
            obj.room = obj.room_number;
            return obj;
        }).sort((a, b) => {
            const dayDiff = (dayOrder[a.day_of_week] || 0) - (dayOrder[b.day_of_week] || 0);
            if (dayDiff !== 0) return dayDiff;
            return a.start_time.localeCompare(b.start_time);
        });

        res.json(sorted);
    } catch (err) {
        logger.error('Error fetching timetable slots', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// SINGLE TIMETABLE SLOT: admin, teacher, student
app.get('/api/timetable/:id', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Timetable Slot ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const slot = await TimetableSlot.findById(idR.value)
            .populate('class_id', '_id name')
            .populate('subject_id', '_id name code')
            .populate('teacher_id', '_id name subject phone')
            .populate('academic_year_id', '_id name status');

        if (!slot) return res.status(404).json({ message: 'Timetable slot not found' });

        const obj = slot.toObject();
        obj.id = obj._id.toString();
        obj.room = obj.room_number;
        res.json(obj);
    } catch (err) {
        logger.error('Error fetching timetable slot', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// CREATE TIMETABLE SLOT: admin only (with clash prevention)
app.post('/api/timetable', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const cidR = validateObjectId(req.body.class_id, 'Class ID');
        const sidR = validateObjectId(req.body.subject_id, 'Subject ID');
        const tidR = validateObjectId(req.body.teacher_id, 'Teacher ID');
        const dayR = validateEnum(req.body.day_of_week, 'Day of week', VALID_DAYS_OF_WEEK);

        const firstErr = firstError(cidR, sidR, tidR, dayR);
        if (firstErr) return res.status(400).json({ message: firstErr });

        let ayId = null;
        if (req.body.academic_year_id) {
            const ayR = validateObjectId(req.body.academic_year_id, 'Academic Year ID');
            if (ayR.error) return res.status(400).json({ message: ayR.error });
            ayId = ayR.value;
        } else {
            let activeAy = await AcademicYear.findOne({ status: 'active' });
            if (!activeAy) {
                activeAy = await AcademicYear.findOne().sort({ createdAt: -1 });
            }
            if (!activeAy) {
                return res.status(400).json({ message: 'No academic year found. Please specify academic_year_id.' });
            }
            ayId = activeAy._id;
        }

        // Validate time formats (HH:MM 24-hour)
        const startTime = req.body.start_time ? String(req.body.start_time).trim() : '';
        const endTime = req.body.end_time ? String(req.body.end_time).trim() : '';

        if (!TIME_FORMAT_REGEX.test(startTime)) {
            return res.status(400).json({ message: 'Start time must be in HH:MM 24-hour format (e.g. 08:30)' });
        }
        if (!TIME_FORMAT_REGEX.test(endTime)) {
            return res.status(400).json({ message: 'End time must be in HH:MM 24-hour format (e.g. 09:30)' });
        }
        if (startTime >= endTime) {
            return res.status(400).json({ message: 'Start time must be earlier than end time' });
        }

        // Verify relational existence
        const [cls, subject, teacher, ay] = await Promise.all([
            Class.findById(cidR.value),
            Subject.findById(sidR.value),
            Teacher.findById(tidR.value),
            AcademicYear.findById(ayId)
        ]);

        if (!cls) return res.status(404).json({ message: 'Referenced class not found' });
        if (!subject) return res.status(404).json({ message: 'Referenced subject not found' });
        if (!teacher) return res.status(404).json({ message: 'Referenced teacher not found' });
        if (!ay) return res.status(404).json({ message: 'Referenced academic year not found' });

        const roomNumber = req.body.room_number || req.body.room ? String(req.body.room_number || req.body.room).trim().slice(0, 50) : '';

        // 1. CLASH CHECK: Teacher overlap
        const teacherSlots = await TimetableSlot.find({
            teacher_id: tidR.value,
            academic_year_id: ayId,
            day_of_week: dayR.value,
            status: 'active'
        }).populate('class_id', 'name').populate('subject_id', 'name');

        for (const existing of teacherSlots) {
            if (timesOverlap(startTime, endTime, existing.start_time, existing.end_time)) {
                const cName = existing.class_id ? existing.class_id.name : 'another class';
                return res.status(409).json({
                    conflict_type: 'teacher',
                    message: `Teacher ${teacher.name} is already scheduled on ${dayR.value} from ${existing.start_time} to ${existing.end_time} in ${cName}`
                });
            }
        }

        // 2. CLASH CHECK: Class overlap
        const classSlots = await TimetableSlot.find({
            class_id: cidR.value,
            academic_year_id: ayId,
            day_of_week: dayR.value,
            status: 'active'
        }).populate('subject_id', 'name');

        for (const existing of classSlots) {
            if (timesOverlap(startTime, endTime, existing.start_time, existing.end_time)) {
                const sName = existing.subject_id ? existing.subject_id.name : 'another subject';
                return res.status(409).json({
                    conflict_type: 'class',
                    message: `Class ${cls.name} is already scheduled for ${sName} on ${dayR.value} from ${existing.start_time} to ${existing.end_time}`
                });
            }
        }

        const newSlot = await TimetableSlot.create({
            class_id: cidR.value,
            subject_id: sidR.value,
            teacher_id: tidR.value,
            academic_year_id: ayId,
            day_of_week: dayR.value,
            start_time: startTime,
            end_time: endTime,
            room_number: roomNumber,
            status: 'active'
        });

        const created = await TimetableSlot.findById(newSlot._id)
            .populate('class_id', '_id name')
            .populate('subject_id', '_id name code')
            .populate('teacher_id', '_id name subject phone')
            .populate('academic_year_id', '_id name status');

        const obj = created.toObject();
        obj.id = obj._id.toString();
        obj.room = obj.room_number;

        logger.info('Timetable slot created successfully', { requestId: req.requestId, slotId: obj.id });
        res.status(201).json(obj);
    } catch (err) {
        logger.error('Error creating timetable slot', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// UPDATE TIMETABLE SLOT: admin only (with clash prevention)
app.put('/api/timetable/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Timetable Slot ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const targetSlot = await TimetableSlot.findById(idR.value);
        if (!targetSlot) return res.status(404).json({ message: 'Timetable slot not found' });

        const effectiveClassId = req.body.class_id ? validateObjectId(req.body.class_id, 'Class ID') : { value: targetSlot.class_id };
        const effectiveSubjectId = req.body.subject_id ? validateObjectId(req.body.subject_id, 'Subject ID') : { value: targetSlot.subject_id };
        const effectiveTeacherId = req.body.teacher_id ? validateObjectId(req.body.teacher_id, 'Teacher ID') : { value: targetSlot.teacher_id };
        const effectiveAyId = req.body.academic_year_id ? validateObjectId(req.body.academic_year_id, 'Academic Year ID') : { value: targetSlot.academic_year_id };
        const effectiveDay = req.body.day_of_week ? validateEnum(req.body.day_of_week, 'Day of week', VALID_DAYS_OF_WEEK) : { value: targetSlot.day_of_week };

        const firstErr = firstError(effectiveClassId, effectiveSubjectId, effectiveTeacherId, effectiveAyId, effectiveDay);
        if (firstErr) return res.status(400).json({ message: firstErr });

        const startTime = req.body.start_time !== undefined ? String(req.body.start_time).trim() : targetSlot.start_time;
        const endTime = req.body.end_time !== undefined ? String(req.body.end_time).trim() : targetSlot.end_time;

        if (!TIME_FORMAT_REGEX.test(startTime)) {
            return res.status(400).json({ message: 'Start time must be in HH:MM 24-hour format' });
        }
        if (!TIME_FORMAT_REGEX.test(endTime)) {
            return res.status(400).json({ message: 'End time must be in HH:MM 24-hour format' });
        }
        if (startTime >= endTime) {
            return res.status(400).json({ message: 'Start time must be earlier than end time' });
        }

        // Verify relational existence if changed
        if (req.body.class_id && !(await Class.findById(effectiveClassId.value))) {
            return res.status(404).json({ message: 'Referenced class not found' });
        }
        if (req.body.subject_id && !(await Subject.findById(effectiveSubjectId.value))) {
            return res.status(404).json({ message: 'Referenced subject not found' });
        }
        if (req.body.teacher_id && !(await Teacher.findById(effectiveTeacherId.value))) {
            return res.status(404).json({ message: 'Referenced teacher not found' });
        }
        if (req.body.academic_year_id && !(await AcademicYear.findById(effectiveAyId.value))) {
            return res.status(404).json({ message: 'Referenced academic year not found' });
        }

        // Clash checks excluding current slot
        const teacherSlots = await TimetableSlot.find({
            _id: { $ne: targetSlot._id },
            teacher_id: effectiveTeacherId.value,
            academic_year_id: effectiveAyId.value,
            day_of_week: effectiveDay.value,
            status: 'active'
        }).populate('class_id', 'name');

        for (const existing of teacherSlots) {
            if (timesOverlap(startTime, endTime, existing.start_time, existing.end_time)) {
                return res.status(409).json({
                    conflict_type: 'teacher',
                    message: `Teacher is already scheduled on ${effectiveDay.value} from ${existing.start_time} to ${existing.end_time}`
                });
            }
        }

        const classSlots = await TimetableSlot.find({
            _id: { $ne: targetSlot._id },
            class_id: effectiveClassId.value,
            academic_year_id: effectiveAyId.value,
            day_of_week: effectiveDay.value,
            status: 'active'
        }).populate('subject_id', 'name');

        for (const existing of classSlots) {
            if (timesOverlap(startTime, endTime, existing.start_time, existing.end_time)) {
                return res.status(409).json({
                    conflict_type: 'class',
                    message: `Class is already scheduled on ${effectiveDay.value} from ${existing.start_time} to ${existing.end_time}`
                });
            }
        }

        targetSlot.class_id = effectiveClassId.value;
        targetSlot.subject_id = effectiveSubjectId.value;
        targetSlot.teacher_id = effectiveTeacherId.value;
        targetSlot.academic_year_id = effectiveAyId.value;
        targetSlot.day_of_week = effectiveDay.value;
        targetSlot.start_time = startTime;
        targetSlot.end_time = endTime;
        if (req.body.room_number !== undefined || req.body.room !== undefined) {
            targetSlot.room_number = String(req.body.room_number !== undefined ? req.body.room_number : req.body.room).trim().slice(0, 50);
        }
        if (req.body.status) {
            const stR = validateEnum(req.body.status, 'Status', ['active', 'inactive']);
            if (stR.error) return res.status(400).json({ message: stR.error });
            targetSlot.status = stR.value;
        }

        await targetSlot.save();

        const updated = await TimetableSlot.findById(targetSlot._id)
            .populate('class_id', '_id name')
            .populate('subject_id', '_id name code')
            .populate('teacher_id', '_id name subject phone')
            .populate('academic_year_id', '_id name status');

        const obj = updated.toObject();
        obj.id = obj._id.toString();
        obj.room = obj.room_number;

        logger.info('Timetable slot updated successfully', { requestId: req.requestId, slotId: obj.id });
        res.json(obj);
    } catch (err) {
        logger.error('Error updating timetable slot', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// DELETE TIMETABLE SLOT: admin only
app.delete('/api/timetable/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Timetable Slot ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const slot = await TimetableSlot.findById(idR.value);
        if (!slot) return res.status(404).json({ message: 'Timetable slot not found' });

        await TimetableSlot.findByIdAndDelete(idR.value);
        logger.info('Timetable slot deleted successfully', { requestId: req.requestId, slotId: idR.value });
        res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Error deleting timetable slot', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// ---------------------------------------------------------------------------
// 3. NOTICE BOARD & ANNOUNCEMENTS
// ---------------------------------------------------------------------------

// LIST NOTICES: filtered by authenticated user role
app.get('/api/notices', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const query = {};
        const now = new Date();

        if (req.user.role === 'admin') {
            if (req.query.status) {
                const stR = validateEnum(req.query.status, 'Status', ['active', 'archived']);
                if (stR.error) return res.status(400).json({ message: stR.error });
                query.status = stR.value;
            }
        } else {
            // Teachers and Students only see active, non-expired notices targeted to their role or 'all'
            query.status = 'active';
            query.target_role = { $in: ['all', req.user.role] };
            query.$or = [{ expires_at: null }, { expires_at: { $gt: now } }];
        }

        if (req.query.priority) {
            const prioR = validateEnum(req.query.priority, 'Priority', ['normal', 'urgent']);
            if (prioR.error) return res.status(400).json({ message: prioR.error });
            query.priority = prioR.value;
        }

        const notices = await Notice.find(query).sort({ priority: -1, createdAt: -1 });

        const result = notices.map(n => {
            const obj = n.toObject();
            obj.id = obj._id.toString();
            obj.is_archived = (obj.status === 'archived');
            return obj;
        });

        res.json(result);
    } catch (err) {
        logger.error('Error fetching notices', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// VIEW SINGLE NOTICE: with audience visibility check
app.get('/api/notices/:id', authenticateJWT, authorizeRoles('admin', 'teacher', 'student'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Notice ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const notice = await Notice.findById(idR.value);
        if (!notice) return res.status(404).json({ message: 'Notice not found' });

        // Non-admin audience check
        if (req.user.role !== 'admin') {
            if (notice.status !== 'active') {
                return res.status(404).json({ message: 'Notice not found' });
            }
            if (notice.target_role !== 'all' && notice.target_role !== req.user.role) {
                return res.status(403).json({ message: 'Access denied to this announcement' });
            }
        }

        const obj = notice.toObject();
        obj.id = obj._id.toString();
        obj.is_archived = (obj.status === 'archived');
        res.json(obj);
    } catch (err) {
        logger.error('Error fetching notice', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// CREATE NOTICE: admin only
app.post('/api/notices', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const titleR = validateString(req.body.title, 'Notice Title', { maxLength: 150 });
        const contentR = validateString(req.body.content, 'Notice Content', { maxLength: 2000 });
        const targetR = validateEnum(req.body.target_role, 'Target Role', ['all', 'teacher', 'student']);
        const priorityR = validateEnum(req.body.priority, 'Priority', ['normal', 'urgent']);

        const firstErr = firstError(titleR, contentR, targetR, priorityR);
        if (firstErr) return res.status(400).json({ message: firstErr });

        let expiresAt = null;
        if (req.body.expires_at) {
            const expDate = new Date(req.body.expires_at);
            if (isNaN(expDate.getTime())) {
                return res.status(400).json({ message: 'Invalid expiration date format' });
            }
            expiresAt = expDate;
        }

        const adminUser = await User.findById(req.user.id);
        const authorName = adminUser ? adminUser.username : 'Administrator';

        const newNotice = await Notice.create({
            title: titleR.value,
            content: contentR.value,
            author_id: req.user.id,
            author_name: authorName,
            target_role: targetR.value,
            priority: priorityR.value,
            status: 'active',
            expires_at: expiresAt
        });

        const obj = newNotice.toObject();
        obj.id = obj._id.toString();
        obj.is_archived = false;

        logger.info('Notice published successfully', { requestId: req.requestId, noticeId: obj.id, priority: obj.priority });
        res.status(201).json(obj);
    } catch (err) {
        logger.error('Error creating notice', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// UPDATE NOTICE: admin only
app.put('/api/notices/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Notice ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const notice = await Notice.findById(idR.value);
        if (!notice) return res.status(404).json({ message: 'Notice not found' });

        if (req.body.title !== undefined) {
            const titleR = validateString(req.body.title, 'Notice Title', { maxLength: 150 });
            if (titleR.error) return res.status(400).json({ message: titleR.error });
            notice.title = titleR.value;
        }

        if (req.body.content !== undefined) {
            const contentR = validateString(req.body.content, 'Notice Content', { maxLength: 2000 });
            if (contentR.error) return res.status(400).json({ message: contentR.error });
            notice.content = contentR.value;
        }

        if (req.body.target_role !== undefined) {
            const targetR = validateEnum(req.body.target_role, 'Target Role', ['all', 'teacher', 'student']);
            if (targetR.error) return res.status(400).json({ message: targetR.error });
            notice.target_role = targetR.value;
        }

        if (req.body.priority !== undefined) {
            const priorityR = validateEnum(req.body.priority, 'Priority', ['normal', 'urgent']);
            if (priorityR.error) return res.status(400).json({ message: priorityR.error });
            notice.priority = priorityR.value;
        }

        if (req.body.status !== undefined) {
            const statusR = validateEnum(req.body.status, 'Status', ['active', 'archived']);
            if (statusR.error) return res.status(400).json({ message: statusR.error });
            notice.status = statusR.value;
        }

        if (req.body.expires_at !== undefined) {
            if (!req.body.expires_at) {
                notice.expires_at = null;
            } else {
                const expDate = new Date(req.body.expires_at);
                if (isNaN(expDate.getTime())) {
                    return res.status(400).json({ message: 'Invalid expiration date format' });
                }
                notice.expires_at = expDate;
            }
        }

        await notice.save();

        const obj = notice.toObject();
        obj.id = obj._id.toString();
        obj.is_archived = (obj.status === 'archived');

        logger.info('Notice updated successfully', { requestId: req.requestId, noticeId: obj.id });
        res.json(obj);
    } catch (err) {
        logger.error('Error updating notice', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// ARCHIVE/UNARCHIVE NOTICE: admin only
app.patch('/api/notices/:id/archive', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Notice ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const notice = await Notice.findById(idR.value);
        if (!notice) return res.status(404).json({ message: 'Notice not found' });

        notice.status = notice.status === 'active' ? 'archived' : 'active';
        await notice.save();

        const obj = notice.toObject();
        obj.id = obj._id.toString();
        obj.is_archived = (notice.status === 'archived');

        logger.info('Notice archive status toggled', { requestId: req.requestId, noticeId: obj.id, status: obj.status });
        res.json(obj);
    } catch (err) {
        logger.error('Error archiving notice', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// DELETE NOTICE: admin only
app.delete('/api/notices/:id', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
    try {
        const idR = validateObjectId(req.params.id, 'Notice ID');
        if (idR.error) return res.status(400).json({ message: idR.error });

        const notice = await Notice.findById(idR.value);
        if (!notice) return res.status(404).json({ message: 'Notice not found' });

        await Notice.findByIdAndDelete(idR.value);
        logger.info('Notice deleted successfully', { requestId: req.requestId, noticeId: idR.value });
        res.json({ success: true, deleted: true });
    } catch (err) {
        logger.error('Error deleting notice', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'An internal error occurred' });
    }
});

// ---------------------------------------------------------------------------
// Catch-all — serve frontend SPA for page navigation, 404 for unknown API / data routes
// ---------------------------------------------------------------------------
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || (req.accepts('json') && !req.accepts('html'))) {
        return next();
    }
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ---------------------------------------------------------------------------
// 404 ROUTE NOT FOUND HANDLER (STEP 5)
// ---------------------------------------------------------------------------
app.use((req, res) => {
    logger.warn('Route not found', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl || req.path,
        status: 404
    });
    res.status(404).json({
        message: 'Route not found',
        requestId: req.requestId
    });
});

// ---------------------------------------------------------------------------
// CENTRALIZED ERROR HANDLING MIDDLEWARE (STEP 8)
// Catches unhandled errors, JSON syntax errors, payload limit errors,
// and Mongoose/database errors without leaking stack traces or credentials.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
    const requestId = req.requestId;

    // 1. Body Parser / JSON Syntax Error
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        logger.warn('Malformed JSON payload', { requestId, status: 400, method: req.method, path: req.path });
        return res.status(400).json({ error: 'Malformed JSON payload in request body', message: 'Malformed JSON payload in request body', requestId });
    }

    // 2. Payload Too Large Error (express.json limit)
    if (err.type === 'entity.too.large' || err.status === 413) {
        logger.warn('Payload too large', { requestId, status: 413, method: req.method, path: req.path });
        return res.status(413).json({ error: 'Payload too large (maximum allowed size: 100kb)', message: 'Payload too large (maximum allowed size: 100kb)', requestId });
    }

    // 3. CORS Policy Error
    if (err.message === 'CORS request blocked by security policy') {
        logger.warn('CORS request blocked by security policy', { requestId, status: 403, method: req.method, path: req.path });
        return res.status(403).json({ error: 'CORS request blocked by security policy', message: 'CORS request blocked by security policy', requestId });
    }

    // 4. Mongoose CastError (e.g. invalid ObjectId)
    if (err.name === 'CastError') {
        logger.warn('Database cast error', { requestId, status: 400, path: err.path });
        return res.status(400).json({ error: `Invalid format for field: ${err.path}`, message: `Invalid format for field: ${err.path}`, requestId });
    }

    // 5. Mongoose ValidationError
    if (err.name === 'ValidationError') {
        const messages = Object.values(err.errors).map(e => e.message);
        logger.warn('Database validation error', { requestId, status: 400, errors: messages });
        return res.status(400).json({ error: messages.join(', '), message: messages.join(', '), requestId });
    }

    // 6. MongoDB Duplicate Key Error (E11000)
    if (err.code === 11000) {
        logger.warn('Database duplicate key error', { requestId, status: 409 });
        return res.status(409).json({ error: 'A record with duplicate unique fields already exists', message: 'A record with duplicate unique fields already exists', requestId });
    }

    // 7. General Server Error (never leak stack trace or internal secrets)
    logger.error('[SERVER ERROR]', {
        requestId,
        status: err.status || 500,
        message: err.message,
        method: req.method,
        path: req.originalUrl || req.path
    });

    const isProd = process.env.NODE_ENV === 'production';
    return res.status(err.status || 500).json({
        error: 'An internal error occurred',
        message: isProd ? 'Internal server error' : (err.message || 'An internal error occurred'),
        requestId
    });
});

const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
    logger.info(`Server running on http://localhost:${PORT}`, {
        port: PORT,
        host: HOST,
        environment: process.env.NODE_ENV || 'development'
    });
});

// ---------------------------------------------------------------------------
// GRACEFUL SHUTDOWN (P1 #6 STEP 11)
// Handles SIGTERM and SIGINT: stops HTTP traffic, closes DB cleanly, logs events.
// ---------------------------------------------------------------------------
let isShuttingDown = false;

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal}, initiating graceful shutdown...`, { signal });

    // Safety timeout: force exit if resources hang for longer than 10 seconds
    const forceExitTimer = setTimeout(() => {
        logger.error('Graceful shutdown timed out after 10s, forcing exit.', { signal });
        process.exit(1);
    }, 10000);
    forceExitTimer.unref();

    if (server && server.listening) {
        server.close(async (err) => {
            if (err) {
                logger.error('Error closing HTTP server during shutdown', { error: err.message });
            } else {
                logger.info('HTTP server closed. Stopped accepting new connections.');
            }

            try {
                await mongoose.connection.close();
                logger.info('MongoDB connection closed cleanly.');
            } catch (dbErr) {
                logger.error('Error closing MongoDB connection during shutdown', { error: dbErr.message });
            }

            logger.info('Graceful shutdown complete. Exiting process.');
            process.exit(0);
        });
    } else {
        try {
            await mongoose.connection.close();
            logger.info('MongoDB connection closed cleanly.');
        } catch (dbErr) {
            logger.error('Error closing MongoDB connection', { error: dbErr.message });
        }
        process.exit(0);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = { app, server, gracefulShutdown };

