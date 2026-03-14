# High-Level Design (HLD) — AssetTrack

## 1. Introduction

### 1.1 Purpose
AssetTrack is a corporate asset lifecycle management system. It enables organisations to track IT hardware from procurement through assignment, maintenance, and eventual retirement — with a full, tamper-evident audit trail throughout.

### 1.2 Scope
- Full-stack single-page application (SPA) with a RESTful JSON API
- Role-based access control (RBAC) — three roles: Admin, Manager, Viewer
- Hierarchical location management (Building → Floor → Room)
- Real-time dashboard analytics

### 1.3 Goals
| Goal | How it is achieved |
|------|--------------------|
| Data integrity | Mongoose schema validation + express-validator at the API boundary |
| Security | JWT authentication, bcrypt password hashing, role middleware |
| Auditability | Immutable append-only AuditLog collection |
| Maintainability | Layered architecture with clear separation of concerns |
| Testability | 145 automated tests; in-memory DB for isolation |

---

## 2. System Context

```
                    ┌─────────────────────┐
                    │   Browser / SPA     │
                    │   (React + Vite)    │
                    └──────────┬──────────┘
                               │ HTTPS (JSON REST)
                    ┌──────────▼──────────┐
                    │   Nginx (port 443)  │
                    │   TLS termination   │
                    └──────────┬──────────┘
                               │ HTTP proxy
              ┌────────────────▼────────────────┐
              │     Node.js / Express API        │
              │          (port 3000)             │
              │                                  │
              │  Auth · Assets · Locations ·     │
              │  Users · Audit                   │
              └────────────────┬────────────────┘
                               │ Mongoose
              ┌────────────────▼────────────────┐
              │           MongoDB                │
              │  users · assets · locations ·   │
              │  auditlogs                       │
              └─────────────────────────────────┘
```

**External actors:**
- **End users** — interact via the React SPA in their browser
- **Administrators** — manage users and roles
- **Ops/CI** — run `GET /health` for uptime checks

---

## 3. Component Architecture

### 3.1 Frontend (React SPA)

```
src/
├── context/AuthContext        JWT decode, login/logout, role helpers
├── lib/api                    Axios instance + 401 interceptor
├── lib/utils                  cn() — clsx + tailwind-merge
├── components/ui/             shadcn/ui primitive components
│   Button · Card · Input · Label · Badge · Table · Dialog · Separator
├── components/
│   Sidebar                    Role-filtered navigation
│   AssetStatusBadge           Semantic status display
└── pages/
    Dashboard                  KPI cards + Recharts charts + activity feed
    Assets                     Table + pagination + filters + CRUD modals
    AssetDetail                Detail panel + assignment history + timeline
    Locations                  Recursive tree + inline CRUD
    Users                      User management + toggle activate
    AuditLog                   Paginated event log + filters
    Roles                      Permission matrix + inline role editor
    Login                      Authentication form
```

**Key design decisions:**
- **shadcn/ui** over a monolithic component library — ships only what is used, built on accessible Radix primitives
- **Radix Dialog** replaces Headless UI — declarative `open/onOpenChange` avoids imperative state bugs
- **MSW v2** for tests — intercepts at the network layer, so tests cover real Axios config (headers, interceptors)
- **CSS custom properties** (HSL tokens) enable a consistent design system with zero runtime overhead

### 3.2 Backend (Express REST API)

```
src/
├── index.js          App bootstrap: CORS, body parser, routes, error handler, graceful shutdown
├── middleware/
│   └── auth.js       verifyToken · requireRole(roles) · optionalAuth
├── models/           Mongoose schemas with validation and hooks
├── routes/           Route handlers — thin controllers that delegate to Mongoose + utils
└── utils/
    ├── buildTree.js  Pure O(n) tree construction and traversal
    └── auditLogger.js  logAudit(action, asset, user, meta) — always called from route handlers
```

