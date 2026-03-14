const mongoose = require('mongoose');

const ASSET_STATUSES = ['active', 'inactive', 'maintenance', 'retired', 'lost'];
const ASSET_CATEGORIES = [
  'laptop',
  'desktop',
  'monitor',
  'server',
  'networking',
  'phone',
  'tablet',
  'printer',
  'furniture',
  'vehicle',
  'software',
  'other',
];

const assetSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Asset name is required'],
      trim: true,
      maxlength: [200, 'Name cannot exceed 200 characters'],
    },
    serialNo: {
      type: String,
      required: [true, 'Serial number is required'],
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: [100, 'Serial number cannot exceed 100 characters'],
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      enum: {
        values: ASSET_CATEGORIES,
        message: `Category must be one of: ${ASSET_CATEGORIES.join(', ')}`,
      },
    },
    status: {
      type: String,
      enum: {
        values: ASSET_STATUSES,
        message: `Status must be one of: ${ASSET_STATUSES.join(', ')}`,
      },
      default: 'active',
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    locationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Location',
      default: null,
    },
    purchaseDate: {
      type: Date,
    },
    value: {
      type: Number,
      min: [0, 'Value cannot be negative'],
    },
    // Additional useful tracking fields
    manufacturer: {
      type: String,
      trim: true,
      maxlength: [100, 'Manufacturer cannot exceed 100 characters'],
    },
    model: {
      type: String,
      trim: true,
      maxlength: [100, 'Model cannot exceed 100 characters'],
    },
    warrantyExpiry: {
      type: Date,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
    },
    // Track assignment history
    assignmentHistory: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        assignedAt: { type: Date, default: Date.now },
        unassignedAt: { type: Date },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for common query patterns
assetSchema.index({ status: 1 });
assetSchema.index({ category: 1 });
assetSchema.index({ locationId: 1 });
assetSchema.index({ assignedTo: 1 });
assetSchema.index({ serialNo: 1 }, { unique: true });
assetSchema.index({ name: 'text', serialNo: 'text' }); // full-text search

// Virtual: is the asset under warranty?
assetSchema.virtual('underWarranty').get(function () {
  if (!this.warrantyExpiry) return null;
  return this.warrantyExpiry > new Date();
});

module.exports = mongoose.model('Asset', assetSchema);
module.exports.ASSET_STATUSES = ASSET_STATUSES;
module.exports.ASSET_CATEGORIES = ASSET_CATEGORIES;
