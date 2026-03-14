const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const Location = require('../models/Location');
const Asset = require('../models/Asset');
const { verifyToken, requireRole } = require('../middleware/auth');
const { buildTree, findSubtree, collectDescendantIds } = require('../utils/buildTree');

const router = express.Router();

const handleValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }
  return null;
};

// ─── GET /api/locations/tree ──────────────────────────────────────────────────
/**
 * Returns the full location hierarchy as a nested tree.
 * Optional query param ?rootId=<id> to get the subtree of a specific node.
 *
 * Response shape:
 *  [
 *    { _id, name, type, ..., children: [
 *        { _id, name, type, ..., children: [ ... ] }
 *    ]}
 *  ]
 */
router.get(
  '/tree',
  verifyToken,
  [query('rootId').optional().isMongoId().withMessage('rootId must be a valid Mongo ID')],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      // Fetch all active locations — lean() gives plain JS objects (faster)
      const locations = await Location.find({ isActive: true }).sort({ type: 1, name: 1 }).lean();

      const tree = buildTree(locations);

      if (req.query.rootId) {
        const subtree = findSubtree(tree, req.query.rootId);
        if (!subtree) {
          return res.status(404).json({ success: false, message: 'Root location not found or inactive.' });
        }
        return res.json({ success: true, data: subtree });
      }

      res.json({ success: true, data: tree });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/locations ───────────────────────────────────────────────────────
/**
 * Flat list of locations with optional filters.
 */
router.get(
  '/',
  verifyToken,
  [
    query('type').optional().isIn(['building', 'floor', 'room']),
    query('parent').optional().isMongoId(),
    query('isActive').optional().isBoolean(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 1000 }),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const { type, parent, isActive, page = 1, limit = 50, search } = req.query;

      const filter = {};
      if (type) filter.type = type;
      if (parent) filter.parent = parent;
      if (isActive !== undefined) filter.isActive = isActive === 'true';
      // Default to only active locations
      if (isActive === undefined) filter.isActive = true;

      const skip = (Number(page) - 1) * Number(limit);
      const [locations, total] = await Promise.all([
        Location.find(filter)
          .populate('parent', 'name type')
          .sort({ type: 1, name: 1 })
          .skip(skip)
          .limit(Number(limit)),
        Location.countDocuments(filter),
      ]);

      res.json({
        success: true,
        data: locations,
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

// ─── GET /api/locations/:id ───────────────────────────────────────────────────
router.get(
  '/:id',
  verifyToken,
  param('id').isMongoId().withMessage('Invalid location ID'),
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const location = await Location.findById(req.params.id).populate('parent', 'name type');
      if (!location) {
        return res.status(404).json({ success: false, message: 'Location not found.' });
      }

      // Include direct children count as metadata
      const childrenCount = await Location.countDocuments({ parent: location._id, isActive: true });
      const assetCount = await Asset.countDocuments({ locationId: location._id });

      res.json({
        success: true,
        data: location,
        meta: { childrenCount, assetCount },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/locations ──────────────────────────────────────────────────────
router.post(
  '/',
  verifyToken,
  requireRole('admin', 'manager'),
  [
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 150 }),
    body('type')
      .isIn(['building', 'floor', 'room'])
      .withMessage('Type must be building, floor, or room'),
    body('parent').optional({ nullable: true }).isMongoId().withMessage('parent must be a valid Mongo ID'),
    body('description').optional().trim().isLength({ max: 500 }),
    body('address').optional().isObject(),
    body('address.street').optional().trim(),
    body('address.city').optional().trim(),
    body('address.state').optional().trim(),
    body('address.country').optional().trim(),
    body('address.postalCode').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const { name, type, parent, description, address } = req.body;

      // Validate hierarchy: building has no parent, floor's parent must be a building,
      // room's parent must be a floor.
      if (parent) {
        const parentDoc = await Location.findById(parent);
        if (!parentDoc) {
          return res.status(400).json({ success: false, message: 'Parent location not found.' });
        }

        const validParentTypes = { floor: 'building', room: 'floor' };
        const expectedParentType = validParentTypes[type];

        if (!expectedParentType) {
          return res.status(400).json({
            success: false,
            message: 'A building cannot have a parent location.',
          });
        }

        if (parentDoc.type !== expectedParentType) {
          return res.status(400).json({
            success: false,
            message: `A ${type} must have a ${expectedParentType} as its parent. Got: ${parentDoc.type}.`,
          });
        }
      } else if (type !== 'building') {
        return res.status(400).json({
          success: false,
          message: `A ${type} must have a parent location.`,
        });
      }

      const location = await Location.create({ name, type, parent: parent || null, description, address });

      res.status(201).json({ success: true, data: location });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/locations/:id ───────────────────────────────────────────────────
router.put(
  '/:id',
  verifyToken,
  requireRole('admin', 'manager'),
  [
    param('id').isMongoId().withMessage('Invalid location ID'),
    body('name').optional().trim().notEmpty().isLength({ max: 150 }),
    body('description').optional().trim().isLength({ max: 500 }),
    body('isActive').optional().isBoolean(),
    body('address').optional().isObject(),
    body('address.street').optional().trim(),
    body('address.city').optional().trim(),
    body('address.state').optional().trim(),
    body('address.country').optional().trim(),
    body('address.postalCode').optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      // type and parent are intentionally not updatable to maintain hierarchy integrity.
      // To move a location, delete and recreate it.
      const { name, description, isActive, address } = req.body;
      const update = {};
      if (name !== undefined) update.name = name;
      if (description !== undefined) update.description = description;
      if (isActive !== undefined) update.isActive = isActive;
      if (address !== undefined) update.address = address;

      const location = await Location.findByIdAndUpdate(req.params.id, update, {
        new: true,
        runValidators: true,
      }).populate('parent', 'name type');

      if (!location) return res.status(404).json({ success: false, message: 'Location not found.' });

      res.json({ success: true, data: location });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/locations/:id ────────────────────────────────────────────────
/**
 * Soft-deletes a location. Refuses if the location has active children or
 * assigned assets (to preserve referential integrity).
 * Use ?force=true to hard-delete (admin only).
 */
router.delete(
  '/:id',
  verifyToken,
  requireRole('admin'),
  param('id').isMongoId().withMessage('Invalid location ID'),
  async (req, res, next) => {
    try {
      const validationError = handleValidation(req, res);
      if (validationError) return;

      const location = await Location.findById(req.params.id);
      if (!location) return res.status(404).json({ success: false, message: 'Location not found.' });

      // Check for active children
      const childCount = await Location.countDocuments({ parent: req.params.id, isActive: true });
      if (childCount > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot delete: ${childCount} active child location(s) exist. Deactivate or move them first.`,
        });
      }

      // Check for assets assigned to this location
      const assetCount = await Asset.countDocuments({ locationId: req.params.id });
      if (assetCount > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot delete: ${assetCount} asset(s) are assigned to this location. Reassign them first.`,
        });
      }

      if (req.query.force === 'true') {
        await Location.findByIdAndDelete(req.params.id);
        return res.json({ success: true, message: 'Location permanently deleted.' });
      }

      await Location.findByIdAndUpdate(req.params.id, { isActive: false });
      res.json({ success: true, message: 'Location deactivated.' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
