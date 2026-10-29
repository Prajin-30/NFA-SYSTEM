export type Role =
  | 'faculty'
  | 'hod'
  | 'dean'
  | 'associate_dean'
  | 'finance'
  | 'director'
  | 'super_admin'
  | 'it_admin'
  | 'student';

export type NfaStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'dean_review'
  | 'accounts_review'
  | 'pending_director_approval'
  | 'revision_required'
  | 'budget_validation'
  | 'pending_higher_approval'
  | 'approved'
  | 'rejected';

export interface User {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  department_id: string | null;
  created_at: string;
}

export interface Department {
  id: string;
  name: string;
  code: string;
  hod_name?: string;
  dean_name?: string;
  faculty_name?: string;
  associate_dean_name?: string;
  director_name?: string;
  finance_officer_name?: string;
}

export interface FinancialYear {
  id: string;
  label: string; // e.g. "2026-27"
  is_active: boolean;
}

export interface BudgetType {
  id: string;
  name: string; // Revenue Expenditure | CAPEX | Revenue/Earnings
}

export interface BudgetCategory {
  id: string;
  budget_type_id: string;
  name: string; // External Remuneration, Staff Development & Welfare, Student Related Expenses, Administrative Expenses, Others...
}

export interface BudgetSubcategory {
  id: string;
  budget_category_id: string;
  department_id?: string;
  name: string;
  allocated_amount: number;
  approved_amount: number;
  pending_amount: number;
}

export interface DepartmentBudget {
  id: string;
  department_id: string;
  financial_year_id: string;
  budget_category_id: string;
  allocated_amount: number;
  approved_amount: number; // sum of approved NFAs/items charged to this category
  pending_amount: number; // sum awaiting approval
  revised_amount: number; // net effect of revisions (can be +/-), informational
}

export interface Project {
  id: string;
  name: string;
  department_id: string;
  financial_year_id: string;
  budget_category_id: string;
  created_by: string;
  status: 'active' | 'closed';
  created_at: string;
  description?: string;
  budget_amount?: number;
  remarks?: string;
  assigned_faculty_id?: string | null;
}

export interface NfaItem {
  id: string;
  nfa_id: string;
  sl_no: number;
  particulars: string;
  quantity: string;
  rate?: string;
  amount: number;
  comments?: string;
  justification?: string;
  basis_of_budget?: string;
  previous_year_budget?: number;
  previous_year_actual?: number;
}

export interface Nfa {
  id: string;
  ref_no: string;
  project_id?: string | null;
  department_id: string;
  financial_year_id: string;
  budget_type_id?: string;
  budget_category_id: string;
  budget_subcategory_id?: string;
  budget_subcategory_name?: string;
  title: string;
  purpose: string;
  description: string;
  justification: string;
  sdgs: string;
  requirements?: string;
  total_amount: number;
  status: NfaStatus;
  created_by: string;
  submitted_by_name?: string;
  submitted_by_designation?: string;
  hod_name?: string;
  date: string;
  created_at: string;
  updated_at: string;
  // set while a revision to an already-approved NFA awaits Finance sign-off
  pending_revision_amount?: number;
  pending_revision_reason?: string;
}

export interface Approval {
  id: string;
  nfa_id: string;
  approver_role: Role;
  approver_id: string;
  approver_name?: string;
  decision: 'approved' | 'rejected' | 'revision_required' | 'recommended';
  comments: string;
  level: number;
  created_at: string;
}

export interface BudgetTransaction {
  id: string;
  nfa_id: string | null;
  project_id: string | null;
  department_budget_id: string;
  type: 'new' | 'increase' | 'decrease' | 'excel_sync';
  old_amount: number;
  new_amount: number;
  difference: number;
  created_by: string;
  created_at: string;
}

export interface AuditLog {
  id: string;
  entity_type: 'nfa' | 'project' | 'department_budget' | 'excel_sync';
  entity_id: string;
  department_id: string;
  old_amount: number | null;
  new_amount: number | null;
  difference: number | null;
  changed_by: string;
  role: Role;
  reason: string;
  source: 'portal' | 'excel' | 'system';
  approval_status: string;
  created_at: string;
}

export interface ExcelSyncRecord {
  id: string;
  financial_year_id: string;
  department_id: string;
  filename: string;
  status: 'pending_review' | 'confirmed' | 'rejected';
  diff_json: string;
  created_by: string;
  created_at: string;
}

export interface BudgetUpload {
  id: string;
  financial_year_id: string;
  department_id: string;
  filename: string;
  stored_filename: string;
  uploaded_by: string;
  uploaded_at: string;
  status: 'original';
}

export interface BudgetChange {
  id: string;
  version: number;
  financial_year_id: string;
  department_id: string;
  project_id?: string | null;
  changed_by: string;
  action: string;
  previous_value: string;
  new_value: string;
  description: string;
  approval_status: 'original' | 'pending' | 'approved' | 'rejected';
  created_at: string;
}

export interface DB {
  users: User[];
  departments: Department[];
  financial_years: FinancialYear[];
  budget_types: BudgetType[];
  budget_categories: BudgetCategory[];
  budget_subcategories?: BudgetSubcategory[];
  department_budgets: DepartmentBudget[];
  projects: Project[];
  nfas: Nfa[];
  nfa_items: NfaItem[];
  approvals: Approval[];
  budget_transactions: BudgetTransaction[];
  audit_logs: AuditLog[];
  excel_sync_records: ExcelSyncRecord[];
  budget_uploads: BudgetUpload[];
  budget_changes: BudgetChange[];
}
