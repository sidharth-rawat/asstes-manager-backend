const express = require('express');
const jwt = require('jsonwebtoken');
const { body, param, query, validationResult } = require('express-validator');
const User = require('../models/User');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const signToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

const handleValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }
  return null;
};

// ─── Auth endpoints (public) ──────────────────────────────────────────────────

/**
 * POST /api/users/register
 * Creates a new user. The very first user in the system becomes admin;
 * all subsequent registrations default to the 'viewer' role.
 * An admin may pass a { role } field to override the default.
 */
router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/\d/)
      .withMessage('Password must contain at least one number'),
    body('department').optional().trim().isLength({ max: 100 }),
    body('role').optional().isIn(['admin', 'manager', 'viewer']).withMessage('Invalid role'),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const { name, email, password, department, role } = req.body;

      const existing = await User.findOne({ email });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Email already registered.' });
      }

      // First user in the system automatically becomes admin
      const userCount = await User.countDocuments();
      const assignedRole = userCount === 0 ? 'admin' : (role || 'viewer');

      const user = await User.create({ name, email, password, department, role: assignedRole });

      const token = signToken(user._id);

      res.status(201).json({
        success: true,
        message: userCount === 0 ? 'First admin user created.' : 'User registered.',
        token,
        user,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/users/login
 */
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const { email, password } = req.body;

      const user = await User.findOne({ email }).select('+password');
      if (!user || !(await user.comparePassword(password))) {
        return res.status(401).json({ success: false, message: 'Invalid email or password.' });
      }

      if (!user.isActive) {
        return res.status(403).json({ success: false, message: 'Account is deactivated.' });
      }

      const token = signToken(user._id);
      // Re-fetch without password for response
      const safeUser = await User.findById(user._id);

      res.json({ success: true, token, user: safeUser });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/users/me
 * Returns the currently authenticated user's profile.
 */
router.get('/me', verifyToken, async (req, res) => {
  res.json({ success: true, user: req.user });
});

/**
 * PATCH /api/users/me
 * Allow a user to update their own name / department / password.
 */
router.patch(
  '/me',
  verifyToken,
  [
    body('name').optional().trim().notEmpty().isLength({ max: 100 }),
    body('department').optional().trim().isLength({ max: 100 }),
    body('password')
      .optional()
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/\d/)
      .withMessage('Password must contain at least one number'),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const { name, department, password } = req.body;
      const update = {};
      if (name) update.name = name;
      if (department !== undefined) update.department = department;
      if (password) update.password = password; // pre-save hook handles hashing

      const user = await User.findByIdAndUpdate(req.user._id, update, {
        new: true,
        runValidators: true,
      });

      res.json({ success: true, user });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Admin-only user management ───────────────────────────────────────────────

/**
 * GET /api/users
 * List all users with optional filters.
 */
router.get(
  '/',
  verifyToken,
  requireRole('admin', 'manager'),
  [
    query('role').optional().isIn(['admin', 'manager', 'viewer']),
    query('isActive').optional().isBoolean(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 1000 }),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const { role, isActive, page = 1, limit = 20, search } = req.query;

      const filter = {};
      if (role) filter.role = role;
      if (isActive !== undefined) filter.isActive = isActive === 'true';
      if (search) filter.$text = { $search: search };

      const skip = (Number(page) - 1) * Number(limit);
      const [users, total] = await Promise.all([
        User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
        User.countDocuments(filter),
      ]);

      res.json({
        success: true,
        data: users,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit)),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/users/:id
 */
router.get(
  '/:id',
  verifyToken,
  requireRole('admin', 'manager'),
  param('id').isMongoId().withMessage('Invalid user ID'),
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

      res.json({ success: true, data: user });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/users/:id  — admin full update
 */
router.put(
  '/:id',
  verifyToken,
  requireRole('admin'),
  [
    param('id').isMongoId().withMessage('Invalid user ID'),
    body('name').optional().trim().notEmpty().isLength({ max: 100 }),
    body('email').optional().isEmail().normalizeEmail(),
    body('role').optional().isIn(['admin', 'manager', 'viewer']),
    body('department').optional().trim().isLength({ max: 100 }),
    body('isActive').optional().isBoolean(),
    body('password')
      .optional()
      .isLength({ min: 8 })
      .matches(/\d/),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const { name, email, role, department, isActive, password } = req.body;
      const update = {};
      if (name !== undefined) update.name = name;
      if (email !== undefined) update.email = email;
      if (role !== undefined) update.role = role;
      if (department !== undefined) update.department = department;
      if (isActive !== undefined) update.isActive = isActive;
      if (password !== undefined) update.password = password;

      if (email) {
        const conflict = await User.findOne({ email, _id: { $ne: req.params.id } });
        if (conflict) {
          return res.status(409).json({ success: false, message: 'Email already in use.' });
        }
      }

      const user = await User.findByIdAndUpdate(req.params.id, update, {
        new: true,
        runValidators: true,
      });

      if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

      res.json({ success: true, data: user });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/users/:id  — soft-delete (deactivates) the user
 */
router.delete(
  '/:id',
  verifyToken,
  requireRole('admin'),
  param('id').isMongoId().withMessage('Invalid user ID'),
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      if (req.params.id === req.user._id.toString()) {
        return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
      }

      const user = await User.findByIdAndUpdate(
        req.params.id,
        { isActive: false },
        { new: true }
      );

      if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

      res.json({ success: true, message: 'User deactivated.', data: user });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
