require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');

const userRoutes = require('./routes/users');
const assetRoutes = require('./routes/assets');
const locationRoutes = require('./routes/locations');
const auditRoutes = require('./routes/audit');

// ─── Validate required environment variables ──────────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// ─── Express app setup ────────────────────────────────────────────────────────
const app = express();

// ─── Security headers (helmet) ────────────────────────────────────────────────
app.use(helmet());

// ─── Rate limiting ────────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 min
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 100;
const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX) || 10;

const isTest = process.env.NODE_ENV === 'test';

// General API rate limiter — 100 req / 15 min per IP
const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,  // Return RateLimit-* headers
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
  skip: () => isTest,
});

// Strict auth limiter — 10 attempts / 15 min per IP (brute-force protection)
const authLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many authentication attempts. Please try again later.' },
  skip: () => isTest,
});

// CORS — parse comma-separated origin list from env
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0
      ? (origin, cb) => {
          // Allow requests with no origin (server-to-server, curl, etc.)
          if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
          cb(new Error(`CORS: origin '${origin}' not allowed`));
        }
      : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── MongoDB operator injection sanitization ──────────────────────────────────
// Strips keys containing '$' or '.' from req.body, req.params, req.query
app.use(mongoSanitize());

// ─── Apply rate limiters ──────────────────────────────────────────────────────
app.use('/api/', apiLimiter);
app.use('/api/users/login', authLimiter);
app.use('/api/users/register', authLimiter);

// ─── Request logger (simple, no external deps) ───────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
  });
}

// ─── Health check (no auth required) ─────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    mongoState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/users', userRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/audit', auditRoutes);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err);

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(422).json({ success: false, message: 'Validation failed.', errors: messages });
  }

  // Mongoose cast error (invalid ObjectId in URL param)
  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: `Invalid value for field '${err.path}'.` });
  }

  // Mongo duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({
      success: false,
      message: `Duplicate value: '${err.keyValue?.[field]}' already exists for ${field}.`,
    });
  }

  // CORS error
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ success: false, message: err.message });
  }

  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error.' : err.message,
  });
});

// ─── MongoDB connection + server start ───────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;

const connectAndStart = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      // These options are defaults in Mongoose 8+ but listed for clarity
      serverSelectionTimeoutMS: 10_000,
    });
    console.log('[db] Connected to MongoDB');

    const server = app.listen(PORT, () => {
      console.log(`[server] Asset Lifecycle API running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
    });

    // Graceful shutdown
    const shutdown = (signal) => {
      console.log(`[server] ${signal} received — shutting down gracefully`);
      server.close(async () => {
        await mongoose.connection.close();
        console.log('[server] Closed. Goodbye.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('[db] Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }
};

// Only auto-start when this file is run directly (not during Jest tests)
if (require.main === module) {
  connectAndStart();
}

module.exports = app; // exported for testing
