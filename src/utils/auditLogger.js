const AuditLog = require('../models/AuditLog');

/**
 * logAudit — fire-and-forget audit log creation.
 * Failures are logged to stderr but never propagate to the caller.
 *
 * @param {Object} opts
 * @param {string|ObjectId} opts.assetId
 * @param {string} opts.assetName      snapshot of asset name
 * @param {string} opts.assetSerialNo  snapshot
 * @param {string} opts.action         one of AUDIT_ACTIONS
 * @param {Object} opts.user           req.user (performedBy, name, email)
 * @param {string} [opts.fromValue]    human-readable "before"
 * @param {string} [opts.toValue]      human-readable "after"
 * @param {Object} [opts.changes]      full diff { field: { from, to } }
 */
async function logAudit({ assetId, assetName, assetSerialNo, action, user, fromValue, toValue, changes }) {
  try {
    await AuditLog.create({
      assetId,
      assetName,
      assetSerialNo,
      action,
      performedBy: user?._id,
      performedByName: user?.name,
      performedByEmail: user?.email,
      fromValue,
      toValue,
      changes,
    });
  } catch (err) {
    console.error('[audit] Failed to write audit log:', err.message);
  }
}

module.exports = { logAudit };
