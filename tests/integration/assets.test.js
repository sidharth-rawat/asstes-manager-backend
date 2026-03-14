/**
 * Integration tests — Asset routes
 * GET    /api/assets/stats
 * POST   /api/assets/bulk-assign
 * GET    /api/assets
 * GET    /api/assets/:id
 * POST   /api/assets
 * PUT    /api/assets/:id
 * DELETE /api/assets/:id
 */
const request = require('supertest');
const app = require('../../src/index');
const { connect, disconnect, clearDatabase } = require('../setup/db');
const {
  createAdmin, createManager, createViewer,
  createAsset, createBuilding, createFloor,
} = require('../helpers');

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.MONGODB_URI = 'mongodb://localhost/test';
  await connect();
});
afterAll(async () => { await disconnect(); });
afterEach(async () => { await clearDatabase(); });

// ─── Stats ────────────────────────────────────────────────────────────────────
describe('GET /api/assets/stats', () => {
  test('returns aggregated stats', async () => {
    const { token } = await createViewer();
    await createAsset({ category: 'laptop', status: 'active' });
    await createAsset({ category: 'laptop', status: 'inactive' });
    await createAsset({ category: 'desktop', status: 'active' });

    const res = await request(app)
      .get('/api/assets/stats')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.byStatus).toBeDefined();
    expect(res.body.data.byCategory).toBeInstanceOf(Array);
    expect(res.body.data.byLocation).toBeInstanceOf(Array);
  });

  test('returns 401 without token', async () => {
    const res = await request(app).get('/api/assets/stats');
    expect(res.status).toBe(401);
  });
});

// ─── GET list ─────────────────────────────────────────────────────────────────
describe('GET /api/assets', () => {
  test('returns paginated asset list', async () => {
    const { token } = await createViewer();
    await createAsset({ name: 'Asset 1' });
    await createAsset({ name: 'Asset 2' });

    const res = await request(app)
      .get('/api/assets')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.pagination.total).toBe(2);
  });

  test('filters by status', async () => {
    const { token } = await createViewer();
    await createAsset({ status: 'active' });
    await createAsset({ status: 'retired' });

    const res = await request(app)
      .get('/api/assets?status=active')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('active');
  });

  test('filters by category', async () => {
    const { token } = await createViewer();
    await createAsset({ category: 'laptop' });
    await createAsset({ category: 'desktop' });

    const res = await request(app)
      .get('/api/assets?category=laptop')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    res.body.data.forEach((a) => expect(a.category).toBe('laptop'));
  });

  test('pagination works', async () => {
    const { token } = await createViewer();
    for (let i = 0; i < 5; i++) await createAsset({ name: `Asset ${i}` });

    const res = await request(app)
      .get('/api/assets?page=1&limit=3')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination.pages).toBe(2);
  });

  test('returns 401 without token', async () => {
    const res = await request(app).get('/api/assets');
    expect(res.status).toBe(401);
  });
});

