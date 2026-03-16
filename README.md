# AssetTrack — Corporate Asset Lifecycle Manager

> A production-ready REST API for tracking the complete lifecycle of corporate IT assets — from procurement and assignment through maintenance and retirement.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4-lightgrey)](https://expressjs.com)
[![MongoDB](https://img.shields.io/badge/MongoDB-7-green)](https://mongodb.com)
[![Tests](https://img.shields.io/badge/Tests-144%20passing-brightgreen)](#testing)

---

## Table of Contents

- [System Design](#system-design)
  - [Architecture Overview](#architecture-overview)
  - [Request Lifecycle](#request-lifecycle)
  - [Data Model](#data-model)
  - [Security Model](#security-model)
  - [Scalability Considerations](#scalability-considerations)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Role-Based Access Control](#role-based-access-control)
- [Testing](#testing)
- [Deployment](#deployment)

---

## System Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Client (React SPA)                        │
│             Axios + JWT Bearer token in header               │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS / JSON
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Nginx (Reverse Proxy + TLS Termination)         │
│         Serves static React build + proxies /api/*           │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP (internal)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Express REST API  (Node.js / PM2)               │
│                                                              │
│  Security Layer:                                             │
│    helmet → cors → mongoSanitize → rateLimiter               │
│                                                              │
│  Auth Layer:                                                 │
│    verifyToken → requireRole(roles)                          │
│                                                              │
│  Route Handlers:                                             │
│    /api/users  /api/assets  /api/locations  /api/audit       │
│                                                              │
│  Utilities:                                                  │
│    buildTree · logAudit · express-validator                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ Mongoose ODM
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                        MongoDB                               │
│                                                              │
│  Collections:  users · assets · locations · auditlogs        │
│                                                              │
│  Indexes:                                                    │
│    assets:    text(name, serialNo) · status · category       │
│               locationId · assignedTo · serialNo (unique)    │
│    locations: parent · type                                  │
│    auditlogs: createdAt · assetId+createdAt · performedBy    │
└─────────────────────────────────────────────────────────────┘
```

**Key design decisions:**

| Decision | Rationale |
|----------|-----------|
| Stateless JWT auth | Horizontal scaling without sticky sessions or shared session store |
| Append-only audit log | Tamper-evident history; audit entries survive asset/user deletion via field snapshots |
| Fire-and-forget audit writes | Audit failures never block mutations; errors logged to stderr |
| O(n) tree construction | Single-pass `Map`-based algorithm avoids repeated DB roundtrips for location hierarchy |
| `require.main === module` guard | App module exports cleanly for supertest without auto-starting the server |
| MongoDB operator sanitization | Strips `$` and `.` from all user input to prevent NoSQL injection |

---

### Request Lifecycle

```
1. HTTPS request hits Nginx
2. Nginx terminates TLS, proxies /api/* to Node on port 3000

3. Express security middleware chain:
   a. helmet()          — sets security headers (CSP, HSTS, X-Frame-Options, etc.)
   b. cors()            — validates Origin against CORS_ORIGINS allowlist
   c. express.json()    — parses body (1 MB limit)
   d. mongoSanitize()   — strips MongoDB operators ($, .) from body/params/query
   e. apiLimiter        — enforces 100 req/15 min per IP (general API)
   f. authLimiter       — enforces 10 req/15 min per IP (login + register only)

4. Route middleware:
   a. verifyToken       — validates Bearer JWT, fetches user from DB, checks isActive
   b. requireRole(...)  — compares req.user.role against allowed roles for the route

5. Route handler:
   a. express-validator — validates and sanitizes request body/params/query
   b. Business logic    — queries MongoDB via Mongoose
   c. logAudit()        — fire-and-forget audit log entry for mutations
   d. JSON response     — { success, data } or { success, message, errors }

6. Global error handler normalizes Mongoose errors:
   ValidationError → 422  |  CastError → 400  |  Duplicate key → 409
```

---

### Data Model

#### Entity Relationship

```
User ──────────────< Asset (assignedTo)
                          │
                     Assignment History (embedded array)
                          │ tracks every assignment epoch

Location ─────────< Location (parent self-ref, max 3 levels)
    Building → Floor → Room

Asset >──────────── Location (locationId)

AuditLog >────────── Asset (assetId snapshot)
AuditLog >────────── User  (performedBy snapshot)
```

#### Collection Schemas

**`users`**
```
_id, name, email (unique), password (bcrypt, select:false),
role (admin|manager|viewer), department, isActive, timestamps
```

**`assets`**
```
_id, name, serialNo (unique), category, status,
assignedTo (ref: User), locationId (ref: Location),
purchaseDate, value, manufacturer, model, warrantyExpiry, notes,
assignmentHistory: [{ user, assignedAt, unassignedAt }],
timestamps
```
- Virtual: `underWarranty` (boolean, derived from warrantyExpiry)
- Text index on `name + serialNo` for full-text search

**`locations`**
```
_id, name, type (building|floor|room), parent (self-ref),
address { street, city, state, country, postalCode },
description, isActive, timestamps
```
- Hierarchy rule enforced in routes: building has no parent; floor's parent must be a building; room's parent must be a floor

**`auditlogs`**
```
_id, assetId, assetName*, assetSerialNo*,
action (created|updated|deleted|assigned|unassigned|
        status_changed|location_changed|bulk_assigned),
performedBy, performedByName*, performedByEmail*,
fromValue, toValue, changes (diff object), createdAt
```
`*` = snapshot fields — preserved even after entity deletion

---

### Security Model

#### Defense Layers

| Layer | Mechanism | What it prevents |
|-------|-----------|-----------------|
| **Transport** | TLS via Nginx + Let's Encrypt | Eavesdropping, MITM |
| **HTTP headers** | `helmet` | XSS via CSP, clickjacking via X-Frame-Options, MIME sniffing, HSTS enforcement |
| **Origin control** | `cors` with allowlist | Cross-site request forgery from unauthorized origins |
| **Rate limiting** | `express-rate-limit` | Brute-force attacks, credential stuffing, DoS |
| **Input sanitization** | `express-mongo-sanitize` | NoSQL injection via MongoDB operator injection (`$where`, `$gt`, etc.) |
| **Input validation** | `express-validator` | Malformed data, unexpected field types |
| **Authentication** | JWT (HS256) + bcrypt (cost 12) | Forged tokens, credential theft, rainbow table attacks |
| **Authorization** | RBAC via `requireRole` middleware | Privilege escalation, unauthorized data access |
| **Body size limit** | `express.json({ limit: '1mb' })` | Large payload DoS |

#### Rate Limits

| Endpoint group | Window | Max requests | Purpose |
|---------------|--------|-------------|---------|
| `/api/*` (all) | 15 min | 100 per IP | General abuse prevention |
| `/api/users/login` | 15 min | 10 per IP | Brute-force / credential stuffing |
| `/api/users/register` | 15 min | 10 per IP | Account creation abuse |

Rate limits are skipped in `NODE_ENV=test` to avoid interfering with the test suite.
Responses include standard `RateLimit-*` headers for client-side handling.

#### Authentication Flow

```
POST /api/users/login
  → bcrypt.compare(plaintext, hash)  [timing-safe]
  → jwt.sign({ id, role }, JWT_SECRET, { expiresIn })
  → client stores token in memory / localStorage

Subsequent requests:
  Authorization: Bearer <token>
  → jwt.verify(token, JWT_SECRET)
  → User.findById(payload.id).select('-password')
  → check user.isActive
  → attach to req.user
```

---

### Scalability Considerations

**Current (single-node):** Node.js + PM2 cluster mode utilises all CPU cores on one machine.

**Horizontal scaling path:**

```
Load Balancer (AWS ALB / Nginx upstream)
    │
    ├── Node instance 1 (stateless)
    ├── Node instance 2 (stateless)
    └── Node instance N (stateless)
            │
            └── MongoDB Atlas (replica set with read preference)
```

No shared server-side state: JWT is self-contained, no session store required.

**MongoDB optimisation:**
- Compound index `{ assetId: 1, createdAt: -1 }` on `auditlogs` for per-asset history queries
- Aggregation pipeline for `/assets/stats` — computed server-side, no N+1 queries
- `deep` location filter uses `collectDescendantIds` in-memory after a single location fetch (suitable for typical corporate hierarchies; switch to `$graphLookup` for very deep trees)

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- MongoDB (local or Atlas)

### Install

```bash
git clone <repo-url>
cd asstes-manager-backend
npm install
```

### Configure

```bash
cp .env.example .env
# Edit .env — MONGODB_URI and JWT_SECRET are required
```

### Run

```bash
npm run dev     # nodemon — hot reload
npm start       # production
```

```bash
# Bootstrap the first admin user
curl -X POST http://localhost:3000/api/users/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin","email":"admin@company.com","password":"Admin1234"}'
```

The **first registered user** is automatically promoted to `admin`.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGODB_URI` | **Yes** | — | MongoDB connection string |
| `JWT_SECRET` | **Yes** | — | ≥ 32-char random secret (`openssl rand -base64 48`) |
| `JWT_EXPIRES_IN` | No | `7d` | Token lifetime (`1h`, `7d`, `30d`) |
| `PORT` | No | `3000` | API listen port |
| `NODE_ENV` | No | `development` | `production` hides stack traces in error responses |
| `CORS_ORIGINS` | No | `*` | Comma-separated allowed origins |
| `RATE_LIMIT_WINDOW_MS` | No | `900000` | Rate limit window in ms (default 15 min) |
| `RATE_LIMIT_MAX` | No | `100` | Max general API requests per window per IP |
| `AUTH_RATE_LIMIT_MAX` | No | `10` | Max login/register attempts per window per IP |

---

## API Reference

All responses use a consistent JSON envelope:

```json
{ "success": true,  "data": { ... } }
{ "success": false, "message": "...", "errors": [...] }
```

List responses include pagination metadata:

```json
{ "pagination": { "total": 42, "page": 2, "limit": 20, "pages": 3 } }
```

### Auth & Users

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `POST` | `/api/users/register` | Public | Register (first user → admin) |
| `POST` | `/api/users/login` | Public | Login, returns JWT |
| `GET` | `/api/users/me` | Any auth | Own profile |
| `PATCH` | `/api/users/me` | Any auth | Update own name / department / password |
| `GET` | `/api/users` | Admin, Manager | List users; `?role=&isActive=&page=&limit=` |
| `PUT` | `/api/users/:id` | Admin | Update role, isActive, department |
| `DELETE` | `/api/users/:id` | Admin | Soft-deactivate |

### Assets

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/api/assets/stats` | Any auth | Aggregations: total, byStatus, byCategory, byLocation |
| `GET` | `/api/assets` | Any auth | Paginated list; `?search=&status=&category=&locationId=&deep=&page=&limit=` |
| `POST` | `/api/assets` | Manager+ | Create asset |
| `GET` | `/api/assets/:id` | Any auth | Asset detail + populated assignmentHistory |
| `PUT` | `/api/assets/:id` | Manager+ | Update any field; assignment history maintained automatically |
| `DELETE` | `/api/assets/:id` | Admin | Hard delete |
| `POST` | `/api/assets/bulk-assign` | Manager+ | `{ assetIds: [...], userId: id \| null }` |

### Locations

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/api/locations/tree` | Any auth | Nested hierarchy (building → floor → room) |
| `GET` | `/api/locations` | Any auth | Flat list; `?type=&parent=&isActive=` |
| `POST` | `/api/locations` | Manager+ | Create node; type + parent constraints enforced |
| `PUT` | `/api/locations/:id` | Manager+ | Update name / description |
| `DELETE` | `/api/locations/:id` | Admin | Soft-deactivate; blocked if active children or assets exist |

### Audit Log

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/api/audit` | Admin, Manager | Global log; `?action=&performedBy=&assetId=&page=&limit=` |
| `GET` | `/api/audit/asset/:id` | Any auth | Per-asset event history |

---

## Role-Based Access Control

| Permission | Admin | Manager | Viewer |
|-----------|:-----:|:-------:|:------:|
| View assets & locations | ✓ | ✓ | ✓ |
| Create / edit assets | ✓ | ✓ | — |
| Delete assets | ✓ | — | — |
| Bulk assign assets | ✓ | ✓ | — |
| Manage locations (create/edit) | ✓ | ✓ | — |
| Delete / deactivate locations | ✓ | — | — |
| View user list | ✓ | ✓ | — |
| Create / edit / deactivate users | ✓ | — | — |
| Change user roles | ✓ | — | — |
| View audit log | ✓ | ✓ | — |

Enforcement lives in `src/middleware/auth.js`. `requireRole(...roles)` is declared per-route — no implicit role elevation is possible.

---

## Project Structure

```
asstes-manager-backend/
├── src/
│   ├── index.js                # Express bootstrap: security middleware, routes, error handler
│   ├── middleware/
│   │   └── auth.js             # verifyToken · requireRole · optionalAuth
│   ├── models/
│   │   ├── User.js             # Schema + bcrypt pre-save hook + comparePassword
│   │   ├── Asset.js            # Schema + text index + assignmentHistory + underWarranty virtual
│   │   ├── Location.js         # Self-referencing hierarchical schema
│   │   └── AuditLog.js         # Immutable append-only event schema
│   ├── routes/
│   │   ├── users.js            # Auth (register/login) + admin user CRUD
│   │   ├── assets.js           # CRUD + /stats aggregation + /bulk-assign
│   │   ├── locations.js        # CRUD + /tree + hierarchy constraint enforcement
│   │   └── audit.js            # Global log + per-asset history
│   └── utils/
│       ├── buildTree.js        # O(n) tree builder + flattenTree + findSubtree + collectDescendantIds
│       └── auditLogger.js      # Fire-and-forget logAudit() helper
├── tests/
│   ├── setup/db.js             # MongoMemoryServer connect/disconnect helpers
│   ├── helpers/index.js        # Test factories: createAdmin · createAsset · createBuilding ...
│   ├── unit/                   # Pure function and model tests
│   └── integration/            # Supertest API endpoint tests
├── docs/
│   ├── HLD.md                  # High-Level Design: context, component breakdown, data flow
│   └── LLD.md                  # Low-Level Design: schemas, API contracts, security model
├── .env.example                # Environment variable template
├── jest.config.js
└── package.json
```

---

## Testing

```bash
npm test                  # run all suites
npm run test:coverage     # with V8 line/branch coverage report
```

| Suite | Tests | Coverage |
|-------|------:|---------|
| `unit/buildTree` | 17 | Tree construction, flattening, subtree search, descendant collection |
| `unit/models` | 24 | Schema validation, bcrypt hooks, `comparePassword`, virtuals |
| `integration/auth` | 16 | Register, login, token expiry, deactivated-account blocking |
| `integration/assets` | 34 | CRUD, bulk-assign, stats aggregation, pagination, deep location filter |
| `integration/locations` | 20 | Hierarchy constraints, tree output, delete guards |
| `integration/users` | 15 | RBAC enforcement on every user management endpoint |
| `integration/audit` | 15 | Audit entry created for every mutation |
| **Total** | **144** | |

**Isolation strategy:** `mongodb-memory-server` v9 spins up an in-process MongoDB instance per test run. `clearDatabase()` resets state between tests — no real database, no flaky network calls.

---

## Deployment

### AWS EC2 + Nginx + PM2

```bash
# 1. Install runtime and process manager
sudo apt update && sudo apt install -y nodejs npm nginx
sudo npm install -g pm2

# 2. Clone and install production dependencies
git clone <repo> /opt/assettrack && cd /opt/assettrack
npm install --omit=dev

# 3. Configure environment
cp .env.example .env
nano .env   # set MONGODB_URI, JWT_SECRET, NODE_ENV=production, CORS_ORIGINS

# 4. Start with PM2 (cluster mode = one process per CPU core)
pm2 start src/index.js --name assettrack -i max --env production
pm2 save && pm2 startup
```

**Nginx config — reverse-proxy API + optional static build:**

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # Proxy API calls to the Node process
    location /api/ {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

```bash
# HTTPS via Let's Encrypt
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

### Production Checklist

- [ ] `JWT_SECRET` is ≥ 32 random chars (`openssl rand -base64 48`)
- [ ] `NODE_ENV=production` — hides stack traces in error responses
- [ ] `CORS_ORIGINS` scoped to actual frontend origin (not `*`)
- [ ] MongoDB bound to `127.0.0.1`, not exposed on public interface
- [ ] Port 3000 blocked in firewall / security group (only 80/443 open)
- [ ] HTTPS configured with auto-renewal (`sudo systemctl status certbot.timer`)
- [ ] PM2 startup script registered (`pm2 startup && pm2 save`)
- [ ] Rate limit env vars tuned for expected traffic volume
