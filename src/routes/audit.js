const express = require('express');
const { param, query, validationResult } = require('express-validator');
const AuditLog = require('../models/AuditLog');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

const handleValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }
  return null;
};

/**
 * GET /api/audit
 * Returns paginated audit logs across all assets.
 * Query params: page, limit, action, assetId, performedBy
 */
router.get(
  '/',
  verifyToken,
  requireRole('admin', 'manager'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('action').optional().isIn([
      'created', 'updated', 'deleted', 'assigned', 'unassigned',
      'status_changed', 'location_changed', 'bulk_assigned',
    ]),
    query('assetId').optional().isMongoId(),
    query('performedBy').optional().isMongoId(),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const { page = 1, limit = 30, action, assetId, performedBy } = req.query;

      const filter = {};
      if (action) filter.action = action;
      if (assetId) filter.assetId = assetId;
      if (performedBy) filter.performedBy = performedBy;

      const skip = (Number(page) - 1) * Number(limit);
      const [logs, total] = await Promise.all([
        AuditLog.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(Number(limit))
          .populate('performedBy', 'name email')
          .populate('assetId', 'name serialNo'),
        AuditLog.countDocuments(filter),
      ]);

      res.json({
        success: true,
        data: logs,
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
 * GET /api/audit/asset/:assetId
 * Returns the full audit trail for a specific asset, newest first.
 */
router.get(
  '/asset/:assetId',
  verifyToken,
  [
    param('assetId').isMongoId().withMessage('Invalid asset ID'),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 200 }),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const { page = 1, limit = 50 } = req.query;
      const skip = (Number(page) - 1) * Number(limit);

      const [logs, total] = await Promise.all([
        AuditLog.find({ assetId: req.params.assetId })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(Number(limit))
          .populate('performedBy', 'name email role'),
        AuditLog.countDocuments({ assetId: req.params.assetId }),
      ]);

      res.json({
        success: true,
        data: logs,
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

module.exports = router;
