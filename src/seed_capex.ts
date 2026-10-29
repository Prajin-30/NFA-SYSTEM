import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'db.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

// Budget Type IDs from db.json:
// CAPEX: ecdfc569-50b7-4242-adf2-102a8a3ff266
// Revenue / Earnings: 53aa7a65-a652-4e86-beef-c7acf806a48c
const capexTypeId = 'ecdfc569-50b7-4242-adf2-102a8a3ff266';
const earnTypeId = '53aa7a65-a652-4e86-beef-c7acf806a48c';

const newCategories = [
  // CAPEX Categories
  { id: uuid(), budget_type_id: capexTypeId, name: 'CAPEX: Computing & Servers', allocated: 9110000 },
  { id: uuid(), budget_type_id: capexTypeId, name: 'CAPEX: Laboratory Infrastructure & Furniture', allocated: 8000000 },
  { id: uuid(), budget_type_id: capexTypeId, name: 'CAPEX: Software Licenses & Subscriptions', allocated: 1510000 },
  { id: uuid(), budget_type_id: capexTypeId, name: 'CAPEX: Specialized Equipment & IoT', allocated: 1100000 },

  // Revenue / Earnings
  { id: uuid(), budget_type_id: earnTypeId, name: 'Research Grants & External Funding', allocated: 2500000 },
  { id: uuid(), budget_type_id: earnTypeId, name: 'Industrial Consultancy & Training', allocated: 1000000 },
  { id: uuid(), budget_type_id: earnTypeId, name: 'Academic Events, Fests & Conferences', allocated: 350000 }
];

const newSubcats = [
  // Computing & Servers
  { catName: 'CAPEX: Computing & Servers', name: 'GPU Computers - Research Lab (RTX 5060, i7 14th Gen)', allocated: 800000 },
  { catName: 'CAPEX: Computing & Servers', name: 'Cyber Security Lab Computers (60 Systems)', allocated: 7800000 },
  { catName: 'CAPEX: Computing & Servers', name: 'DELL VM Server PowerEdge R550 Rack Server', allocated: 510000 },

  // Lab Infrastructure
  { catName: 'CAPEX: Laboratory Infrastructure & Furniture', name: 'Cyber Security Lab Furniture & Networking Components', allocated: 8000000 },

  // Software & Licenses
  { catName: 'CAPEX: Software Licenses & Subscriptions', name: 'Canva Team Subscription', allocated: 10000 },
  { catName: 'CAPEX: Software Licenses & Subscriptions', name: '100 Users Firewall Security Subscription', allocated: 200000 },
  { catName: 'CAPEX: Software Licenses & Subscriptions', name: 'Microsoft Purview DLP + Security Onion NDR SIEM IDS', allocated: 500000 },
  { catName: 'CAPEX: Software Licenses & Subscriptions', name: 'Encase Forensics Suite', allocated: 800000 },

  // Specialized Equipment & IoT
  { catName: 'CAPEX: Specialized Equipment & IoT', name: 'Quadcopter Assembly & Humanoid Bots', allocated: 35000 },
  { catName: 'CAPEX: Specialized Equipment & IoT', name: 'RFID NFC Reader Writer & Sensors', allocated: 5000 },
  { catName: 'CAPEX: Specialized Equipment & IoT', name: 'C-DAC IoT Controller Module', allocated: 160000 },
  { catName: 'CAPEX: Specialized Equipment & IoT', name: 'IoT Academic Lab Components & Sensors', allocated: 800000 },
  { catName: 'CAPEX: Specialized Equipment & IoT', name: 'Advantech Industry Oriented Lab Components', allocated: 100000 },

  // Revenue / Earnings Subcategories
  { catName: 'Research Grants & External Funding', name: 'External Research Grants (DST, DBT, AICTE, ISRO)', allocated: 2500000 },
  { catName: 'Industrial Consultancy & Training', name: 'Industrial Consultancy Projects', allocated: 1000000 },
  { catName: 'Academic Events, Fests & Conferences', name: 'International Conference & FDP Registrations', allocated: 200000 },
  { catName: 'Academic Events, Fests & Conferences', name: 'Value Added Courses & Specializations', allocated: 150000 }
];

// Add categories if not existing
newCategories.forEach(c => {
  if (!db.budget_categories.some(ex => ex.name === c.name)) {
    db.budget_categories.push({ id: c.id, budget_type_id: c.budget_type_id, name: c.name });
  }
});

// Add subcategories
newSubcats.forEach(s => {
  const cat = db.budget_categories.find(c => c.name === s.catName);
  if (cat && !db.budget_subcategories.some(ex => ex.name === s.name)) {
    db.budget_subcategories.push({
      id: uuid(),
      budget_category_id: cat.id,
      name: s.name,
      allocated_amount: s.allocated,
      approved_amount: 0,
      pending_amount: 0
    });
  }
});

// Seed department_budgets for these new categories across departments for active FY
const activeFy = db.financial_years.find(f => f.is_active) || db.financial_years[0];
db.departments.forEach(dept => {
  newCategories.forEach(cat => {
    const existingBudget = db.department_budgets.find(b => b.department_id === dept.id && b.financial_year_id === activeFy.id && b.budget_category_id === cat.id);
    if (!existingBudget) {
      const scale = dept.code === 'CSE' ? 1 : 0.2;
      db.department_budgets.push({
        id: uuid(),
        department_id: dept.id,
        financial_year_id: activeFy.id,
        budget_category_id: cat.id,
        allocated_amount: Math.round(cat.allocated * scale),
        approved_amount: 0,
        pending_amount: 0,
        revised_amount: 0
      });
    }
  });
});

fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log('Successfully seeded CAPEX & Earnings categories and subcategories into db.json');
