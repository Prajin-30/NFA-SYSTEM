import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { store } from './store.js';
import type { Role } from './types.js';

/**
 * Seed data reconstructed from the two reference files provided:
 *  - ERP_ADSE_NFA_Final.docx            -> the ERP Server Infrastructure NFA (first test case)
 *  - CSE_Financial_Budget_2026-2027.xlsx -> department budget structure & real category totals
 *
 * Category totals below are the actual sums from the "Revenue Expenditures" sheet
 * (5 category groups totalling Rs. 3,11,38,700 = the sheet's own grand total).
 */

async function seed() {
  if (store.data.departments.length > 0) {
    console.log('DB already seeded. Delete data/db.json to reseed.');
    return;
  }

  await store.transact((db) => {
    // ---- Departments (from the workbook + NFA: ADSE raised the NFA on behalf of the School of Engineering; CSE is the budget workbook owner) ----
    const deptCSE = { id: uuid(), name: 'Computer Science and Engineering', code: 'CSE', hod_name: 'Dr M Balamurugan', dean_name: 'Dr Raghunandhankumar', faculty_name: '', associate_dean_name: 'Dr. Mary Anita E A', director_name: 'Fr. Jiby Jose', finance_officer_name: 'Fr. Shijin P J' };
    const deptADSE = { id: uuid(), name: 'Applied Data Science and Engineering', code: 'ADSE', hod_name: 'Dr Michael Moses T', dean_name: 'Dr Mary Anita E A', faculty_name: 'Dr. Babu Kumar S', associate_dean_name: 'Dr. Mary Anita E A', director_name: 'Fr. Jiby Jose', finance_officer_name: 'Fr. Shijin P J' };
    db.departments.push(deptCSE, deptADSE);

    // ---- Financial year ----
    const fy2627 = { id: uuid(), label: '2026-27', is_active: true };
    db.financial_years.push(fy2627);

    // ---- Budget types (from workbook sheet names) ----
    const btRevExp = { id: uuid(), name: 'Revenue Expenditure' };
    const btCapex = { id: uuid(), name: 'CAPEX' };
    const btEarnings = { id: uuid(), name: 'Revenue / Earnings' };
    db.budget_types.push(btRevExp, btCapex, btEarnings);

    // ---- Budget categories under Revenue Expenditure (real group headers from the sheet) ----
    const categories = [
      { name: 'External Remuneration', allocated: 6530000 },
      { name: 'Staff Development & Welfare', allocated: 2585000 },
      { name: 'Student Related Expenses', allocated: 13978700 }, // includes the ERP NFA line item, Rs.1,17,700
      { name: 'Administrative Expenses', allocated: 745000 },
      { name: 'Others', allocated: 7300000 },
    ].map((c) => ({ id: uuid(), budget_type_id: btRevExp.id, name: c.name, allocated: c.allocated }));
    db.budget_categories.push(...categories.map(({ allocated, ...c }) => c));

    // ---- Department budgets (FY 2026-27) ----
    // CSE's category allocations come straight from the provided workbook. "approved_amount" for
    // CSE starts pre-populated with everything from the workbook EXCEPT the ERP NFA line
    // (Rs.1,17,700), because that item is our live NFA workflow test case below and must flow
    // through NFA -> approval -> auto-update, not be pre-baked in.
    // ADSE (the department that actually raised the ERP NFA) is allocated the same category
    // structure with a smaller, independent allocation - the system supports any number of
    // departments, each with their own figures; only one workbook was supplied as reference.
    const studentRelatedCat = categories.find((c) => c.name === 'Student Related Expenses')!;
    for (const c of categories) {
      const preApproved = c.name === 'Student Related Expenses' ? c.allocated - 117700 : c.allocated;
      db.department_budgets.push({
        id: uuid(),
        department_id: deptCSE.id,
        financial_year_id: fy2627.id,
        budget_category_id: c.id,
        allocated_amount: c.allocated,
        approved_amount: preApproved,
        pending_amount: 0,
        revised_amount: 0,
      });
    }
    const adseScale = 0.2; // ADSE is a newer/smaller department; independent allocation for demo purposes
    for (const c of categories) {
      const allocated = Math.round(c.allocated * adseScale);
      const preApproved = c.name === 'Student Related Expenses' ? Math.max(0, allocated - 117700) : Math.round(allocated * 0.5);
      db.department_budgets.push({
        id: uuid(),
        department_id: deptADSE.id,
        financial_year_id: fy2627.id,
        budget_category_id: c.id,
        allocated_amount: allocated,
        approved_amount: preApproved,
        pending_amount: 0,
        revised_amount: 0,
      });
    }

    // ---- Users (one per role, password = "password123" for all, for demo login) ----
    const pw = bcrypt.hashSync('password123', 8);
    const mkUser = (name: string, email: string, role: Role, department_id: string | null) => ({
      id: uuid(), name, email, password_hash: pw, role, department_id, created_at: new Date().toISOString(),
    });
    const student = mkUser('Ananya Rao', 'student@christ.edu', 'student', deptCSE.id);
    const faculty = mkUser('Dr Arul V', 'faculty@christ.edu', 'faculty', deptADSE.id);
    const hod = mkUser('Dr Michael Moses T', 'hod@christ.edu', 'hod', deptADSE.id);
    const dean = mkUser('Dr Mary Anita E A', 'dean@christ.edu', 'dean', null);
    const director = mkUser('Fr Jiby Jose', 'director@christ.edu', 'director', null);
    const finance = mkUser('Fr Shijin P J', 'finance@christ.edu', 'finance', null);
    const superAdmin = mkUser('System Admin', 'admin@christ.edu', 'super_admin', null);
    const itAdmin = mkUser('IT Administrator', 'itadmin@christ.edu', 'it_admin', deptADSE.id);
    db.users.push(student, faculty, hod, dean, director, finance, superAdmin, itAdmin);

    // ---- Seed Project + NFA: the ERP Server Infrastructure NFA (first test case, from the .docx) ----
    const project = {
      id: uuid(),
      name: 'Server Infrastructure Plan for School of Engineering ERP System',
      department_id: deptADSE.id,
      financial_year_id: fy2627.id,
      budget_category_id: studentRelatedCat.id,
      created_by: faculty.id,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };
    db.projects.push(project);

    const nfa = {
      id: uuid(),
      ref_no: 'NFA/CU/SoET/ADSE/2026-27/004',
      project_id: project.id,
      department_id: deptADSE.id,
      financial_year_id: fy2627.id,
      budget_category_id: studentRelatedCat.id,
      title: 'Server Infrastructure Plan for School of Engineering ERP System',
      purpose:
        "The Department of ADSE seeks approval to design and implement a centralized Server Infrastructure Plan for the School of Engineering's ERP system, serving approx. 2,000 students and faculty across all eight departments.",
      description:
        'Infrastructure deployed on Ubuntu Server 22.04 LTS, secured through Role-Based Access Control (RBAC). Executed with technical support from the department IT Administrator; no external resource person required.',
      justification:
        'Replaces fragmented, manual record-keeping with a scalable, reliable, and secure digital system that improves administrative efficiency across the institution.',
      sdgs: 'SDG 4 - Quality Education; SDG 9 - Industry, Innovation and Infrastructure',
      total_amount: 117700,
      status: 'draft' as const,
      created_by: faculty.id,
      submitted_by_name: 'Dr Arul V, Asst. Professor, Dept. of ADSE',
      hod_name: 'Dr Michael Moses T, HOD / Coordinator, Dept. of ADSE',
      date: '2026-08-01',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.nfas.push(nfa);

    const items = [
      ['Server Hardware (8-core CPU, 32 GB RAM, ECC Motherboard, RAID)', '1 Unit', 90000],
      ['Storage - 2 TB SSD', '1 Unit', 5500],
      ['UPS (Power Backup)', '1 Unit', 11500],
      ['Network Setup (Gigabit Ethernet, Switches, Cabling)', '1 Set', 7500],
      ['Backup Solution', '1 Set', 2000],
      ['Domain (Annual)', '1 Year', 1200],
    ];
    items.forEach(([particulars, quantity, amount], i) => {
      db.nfa_items.push({
        id: uuid(),
        nfa_id: nfa.id,
        sl_no: i + 1,
        particulars: particulars as string,
        quantity: quantity as string,
        amount: amount as number,
      });
    });

    console.log('Seeded departments:', db.departments.map((d) => d.code));
    console.log('Seeded users (password123 for all):');
    db.users.forEach((u) => console.log(`  ${u.role.padEnd(12)} ${u.email}`));
    console.log('Seeded ERP NFA (status: draft) ref', nfa.ref_no, 'total Rs.', nfa.total_amount);
  });
}

seed().then(() => process.exit(0));
