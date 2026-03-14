/**
 * Test factory helpers.
 * Each function creates a fully-saved document and returns it together
 * with a signed JWT token (where applicable).
 */
const jwt = require('jsonwebtoken');
const User = require('../../src/models/User');
const Asset = require('../../src/models/Asset');
const Location = require('../../src/models/Location');

// Ensure JWT_SECRET is set for tests
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-jest';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test';

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Create a user with the given role and return { user, token }.
 */
async function createUser({ name = 'Test User', email, password = 'Password1', role = 'viewer', isActive = true } = {}) {
  const uniqueEmail = email || `user-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
  const user = await User.create({ name, email: uniqueEmail, password, role, isActive });
  const token = signToken(user._id);
  return { user, token };
}

async function createAdmin(overrides = {}) {
  return createUser({ role: 'admin', email: `admin-${Date.now()}@test.com`, name: 'Admin User', ...overrides });
}

async function createManager(overrides = {}) {
  return createUser({ role: 'manager', email: `manager-${Date.now()}@test.com`, name: 'Manager User', ...overrides });
}

async function createViewer(overrides = {}) {
  return createUser({ role: 'viewer', email: `viewer-${Date.now()}@test.com`, name: 'Viewer User', ...overrides });
}

/**
 * Create a building location.
 */
async function createBuilding(overrides = {}) {
  return Location.create({ name: 'Main Building', type: 'building', ...overrides });
}

/**
 * Create a floor under a given building.
 */
async function createFloor(buildingId, overrides = {}) {
  return Location.create({ name: 'Floor 1', type: 'floor', parent: buildingId, ...overrides });
}

/**
 * Create a room under a given floor.
 */
async function createRoom(floorId, overrides = {}) {
  return Location.create({ name: 'Room 101', type: 'room', parent: floorId, ...overrides });
}

/**
 * Create an asset with minimal required fields.
 */
async function createAsset(overrides = {}) {
  const uniqueSerial = `SN-${Date.now()}-${Math.random().toString(36).slice(2).toUpperCase()}`;
  return Asset.create({
    name: 'Test Laptop',
    serialNo: uniqueSerial,
    category: 'laptop',
    status: 'active',
    ...overrides,
  });
}

module.exports = {
  createUser,
  createAdmin,
  createManager,
  createViewer,
  createBuilding,
  createFloor,
  createRoom,
  createAsset,
  signToken,
};