**Key design decisions:**
- **Layered structure** — middleware → routes → models → utils; each layer has one concern
- **`requireRole` factory** — roles are declared per-route at registration time, not scattered in handlers
- **`logAudit` helper** — centralised so no mutation can silently skip the audit trail
- **`require.main === module` guard** — allows the app to be required in tests without starting the server

### 3.3 Database (MongoDB)

Four collections:

| Collection | Purpose |
|------------|---------|
| `users` | Accounts, credentials, roles |
| `assets` | IT assets and their current state |
| `locations` | Building/floor/room hierarchy nodes |
| `auditlogs` | Immutable event log (never updated, never deleted) |

---

## 4. Data Flow Diagrams

### 4.1 Login Flow

```
Browser          React           Axios/API         Express          MongoDB
  │                │                 │                  │               │
  │── submit form ─▶                 │                  │               │
  │                │── POST /login ──▶                  │               │
  │                │                 │── validateBody ──▶               │
  │                │                 │                  │── findUser ──▶│
  │                │                 │                  │◀── user ──────│
  │                │                 │                  │── compareHash │
  │                │                 │◀── {token, user} │               │
  │                │◀── store token  │                  │               │
  │◀── redirect /  │                 │                  │               │
```

### 4.2 Asset Update with Audit

```
Manager           React          Axios           Express         MongoDB
  │                 │               │                │               │
  │── edit form ───▶               │                │               │
  │                 │── PUT /assets/:id             │               │
  │                 │               │── verifyToken ▶               │
  │                 │               │── requireRole ▶               │
  │                 │               │── validate ───▶               │
  │                 │               │                │── findAsset ─▶│
  │                 │               │                │── updateAsset▶│
  │                 │               │                │── logAudit ──▶│ (auditlogs insert)
  │                 │               │◀── {success}   │               │
  │◀── toast.success│               │                │               │
```

### 4.3 Dashboard Stats Aggregation

```
React (Dashboard)           Express (/assets/stats)        MongoDB
       │                              │                         │
       │── GET /assets/stats ────────▶                         │
       │                              │── Promise.all([         │
       │                              │    countDocuments,      │
       │                              │    aggregate(byStatus), │
       │                              │    aggregate(byCat),    │
       │                              │    aggregate(byLoc)     │
       │                              │   ])──────────────────▶│
       │                              │◀── [count, s, c, l] ───│
       │◀── {total,byStatus,          │                         │
       │     byCategory,byLocation}   │                         │
       │                              │                         │
 Recharts renders                     │                         │
 pie + bar charts                     │                         │
```

---

## 5. Authentication & Authorisation

### 5.1 Authentication (JWT)

```
POST /login → bcrypt.compare() → jwt.sign({id}, secret, {expiresIn})
                                         ↓
Every request: Authorization: Bearer <token>
                ↓
verifyToken middleware:
  1. Extract token from header
  2. jwt.verify(token, secret)         → TokenExpiredError | invalid
  3. User.findById(decoded.id)         → user deleted?
  4. user.isActive check               → deactivated?
  5. attach req.user → next()
```

### 5.2 Authorisation (RBAC)

```
requireRole('admin', 'manager') middleware:
  if (!req.user)            → 401
  if (!roles.includes(role)) → 403 with descriptive message
  else                      → next()
```

**Role hierarchy (no inheritance — explicit per resource):**

```
admin   ──────────────────────────────────── full access
manager ──── assets (C/R/U) · locations (C/R/U) · users (R) · audit (R)
viewer  ──── assets (R) · locations (R)
```

### 5.3 Password Security

- bcryptjs with cost factor **12** (≈ 250ms hash time)
- `password` field has `select: false` — never returned in any query by default
- Minimum 8 characters, must contain at least one digit (enforced by express-validator)

---

## 6. Audit Trail Design

The AuditLog collection is **append-only by design**. No route exposes `PUT /audit/:id` or `DELETE /audit/:id`. Every mutation in the assets, locations, and users routes calls `logAudit()` before responding.

