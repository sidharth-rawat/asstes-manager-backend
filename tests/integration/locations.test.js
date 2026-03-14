/**
 * Integration tests — Location routes
 * GET    /api/locations/tree
 * GET    /api/locations
 * GET    /api/locations/:id
 * POST   /api/locations
 * PUT    /api/locations/:id
 * DELETE /api/locations/:id
 */
const request = require('supertest');
const app = require('../../src/index');
const { connect, disconnect, clearDatabase } = require('../setup/db');
const { createAdmin, createManager, createViewer, createBuilding, createFloor, createRoom } = require('../helpers');

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.MONGODB_URI = 'mongodb://localhost/test';
  await connect();
});
afterAll(async () => { await disconnect(); });
afterEach(async () => { await clearDatabase(); });

describe('GET /api/locations/tree', () => {
  test('returns nested tree for authenticated user', async () => {
    const { token } = await createViewer();
    const building = await createBuilding({ name: 'HQ' });
    await createFloor(building._id, { name: 'Floor 1' });

    const res = await request(app)
      .get('/api/locations/tree')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.data[0].name).toBe('HQ');
    expect(res.body.data[0].children).toHaveLength(1);
    expect(res.body.data[0].children[0].name).toBe('Floor 1');
  });

  test('returns subtree when rootId is provided', async () => {
    const { token } = await createViewer();
    const b = await createBuilding();
    const f = await createFloor(b._id, { name: 'Floor 2' });
    await createRoom(f._id, { name: 'Room A' });

    const res = await request(app)
      .get(`/api/locations/tree?rootId=${f._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Floor 2');
  });

  test('returns 401 without token', async () => {
    const res = await request(app).get('/api/locations/tree');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/locations', () => {
  test('returns paginated flat list', async () => {
    const { token } = await createViewer();
    await createBuilding({ name: 'Building A' });
    await createBuilding({ name: 'Building B' });

    const res = await request(app)
      .get('/api/locations?limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.pagination.total).toBe(2);
  });

  test('filters by type', async () => {
    const { token } = await createViewer();
    const b = await createBuilding();
    await createFloor(b._id);

    const res = await request(app)
      .get('/api/locations?type=building')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    res.body.data.forEach((loc) => expect(loc.type).toBe('building'));
  });
});

describe('GET /api/locations/:id', () => {
  test('returns location with metadata', async () => {
    const { token } = await createViewer();
    const building = await createBuilding({ name: 'Test HQ' });
    await createFloor(building._id);

    const res = await request(app)
      .get(`/api/locations/${building._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Test HQ');
    expect(res.body.meta.childrenCount).toBe(1);
    expect(res.body.meta.assetCount).toBe(0);
  });

  test('returns 404 for non-existent location', async () => {
    const { token } = await createViewer();
    const res = await request(app)
      .get('/api/locations/507f1f77bcf86cd799439011')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/locations', () => {
  test('admin can create a building (no parent)', async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Building', type: 'building' });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('building');
    expect(res.body.data.parent).toBeNull();
  });

  test('creates floor under a building', async () => {
    const { token } = await createAdmin();
    const building = await createBuilding();

    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Floor 1', type: 'floor', parent: building._id });

    expect(res.status).toBe(201);
    expect(res.body.data.parent).toBe(building._id.toString());
  });

  test('creates room under a floor', async () => {
    const { token } = await createAdmin();
    const building = await createBuilding();
    const floor = await createFloor(building._id);

    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Room 101', type: 'room', parent: floor._id });

    expect(res.status).toBe(201);
  });

  test('rejects floor without parent', async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Floating Floor', type: 'floor' });

    expect(res.status).toBe(400);
  });

  test('rejects building with parent', async () => {
    const { token } = await createAdmin();
    const building = await createBuilding();

    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Sub Building', type: 'building', parent: building._id });

    expect(res.status).toBe(400);
  });

  test('rejects room under building (wrong hierarchy)', async () => {
    const { token } = await createAdmin();
    const building = await createBuilding();

    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad Room', type: 'room', parent: building._id });

    expect(res.status).toBe(400);
  });

  test('viewer cannot create location (403)', async () => {
    const { token } = await createViewer();
    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Building', type: 'building' });

    expect(res.status).toBe(403);
  });

  test('manager can create a location', async () => {
    const { token } = await createManager();
    const res = await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Mgr Building', type: 'building' });

    expect(res.status).toBe(201);
  });
});

describe('PUT /api/locations/:id', () => {
  test('admin can update location name', async () => {
    const { token } = await createAdmin();
    const building = await createBuilding({ name: 'Old Name' });

    const res = await request(app)
      .put(`/api/locations/${building._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('New Name');
  });

  test('can deactivate a location', async () => {
    const { token } = await createAdmin();
    const building = await createBuilding();

    const res = await request(app)
      .put(`/api/locations/${building._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
  });
});

describe('DELETE /api/locations/:id', () => {
  test('admin can soft-delete a location with no children and no assets', async () => {
    const { token } = await createAdmin();
    const building = await createBuilding();

    const res = await request(app)
      .delete(`/api/locations/${building._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deactivated/i);
  });

  test('refuses deletion when active children exist', async () => {
    const { token } = await createAdmin();
    const building = await createBuilding();
    await createFloor(building._id);

    const res = await request(app)
      .delete(`/api/locations/${building._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
  });

  test('force=true hard-deletes the location', async () => {
    const { token } = await createAdmin();
    const building = await createBuilding();

    const res = await request(app)
      .delete(`/api/locations/${building._id}?force=true`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/permanently deleted/i);
  });

  test('manager cannot delete location (403)', async () => {
    const { token } = await createManager();
    const building = await createBuilding();

    const res = await request(app)
      .delete(`/api/locations/${building._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
