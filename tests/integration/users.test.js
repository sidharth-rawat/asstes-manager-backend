/**
 * Integration tests — User management (admin-only CRUD)
 * GET    /api/users
 * GET    /api/users/:id
 * PUT    /api/users/:id
 * DELETE /api/users/:id
 */
const request = require('supertest');
const app = require('../../src/index');
const { connect, disconnect, clearDatabase } = require('../setup/db');
const { createAdmin, createManager, createViewer } = require('../helpers');

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.MONGODB_URI = 'mongodb://localhost/test';
  await connect();
});
afterAll(async () => { await disconnect(); });
afterEach(async () => { await clearDatabase(); });

describe('GET /api/users', () => {
  test('admin can list users', async () => {
    const { token } = await createAdmin();
    await createViewer();

    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.pagination).toBeDefined();
  });

  test('manager can list users', async () => {
    const { token } = await createManager();
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  test('viewer cannot list users (403)', async () => {
    const { token } = await createViewer();
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('filters by role', async () => {
    const { token } = await createAdmin();
    await createViewer();
    await createManager();

    const res = await request(app)
      .get('/api/users?role=manager')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    res.body.data.forEach((u) => expect(u.role).toBe('manager'));
  });

  test('unauthenticated request returns 401', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/users/:id', () => {
  test('admin can fetch a specific user', async () => {
    const { token } = await createAdmin();
    const { user: viewer } = await createViewer();

    const res = await request(app)
      .get(`/api/users/${viewer._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(viewer._id.toString());
  });

  test('returns 404 for non-existent user', async () => {
    const { token } = await createAdmin();
    const fakeId = '507f1f77bcf86cd799439011';

    const res = await request(app)
      .get(`/api/users/${fakeId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  test('returns 422 for invalid ObjectId', async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .get('/api/users/not-a-mongo-id')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(422);
  });
});

describe('PUT /api/users/:id', () => {
  test('admin can update user role', async () => {
    const { token } = await createAdmin();
    const { user: viewer } = await createViewer();

    const res = await request(app)
      .put(`/api/users/${viewer._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'manager' });

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('manager');
  });

  test('admin can deactivate a user', async () => {
    const { token } = await createAdmin();
    const { user } = await createViewer();

    const res = await request(app)
      .put(`/api/users/${user._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
  });

  test('manager cannot update users (403)', async () => {
    const { token } = await createManager();
    const { user } = await createViewer();

    const res = await request(app)
      .put(`/api/users/${user._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(403);
  });

  test('cannot set duplicate email', async () => {
    const { token } = await createAdmin();
    const { user: u1 } = await createViewer({ email: 'first@test.com' });
    const { user: u2 } = await createViewer({ email: 'second@test.com' });

    const res = await request(app)
      .put(`/api/users/${u2._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'first@test.com' });

    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/users/:id (soft delete)', () => {
  test('admin can deactivate another user', async () => {
    const { token } = await createAdmin();
    const { user } = await createViewer();

    const res = await request(app)
      .delete(`/api/users/${user._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
  });

  test('admin cannot delete their own account', async () => {
    const { token, user } = await createAdmin();

    const res = await request(app)
      .delete(`/api/users/${user._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  test('manager cannot delete users (403)', async () => {
    const { token } = await createManager();
    const { user } = await createViewer();

    const res = await request(app)
      .delete(`/api/users/${user._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
