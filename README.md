# AssetTrack — Corporate Asset Lifecycle Manager

> A production-ready, full-stack web application for tracking the complete lifecycle of corporate IT assets — from procurement and assignment through maintenance and retirement.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4-lightgrey)](https://expressjs.com)
[![MongoDB](https://img.shields.io/badge/MongoDB-7-green)](https://mongodb.com)
[![React](https://img.shields.io/badge/React-18-blue)](https://reactjs.org)
[![Tests](https://img.shields.io/badge/Tests-145%20passing-brightgreen)](#testing)

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Role-Based Access Control](#role-based-access-control)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Design Documents](#design-documents)
- [Deployment](#deployment)

---

## Features

| Feature | Details |
|---------|---------|
| **Asset CRUD** | Create, read, update, delete assets with serial number uniqueness enforcement |
| **Assignment Tracking** | Assign assets to users; automatic timestamped history entry on every assignment change |
| **Bulk Operations** | Assign or unassign up to 200 assets in a single atomic request |
| **Location Hierarchy** | Three-level tree — Building → Floor → Room — with parent-child constraint enforcement |
| **Immutable Audit Log** | Append-only record of every mutation with actor, timestamp, and before/after values |
| **Dashboard Analytics** | Recharts pie (by category) and bar (by location) charts with KPI stat cards |
| **Full-Text Search** | MongoDB text index on asset name and serial number |
| **Pagination & Filters** | Server-side pagination with status, category, location, and keyword filters |
| **RBAC** | Three roles (Admin / Manager / Viewer) enforced at the API middleware layer |
| **Warranty Alerts** | UI warns when warranty is expired or expiring within 30 days |
| **Graceful Shutdown** | SIGTERM/SIGINT handlers ensure clean MongoDB disconnection before process exit |

---

## Tech Stack

### Backend

| Concern | Technology |
|---------|-----------|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | MongoDB 7 via Mongoose 8 |
| Authentication | JWT (jsonwebtoken) + bcryptjs (cost factor 12) |
| Input Validation | express-validator |
| Testing | Jest 29 + Supertest + mongodb-memory-server 9 |

### Frontend

| Concern | Technology |
|---------|-----------|
| Framework | React 18 + Vite 5 |
| UI Components | shadcn/ui (Radix UI primitives + CVA) |
| Styling | Tailwind CSS 3 + CSS custom properties (HSL design tokens) |
| Charts | Recharts |
| Routing | React Router v6 |
| HTTP | Axios with 401-interceptor auto-redirect |
| Toasts | react-hot-toast |
| Testing | Vitest 1 + React Testing Library + MSW v2 |

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│           React SPA  (Vite dev server :5173)          │
│                                                        │
│  Dashboard · Assets · Locations · Users · AuditLog    │
│           ↕  axios  +  JWT Bearer token                │
│        /api/*  proxied by Vite to :3000                │
└──────────────────────────┬───────────────────────────┘
                           │ HTTP / JSON
┌──────────────────────────▼───────────────────────────┐
│         Express REST API  (port 3000)                  │
│                                                        │
│  Middleware chain:                                     │
│    request → verifyToken → requireRole → handler       │
│                                                        │
│  Route modules:                                        │
│    /users  /assets  /locations  /audit                 │
│                                                        │
│  Utilities:  buildTree · logAudit · validation         │
└──────────────────────────┬───────────────────────────┘
                           │ Mongoose ODM
┌──────────────────────────▼───────────────────────────┐
│                     MongoDB                            │
│                                                        │
│  users · assets · locations · auditlogs               │
│  Indexes: text(name,serialNo) · status · category     │
│           parent · locationId · assignedTo            │
└───────────────────────────────────────────────────────┘
```

**Request lifecycle:**
1. React page calls `api.get('/assets')` via the Axios instance in `src/lib/api.js`
2. Axios interceptor attaches `Authorization: Bearer <token>` from localStorage
3. Vite dev-server proxy forwards `/api/*` to `localhost:3000`
4. `verifyToken` decodes the JWT, fetches the user from MongoDB, attaches `req.user`
5. `requireRole(...)` checks `req.user.role` against the route's allowed roles
6. The route handler executes business logic, calls `logAudit()` for mutations, returns JSON envelope
7. On a 401 response the Axios interceptor clears localStorage and redirects to `/login`

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- MongoDB (local or Atlas)

### Install

```bash
git clone <repo-url>
cd asstes-manager

# Backend dependencies
npm install

# Frontend dependencies
cd client && npm install && cd ..
```

### Configure

```bash
cp .env.example .env
# Edit .env — MONGODB_URI and JWT_SECRET are required
```

### Run

```bash
# Terminal 1 — API server (port 3000)
npm run dev

# Terminal 2 — React dev server (port 5173)
cd client && npm run dev
```

Open `http://localhost:5173`. The **first registered user** is automatically promoted to `admin`.

```bash
# Bootstrap first admin
curl -X POST http://localhost:3000/api/users/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin","email":"admin@company.com","password":"Admin1234"}'
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGODB_URI` | **Yes** | — | MongoDB connection string |
| `JWT_SECRET` | **Yes** | — | ≥ 32-char random secret for signing JWTs |
| `JWT_EXPIRES_IN` | No | `7d` | Token lifetime (`1h`, `7d`, `30d`) |
| `PORT` | No | `3000` | API listen port |
| `NODE_ENV` | No | `development` | `production` hides stack traces in responses |
| `CORS_ORIGINS` | No | `*` | Comma-separated allowed origins |

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
| `GET` | `/api/assets/stats` | Any auth | Dashboard aggregations (total, byStatus, byCategory, byLocation) |
| `GET` | `/api/assets` | Any auth | Paginated list; `?search=&status=&category=&locationId=&deep=true&page=&limit=` |
| `POST` | `/api/assets` | Manager+ | Create asset |
| `GET` | `/api/assets/:id` | Any auth | Asset detail + populated assignmentHistory |
| `PUT` | `/api/assets/:id` | Manager+ | Update any field; assignment history maintained automatically |
| `DELETE` | `/api/assets/:id` | Admin | Hard delete |
| `POST` | `/api/assets/bulk-assign` | Manager+ | `{ assetIds: [...], userId: id | null }` |

### Locations

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/api/locations/tree` | Any auth | Full nested hierarchy (building → floor → room) |
| `GET` | `/api/locations` | Any auth | Flat list; `?type=&parent=&isActive=` |
| `POST` | `/api/locations` | Manager+ | Create node; type + parent constraints enforced |
| `PUT` | `/api/locations/:id` | Manager+ | Update name / description |
| `DELETE` | `/api/locations/:id` | Admin | Soft-deactivate; blocked if children or assets exist |

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

Enforcement lives in `src/middleware/auth.js`. The `requireRole(...roles)` factory is applied per-route — no implicit role elevation.

---

## Testing

### Backend — 101 tests

```bash
npm test                  # run all suites
npm run test:coverage     # with V8 line/branch coverage
```

| Suite | Tests | What is covered |
|-------|------:|-----------------|
| `unit/buildTree` | 17 | `buildTree`, `flattenTree`, `findSubtree`, `collectDescendantIds` |
| `unit/models` | 24 | Schema validation, bcrypt hooks, `comparePassword`, virtuals |
| `integration/auth` | 16 | Register, login, token expiry, deactivated account blocks |
| `integration/assets` | 34 | CRUD, bulk-assign, stats aggregation pipeline, pagination, filters |
| `integration/locations` | 20 | Hierarchy constraints, tree validation, delete guards |
| `integration/users` | 15 | RBAC enforcement on every user management endpoint |
| `integration/audit` | 15 | Audit entry created for every mutation action |

**Isolation strategy:** `mongodb-memory-server` v9 spins up an isolated MongoDB instance per test run. `clearDatabase()` resets state between tests — no real database, no flaky network calls.

### Frontend — 44 tests

```bash
cd client
npm test                  # run all suites
npm run test:coverage     # with V8 coverage
```

| Suite | Tests | What is covered |
|-------|------:|-----------------|
| `components/AssetStatusBadge` | 12 | All statuses, size variants, colour classes |
| `context/AuthContext` | 9 | Token loading, `isAdmin`/`isManager`, login, logout |
| `pages/Login` | 7 | Form render, password toggle, validation, success/error flows |
| `pages/AuditLog` | 7 | Empty state, data rows, missing-date crash guard |
| `pages/Users` | 9 | User list rendering, "(you)" label, missing `createdAt` guard |

**Isolation strategy:** MSW v2 intercepts Axios at the network level — no `jest.mock()` needed for modules.

---

## Project Structure

```
asstes-manager/
├── src/
│   ├── index.js                      # Express app + CORS + error handler + graceful shutdown
│   ├── middleware/
│   │   └── auth.js                   # verifyToken · requireRole · optionalAuth
│   ├── models/
│   │   ├── User.js                   # Schema + bcrypt pre-save + comparePassword method
│   │   ├── Asset.js                  # Schema + text index + assignmentHistory + underWarranty virtual
│   │   ├── Location.js               # Hierarchical schema + parent/type compound indexes
│   │   └── AuditLog.js               # Immutable append-only event log schema
│   ├── routes/
│   │   ├── users.js                  # Auth + admin CRUD
│   │   ├── assets.js                 # CRUD + /stats aggregation + /bulk-assign
│   │   ├── locations.js              # CRUD + /tree + subtree scoping
│   │   └── audit.js                  # Global log + per-asset history
│   └── utils/
│       ├── buildTree.js              # O(n) tree builder · flattenTree · findSubtree · collectDescendantIds
│       └── auditLogger.js            # logAudit(action, asset, user, {fromValue, toValue}) helper
├── tests/
│   ├── setup/db.js                   # MongoMemoryServer helpers
│   ├── helpers/index.js              # Factory fns: createAdmin · createAsset · createBuilding ...
│   ├── unit/
│   └── integration/
├── client/
│   ├── src/
│   │   ├── components/
│   │   │   ├── ui/                   # shadcn/ui: Button · Card · Input · Label · Badge · Table · Dialog · Separator
│   │   │   ├── Sidebar.jsx           # Nav with role-filtered links
│   │   │   └── AssetStatusBadge.jsx  # Status badge using shadcn Badge variants
│   │   ├── context/
│   │   │   └── AuthContext.jsx       # JWT decode · login · logout · isAdmin · isManager helpers
│   │   ├── lib/
│   │   │   ├── api.js                # Axios instance + automatic 401 → /login redirect
│   │   │   └── utils.js              # cn() (clsx + tailwind-merge)
│   │   ├── pages/
│   │   │   ├── Dashboard.jsx         # KPI cards + Recharts pie + bar + recent activity
│   │   │   ├── Assets.jsx            # Table + filters + Radix Dialog create/edit/delete modals
│   │   │   ├── AssetDetail.jsx       # Full detail + assignment history + audit timeline
│   │   │   ├── Locations.jsx         # Recursive tree component + inline CRUD modals
│   │   │   ├── Users.jsx             # User table + add/edit modals + activate/deactivate toggle
│   │   │   ├── AuditLog.jsx          # Paginated audit table with action/user filters
│   │   │   ├── Roles.jsx             # Permission matrix + inline role assignment
│   │   │   └── Login.jsx             # Auth form with password visibility toggle
│   │   └── test/                     # Vitest suites + MSW handlers/server + setup
│   ├── tailwind.config.js            # CSS variable colour tokens mapped to Tailwind utilities
│   ├── vite.config.js                # @ path alias + /api proxy
│   └── vitest.config.js              # jsdom environment + @ alias + coverage config
├── jest.config.js
└── docs/
    ├── HLD.md                        # High-Level Design document
    └── LLD.md                        # Low-Level Design document
```

---

## Design Documents

- [`docs/HLD.md`](./docs/HLD.md) — System context, component breakdown, data flow diagrams, scalability and reliability strategy
- [`docs/LLD.md`](./docs/LLD.md) — Database schemas, API contracts, security model, class-level utility design, test architecture

---

## Deployment

### AWS EC2 + Nginx + PM2

```bash
# 1. On the server — install dependencies
sudo apt update && sudo apt install -y nodejs npm nginx
sudo npm install -g pm2

# 2. Clone and install
git clone <repo> /opt/assettrack && cd /opt/assettrack
npm install --omit=dev
cd client && npm run build && cd ..   # outputs to client/dist/

# 3. Environment
cp .env.example .env
nano .env   # set MONGODB_URI, JWT_SECRET, NODE_ENV=production, CORS_ORIGINS

# 4. Start with PM2
pm2 start src/index.js --name assettrack --env production
pm2 save && pm2 startup
```

**Nginx — reverse-proxy API + serve React build:**

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    root /opt/assettrack/client/dist;
    index index.html;

    # React SPA — serve index.html for any client-side route
    location / {
        try_files $uri $uri/ /index.html;
    }

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
- [ ] `NODE_ENV=production` set
- [ ] MongoDB bound to `127.0.0.1`, not exposed publicly
- [ ] `CORS_ORIGINS` scoped to actual frontend origin
- [ ] Port 3000 not open in EC2 Security Group (only 80/443)
- [ ] HTTPS configured and auto-renewal active (`sudo systemctl status certbot.timer`)
- [ ] PM2 startup script registered (`pm2 startup` + `pm2 save`)
