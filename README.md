# University NFA & Dynamic Department Budget Management System

Full working system: **Role-Based Portal → NFA → Budget Validation → Master Department Budget →
Approval → Excel/PDF Reports**, built from and seeded with the actual data in the two reference
files provided (`ERP_ADSE_NFA_Final.docx`, `CSE_Financial_Budget_2026-2027...xlsx`).

## 1. Run it (VS Code)

```bash
cd nfa-system
npm install
npm run seed     # one-time: creates data/db.json with real departments/categories/users/the ERP NFA
npm run dev       # starts API + frontend on http://localhost:4000
```

Open **http://localhost:4000**. Demo logins (password `password123` for all — shown on the login screen too):

| Role | Email |
|---|---|
| Student | student@christ.edu |
| Faculty | faculty@christ.edu |
| HOD | hod@christ.edu |
| Finance | finance@christ.edu |
| Super Admin | admin@christ.edu |
| IT Administrator | itadmin@christ.edu |

No database server, Docker, or native build step required — persistence is a JSON file at
`data/db.json` (see "Swapping in PostgreSQL" below for production).

## 2. What's seeded, from the real files

- **Departments**: CSE (budget workbook owner) and ADSE (raised the sample NFA), with the real HOD/Dean names from the workbook.
- **Financial Year**: 2026-27 (not hard-coded — add more from Settings as Super Admin).
- **Budget Type**: Revenue Expenditure, with the **5 real category groups** and their **actual totals** summed from the "Revenue Expenditures" sheet (these sum exactly to the sheet's own grand total, ₹3,11,38,700):
  - External Remuneration — ₹65,30,000
  - Staff Development & Welfare — ₹25,85,000
  - Student Related Expenses — ₹1,39,78,700
  - Administrative Expenses — ₹7,45,000
  - Others — ₹73,00,000
- **The ERP Server Infrastructure NFA** (`NFA/CU/SoET/ADSE/2026-27/004`), seeded as a `draft` — this is your live Test Case #1 for the workflow, with its real 6 line items (Server Hardware ₹90,000, Storage ₹5,500, UPS ₹11,500, Network Setup ₹7,500, Backup Solution ₹2,000, Domain ₹1,200 = ₹1,17,700 total), under "Student Related Expenses".
- The Student Related Expenses category's `approved_amount` is pre-loaded with every other item from the sheet **except** this ₹1,17,700, so that pushing the seeded NFA through Submit → Faculty → HOD → Approve reproduces the workbook's real total via the actual workflow, not a hard-coded number.

Categories are data, not code — add new ones (CAPEX, Revenue/Earnings sub-categories, future years) from `/api/admin` without touching the codebase, per the "no hard-coding" requirement.

## 3. Core workflow implemented

```
Create Project → Create NFA (draft) → Add items → Submit
   → Faculty review (approve/reject/revision_required)
   → HOD review → runs budget validation automatically
        sufficient & under threshold  → auto-applied → Approved → Master Budget updated
        insufficient OR over ₹1,00,000 / 25% of category → Pending Higher Approval
   → Finance decision → Approved → Master Budget updated
```

Revising an **already-approved** NFA (`POST /api/nfas/:id/revise`) recomputes the *difference*
(never overwrites blindly), applies small changes immediately, and escalates large ones to
Finance the same way. Decreases immediately free up the department's available budget.

## 4. API summary (all endpoints require `Authorization: Bearer <token>` except `/auth/login`)

```
POST   /api/auth/login                          { email, password } -> { token, user }
GET    /api/auth/demo-accounts

GET    /api/projects?department=&fy=
POST   /api/projects                            { name, department_id, financial_year_id, budget_category_id }
PUT    /api/projects/:id

POST   /api/nfas                                { project_id, department_id, financial_year_id, budget_category_id, title, purpose, description, justification, sdgs, items:[{particulars,quantity,amount}] }
GET    /api/nfas?status=&department=
GET    /api/nfas/:id
PUT    /api/nfas/:id                            (only while draft/revision_required)
POST   /api/nfas/:id/submit
POST   /api/nfas/:id/review                     { decision: approve|reject|revision_required, comments }  (faculty then hod)
POST   /api/nfas/:id/finance-decision           { decision: approve|reject, comments }
POST   /api/nfas/:id/revise                     { new_total_amount, reason, items? }  (approved NFAs only)
GET    /api/nfas/:id/pdf                         downloads the NFA as PDF (NOTE FOR APPROVAL template)

GET    /api/budgets/departments
GET    /api/budgets/financial-years
GET    /api/budgets/categories
GET    /api/budgets/:department                 raw budget lines
GET    /api/budgets/:department/summary?fy=      allocated/approved/pending/available per category
PUT    /api/budgets/:id                          super_admin only, sets top-line allocation
GET    /api/budgets/export/:department?fy=        Excel export

POST   /api/budgets/import/preview               multipart: file, department_id, financial_year_id -> diff (no writes yet)
POST   /api/budgets/import/confirm/:syncId        applies the previewed diff through the budget engine
GET    /api/budgets/import/records?department=

GET    /api/audit?department=&entity_type=&nfa_id=
GET    /api/audit/transactions?department=

POST   /api/admin/financial-years                { label }               (super_admin)
PUT    /api/admin/financial-years/:id/activate                            (super_admin)
POST   /api/admin/departments                    { name, code }          (super_admin)
POST   /api/admin/budget-types                   { name }                (super_admin)
POST   /api/admin/budget-categories              { budget_type_id, name } (super_admin)
POST   /api/admin/department-budgets             { department_id, financial_year_id, budget_category_id, allocated_amount } (super_admin)
POST   /api/admin/users                          { name, email, password, role, department_id }         (super_admin)
```

### Example: approving an NFA (HOD step) triggers budget validation

```json
POST /api/nfas/abc123/review
{ "decision": "approve", "comments": "Recommended, infra is needed for ERP rollout" }
```
Response (sufficient budget → auto-approved):
```json
{
  "id": "abc123", "status": "approved", "total_amount": 117700,
  "validation": { "available": 130000, "requested": 117700, "sufficient": true, "shortfall": 0, "higherApprovalRequired": false },
  "escalated": false
}
```
Response (insufficient budget → escalated):
```json
{
  "status": "pending_higher_approval",
  "validation": { "available": 20000, "requested": 40000, "sufficient": false, "shortfall": 20000, "higherApprovalRequired": true },
  "escalated": true
}
```

## 5. Role permissions (enforced in `middleware/auth.ts` + per-route checks — backend, not just UI)

| Role | Can |
|---|---|
| student | create/edit own draft NFA, submit, view own NFAs — cannot approve or touch master budget |
| faculty | level-1 review (approve/reject/revision_required), revise approved NFAs, view dept budget, Excel import for own dept |
| hod | level-2 review + budget validation trigger, revise approved NFAs, dept-wide visibility |
| finance | resolves `pending_higher_approval` NFAs, cross-department visibility |
| super_admin | manage users/departments/financial years/categories/allocations |
| it_admin | department-scoped read access (NFAs, budget, audit) — extend role checks in `middleware/auth.ts` if your portal needs it to do more |

## 6. Integrating with your friend's Role-Based Portal

This runs as an independent service. Your friend's portal calls these REST endpoints directly
(CORS is open in dev — restrict `cors()` in `src/server.ts` to your portal's origin for
production) using a service-to-service JWT, or you front it with the portal's own SSO and have
the portal mint/relay this API's JWT after mapping its own roles to `student|faculty|hod|finance|super_admin|it_admin`.
The frontend in `/public` is optional — the portal can build its own UI purely against the API.

## 7. Swapping in PostgreSQL

`src/store.ts` is the only place that touches persistence (a JSON file, transaction-serialized
through a promise queue so financial mutations never interleave). To move to PostgreSQL: replace
`Store` with a class exposing the same `data` getter shape and an async `transact(fn)` that opens
a `BEGIN`/`COMMIT` transaction and runs equivalent SQL — no route or budget-engine code changes
needed, since all business logic in `lib/budgetEngine.ts` and the routes only touches `db.<table>`
arrays. The table shapes in `src/types.ts` map 1:1 onto the relational schema requested (`users`,
`departments`, `financial_years`, `budget_categories`, `department_budgets`, `projects`, `nfas`,
`nfa_items`, `budget_transactions`, `approvals`, `audit_logs`, `excel_sync_records`).

## 8. Running the required demo tests

1. Log in as **hod**. Go to Projects → New Project ("AI Innovation Workshop", category: Others) → NFAs → New NFA, one item ₹50,000 → Create Draft → Submit.
2. Log out, log in as **faculty**, open the NFA, Approve.
3. Log in as **hod**, Approve → since ₹50,000 is under the threshold and budget is available, it auto-applies. Check Budgets tab: category's Approved amount rose by ₹50,000.
4. As faculty/hod, open the same NFA (now Approved) → "Revise Budget" → 75,000 → check the +₹25,000 difference lands in Approved.
5. Revise again to 60,000 → Available increases by ₹15,000.
6. Repeat step 1-2 for a second project → confirm it appears in Budgets/Excel export automatically.
7. Export Excel, edit an amount, re-upload via the Excel tab → Preview shows the diff → Confirm → audit log records it.
8. Try creating/approving an NFA above the category's available amount → HOD's Approve returns `pending_higher_approval` with `shortfall` — resolve via Finance login.
