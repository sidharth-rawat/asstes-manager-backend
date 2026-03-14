/**
 * Unit tests for Mongoose models.
 * Tests schema validation, virtuals, and instance methods
 * using an in-memory MongoDB instance.
 */
const { connect, disconnect, clearDatabase } = require('../setup/db');
const User = require('../../src/models/User');
const Asset = require('../../src/models/Asset');
const Location = require('../../src/models/Location');

beforeAll(async () => {
  // Set env before connecting
  process.env.JWT_SECRET = 'test-secret';
  process.env.MONGODB_URI = 'mongodb://localhost/test';
  await connect();
});
afterAll(async () => { await disconnect(); });
afterEach(async () => { await clearDatabase(); });

// ─── User Model ───────────────────────────────────────────────────────────────
describe('User model', () => {
  test('creates a user with valid fields', async () => {
    const user = await User.create({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Secret123',
      role: 'admin',
    });
    expect(user._id).toBeDefined();
    expect(user.email).toBe('alice@example.com');
    expect(user.role).toBe('admin');
    expect(user.isActive).toBe(true);
  });

  test('password is hashed before saving', async () => {
    const user = await User.create({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Secret123',
    });
    // Fetch with password
    const found = await User.findById(user._id).select('+password');
    expect(found.password).not.toBe('Secret123');
    expect(found.password).toMatch(/^\$2[aby]\$/); // bcrypt hash
  });

  test('comparePassword returns true for correct password', async () => {
    const user = await User.create({ name: 'Carol', email: 'carol@example.com', password: 'Secret123' });
    const found = await User.findById(user._id).select('+password');
    const match = await found.comparePassword('Secret123');
    expect(match).toBe(true);
  });

  test('comparePassword returns false for wrong password', async () => {
    const user = await User.create({ name: 'Dan', email: 'dan@example.com', password: 'Secret123' });
    const found = await User.findById(user._id).select('+password');
    const match = await found.comparePassword('WrongPassword1');
    expect(match).toBe(false);
  });

  test('password field is not returned by default', async () => {
    await User.create({ name: 'Eve', email: 'eve@example.com', password: 'Secret123' });
    const user = await User.findOne({ email: 'eve@example.com' });
    expect(user.password).toBeUndefined();
  });

  test('email is lowercased automatically', async () => {
    const user = await User.create({ name: 'Frank', email: 'Frank@EXAMPLE.COM', password: 'Secret123' });
    expect(user.email).toBe('frank@example.com');
  });

  test('duplicate email is rejected', async () => {
    await User.create({ name: 'User1', email: 'dup@example.com', password: 'Secret123' });
    await expect(
      User.create({ name: 'User2', email: 'dup@example.com', password: 'Secret123' })
    ).rejects.toThrow();
  });

  test('invalid role is rejected', async () => {
    await expect(
      User.create({ name: 'User', email: 'x@example.com', password: 'Secret123', role: 'superadmin' })
    ).rejects.toThrow();
  });

  test('default role is viewer', async () => {
    const user = await User.create({ name: 'Guest', email: 'guest@example.com', password: 'Secret123' });
    expect(user.role).toBe('viewer');
  });

  test('toJSON does not include password', async () => {
    const user = await User.create({ name: 'H', email: 'h@example.com', password: 'Secret123' });
    const json = user.toJSON();
    expect(json.password).toBeUndefined();
  });
});

// ─── Asset Model ──────────────────────────────────────────────────────────────
describe('Asset model', () => {
  test('creates an asset with required fields', async () => {
    const asset = await Asset.create({ name: 'Dell XPS', serialNo: 'SN-001', category: 'laptop' });
    expect(asset._id).toBeDefined();
    expect(asset.serialNo).toBe('SN-001');
    expect(asset.status).toBe('active');
  });

  test('serialNo is uppercased', async () => {
    const asset = await Asset.create({ name: 'MacBook', serialNo: 'sn-lowercase', category: 'laptop' });
    expect(asset.serialNo).toBe('SN-LOWERCASE');
  });

  test('duplicate serialNo is rejected', async () => {
    await Asset.create({ name: 'Asset1', serialNo: 'UNIQUE-001', category: 'laptop' });
    await expect(
      Asset.create({ name: 'Asset2', serialNo: 'UNIQUE-001', category: 'desktop' })
    ).rejects.toThrow();
  });

  test('invalid category is rejected', async () => {
    await expect(
      Asset.create({ name: 'X', serialNo: 'SN-X', category: 'rocket' })
    ).rejects.toThrow();
  });

  test('invalid status is rejected', async () => {
    await expect(
      Asset.create({ name: 'X', serialNo: 'SN-Y', category: 'laptop', status: 'broken' })
    ).rejects.toThrow();
  });

  test('underWarranty virtual returns true when warranty is in future', async () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const asset = await Asset.create({ name: 'A', serialNo: 'SN-W1', category: 'laptop', warrantyExpiry: future });
    expect(asset.underWarranty).toBe(true);
  });

  test('underWarranty virtual returns false when warranty has expired', async () => {
    const past = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const asset = await Asset.create({ name: 'A', serialNo: 'SN-W2', category: 'laptop', warrantyExpiry: past });
    expect(asset.underWarranty).toBe(false);
  });

  test('underWarranty virtual returns null when no warrantyExpiry', async () => {
    const asset = await Asset.create({ name: 'A', serialNo: 'SN-W3', category: 'laptop' });
    expect(asset.underWarranty).toBeNull();
  });

  test('value cannot be negative', async () => {
    await expect(
      Asset.create({ name: 'A', serialNo: 'SN-NEG', category: 'laptop', value: -100 })
    ).rejects.toThrow();
  });
});

// ─── Location Model ───────────────────────────────────────────────────────────
describe('Location model', () => {
  test('creates a building with valid fields', async () => {
    const loc = await Location.create({ name: 'HQ', type: 'building' });
    expect(loc._id).toBeDefined();
    expect(loc.type).toBe('building');
    expect(loc.isActive).toBe(true);
    expect(loc.parent).toBeNull();
  });

  test('creates a floor with parent reference', async () => {
    const building = await Location.create({ name: 'HQ', type: 'building' });
    const floor = await Location.create({ name: 'Floor 1', type: 'floor', parent: building._id });
    expect(floor.parent.toString()).toBe(building._id.toString());
  });

  test('invalid type is rejected', async () => {
    await expect(
      Location.create({ name: 'Office', type: 'office' })
    ).rejects.toThrow();
  });

  test('name is required', async () => {
    await expect(
      Location.create({ type: 'building' })
    ).rejects.toThrow();
  });

  test('isActive defaults to true', async () => {
    const loc = await Location.create({ name: 'Room', type: 'room', parent: null });
    expect(loc.isActive).toBe(true);
  });
});
