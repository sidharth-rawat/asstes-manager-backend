const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const Asset = require('../models/Asset');
const Location = require('../models/Location');
const User = require('../models/User');
const { verifyToken, requireRole } = require('../middleware/auth');
const { buildTree, findSubtree, collectDescendantIds } = require('../utils/buildTree');
const { logAudit } = require('../utils/auditLogger');

const router = express.Router();

const CATEGORIES = [
  'laptop', 'desktop', 'monitor', 'server', 'networking',
  'phone', 'tablet', 'printer', 'furniture', 'vehicle', 'software', 'other',
];
const STATUSES = ['active', 'inactive', 'maintenance', 'retired', 'lost'];

const handleValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }
  return null;
};

// ─── GET /api/assets/stats ────────────────────────────────────────────────────
/**
 * Aggregated stats for the dashboard.
 * Returns: total, byStatus, byCategory, byLocation (top 8)
 */
router.get('/stats', verifyToken, async (req, res, next) => {
  try {
    const [total, byStatus, byCategory, byLocation] = await Promise.all([
      Asset.countDocuments(),
      Asset.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Asset.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }]),
      Asset.aggregate([
        { $match: { locationId: { $ne: null } } },
        { $group: { _id: '$locationId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
        {
          $lookup: {
            from: 'locations',
            localField: '_id',
            foreignField: '_id',
            as: 'location',
          },
        },
        { $unwind: { path: '$location', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            name: { $ifNull: ['$location.name', 'Unknown'] },
            count: 1,
          },
        },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        total,
        byStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.count])),
        byCategory: byCategory.map((c) => ({ name: c._id, value: c.count })),
        byLocation: byLocation.map((l) => ({ name: l.name, count: l.count })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/assets/bulk-assign ────────────────────────────────────────────
router.post(
  '/bulk-assign',
  verifyToken,
  requireRole('admin', 'manager'),
  [
    body('assetIds').isArray({ min: 1 }).withMessage('assetIds must be a non-empty array'),
    body('assetIds.*').isMongoId().withMessage('Each assetId must be a valid Mongo ID'),
    body('userId')
      .optional({ nullable: true })
      .custom((v) => v === null || mongoose.Types.ObjectId.isValid(v))
      .withMessage('userId must be a valid Mongo ID or null'),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const { assetIds, userId } = req.body;
      const uniqueIds = [...new Set(assetIds)];

      const foundAssets = await Asset.find({ _id: { $in: uniqueIds } }).select('_id name serialNo assignedTo');
      if (foundAssets.length !== uniqueIds.length) {
        const foundSet = new Set(foundAssets.map((a) => a._id.toString()));
        const missing = uniqueIds.filter((id) => !foundSet.has(id));
        return res.status(404).json({ success: false, message: 'Some assets were not found.', missingIds: missing });
      }

      if (userId) {
        const user = await User.findById(userId);
        if (!user || !user.isActive) {
          return res.status(404).json({ success: false, message: 'Target user not found or inactive.' });
        }
      }

      const now = new Date();

      const bulkOps = foundAssets.map((asset) => ({
        updateOne: {
          filter: { _id: asset._id },
          update: [
            {
              $set: {
                assignedTo: userId || null,
                assignmentHistory: {
                  $concatArrays: [
                    {
                      $map: {
                        input: '$assignmentHistory',
                        as: 'h',
                        in: {
                          $cond: {
                            if: { $eq: ['$$h.unassignedAt', null] },
                            then: { $mergeObjects: ['$$h', { unassignedAt: now }] },
                            else: '$$h',
                          },
                        },
                      },
                    },
                    userId
                      ? [{ user: new mongoose.Types.ObjectId(userId), assignedAt: now, unassignedAt: null }]
                      : [],
                  ],
                },
              },
            },
          ],
        },
      }));

      await Asset.bulkWrite(bulkOps);

      // Audit log for each asset
      for (const asset of foundAssets) {
        await logAudit({
          assetId: asset._id,
          assetName: asset.name,
          assetSerialNo: asset.serialNo,
          action: 'bulk_assigned',
          user: req.user,
          fromValue: asset.assignedTo ? asset.assignedTo.toString() : 'Unassigned',
          toValue: userId || 'Unassigned',
        });
      }

      res.json({
        success: true,
        message: userId
          ? `${uniqueIds.length} asset(s) assigned.`
          : `${uniqueIds.length} asset(s) unassigned.`,
        affectedCount: uniqueIds.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/assets ──────────────────────────────────────────────────────────
router.get(
  '/',
  verifyToken,
  [
    query('status').optional().isIn(STATUSES),
    query('category').optional().isIn(CATEGORIES),
    query('locationId').optional().isMongoId(),
    query('deep').optional().isBoolean(),
    query('assignedTo').optional().isMongoId(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 500 }),
    query('order').optional().isIn(['asc', 'desc']),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const {
        status, category, locationId, deep, assignedTo,
        search, page = 1, limit = 20,
        sortBy = 'createdAt', order = 'desc',
      } = req.query;

      const filter = {};
      if (status) filter.status = status;
      if (category) filter.category = category;
      if (assignedTo) filter.assignedTo = assignedTo;

      if (locationId) {
        if (deep === 'true') {
          const allLocations = await Location.find({ isActive: true }).lean();
          const tree = buildTree(allLocations);
          const subtree = findSubtree(tree, locationId);
          if (subtree) {
            const ids = collectDescendantIds(subtree);
            filter.locationId = { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) };
          } else {
            filter.locationId = locationId;
          }
        } else {
          filter.locationId = locationId;
        }
      }

      if (search) filter.$text = { $search: search };

      const sortOrder = order === 'asc' ? 1 : -1;
      const allowedSort = ['name', 'serialNo', 'category', 'status', 'value', 'purchaseDate', 'createdAt'];
      const sortField = allowedSort.includes(sortBy) ? sortBy : 'createdAt';

      const skip = (Number(page) - 1) * Number(limit);
      const [assets, total] = await Promise.all([
        Asset.find(filter)
          .populate('assignedTo', 'name email department')
          .populate('locationId', 'name type')
          .sort({ [sortField]: sortOrder })
          .skip(skip)
          .limit(Number(limit)),
        Asset.countDocuments(filter),
      ]);

      res.json({
        success: true,
        data: assets,
        pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/assets/:id ──────────────────────────────────────────────────────
router.get(
  '/:id',
  verifyToken,
  param('id').isMongoId().withMessage('Invalid asset ID'),
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const asset = await Asset.findById(req.params.id)
        .populate('assignedTo', 'name email department role')
        .populate('locationId', 'name type parent')
        .populate('assignmentHistory.user', 'name email');

      if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });

      res.json({ success: true, data: asset });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/assets ─────────────────────────────────────────────────────────
router.post(
  '/',
  verifyToken,
  requireRole('admin', 'manager'),
  [
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 200 }),
    body('serialNo').trim().notEmpty().withMessage('Serial number is required').isLength({ max: 100 }),
    body('category').isIn(CATEGORIES).withMessage('Invalid category'),
    body('status').optional().isIn(STATUSES),
    body('assignedTo').optional({ nullable: true }).isMongoId(),
    body('locationId').optional({ nullable: true }).isMongoId(),
    body('purchaseDate').optional({ nullable: true }).isISO8601().toDate(),
    body('value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('manufacturer').optional().trim().isLength({ max: 100 }),
    body('model').optional().trim().isLength({ max: 100 }),
    body('warrantyExpiry').optional({ nullable: true }).isISO8601().toDate(),
    body('notes').optional().trim().isLength({ max: 1000 }),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const {
        name, serialNo, category, status, assignedTo,
        locationId, purchaseDate, value, manufacturer, model, warrantyExpiry, notes,
      } = req.body;

      if (assignedTo) {
        const user = await User.findById(assignedTo);
        if (!user || !user.isActive) {
          return res.status(400).json({ success: false, message: 'Assigned user not found or inactive.' });
        }
      }

      if (locationId) {
        const loc = await Location.findById(locationId);
        if (!loc || !loc.isActive) {
          return res.status(400).json({ success: false, message: 'Location not found or inactive.' });
        }
      }

      const assetData = {
        name, serialNo, category, locationId: locationId || null,
        purchaseDate, value, manufacturer, model, warrantyExpiry, notes,
      };
      if (status) assetData.status = status;
      if (assignedTo) {
        assetData.assignedTo = assignedTo;
        assetData.assignmentHistory = [{ user: assignedTo, assignedAt: new Date() }];
      }

      const asset = await Asset.create(assetData);
      await asset.populate('assignedTo', 'name email');
      await asset.populate('locationId', 'name type');

      await logAudit({
        assetId: asset._id,
        assetName: asset.name,
        assetSerialNo: asset.serialNo,
        action: 'created',
        user: req.user,
        toValue: asset.status,
      });

      res.status(201).json({ success: true, data: asset });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ success: false, message: 'Serial number already exists.' });
      }
      next(err);
    }
  }
);

// ─── PUT /api/assets/:id ──────────────────────────────────────────────────────
router.put(
  '/:id',
  verifyToken,
  requireRole('admin', 'manager'),
  [
    param('id').isMongoId().withMessage('Invalid asset ID'),
    body('name').optional().trim().notEmpty().isLength({ max: 200 }),
    body('serialNo').optional().trim().notEmpty().isLength({ max: 100 }),
    body('category').optional().isIn(CATEGORIES),
    body('status').optional().isIn(STATUSES),
    body('assignedTo').optional({ nullable: true }).custom((v) =>
      v === null || mongoose.Types.ObjectId.isValid(v)
    ),
    body('locationId').optional({ nullable: true }).custom((v) =>
      v === null || mongoose.Types.ObjectId.isValid(v)
    ),
    body('purchaseDate').optional({ nullable: true }).isISO8601().toDate(),
    body('value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('manufacturer').optional().trim().isLength({ max: 100 }),
    body('model').optional().trim().isLength({ max: 100 }),
    body('warrantyExpiry').optional({ nullable: true }).isISO8601().toDate(),
    body('notes').optional().trim().isLength({ max: 1000 }),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const asset = await Asset.findById(req.params.id);
      if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });

      const {
        name, serialNo, category, status, assignedTo,
        locationId, purchaseDate, value, manufacturer, model, warrantyExpiry, notes,
      } = req.body;

      // Track changes for audit log
      const changes = {};

      if ('status' in req.body && status !== asset.status) {
        changes.status = { from: asset.status, to: status };
      }

      if ('assignedTo' in req.body) {
        const newUserId = assignedTo || null;
        const prevUserId = asset.assignedTo ? asset.assignedTo.toString() : null;

        if (newUserId !== prevUserId) {
          changes.assignedTo = { from: prevUserId, to: newUserId };
          const now = new Date();
          asset.assignmentHistory = asset.assignmentHistory.map((h) => {
            if (!h.unassignedAt) return { ...h.toObject(), unassignedAt: now };
            return h;
          });
          if (newUserId) {
            const user = await User.findById(newUserId);
            if (!user || !user.isActive) {
              return res.status(400).json({ success: false, message: 'Target user not found or inactive.' });
            }
            asset.assignmentHistory.push({ user: newUserId, assignedAt: now });
          }
          asset.assignedTo = newUserId;
        }
      }

      if ('locationId' in req.body) {
        const newLocId = locationId || null;
        const prevLocId = asset.locationId ? asset.locationId.toString() : null;
        if (newLocId !== prevLocId) {
          changes.locationId = { from: prevLocId, to: newLocId };
        }
        asset.locationId = newLocId;
      }

      if (name !== undefined) { changes.name = { from: asset.name, to: name }; asset.name = name; }
      if (serialNo !== undefined) asset.serialNo = serialNo;
      if (category !== undefined) asset.category = category;
      if (status !== undefined) asset.status = status;
      if (purchaseDate !== undefined) asset.purchaseDate = purchaseDate;
      if (value !== undefined) asset.value = value;
      if (manufacturer !== undefined) asset.manufacturer = manufacturer;
      if (model !== undefined) asset.model = model;
      if (warrantyExpiry !== undefined) asset.warrantyExpiry = warrantyExpiry;
      if (notes !== undefined) asset.notes = notes;

      await asset.save();
      await asset.populate('assignedTo', 'name email department');
      await asset.populate('locationId', 'name type');

      // Determine the most specific action label
      let auditAction = 'updated';
      if (changes.status) auditAction = 'status_changed';
      else if (changes.assignedTo) auditAction = changes.assignedTo.to ? 'assigned' : 'unassigned';
      else if (changes.locationId) auditAction = 'location_changed';

      if (Object.keys(changes).length > 0) {
        await logAudit({
          assetId: asset._id,
          assetName: asset.name,
          assetSerialNo: asset.serialNo,
          action: auditAction,
          user: req.user,
          fromValue: changes.status?.from || changes.assignedTo?.from || undefined,
          toValue: changes.status?.to || changes.assignedTo?.to || undefined,
          changes,
        });
      }

      res.json({ success: true, data: asset });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ success: false, message: 'Serial number already exists.' });
      }
      next(err);
    }
  }
);

// ─── DELETE /api/assets/:id ───────────────────────────────────────────────────
router.delete(
  '/:id',
  verifyToken,
  requireRole('admin'),
  param('id').isMongoId().withMessage('Invalid asset ID'),
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const asset = await Asset.findByIdAndDelete(req.params.id);
      if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });

      await logAudit({
        assetId: asset._id,
        assetName: asset.name,
        assetSerialNo: asset.serialNo,
        action: 'deleted',
        user: req.user,
        fromValue: asset.status,
      });

      res.json({ success: true, message: 'Asset permanently deleted.', data: asset });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
