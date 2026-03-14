/**
 * Integration tests — Audit log routes
 * GET /api/audit
 * GET /api/audit/asset/:assetId
 *
 * Also verifies that asset mutations (create/update/delete/bulk-assign)
 * produce audit log entries.
 */
const request = require('supertest');
const app = require('../../src/index');
const { connect, disconnect, clearDatabase } = require('../setup/db');
const { createAdmin, createManager, createViewer, createAsset } = require('../helpers');
const AuditLog = require('../../src/models/AuditLog');

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.MONGODB_URI = 'mongodb://localhost/test';
  await connect();
});
afterAll(async () => { await disconnect(); });
afterEach(async () => { await clearDatabase(); });

// Helper: create asset via API so audit log is produced
async function apiCreateAsset(token, body = {}) {
  const uniqueSerial = `SN-${Date.now()}-${Math.random().toString(36).slice(2).toUpperCase()}`;
  return request(app)
    .post('/api/assets')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Audit Test Laptop', serialNo: uniqueSerial, category: 'laptop', ...body });
}

describe('GET /api/audit (global log)', () => {
  test('admin can list audit logs', async () => {
    const { token } = await createAdmin();
    await apiCreateAsset(token);

    const res = await request(app)
      .get('/api/audit')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.pagination).toBeDefined();
  });

  test('manager can list audit logs', async () => {
    const { token: adminToken } = await createAdmin();
    const { token: mgrToken } = await createManager();
    await apiCreateAsset(adminToken);

    const res = await request(app)
      .get('/api/audit')
      .set('Authorization', `Bearer ${mgrToken}`);

    expect(res.status).toBe(200);
  });

  test('viewer cannot access audit logs (403)', async () => {
    const { token } = await createViewer();
    const res = await request(app)
      .get('/api/audit')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('returns 401 without token', async () => {
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(401);
  });

  test('filters by action', async () => {
    const { token } = await createAdmin();
    await apiCreateAsset(token);

    const res = await request(app)
      .get('/api/audit?action=created')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    res.body.data.forEach((log) => expect(log.action).toBe('created'));
  });

  test('pagination works', async () => {
    const { token } = await createAdmin();
    // Create 5 assets (5 audit entries)
    for (let i = 0; i < 5; i++) await apiCreateAsset(token);

    const res = await request(app)
      .get('/api/audit?page=1&limit=3')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(5);
  });
});

describe('GET /api/audit/asset/:assetId', () => {
  test('returns audit trail for a specific asset', async () => {
    const { token } = await createAdmin();
    const createRes = await apiCreateAsset(token);
    const assetId = createRes.body.data._id;

    // Also update it to generate another log
    await request(app)
      .put(`/api/assets/${assetId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'maintenance' });

    const res = await request(app)
      .get(`/api/audit/asset/${assetId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    res.body.data.forEach((log) => {
      // assetId may be populated or raw ObjectId string
      const logAssetId = typeof log.assetId === 'object' ? log.assetId._id : log.assetId;
      expect(logAssetId).toBe(assetId);
    });
  });

  test('returns empty array for asset with no audit history', async () => {
    const { token } = await createAdmin();
    const asset = await createAsset(); // created via model, no API call = no audit log

    const res = await request(app)
      .get(`/api/audit/asset/${asset._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  test('returns 422 for invalid assetId', async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .get('/api/audit/asset/not-a-valid-id')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(422);
  });

  test('viewer can view asset-specific audit log', async () => {
    const { token: adminToken } = await createAdmin();
    const { token: viewerToken } = await createViewer();
    const createRes = await apiCreateAsset(adminToken);
    const assetId = createRes.body.data._id;

    const res = await request(app)
      .get(`/api/audit/asset/${assetId}`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(res.status).toBe(200);
  });
});

describe('Audit log creation on asset mutations', () => {
  test('creating an asset produces a "created" audit log', async () => {
    const { token } = await createAdmin();
    const createRes = await apiCreateAsset(token);
    const assetId = createRes.body.data._id;

    const log = await AuditLog.findOne({ assetId, action: 'created' });
    expect(log).not.toBeNull();
    expect(log.assetName).toBeDefined();
  });

  test('updating status produces a "status_changed" audit log', async () => {
    const { token } = await createAdmin();
    const createRes = await apiCreateAsset(token);
    const assetId = createRes.body.data._id;

    await request(app)
      .put(`/api/assets/${assetId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'retired' });

    const log = await AuditLog.findOne({ assetId, action: 'status_changed' });
    expect(log).not.toBeNull();
    expect(log.fromValue).toBe('active');
    expect(log.toValue).toBe('retired');
  });

  test('assigning user produces an "assigned" audit log', async () => {
    const { token } = await createAdmin();
    const { user } = await createViewer();
    const createRes = await apiCreateAsset(token);
    const assetId = createRes.body.data._id;

    await request(app)
      .put(`/api/assets/${assetId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assignedTo: user._id });

    const log = await AuditLog.findOne({ assetId, action: 'assigned' });
    expect(log).not.toBeNull();
  });

  test('deleting asset produces a "deleted" audit log', async () => {
    const { token } = await createAdmin();
    const createRes = await apiCreateAsset(token);
    const assetId = createRes.body.data._id;

    await request(app)
      .delete(`/api/assets/${assetId}`)
      .set('Authorization', `Bearer ${token}`);

    const log = await AuditLog.findOne({ assetId, action: 'deleted' });
    expect(log).not.toBeNull();
  });

  test('bulk-assign produces "bulk_assigned" audit logs for each asset', async () => {
    const { token } = await createAdmin();
    const { user } = await createViewer();
    const asset1 = await createAsset();
    const asset2 = await createAsset();

    await request(app)
      .post('/api/assets/bulk-assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetIds: [asset1._id, asset2._id], userId: user._id });

    const logs = await AuditLog.find({ action: 'bulk_assigned' });
    expect(logs.length).toBe(2);
  });
});
