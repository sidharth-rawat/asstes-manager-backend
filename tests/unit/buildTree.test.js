/**
 * Unit tests for src/utils/buildTree.js
 * Pure function — no database needed.
 */
const { buildTree, flattenTree, findSubtree, collectDescendantIds } = require('../../src/utils/buildTree');

// Helper to create a plain location-like object
function loc(id, parentId, name = `loc-${id}`) {
  return { _id: id, parent: parentId, name, type: 'building', isActive: true };
}

describe('buildTree', () => {
  test('returns empty array for empty input', () => {
    expect(buildTree([])).toEqual([]);
  });

  test('single root node has empty children array', () => {
    const result = buildTree([loc('1', null, 'HQ')]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('HQ');
    expect(result[0].children).toEqual([]);
  });

  test('builds a two-level tree correctly', () => {
    const locations = [
      loc('1', null, 'Building A'),
      loc('2', '1', 'Floor 1'),
      loc('3', '1', 'Floor 2'),
    ];
    const tree = buildTree(locations);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children.map((c) => c.name)).toEqual(
      expect.arrayContaining(['Floor 1', 'Floor 2'])
    );
  });

  test('builds a three-level tree correctly', () => {
    const locations = [
      loc('b1', null, 'Building'),
      loc('f1', 'b1', 'Floor 1'),
      loc('r1', 'f1', 'Room 101'),
      loc('r2', 'f1', 'Room 102'),
    ];
    const tree = buildTree(locations);
    expect(tree).toHaveLength(1);
    const floor = tree[0].children[0];
    expect(floor.name).toBe('Floor 1');
    expect(floor.children).toHaveLength(2);
  });

  test('multiple root nodes are all returned', () => {
    const locations = [
      loc('1', null, 'Building A'),
      loc('2', null, 'Building B'),
    ];
    const tree = buildTree(locations);
    expect(tree).toHaveLength(2);
  });

  test('orphaned node (parent not in set) is treated as root', () => {
    const locations = [loc('1', 'nonexistent', 'Orphan')];
    const tree = buildTree(locations);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('Orphan');
  });

  test('handles Mongoose document objects with toObject method', () => {
    const mockDoc = {
      _id: '1',
      parent: null,
      name: 'Building',
      toObject: function () { return { _id: this._id, parent: this.parent, name: this.name }; },
    };
    const result = buildTree([mockDoc]);
    expect(result).toHaveLength(1);
    expect(result[0].children).toEqual([]);
  });
});

describe('flattenTree', () => {
  test('flattens a nested tree depth-first', () => {
    const locations = [
      loc('b1', null, 'Building'),
      loc('f1', 'b1', 'Floor 1'),
      loc('r1', 'f1', 'Room 101'),
    ];
    const tree = buildTree(locations);
    const flat = flattenTree(tree);
    expect(flat).toHaveLength(3);
    expect(flat.map((n) => n.name)).toEqual(['Building', 'Floor 1', 'Room 101']);
  });

  test('returns empty array for empty tree', () => {
    expect(flattenTree([])).toEqual([]);
  });

  test('flattened nodes do not have children property', () => {
    const tree = buildTree([loc('1', null)]);
    const flat = flattenTree(tree);
    expect(flat[0]).not.toHaveProperty('children');
  });
});

describe('findSubtree', () => {
  let tree;
  beforeEach(() => {
    tree = buildTree([
      loc('b1', null, 'Building'),
      loc('f1', 'b1', 'Floor 1'),
      loc('r1', 'f1', 'Room 101'),
    ]);
  });

  test('finds root node by id', () => {
    const node = findSubtree(tree, 'b1');
    expect(node).not.toBeNull();
    expect(node.name).toBe('Building');
  });

  test('finds deeply nested node by id', () => {
    const node = findSubtree(tree, 'r1');
    expect(node).not.toBeNull();
    expect(node.name).toBe('Room 101');
  });

  test('returns null when id not found', () => {
    expect(findSubtree(tree, 'nonexistent')).toBeNull();
  });

  test('returned subtree preserves its children', () => {
    const node = findSubtree(tree, 'f1');
    expect(node.children).toHaveLength(1);
    expect(node.children[0].name).toBe('Room 101');
  });
});

describe('collectDescendantIds', () => {
  test('includes the root node itself', () => {
    const node = { _id: 'b1', children: [] };
    const ids = collectDescendantIds(node);
    expect(ids).toContain('b1');
    expect(ids).toHaveLength(1);
  });

  test('includes all descendants', () => {
    const tree = buildTree([
      loc('b1', null, 'Building'),
      loc('f1', 'b1', 'Floor 1'),
      loc('r1', 'f1', 'Room 101'),
      loc('r2', 'f1', 'Room 102'),
    ]);
    const root = tree[0];
    const ids = collectDescendantIds(root);
    expect(ids).toHaveLength(4);
    expect(ids).toEqual(expect.arrayContaining(['b1', 'f1', 'r1', 'r2']));
  });

  test('single leaf node returns array with one id', () => {
    const leaf = { _id: 'r1', children: [] };
    expect(collectDescendantIds(leaf)).toEqual(['r1']);
  });
});
