const mongoose = require('mongoose');

const LOCATION_TYPES = ['building', 'floor', 'room'];

const locationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Location name is required'],
      trim: true,
      maxlength: [150, 'Name cannot exceed 150 characters'],
    },
    type: {
      type: String,
      required: [true, 'Location type is required'],
      enum: {
        values: LOCATION_TYPES,
        message: `Type must be one of: ${LOCATION_TYPES.join(', ')}`,
      },
    },
    // Null parent = root-level (building). Buildings → floors → rooms.
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Location',
      default: null,
    },
    // Address stored only at building level but accepted at any level
    address: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true },
      postalCode: { type: String, trim: true },
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description cannot exceed 500 characters'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Index for fast parent-child lookups used in tree building
locationSchema.index({ parent: 1 });
locationSchema.index({ type: 1 });

module.exports = mongoose.model('Location', locationSchema);
module.exports.LOCATION_TYPES = LOCATION_TYPES;