```
AuditLog document:
{
  action:           'created' | 'updated' | 'deleted' | 'assigned' |
                    'unassigned' | 'status_changed' | 'location_changed' | 'bulk_assigned'
  assetId:          ObjectId (ref Asset)
  assetName:        string (snapshot — preserved even after asset deleted)
  assetSerialNo:    string (snapshot)
  performedBy:      ObjectId (ref User)
  performedByName:  string (snapshot)
  performedByEmail: string (snapshot)
  fromValue:        string | null   (before value, e.g. "active")
  toValue:          string | null   (after value,  e.g. "maintenance")
  createdAt:        Date (auto, immutable)
}
```

**Why snapshots?** If an asset or user is deleted, the audit history remains meaningful without needing a JOIN to a non-existent document.

---

## 7. Location Hierarchy

```
Building (parent: null)
  └─ Floor   (parent: building._id)
       └─ Room (parent: floor._id)
```

**Constraints enforced at the API layer:**
- A `floor` must have a `building` as parent
- A `room` must have a `floor` as parent
- A `building` must have no parent
- Delete is blocked if the node has active children or assigned assets

**Tree construction** (`buildTree.js`) — O(n) single-pass algorithm:
1. Build a `Map<id, node>` in one pass
2. Second pass: attach each node to its parent's `children` array
3. Collect nodes with no parent as roots

This avoids the O(n²) naive recursive approach and handles arbitrarily deep trees.

---

## 8. Scalability Considerations

| Concern | Current approach | Scale-up path |
|---------|-----------------|---------------|
| API throughput | Single Node.js process | PM2 cluster mode (`-i max`) or horizontal scaling behind a load balancer |
| Database reads | MongoDB indexes on all filter fields | Read replicas for analytics queries; separate `stats` cache |
| Session state | Stateless JWT | No change needed — JWTs work across any number of API instances |
| Asset search | MongoDB text index | Elasticsearch or Atlas Search for advanced full-text if corpus grows large |
| Audit log growth | Single collection, time-indexed | TTL index for old entries; or archive to S3 via MongoDB Atlas Data Federation |
| Frontend assets | Vite builds static files | CDN (CloudFront / Cloudflare) for JS/CSS bundles |

---

## 9. Reliability & Operational Concerns

- **Health endpoint** — `GET /health` returns uptime, timestamp, and MongoDB connection state; suitable for load balancer health checks
- **Graceful shutdown** — SIGTERM/SIGINT handlers close the HTTP server and MongoDB connection before process exit; prevents in-flight request drops during deployments
- **Error envelope** — All errors return `{success: false, message: "..."}` with appropriate HTTP status codes; stack traces hidden in `NODE_ENV=production`
- **Mongoose error normalisation** — ValidationError → 422, CastError → 400, duplicate key → 409
- **CORS** — Configurable via environment variable; defaults to `*` for development, should be locked to specific origins in production

---

## 10. Technology Choices — Rationale

| Choice | Alternatives considered | Reason chosen |
|--------|------------------------|---------------|
| MongoDB | PostgreSQL, MySQL | Schema flexibility for evolving asset fields; native JSON; excellent aggregation pipeline for dashboard stats |
| JWT (stateless) | Sessions + Redis | No shared session store required; horizontally scalable without coordination |
| Express | Fastify, NestJS | Minimal surface area; team familiarity; no framework-imposed abstractions for a project this size |
| React + Vite | Next.js | No SSR/SEO requirement; Vite's HMR is significantly faster for development |
| shadcn/ui | Material UI, Chakra | Zero runtime; ships only used components; built on Radix accessible primitives; owned CSS |
| MSW v2 | axios-mock-adapter, jest.mock | Intercepts at the network layer — tests cover actual Axios config including interceptors and headers |
| mongodb-memory-server | Test MongoDB Atlas cluster | Fully isolated, zero infrastructure, runs in CI without external dependencies |
