export type Role =
  | 'faculty'
  | 'hod'
  | 'deans_office'
  | 'dean'
  | 'associate_dean'
  | 'finance'
  | 'director'
  | 'finance_head'
  | 'super_admin'
  | 'it_admin'
  | 'student';

export type NfaStatus =
  | 'draft'
  | 'submitted'
  | 'pending_hod_review'
  | 'pending_deans_office_verification'
  | 'pending_associate_dean_approval'
  | 'dean_review'
  | 'pending_dean_approval'
  | 'accounts_review'
  | 'pending_finance_office_approval'
  | 'pending_director_approval'
  | 'pending_finance_head_approval'
  | 'under_review'
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
  authorized_centre_ids?: string[];
  school?: string | null;
  signature_image?: string;
  created_at: string;
  must_change_password?: boolean;
  is_active?: boolean;
  temp_password_created_at?: string | null;
}

export interface School {
  id: string;
  code: string;
  name: string;
  campus: string;
  dean_id?: string | null;
  created_at?: string;
}

export interface Department {
  id: string;
  name: string;
  code: string;
  category?: 'academic' | 'coe';
  department_type?: 'academic' | 'centre';
  school?: string | null;
  school_id?: string | null;
  is_active?: boolean;
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

export interface ExcelCellMapping {
  sheet_name: string;
  cell_address: string;
  row: number;
  col: number;
  original_value?: number;
  sl_no?: number | string;
}

export interface BudgetSubcategory {
  id: string;
  budget_category_id: string;
  department_id?: string;
  name: string;
  allocated_amount: number;
  approved_amount: number;
  pending_amount: number;
  cell_mapping?: ExcelCellMapping;
  sl_no?: number | string;
}

export interface DepartmentBudget {
  id: string;
  department_id: string;
  financial_year_id: string;
  budget_category_id: string;
  allocated_amount: number;
  approved_amount: number; // sum of approved NFAs/items charged to this category
  pending_amount: number; // sum awaiting approval (Reserved for active NFAs)
  revised_amount: number; // net effect of revisions (can be +/-), informational
  cell_mapping?: ExcelCellMapping;
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
  // Event Predefined / Custom metadata
  is_predefined?: boolean;
  predefined_key?: string;
  distance_km?: string;
  carry_back_arrangement?: string;
  sampling_required?: boolean;
  item_type?: 'predefined' | 'custom' | 'purchase';
}

export interface EventDetails {
  resource_person_name?: string;
  designation?: string;
  organization?: string;
  event_date?: string;
  venue?: string;
  additional_info?: string;
}

export interface PurchaseDetails {
  item_name?: string;
  description?: string;
  quantity?: string;
  purpose?: string;
  additional_info?: string;
}

export interface VendorQuotation {
  vendor_name: string;
  quotation_ref?: string;
  quotation_date?: string;
  file_id: string;
  original_filename: string;
  file_path: string;
  file_size: number;
  file_hash?: string;
  mime_type?: string;
  uploaded_at: string;
}

export interface ComparativeStatementDoc {
  file_id: string;
  original_filename: string;
  file_path: string;
  file_size: number;
  file_hash?: string;
  mime_type?: string;
  uploaded_at: string;
}

export interface Nfa {
  id: string;
  ref_no: string;
  project_id?: string | null;
  department_id: string;
  centre_id?: string | null;
  organization_type?: 'department' | 'centre_or_office';
  workflow_type?: 'department' | 'centre_or_office';
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
  // Four Description Points (max 50 words each)
  point1?: string;
  point2?: string;
  point3?: string;
  point4?: string;
  // Event vs Purchase details
  nfa_type?: 'event' | 'purchase';
  event_details?: EventDetails;
  purchase_details?: PurchaseDetails;
  quotations?: VendorQuotation[];
  comparative_statement?: ComparativeStatementDoc;
  proposer_signature?: string;
  // set while a revision to an already-approved NFA awaits Finance sign-off
  pending_revision_amount?: number;
  pending_revision_reason?: string;
  is_deleted?: boolean;
  deleted_at?: string | null;
  // Event Revenue Generation & Completion
  will_generate_revenue?: boolean;
  event_completion_status?: 'not_started' | 'scheduled' | 'completed' | 'cancelled';
  event_completion_date?: string;
  event_completion_remarks?: string;
  event_completed_by?: string;
  event_completed_at?: string;
}

export interface Approval {
  id: string;
  nfa_id: string;
  approver_role: Role;
  approver_id: string;
  approver_name?: string;
  decision: 'approved' | 'rejected' | 'revision_required' | 'recommended' | 'verified';
  comments: string;
  level: number;
  previous_status?: NfaStatus;
  new_status?: NfaStatus;
  signature_image?: string;
  created_at: string;
}

export interface MockEmail {
  id: string;
  nfa_id: string;
  nfa_ref_no: string;
  event: string;
  recipient_role: string;
  recipient_email: string;
  recipient_name: string;
  subject: string;
  body: string;
  html_body?: string;
  attachment_name?: string;
  has_pdf_attachment: boolean;
  status: 'mock_delivered' | 'failed';
  error_message?: string;
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
  entity_type: 'nfa' | 'project' | 'department_budget' | 'excel_sync' | 'user_account' | 'bank_detail' | 'purchase_invoice' | 'event_revenue';
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
  status: 'original' | 'active' | 'archived';
  is_master?: boolean;
  sheets_info?: any[];
  cell_mappings?: Array<{
    sheet_name: string;
    cell_address: string;
    category_id?: string;
    subcategory_id?: string;
    field: string;
  }>;
}

export interface MasterBudgetSubcategoryPreview {
  sl_no?: number | string;
  name: string;
  allocated_amount: number;
  cell_address: string;
  sheet_name?: string;
  row: number;
  col: number;
}

export interface MasterBudgetCategoryPreview {
  category_name: string;
  budget_type_name: string;
  allocated_amount: number;
  cell_address?: string;
  subcategories: MasterBudgetSubcategoryPreview[];
}

export interface MasterBudgetSheetPreview {
  name: string;
  sheet_type: 'financial' | 'summary' | 'skipped';
  reason?: string;
  budget_type_name?: string;
  declared_total?: number;
  extracted_total: number;
  variance?: number;
  categories_count: number;
  items_count: number;
}

export interface MasterBudgetPreviewResponse {
  preview_id: string;
  filename: string;
  detected_department?: { id?: string; code?: string; name?: string };
  detected_financial_year?: { id?: string; label?: string };
  has_existing_budget?: boolean;
  existing_total_allocated?: number;
  existing_categories_count?: number;
  sheets: MasterBudgetSheetPreview[];
  categories: MasterBudgetCategoryPreview[];
  total_allocated: number;
  warnings: string[];
  errors: string[];
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

export type InvoiceVerificationStatus = 'pending_verification' | 'verified' | 'returned';
export type InvoicePaymentStatus = 'unpaid' | 'in_process' | 'paid';

export interface PurchaseInvoice {
  id: string;
  nfa_id: string;
  invoice_number: string;
  invoice_date: string;
  vendor_name: string;
  invoice_amount: number;
  gst_amount?: number;
  file_id?: string;
  original_filename?: string;
  file_path: string;
  file_size?: number;
  mime_type?: string;
  uploaded_by: string;
  uploaded_by_name?: string;
  uploaded_at: string;
  verification_status: InvoiceVerificationStatus;
  verified_by?: string;
  verified_by_name?: string;
  verified_at?: string;
  return_reason?: string;
  payment_status: InvoicePaymentStatus;
  paid_amount?: number;
  payment_date?: string;
  payment_ref_utr?: string;
  payment_remarks?: string;
  created_at: string;
  updated_at: string;
}

export type ResourcePersonPaymentStatus =
  | 'details_pending'
  | 'details_submitted'
  | 'finance_verification'
  | 'ready_for_payment'
  | 'payment_processing'
  | 'paid'
  | 'returned_for_correction'
  | 'payment_failed';

export interface ResourcePersonBankDetail {
  id: string;
  nfa_id: string;
  // Personal Details
  resource_person_name: string;
  designation?: string;
  organization?: string;
  email?: string;
  mobile?: string;
  honorarium_amount?: number;
  // Banking Credentials (Encrypted at rest)
  account_holder_name: string;
  bank_name: string;
  encrypted_account_number: string;
  iv: string;
  auth_tag: string;
  masked_account_number: string;
  ifsc_code: string;
  branch_name?: string;
  remarks?: string;
  // Finance Honorarium Payment Tracking
  tracking_status?: ResourcePersonPaymentStatus;
  approved_honorarium?: number;
  deductions?: number;
  net_payable_amount?: number;
  payment_date?: string;
  payment_ref_utr?: string;
  payment_remarks?: string;
  created_at: string;
  updated_at: string;
}

export interface ResourcePersonBankDetailDTO {
  id: string;
  nfa_id: string;
  // Personal Details
  resource_person_name: string;
  designation?: string;
  organization?: string;
  email?: string;
  mobile?: string;
  honorarium_amount?: number;
  // Banking Details
  account_holder_name: string;
  bank_name: string;
  masked_account_number: string;
  ifsc_code: string;
  branch_name?: string;
  remarks?: string;
  // Payment Tracking
  tracking_status?: ResourcePersonPaymentStatus;
  approved_honorarium?: number;
  deductions?: number;
  net_payable_amount?: number;
  payment_date?: string;
  payment_ref_utr?: string;
  payment_remarks?: string;
  created_at: string;
  can_reveal?: boolean;
}

export type EventRevenueSource =
  | 'registration_fee'
  | 'sponsorship'
  | 'participation_fee'
  | 'event_collection'
  | 'other_income';

export type EventRevenueStatus = 'submitted' | 'verified' | 'returned';

export interface EventRevenue {
  id: string;
  nfa_id: string;
  department_id?: string | null;
  revenue_source: EventRevenueSource;
  description: string;
  amount: number;
  collection_date: string;
  payment_method?: string;
  receipt_url?: string;
  receipt_filename?: string;
  remarks?: string;
  submitted_by: string;
  submitted_by_name?: string;
  status: EventRevenueStatus;
  verified_by?: string;
  verified_by_name?: string;
  verified_at?: string;
  verification_remarks?: string;
  created_at: string;
  updated_at: string;
}

export interface EventRevenueReminder {
  id: string;
  nfa_id: string;
  sent_to: string;
  sent_to_email: string;
  sent_at: string;
  status: 'mock_delivered' | 'delivered' | 'failed';
  error_message?: string;
  created_at?: string;
}

export interface UserMfaSetting {
  user_id: string;
  mfa_enabled: boolean;
  secret?: string;
  recovery_codes?: string[];
  enrolled_at?: string;
  last_verified_at?: string;
  created_at: string;
  updated_at: string;
}

export type SecuritySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type SecurityLogStatus = 'SUCCESS' | 'FAILURE' | 'BLOCKED' | 'FLAGGED';

export interface SecurityAuditLog {
  id: string;
  event_type: string;
  severity: SecuritySeverity;
  user_id?: string;
  user_role?: string;
  ip_address?: string;
  user_agent?: string;
  resource?: string;
  action?: string;
  status: SecurityLogStatus;
  details?: Record<string, any>;
  request_id?: string;
  created_at: string;
}

export type SecurityAlertStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED' | 'FALSE_POSITIVE';

export interface SecurityAlert {
  id: string;
  incident_ref: string;
  alert_type: string;
  severity: SecuritySeverity;
  affected_component: string;
  description: string;
  action_taken: string;
  recommended_action: string;
  status: SecurityAlertStatus;
  acknowledged_by?: string;
  acknowledged_at?: string;
  resolved_by?: string;
  resolved_at?: string;
  created_at: string;
  updated_at: string;
}

export interface EmergencyModeState {
  id: string;
  is_active: boolean;
  activated_by?: string;
  activated_at?: string;
  reason?: string;
  restrictions?: Record<string, boolean>;
  updated_at: string;
}

export interface DB {
  users: User[];
  departments: Department[];
  schools?: School[];
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
  mock_emails?: MockEmail[];
  resource_person_bank_details?: ResourcePersonBankDetail[];
  purchase_invoices?: PurchaseInvoice[];
  event_revenues?: EventRevenue[];
  event_revenue_reminders?: EventRevenueReminder[];
  revoked_tokens?: { token_hash: string; expires_at: number }[];
  user_mfa_settings?: UserMfaSetting[];
  security_audit_logs?: SecurityAuditLog[];
  security_alerts?: SecurityAlert[];
  emergency_mode_state?: EmergencyModeState;
}
