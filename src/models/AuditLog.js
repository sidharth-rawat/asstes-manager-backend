const mongoose = require('mongoose');

const AUDIT_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'assigned',
  'unassigned',
  'status_changed',
  'location_changed',
  'bulk_assigned',
];

const auditLogSchema = new mongoose.Schema(
  {
    assetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Asset',
      required: true,
      index: true,
    },
    assetName: { type: String }, // snapshot — survives asset deletion
    assetSerialNo: { type: String },
    action: {
      type: String,
      required: true,
      enum: { values: AUDIT_ACTIONS, message: `action must be one of: ${AUDIT_ACTIONS.join(', ')}` },
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    performedByName: { type: String }, // snapshot
    performedByEmail: { type: String },
    // Generic before/after strings for quick display
    fromValue: { type: String },
    toValue: { type: String },
    // Full diff of all changed fields
    changes: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true, // createdAt acts as the event timestamp
    versionKey: false,
  }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ assetId: 1, createdAt: -1 });
auditLogSchema.index({ performedBy: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
module.exports.AUDIT_ACTIONS = AUDIT_ACTIONS;
