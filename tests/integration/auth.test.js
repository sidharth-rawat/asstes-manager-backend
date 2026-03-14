/**
 * Integration tests — Auth endpoints
 * POST /api/users/register
 * POST /api/users/login
 * GET  /api/users/me
 * PATCH /api/users/me
 */
const request = require('supertest');
const app = require('../../src/index');
const { connect, disconnect, clearDatabase } = require('../setup/db');
const { createAdmin } = require('../helpers');

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.MONGODB_URI = 'mongodb://localhost/test';
  await connect();
});
afterAll(async () => { await disconnect(); });
afterEach(async () => { await clearDatabase(); });

describe('POST /api/users/register', () => {
  test('first registration becomes admin automatically', async () => {
    const res = await request(app)
      .post('/api/users/register')
      .send({ name: 'First Admin', email: 'admin@test.com', password: 'Password1' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.token).toBeDefined();
  });

  test('subsequent registrations default to viewer', async () => {
    // Create first user (admin)
    await request(app)
      .post('/api/users/register')
      .send({ name: 'Admin', email: 'admin@test.com', password: 'Password1' });

    // Second user should be viewer
    const res = await request(app)
      .post('/api/users/register')
      .send({ name: 'Viewer', email: 'viewer@test.com', password: 'Password1' });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('viewer');
  });

  test('rejects duplicate email with 409', async () => {
    await request(app).post('/api/users/register')
      .send({ name: 'User', email: 'dup@test.com', password: 'Password1' });

    const res = await request(app).post('/api/users/register')
      .send({ name: 'User2', email: 'dup@test.com', password: 'Password1' });

    expect(res.status).toBe(409);
  });

  test('rejects weak password (no number) with 422', async () => {
    const res = await request(app).post('/api/users/register')
      .send({ name: 'User', email: 'u@test.com', password: 'weakpassword' });
    expect(res.status).toBe(422);
  });

  test('rejects password shorter than 8 chars with 422', async () => {
    const res = await request(app).post('/api/users/register')
      .send({ name: 'User', email: 'u2@test.com', password: 'Pass1' });
    expect(res.status).toBe(422);
  });

  test('rejects invalid email with 422', async () => {
    const res = await request(app).post('/api/users/register')
      .send({ name: 'User', email: 'not-an-email', password: 'Password1' });
    expect(res.status).toBe(422);
  });

  test('rejects missing name with 422', async () => {
    const res = await request(app).post('/api/users/register')
      .send({ email: 'u@test.com', password: 'Password1' });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/users/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/users/register')
      .send({ name: 'Login User', email: 'login@test.com', password: 'Password1' });
  });

  test('returns 200 + token for valid credentials', async () => {
    const res = await request(app).post('/api/users/login')
      .send({ email: 'login@test.com', password: 'Password1' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.user.password).toBeUndefined();
  });

  test('returns 401 for wrong password', async () => {
    const res = await request(app).post('/api/users/login')
      .send({ email: 'login@test.com', password: 'WrongPass1' });
    expect(res.status).toBe(401);
  });

  test('returns 401 for non-existent email', async () => {
    const res = await request(app).post('/api/users/login')
      .send({ email: 'nobody@test.com', password: 'Password1' });
    expect(res.status).toBe(401);
  });

  test('returns 403 for deactivated user', async () => {
    const User = require('../../src/models/User');
    await User.updateOne({ email: 'login@test.com' }, { isActive: false });

    const res = await request(app).post('/api/users/login')
      .send({ email: 'login@test.com', password: 'Password1' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/users/me', () => {
  test('returns current user profile', async () => {
    const { token, user } = await createAdmin();

    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user._id).toBe(user._id.toString());
    expect(res.body.user.password).toBeUndefined();
  });

  test('returns 401 without token', async () => {
    const res = await request(app).get('/api/users/me');
    expect(res.status).toBe(401);
  });

  test('returns 401 with invalid token', async () => {
    const res = await request(app).get('/api/users/me')
      .set('Authorization', 'Bearer invalid.token.here');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/users/me', () => {
  test('user can update their own name and department', async () => {
    const { token } = await createAdmin();

    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name', department: 'Engineering' });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('New Name');
    expect(res.body.user.department).toBe('Engineering');
  });

  test('user can change their password', async () => {
    const { token, user } = await createAdmin();

    await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'NewPassword2' });

    // Login with new password should work
    const loginRes = await request(app).post('/api/users/login')
      .send({ email: user.email, password: 'NewPassword2' });
    expect(loginRes.status).toBe(200);
  });
});