// ─── GET single ───────────────────────────────────────────────────────────────
describe('GET /api/assets/:id', () => {
  test('returns asset by id', async () => {
    const { token } = await createViewer();
    const asset = await createAsset({ name: 'My Laptop' });

    const res = await request(app)
      .get(`/api/assets/${asset._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('My Laptop');
  });

  test('returns 404 for non-existent asset', async () => {
    const { token } = await createViewer();
    const res = await request(app)
      .get('/api/assets/507f1f77bcf86cd799439011')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('returns 422 for invalid ObjectId', async () => {
    const { token } = await createViewer();
    const res = await request(app)
      .get('/api/assets/bad-id')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(422);
  });
});

// ─── POST (create) ────────────────────────────────────────────────────────────
describe('POST /api/assets', () => {
  test('admin can create an asset', async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post('/api/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Laptop', serialNo: 'SN-NEW-001', category: 'laptop' });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('New Laptop');
    expect(res.body.data.serialNo).toBe('SN-NEW-001');
  });

  test('manager can create an asset', async () => {
    const { token } = await createManager();
    const res = await request(app)
      .post('/api/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Manager Asset', serialNo: 'SN-MGR-001', category: 'desktop' });
    expect(res.status).toBe(201);
  });

  test('viewer cannot create asset (403)', async () => {
    const { token } = await createViewer();
    const res = await request(app)
      .post('/api/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Sneaky Asset', serialNo: 'SN-SNEAK-001', category: 'laptop' });
    expect(res.status).toBe(403);
  });

  test('rejects duplicate serial number (409)', async () => {
    const { token } = await createAdmin();
    await request(app).post('/api/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Asset A', serialNo: 'SN-DUP-001', category: 'laptop' });

    const res = await request(app).post('/api/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Asset B', serialNo: 'SN-DUP-001', category: 'laptop' });

    expect(res.status).toBe(409);
  });

  test('rejects invalid category (422)', async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post('/api/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', serialNo: 'SN-X', category: 'spaceship' });
    expect(res.status).toBe(422);
  });

  test('rejects missing required fields (422)', async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post('/api/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'No Serial' });
    expect(res.status).toBe(422);
  });

  test('creates asset with location', async () => {
    const { token } = await createAdmin();
    const building = await createBuilding();

    const res = await request(app)
      .post('/api/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Located Asset',
        serialNo: 'SN-LOC-001',
        category: 'laptop',
        locationId: building._id,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.locationId._id).toBe(building._id.toString());
  });

  test('creates asset with assigned user and records assignment history', async () => {
    const { token } = await createAdmin();
    const { user: viewer } = await createViewer();

    const res = await request(app)
      .post('/api/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Assigned Laptop',
        serialNo: 'SN-ASSIGN-001',
        category: 'laptop',
        assignedTo: viewer._id,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.assignedTo._id).toBe(viewer._id.toString());
    expect(res.body.data.assignmentHistory).toHaveLength(1);
  });
});

// ─── PUT (update) ─────────────────────────────────────────────────────────────
describe('PUT /api/assets/:id', () => {
  test('admin can update asset name', async () => {
    const { token } = await createAdmin();
    const asset = await createAsset({ name: 'Old Name' });

    const res = await request(app)
      .put(`/api/assets/${asset._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('New Name');
  });

  test('can change asset status', async () => {
    const { token } = await createAdmin();
    const asset = await createAsset({ status: 'active' });

    const res = await request(app)
      .put(`/api/assets/${asset._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'maintenance' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('maintenance');
  });

  test('can assign user to asset', async () => {
    const { token } = await createAdmin();
    const asset = await createAsset();
    const { user } = await createViewer();

    const res = await request(app)
      .put(`/api/assets/${asset._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assignedTo: user._id });

    expect(res.status).toBe(200);
    expect(res.body.data.assignedTo._id).toBe(user._id.toString());
  });

  test('can unassign asset by passing assignedTo: null', async () => {
    const { token } = await createAdmin();
    const { user } = await createViewer();
    const asset = await createAsset({ assignedTo: user._id });

    const res = await request(app)
      .put(`/api/assets/${asset._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assignedTo: null });

    expect(res.status).toBe(200);
    expect(res.body.data.assignedTo).toBeNull();
  });

  test('viewer cannot update asset (403)', async () => {
    const { token } = await createViewer();
    const asset = await createAsset();

    const res = await request(app)
      .put(`/api/assets/${asset._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hacked Name' });

    expect(res.status).toBe(403);
  });

  test('returns 404 for non-existent asset', async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .put('/api/assets/507f1f77bcf86cd799439011')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────
describe('DELETE /api/assets/:id', () => {
  test('admin can delete asset', async () => {
    const { token } = await createAdmin();
    const asset = await createAsset();

    const res = await request(app)
      .delete(`/api/assets/${asset._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('manager cannot delete asset (403)', async () => {
    const { token } = await createManager();
    const asset = await createAsset();

    const res = await request(app)
      .delete(`/api/assets/${asset._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('returns 404 for non-existent asset', async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .delete('/api/assets/507f1f77bcf86cd799439011')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

// ─── Bulk assign ──────────────────────────────────────────────────────────────
describe('POST /api/assets/bulk-assign', () => {
  test('admin can bulk-assign assets to a user', async () => {
    const { token } = await createAdmin();
    const asset1 = await createAsset();
    const asset2 = await createAsset();
    const { user } = await createViewer();

    const res = await request(app)
      .post('/api/assets/bulk-assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetIds: [asset1._id, asset2._id], userId: user._id });

    expect(res.status).toBe(200);
    expect(res.body.affectedCount).toBe(2);
  });

  test('bulk-unassign by passing userId: null', async () => {
    const { token } = await createAdmin();
    const { user } = await createViewer();
    const asset = await createAsset({ assignedTo: user._id });

    const res = await request(app)
      .post('/api/assets/bulk-assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetIds: [asset._id], userId: null });

    expect(res.status).toBe(200);
    expect(res.body.affectedCount).toBe(1);
  });

  test('returns 404 if any assetId is not found', async () => {
    const { token } = await createAdmin();
    const asset = await createAsset();
    const fakeId = '507f1f77bcf86cd799439011';

    const res = await request(app)
      .post('/api/assets/bulk-assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetIds: [asset._id, fakeId], userId: null });

    expect(res.status).toBe(404);
  });

  test('returns 404 if target user is inactive', async () => {
    const { token } = await createAdmin();
    const asset = await createAsset();
    const { user } = await createViewer();
    const User = require('../../src/models/User');
    await User.updateOne({ _id: user._id }, { isActive: false });

    const res = await request(app)
      .post('/api/assets/bulk-assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetIds: [asset._id], userId: user._id });

    expect(res.status).toBe(404);
  });

  test('viewer cannot bulk-assign (403)', async () => {
    const { token } = await createViewer();
    const asset = await createAsset();

    const res = await request(app)
      .post('/api/assets/bulk-assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetIds: [asset._id], userId: null });

    expect(res.status).toBe(403);
  });

  test('rejects empty assetIds array (422)', async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post('/api/assets/bulk-assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetIds: [], userId: null });
    expect(res.status).toBe(422);
  });
});
