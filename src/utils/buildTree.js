/**
 * buildTree — converts a flat array of Location documents into a
 * fully nested tree structure.
 *
 * Each node in the returned tree looks like:
 *   {
 *     _id, name, type, parent, address, description, isActive,
 *     createdAt, updatedAt,
 *     children: [ ...recursively nested nodes ]
 *   }
 *
 * The algorithm runs in O(n) time by first building an id→node map
 * and then wiring up parent-child relationships in a single pass —
 * far more efficient than the naïve recursive-filter approach which
 * is O(n²).
 *
 * @param {Array} locations  Array of Mongoose Location documents or
 *                           plain objects that have _id and parent fields.
 * @param {string|null} rootParentId  The parent id that identifies
 *                           root nodes. Defaults to null (top-level
 *                           buildings have parent === null).
 * @returns {Array}          Nested tree starting from root nodes.
 */
function buildTree(locations, rootParentId = null) {
  // Step 1: Build a lookup map: id (string) → node with empty children array
  const map = {};
  const nodes = locations.map((loc) => {
    const obj = typeof loc.toObject === 'function' ? loc.toObject({ virtuals: true }) : { ...loc };
    obj.children = [];
    // Normalise _id to string for consistent key comparisons
    const id = obj._id.toString();
    map[id] = obj;
    return obj;
  });

  // Step 2: Wire children to their parents
  const roots = [];
  for (const node of nodes) {
    const parentId = node.parent ? node.parent.toString() : null;

    if (parentId === null || parentId === rootParentId) {
      // This is a root node
      roots.push(node);
    } else if (map[parentId]) {
      // Attach to existing parent
      map[parentId].children.push(node);
    } else {
      // Orphaned node (parent was deleted / not in the result set).
      // Treat it as a root so it is still visible rather than silently lost.
      roots.push(node);
    }
  }

  return roots;
}

/**
 * flattenTree — the inverse of buildTree. Takes a nested tree and
 * returns a flat array of all nodes (depth-first).
 * Useful for export or aggregation after building the tree.
 *
 * @param {Array} tree   Result of buildTree()
 * @returns {Array}      Flat array of all nodes (children removed)
 */
function flattenTree(tree) {
  const result = [];

  function walk(nodes) {
    for (const node of nodes) {
      const { children, ...rest } = node;
      result.push(rest);
      if (children && children.length > 0) {
        walk(children);
      }
    }
  }

  walk(tree);
  return result;
}

/**
 * findSubtree — returns the subtree rooted at the node whose _id
 * matches the given id, or null if not found.
 *
 * @param {Array}  tree  Nested tree from buildTree()
 * @param {string} id    The _id (as string) of the desired root
 * @returns {Object|null}
 */
function findSubtree(tree, id) {
  for (const node of tree) {
    if (node._id.toString() === id) return node;
    if (node.children && node.children.length > 0) {
      const found = findSubtree(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * collectDescendantIds — given a subtree node, returns a flat array
 * of all descendant _ids (as strings), including the root node itself.
 * Used to filter assets by location hierarchy.
 *
 * @param {Object} subtreeNode  A node from buildTree output
 * @returns {string[]}
 */
function collectDescendantIds(subtreeNode) {
  const ids = [];

  function walk(node) {
    ids.push(node._id.toString());
    if (node.children && node.children.length > 0) {
      node.children.forEach(walk);
    }
  }

  walk(subtreeNode);
  return ids;
}

module.exports = { buildTree, flattenTree, findSubtree, collectDescendantIds };
