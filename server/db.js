const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const QRCode = require('qrcode');
const payroll = require('./payroll');
const plans = require('./plans');
const { seed } = require('./seed');

const VERSION = '1';
const DB_PATH = path.join(__dirname, '..', 'data', 's1hr.sqlite');
const BGV_STEPS = [
  'Backend call coordination',
  'Residential address verification',
  'Documents & certificate authentication',
  'Previous employment verification',
  'Equifax credit verification'
];
const PIPELINE = ['Submitted', 'Viewed', 'Processing', 'Verified', 'Final Report'];
const HIRING = ['Direct', 'Assigned', 'Sourcing company'];
const EXPENSE_CATEGORIES = ['Travel', 'E-bike', 'Food', 'Medical', 'Mobile', 'Hotel', 'Fuel', 'Conveyance', 'Internet', 'Other'];
const TRAVEL_MODES = ['Cab', 'Train', 'Flight', 'Bus', 'Own vehicle'];
const OPEN_CLAIMS = ['Pending', 'Pending company', 'Pending finance', 'Ready'];
const LOCATION_KINDS = ['Office', 'Site', 'Unit', 'Floor'];

let database;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function clip(value, length) {
  return String(value ?? '').trim().slice(0, length);
}

function parse(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function emailOk(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function kolkataStamp(date = new Date()) {
  const text = date.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
  const [day, time] = text.split(' ');
  return { date: day, time: time.slice(0, 5), iso: date.toISOString() };
}

function minutes(hhmm) {
  const [hour, minute] = String(hhmm || '00:00').split(':').map(Number);
  return (hour * 60) + minute;
}

function rating(target, achieved) {
  if (!target) return 'Not set';
  const pct = (achieved / target) * 100;
  if (pct >= 95) return 'A+ Top performer';
  if (pct >= 85) return 'A Stable';
  if (pct >= 70) return 'B Watch';
  return 'C Deficit';
}

function transaction(fn) {
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) { /* transaction already closed */ }
    throw error;
  }
}

function nextNumber(prefix) {
  database.prepare(`INSERT INTO counters(prefix, value) VALUES(?, 1)
    ON CONFLICT(prefix) DO UPDATE SET value = value + 1`).run(prefix);
  const row = database.prepare('SELECT value FROM counters WHERE prefix = ?').get(prefix);
  return `APP-${prefix}-2026-${String(row.value).padStart(4, '0')}`;
}

function patchRow(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  database.prepare(`UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((key) => data[key]), id);
}

function notify(audience, title, message) {
  database.prepare(`INSERT INTO notifications (id, audience, title, message, created_at, read_flag)
    VALUES (?, ?, ?, ?, ?, 0)`).run(crypto.randomUUID(), audience, clip(title, 140), clip(message, 500), new Date().toISOString());
}

const messageListeners = new Set();

function onMessage(fn) {
  messageListeners.add(fn);
  return () => messageListeners.delete(fn);
}

function notifyMessage(msg) {
  for (const fn of messageListeners) {
    try { fn(msg); } catch (_) {}
  }
}

function insertMessage({ channel, clientId = null, senderId, senderName, senderRole, body }) {
  const id = crypto.randomUUID();
  const created = new Date().toISOString();
  database.prepare(`INSERT INTO messages (id, channel, client_id, sender_id, sender_name, sender_role, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, channel, clientId, senderId, senderName, senderRole, clip(body, 2000), created);
  const msg = { id, channel, clientId, senderId, senderName, senderRole, body: clip(body, 2000), createdAt: created };
  notifyMessage(msg);
  return msg;
}

function audiencesFor(user) {
  if (user.role === 'admin') return ['admin', 'all'];
  if (user.role === 'client') return ['all', `client:${user.clientId}`];
  return ['all', `employee:${user.employeeId}`];
}

function loadUser(row) {
  const hrAdmin = row.role === 'hradmin';
  let employeeId = row.employee_id || '';
  if (!employeeId && row.email) {
    const emp = database.prepare('SELECT id FROM employees WHERE lower(email) = lower(?)').get(row.email);
    if (emp) employeeId = emp.id;
  }
  return {
    id: row.id,
    role: hrAdmin ? 'client' : row.role,
    isHrAdmin: hrAdmin,
    email: row.email,
    name: row.name,
    phone: row.phone || '',
    title: row.title || '',
    clientId: row.client_id || '',
    employeeId,
    active: !!row.active,
    statusText: row.status_text || '',
    companyName: row.company_name || ''
  };
}

function shapeBranch(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    city: row.city,
    address: row.address,
    staffCount: row.staff_count
  };
}

function shapeClient(row) {
  const employeeCount = database.prepare('SELECT COUNT(*) AS c FROM employees WHERE client_id = ?').get(row.id).c;
  const achieved = Number(row.score_achieved) || 0;
  const target = Number(row.score_target) || 0;
  return {
    id: row.id,
    applicationNumber: row.application_number,
    companyName: row.company_name,
    businessType: row.business_type,
    officialMail: row.official_mail,
    phone: row.phone,
    website: row.website || '',
    address: row.address,
    status: row.status,
    consent: !!row.consent,
    totalBudget: Number(row.total_budget) || 0,
    positionBudgets: parse(row.position_budgets, []),
    storageUsedMb: Number(row.storage_used_mb) || 0,
    storageLimitMb: Number(row.storage_limit_mb) || 0,
    scoreTarget: target,
    scoreAchieved: achieved,
    scoreNotes: row.score_notes || '',
    rating: rating(target, achieved),
    adSlots: row.ad_slots,
    documents: parse(row.documents, {}),
    onboardedAt: row.onboarded_at,
    onboarding: clientOnboarding(row),
    planDetail: plans.resolve(clientOnboarding(row).plan),
    branches: database.prepare('SELECT * FROM branches WHERE client_id = ? ORDER BY name').all(row.id).map(shapeBranch),
    employeeCount,
    clientUsers: database.prepare("SELECT COUNT(*) AS c FROM users WHERE client_id = ? AND role IN ('client','hradmin') AND active = 1").get(row.id).c,
    admins: database.prepare("SELECT id, name, email, title, active, status_text FROM users WHERE client_id = ? AND role = 'hradmin' ORDER BY name").all(row.id).map((person) => ({
      id: person.id, name: person.name, email: person.email, title: person.title || '', active: !!person.active, statusText: person.status_text || ''
    }))
  };
}

const employeeSql = `SELECT e.*, c.company_name, b.name AS branch_name, b.city AS branch_city,
  s.name AS shift_name, s.start_time, s.end_time,
  loc.name AS location_name, loc.kind AS location_kind
  FROM employees e
  JOIN clients c ON c.id = e.client_id
  JOIN branches b ON b.id = e.branch_id
  JOIN shifts s ON s.id = e.shift_id
  LEFT JOIN locations loc ON loc.id = e.location_id`;

function shapeEmployee(row) {
  const payrollData = parse(row.payroll, {});
  return {
    id: row.id,
    employeeCode: row.employee_code,
    applicationNumber: row.application_number,
    clientId: row.client_id,
    companyName: row.company_name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    branchCity: row.branch_city,
    locationId: row.location_id || '',
    locationName: row.location_name || '',
    locationKind: row.location_kind || '',
    fullName: row.full_name,
    email: row.email,
    phone: row.phone || '',
    emergencyName: row.emergency_name || '',
    emergencyPhone: row.emergency_phone || '',
    photoUrl: row.photo_url || '',
    department: row.department,
    levelName: row.level_name,
    roleTitle: row.role_title,
    shiftId: row.shift_id,
    shiftName: row.shift_name,
    shiftStart: row.start_time,
    shiftEnd: row.end_time,
    reportingManager: row.reporting_manager || '',
    hiringSource: row.hiring_source,
    sourceCompany: row.source_company || '',
    reputedCompany: row.reputed_company || '',
    bgvStatus: row.bgv_status,
    hasLogin: !!row.has_login,
    payroll: payrollData,
    pay: applyLocationPay(row, payroll.summarize(payrollData)),
    statutory: parse(row.statutory, {}),
    documents: parse(row.documents, {}),
    warnings: parse(row.warnings, []),
    status: row.status,
    joinedOn: row.joined_on,
    teamId: row.team_id || '',
    deskRole: row.desk_role || '',
    leaveBalance: parse(row.leave_balance, { casual: 12, sick: 8, earned: 15 }),
    workflow: parse(row.workflow, null),
    exitCase: parse(row.exit_case, {}),
    custom: parse(row.custom_data, {})
  };
}

const PROCESS = ['Onboarding', 'Probation', 'Confirmation', 'Transfer', 'Promotion', 'Separation', 'Exit'];

function blankWorkflow(date) {
  return {
    current: 'Onboarding',
    steps: PROCESS.map((name, index) => ({
      name,
      status: index === 0 ? 'In progress' : 'Pending',
      date: index === 0 ? date : '',
      notes: index === 0 ? 'Joined and waiting for onboarding checks.' : '',
      by: '',
      fromValue: '',
      toValue: ''
    }))
  };
}

function assertCompanyDesk(user) {
  if (user.role === 'employee') fail(403, 'This stays with the company desk and the administrator');
}

function shapeAttendance(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    employeeCode: row.employee_code,
    clientId: row.client_id,
    companyName: row.company_name,
    branchName: row.branch_name || '',
    locationId: row.location_id || '',
    locationName: row.location_name || '',
    locationKind: row.location_kind || '',
    workDate: row.work_date,
    shiftName: row.shift_name,
    inTime: row.in_time || '',
    outTime: row.out_time || '',
    inLat: row.in_lat,
    inLng: row.in_lng,
    outLat: row.out_lat,
    outLng: row.out_lng,
    locationNote: row.location_note || '',
    status: row.status,
    penalty: Number(row.penalty) || 0,
    penaltyRemarks: row.penalty_remarks || '',
    otHours: Number(row.ot_hours) || 0,
    otAmount: Number(row.ot_amount) || 0,
    lopDays: Number(row.lop_days) || 0,
    flag: row.flag,
    mode: row.mode || 'Web'
  };
}

function shapeActivity(row) {
  return {
    id: row.id,
    applicationNumber: row.application_number,
    type: row.type,
    clientId: row.client_id || '',
    companyName: row.company_name || 'S1 HR Solution',
    title: row.title,
    description: row.description || '',
    payload: parse(row.payload, {}),
    stage: row.stage,
    result: row.result || '',
    active: !!row.active,
    raisedBy: row.raised_by,
    raisedByName: row.raised_by_name,
    raisedAt: row.raised_at,
    updatedAt: row.updated_at
  };
}

function mustClient(id) {
  const row = database.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!row) fail(404, 'Client company was not found');
  return shapeClient(row);
}

function mustEmployee(id) {
  const row = database.prepare(`${employeeSql} WHERE e.id = ?`).get(id);
  if (!row) fail(404, 'Employee was not found');
  return shapeEmployee(row);
}

function assertClient(user, clientId) {
  if (user.role === 'admin') return;
  if (user.clientId && user.clientId === clientId) return;
  fail(403, 'This company is outside your desk');
}

function assertEmployee(user, employee) {
  if (user.role === 'admin') return;
  if (user.role === 'client' && user.clientId === employee.clientId) return;
  if (user.role === 'employee' && user.employeeId === employee.id) return;
  fail(403, 'This employee record is outside your desk');
}

function assertAdmin(user) {
  if (user.role !== 'admin') fail(403, 'Only the administrator can do that');
}

function migrate(db) {
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE counters (prefix TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT NOT NULL, levels TEXT NOT NULL);
    CREATE TABLE shifts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL
    );
    CREATE TABLE statutory_links (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, details TEXT NOT NULL
    );
    CREATE TABLE clients (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      company_name TEXT NOT NULL,
      business_type TEXT NOT NULL,
      official_mail TEXT NOT NULL,
      phone TEXT NOT NULL,
      website TEXT,
      address TEXT NOT NULL,
      status TEXT NOT NULL,
      consent INTEGER NOT NULL,
      total_budget REAL NOT NULL DEFAULT 0,
      position_budgets TEXT NOT NULL,
      storage_used_mb REAL NOT NULL DEFAULT 0,
      storage_limit_mb REAL NOT NULL DEFAULT 1000,
      score_target REAL NOT NULL DEFAULT 100,
      score_achieved REAL NOT NULL DEFAULT 0,
      score_notes TEXT,
      ad_slots INTEGER NOT NULL DEFAULT 2,
      documents TEXT NOT NULL,
      onboarded_at TEXT NOT NULL
    );
    CREATE TABLE branches (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      address TEXT NOT NULL,
      staff_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE employees (
      id TEXT PRIMARY KEY,
      employee_code TEXT NOT NULL UNIQUE,
      application_number TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL REFERENCES clients(id),
      branch_id TEXT NOT NULL REFERENCES branches(id),
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      emergency_name TEXT,
      emergency_phone TEXT,
      photo_url TEXT,
      department TEXT NOT NULL,
      level_name TEXT NOT NULL,
      role_title TEXT NOT NULL,
      shift_id TEXT NOT NULL REFERENCES shifts(id),
      reporting_manager TEXT,
      hiring_source TEXT NOT NULL,
      source_company TEXT,
      reputed_company TEXT,
      bgv_status TEXT NOT NULL,
      has_login INTEGER NOT NULL DEFAULT 0,
      payroll TEXT NOT NULL,
      statutory TEXT NOT NULL,
      documents TEXT NOT NULL,
      warnings TEXT NOT NULL,
      status TEXT NOT NULL,
      joined_on TEXT NOT NULL
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      title TEXT,
      client_id TEXT REFERENCES clients(id),
      employee_id TEXT REFERENCES employees(id),
      active INTEGER NOT NULL DEFAULT 1,
      status_text TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL
    );
    CREATE TABLE attendance (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL REFERENCES employees(id),
      client_id TEXT NOT NULL REFERENCES clients(id),
      work_date TEXT NOT NULL,
      shift_name TEXT,
      in_time TEXT,
      out_time TEXT,
      in_lat REAL,
      in_lng REAL,
      out_lat REAL,
      out_lng REAL,
      location_note TEXT,
      status TEXT NOT NULL,
      penalty REAL NOT NULL DEFAULT 0,
      penalty_remarks TEXT,
      ot_hours REAL NOT NULL DEFAULT 0,
      ot_amount REAL NOT NULL DEFAULT 0,
      lop_days REAL NOT NULL DEFAULT 0,
      flag TEXT NOT NULL,
      UNIQUE(employee_id, work_date)
    );
    CREATE TABLE leaves (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      employee_id TEXT NOT NULL REFERENCES employees(id),
      client_id TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      leave_type TEXT NOT NULL,
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      approver TEXT,
      raised_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE shift_swaps (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      employee_id TEXT NOT NULL REFERENCES employees(id),
      client_id TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      from_shift TEXT NOT NULL,
      to_shift TEXT NOT NULL,
      swap_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      approver TEXT,
      raised_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE reimbursements (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      employee_id TEXT NOT NULL REFERENCES employees(id),
      client_id TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      receipt_url TEXT,
      status TEXT NOT NULL,
      remarks TEXT,
      raised_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE applicants (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      position TEXT NOT NULL,
      source TEXT NOT NULL,
      source_company TEXT,
      stage TEXT NOT NULL,
      bgv_required INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      raised_at TEXT NOT NULL
    );
    CREATE TABLE activities (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      client_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      payload TEXT NOT NULL,
      stage TEXT NOT NULL,
      result TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      raised_by TEXT,
      raised_by_name TEXT,
      raised_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      client_id TEXT,
      sender_id TEXT,
      sender_name TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      raised_by TEXT,
      raised_by_name TEXT NOT NULL,
      client_id TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      raised_at TEXT NOT NULL
    );
    CREATE TABLE ticket_replies (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE posh_alarms (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      raised_by TEXT,
      raised_by_name TEXT NOT NULL,
      client_id TEXT,
      employee_id TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      raised_at TEXT NOT NULL
    );
    CREATE TABLE leads (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      business_type TEXT,
      priority TEXT NOT NULL,
      assigned_to TEXT,
      status TEXT NOT NULL,
      notes TEXT,
      next_call_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      assignee TEXT,
      client_id TEXT,
      due_date TEXT,
      performance_score REAL,
      photo_url TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE templates (
      id TEXT PRIMARY KEY,
      owner_role TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      body TEXT,
      watermark TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      audience TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_flag INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_emp_client ON employees(client_id);
    CREATE INDEX idx_att_date ON attendance(work_date);
    CREATE INDEX idx_act_type ON activities(type);
    CREATE INDEX idx_msg_channel ON messages(channel);
  `);
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_events (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL REFERENCES employees(id),
      kind TEXT NOT NULL,
      event_date TEXT NOT NULL,
      notes TEXT,
      from_value TEXT,
      to_value TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      asset_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      serial_no TEXT,
      status TEXT NOT NULL,
      client_id TEXT REFERENCES clients(id),
      employee_id TEXT REFERENCES employees(id),
      notes TEXT,
      issued_on TEXT,
      returned_on TEXT
    );
    CREATE TABLE IF NOT EXISTS holidays (
      id TEXT PRIMARY KEY,
      holiday_date TEXT NOT NULL,
      name TEXT NOT NULL,
      client_id TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL REFERENCES clients(id),
      title TEXT NOT NULL,
      description TEXT,
      openings INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const columns = db.prepare('PRAGMA table_info(employees)').all().map((row) => row.name);
  if (!columns.includes('leave_balance')) {
    db.exec(`ALTER TABLE employees ADD COLUMN leave_balance TEXT NOT NULL DEFAULT '{"casual":12,"sick":8,"earned":15}'`);
  }
  const again = db.prepare('PRAGMA table_info(employees)').all().map((row) => row.name);
  if (!again.includes('workflow')) db.exec(`ALTER TABLE employees ADD COLUMN workflow TEXT NOT NULL DEFAULT ''`);
  if (!again.includes('exit_case')) db.exec(`ALTER TABLE employees ADD COLUMN exit_case TEXT NOT NULL DEFAULT ''`);
  const unnamed = db.prepare(`SELECT id, joined_on, status, workflow FROM employees WHERE workflow IS NULL OR workflow = ''`).all();
  unnamed.forEach((person) => {
    const events = db.prepare('SELECT kind FROM lifecycle_events WHERE employee_id = ?').all(person.id).map((row) => row.kind);
    const names = ['Onboarding', 'Probation', 'Confirmation', 'Transfer', 'Promotion', 'Separation', 'Exit'];
    const completed = new Set(['Onboarding']);
    if (events.includes('Probation') || events.includes('Confirmation') || person.status === 'Active') completed.add('Probation');
    if (events.includes('Confirmation') || person.status === 'Active') completed.add('Confirmation');
    if (events.includes('Transfer')) completed.add('Transfer');
    if (events.includes('Promotion')) completed.add('Promotion');
    if (events.includes('Separation') || person.status === 'Separated') completed.add('Separation');
    if (events.includes('Full and final') || person.status === 'Full and final') {
      completed.add('Separation');
      completed.add('Exit');
    }
    const steps = names.map((name) => ({
      name,
      status: completed.has(name) ? 'Completed' : 'Pending',
      date: completed.has(name) ? person.joined_on : '',
      notes: '',
      by: '',
      fromValue: '',
      toValue: ''
    }));
    const current = [...steps].reverse().find((step) => step.status === 'Completed');
    db.prepare('UPDATE employees SET workflow = ? WHERE id = ?').run(JSON.stringify({
      current: current ? current.name : 'Onboarding',
      steps
    }), person.id);
  });
  if (!db.prepare('SELECT COUNT(*) AS c FROM holidays').get().c) {
    const rows = [
      ['hol_1', '2026-10-02', 'Gandhi Jayanti', null],
      ['hol_2', '2026-10-20', 'Dussehra', null],
      ['hol_3', '2026-11-08', 'Diwali', 'cli_nexus']
    ];
    const insert = db.prepare('INSERT INTO holidays (id, holiday_date, name, client_id) VALUES (?, ?, ?, ?)');
    rows.forEach((row) => insert.run(...row));
  }
  if (!db.prepare('SELECT COUNT(*) AS c FROM assets').get().c && db.prepare('SELECT id FROM employees WHERE id = ?').get('emp_aarav')) {
    const insert = db.prepare(`INSERT INTO assets (id, asset_code, name, category, serial_no, status, client_id, employee_id, notes, issued_on, returned_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('ast_1', 'AST-2026-0001', 'Dell Latitude 5440', 'Laptop', 'DL5440-18821', 'Allocated', 'cli_nexus', 'emp_aarav', 'Issued at Mumbai headquarters', '2026-01-20', '');
    insert.run('ast_2', 'AST-2026-0002', 'Access card · Airoli', 'Access card', 'NX-AARAV', 'Allocated', 'cli_nexus', 'emp_aarav', 'Site access card', '2026-01-20', '');
    insert.run('ast_3', 'AST-2026-0003', 'Handheld scanner', 'Device', 'SCN-441', 'In store', 'cli_zenith', null, 'Available for the Bhiwandi hub', '', '');
  }
  if (!db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c && db.prepare('SELECT id FROM clients WHERE id = ?').get('cli_nexus')) {
    db.prepare(`INSERT INTO jobs (id, application_number, client_id, title, description, openings, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'job_1', 'APP-JOB-2026-0001', 'cli_nexus', 'Fullstack engineer',
      'Bellandur lab. Cloud and fullstack delivery for retained client work.', 2, 'Open', '2026-10-05T06:00:00.000Z'
    );
  }
  if (!db.prepare('SELECT COUNT(*) AS c FROM lifecycle_events').get().c && db.prepare('SELECT id FROM employees WHERE id = ?').get('emp_aarav')) {
    const insert = db.prepare(`INSERT INTO lifecycle_events (id, employee_id, kind, event_date, notes, from_value, to_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('life_1', 'emp_aarav', 'Probation', '2026-01-20', 'Joined on the general shift at Mumbai headquarters.', '', 'Probation', '2026-01-20T05:00:00.000Z');
    insert.run('life_2', 'emp_aarav', 'Confirmation', '2026-07-20', 'Confirmed after six months.', 'Probation', 'Confirmed', '2026-07-20T05:00:00.000Z');
  }
  db.prepare(`INSERT INTO counters(prefix, value) VALUES('AST', 3)
    ON CONFLICT(prefix) DO UPDATE SET value = CASE WHEN value < 3 THEN 3 ELSE value END`).run();
  db.prepare(`INSERT INTO counters(prefix, value) VALUES('JOB', 1)
    ON CONFLICT(prefix) DO UPDATE SET value = CASE WHEN value < 1 THEN 1 ELSE value END`).run();
  const shiftCols = db.prepare('PRAGMA table_info(shifts)').all().map((row) => row.name);
  if (!shiftCols.includes('client_id')) db.exec('ALTER TABLE shifts ADD COLUMN client_id TEXT');
  const attendanceCols = db.prepare('PRAGMA table_info(attendance)').all().map((row) => row.name);
  if (!attendanceCols.includes('mode')) db.exec(`ALTER TABLE attendance ADD COLUMN mode TEXT NOT NULL DEFAULT 'Web'`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_rules (
      client_id TEXT PRIMARY KEY,
      late_grace INTEGER NOT NULL,
      early_grace INTEGER NOT NULL,
      ot_after INTEGER NOT NULL,
      modes TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS roster (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      work_date TEXT NOT NULL,
      shift_id TEXT NOT NULL,
      UNIQUE(employee_id, work_date)
    );
    CREATE TABLE IF NOT EXISTS regularizations (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      employee_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      work_date TEXT NOT NULL,
      requested_in TEXT,
      requested_out TEXT,
      mode TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      company_approver TEXT,
      admin_approver TEXT,
      raised_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS leave_policies (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      leave_type TEXT NOT NULL,
      yearly_quota REAL NOT NULL,
      monthly_accrual REAL NOT NULL,
      carry_forward REAL NOT NULL,
      paid INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leave_accruals (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      leave_type TEXT NOT NULL,
      period TEXT NOT NULL,
      days REAL NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(employee_id, leave_type, period)
    );
  `);
  db.prepare(`UPDATE leaves SET status = 'Pending company' WHERE status = 'Pending'`).run();
  const policyTypes = [
    ['Casual', 12, 1, 0, 1],
    ['Sick', 8, 0.5, 0, 1],
    ['Earned', 15, 1.25, 5, 1],
    ['Unpaid', 0, 0, 0, 0]
  ];
  db.prepare('SELECT id FROM clients').all().forEach((client) => {
    if (!db.prepare('SELECT client_id FROM attendance_rules WHERE client_id = ?').get(client.id)) {
      db.prepare('INSERT INTO attendance_rules (client_id, late_grace, early_grace, ot_after, modes) VALUES (?, 10, 10, 0, ?)').run(
        client.id, JSON.stringify(['Web', 'Manual', 'Biometric', 'Roster'])
      );
    }
    if (!db.prepare('SELECT id FROM leave_policies WHERE client_id = ?').get(client.id)) {
      policyTypes.forEach(([leaveType, quota, accrual, carry, paid]) => {
        db.prepare('INSERT INTO leave_policies (id, client_id, leave_type, yearly_quota, monthly_accrual, carry_forward, paid) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          `${client.id}_${leaveType}`, client.id, leaveType, quota, accrual, carry, paid
        );
      });
    }
  });
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name);
  if (!taskCols.includes('priority')) db.exec(`ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'Normal'`);
  if (!taskCols.includes('employee_id')) db.exec('ALTER TABLE tasks ADD COLUMN employee_id TEXT');
  if (!taskCols.includes('progress')) db.exec('ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0');
  if (!taskCols.includes('approval_status')) db.exec(`ALTER TABLE tasks ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'Approved'`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kpi TEXT NOT NULL,
      target REAL NOT NULL,
      achieved REAL NOT NULL,
      period TEXT NOT NULL,
      status TEXT NOT NULL,
      approval_status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kras (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      title TEXT NOT NULL,
      weight REAL NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      period TEXT NOT NULL,
      reviewer TEXT NOT NULL,
      rating REAL NOT NULL,
      appraisal TEXT,
      comments TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  if (db.prepare('SELECT id FROM employees WHERE id = ?').get('emp_aarav')) {
    db.prepare(`UPDATE tasks SET employee_id = 'emp_aarav', priority = 'High' WHERE id = 'task_1' AND (employee_id IS NULL OR employee_id = '')`).run();
    if (!db.prepare('SELECT COUNT(*) AS c FROM goals').get().c) {
      db.prepare(`INSERT INTO goals (id, client_id, employee_id, title, kpi, target, achieved, period, status, approval_status, created_at)
        VALUES ('goal_1', 'cli_nexus', 'emp_aarav', 'Bellandur delivery', 'Stories closed', 24, 18, '2026-Q4', 'Active', 'Approved', '2026-10-01T05:00:00.000Z')`).run();
    }
    if (!db.prepare('SELECT COUNT(*) AS c FROM kras').get().c) {
      db.prepare(`INSERT INTO kras (id, client_id, employee_id, title, weight, description, created_at)
        VALUES ('kra_1', 'cli_nexus', 'emp_aarav', 'Delivery quality', 40, 'Ship reviewed work without reopening defects.', '2026-10-01T05:00:00.000Z')`).run();
      db.prepare(`INSERT INTO kras (id, client_id, employee_id, title, weight, description, created_at)
        VALUES ('kra_2', 'cli_nexus', 'emp_aarav', 'Attendance discipline', 20, 'Stay inside the late-grace rule.', '2026-10-01T05:00:00.000Z')`).run();
    }
    if (!db.prepare('SELECT COUNT(*) AS c FROM reviews').get().c) {
      db.prepare(`INSERT INTO reviews (id, client_id, employee_id, period, reviewer, rating, appraisal, comments, status, created_at)
        VALUES ('rev_1', 'cli_nexus', 'emp_aarav', '2026-H1', 'Priya Shah', 4, 'Confirmed and meeting the delivery KRA.', 'Keep the attendance line green.', 'Final', '2026-07-20T05:00:00.000Z')`).run();
    }
  }
  const applicantCols = db.prepare('PRAGMA table_info(applicants)').all().map((row) => row.name);
  if (!applicantCols.includes('resume_url')) db.exec(`ALTER TABLE applicants ADD COLUMN resume_url TEXT NOT NULL DEFAULT ''`);
  if (!applicantCols.includes('resume_name')) db.exec(`ALTER TABLE applicants ADD COLUMN resume_name TEXT NOT NULL DEFAULT ''`);
  if (!applicantCols.includes('offer_status')) db.exec(`ALTER TABLE applicants ADD COLUMN offer_status TEXT NOT NULL DEFAULT 'None'`);
  if (!applicantCols.includes('job_id')) db.exec('ALTER TABLE applicants ADD COLUMN job_id TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS requisitions (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      position TEXT NOT NULL,
      openings INTEGER NOT NULL,
      department TEXT,
      justification TEXT,
      status TEXT NOT NULL,
      raised_by TEXT,
      created_at TEXT NOT NULL
    );
  `);
  if (db.prepare('SELECT id FROM clients WHERE id = ?').get('cli_nexus') && !db.prepare('SELECT COUNT(*) AS c FROM requisitions').get().c) {
    db.prepare(`INSERT INTO requisitions (id, application_number, client_id, kind, position, openings, department, justification, status, raised_by, created_at)
      VALUES ('req_1', 'APP-REQ-2026-0001', 'cli_nexus', 'Internal', 'Fullstack engineer', 2, 'ERP Solutions', 'Backfill the Bellandur lab from inside Nexus.', 'Approved', 'Priya Shah', '2026-10-05T06:00:00.000Z')`).run();
    db.prepare(`INSERT INTO requisitions (id, application_number, client_id, kind, position, openings, department, justification, status, raised_by, created_at)
      VALUES ('req_2', 'APP-REQ-2026-0002', 'cli_zenith', 'S1 HR', 'Warehouse associate', 12, 'Team Operations', 'Ask S1 HR to source third-party warehouse staff.', 'Pending admin', 'Imran Qureshi', '2026-10-09T03:30:00.000Z')`).run();
    db.prepare(`INSERT INTO counters(prefix, value) VALUES('REQ', 2) ON CONFLICT(prefix) DO UPDATE SET value = CASE WHEN value < 2 THEN 2 ELSE value END`).run();
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      period TEXT NOT NULL,
      status TEXT NOT NULL,
      headcount INTEGER NOT NULL,
      gross REAL NOT NULL,
      deductions REAL NOT NULL,
      net REAL NOT NULL,
      checks TEXT NOT NULL,
      submitted_by TEXT,
      approved_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(client_id, period)
    );
    CREATE TABLE IF NOT EXISTS payroll_requests (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      employee_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      employee_name TEXT NOT NULL,
      period TEXT NOT NULL,
      component TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      raised_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS report_requests (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      report_name TEXT NOT NULL,
      period TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      raised_by TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS incentive_rules (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      component TEXT NOT NULL,
      basis TEXT NOT NULL,
      rate REAL NOT NULL,
      min_rating REAL NOT NULL DEFAULT 0,
      min_tenure_months INTEGER NOT NULL DEFAULT 0,
      department TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incentive_awards (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      rule_id TEXT,
      client_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      period TEXT NOT NULL,
      kind TEXT NOT NULL,
      component TEXT NOT NULL,
      eligible INTEGER NOT NULL,
      amount REAL NOT NULL,
      detail TEXT,
      status TEXT NOT NULL,
      requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS asset_events (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      from_employee TEXT,
      to_employee TEXT,
      detail TEXT,
      actor TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asset_requests (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      asset_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      employee_id TEXT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL,
      raised_by TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      destination_employee_id TEXT
    );
  `);
  const assetRequestCols = db.prepare('PRAGMA table_info(asset_requests)').all().map((row) => row.name);
  if (!assetRequestCols.includes('destination_employee_id')) db.exec('ALTER TABLE asset_requests ADD COLUMN destination_employee_id TEXT');
  const claimCols = db.prepare('PRAGMA table_info(reimbursements)').all().map((row) => row.name);
  if (!claimCols.includes('expense_date')) db.exec(`ALTER TABLE reimbursements ADD COLUMN expense_date TEXT NOT NULL DEFAULT ''`);
  if (!claimCols.includes('detail')) db.exec(`ALTER TABLE reimbursements ADD COLUMN detail TEXT NOT NULL DEFAULT ''`);
  if (!claimCols.includes('receipt_name')) db.exec(`ALTER TABLE reimbursements ADD COLUMN receipt_name TEXT NOT NULL DEFAULT ''`);
  if (!claimCols.includes('finance_note')) db.exec(`ALTER TABLE reimbursements ADD COLUMN finance_note TEXT NOT NULL DEFAULT ''`);
  if (!claimCols.includes('approver')) db.exec(`ALTER TABLE reimbursements ADD COLUMN approver TEXT NOT NULL DEFAULT ''`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_policies (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      category TEXT NOT NULL,
      max_amount REAL NOT NULL,
      receipt_above REAL NOT NULL,
      monthly_cap REAL NOT NULL,
      per_km REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claim_events (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      detail TEXT,
      actor TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare("UPDATE reimbursements SET status = 'Pending company' WHERE status = 'Pending'").run();
  if (db.prepare('SELECT id FROM clients WHERE id = ?').get('cli_nexus') && !db.prepare('SELECT COUNT(*) AS c FROM expense_policies').get().c) {
    const insert = db.prepare(`INSERT INTO expense_policies (id, client_id, category, max_amount, receipt_above, monthly_cap, per_km, notes, created_at)
      VALUES (?, 'cli_nexus', ?, ?, ?, ?, ?, ?, '2026-10-01T05:00:00.000Z')`);
    insert.run('exp_travel', 'Travel', 8000, 500, 20000, 0, 'Cab, train, flight, or bus. A receipt is required above ₹500.');
    insert.run('exp_bike', 'E-bike', 2500, 1000, 4000, 8, 'Paid at ₹8 per kilometre.');
    insert.run('exp_food', 'Food', 800, 200, 4000, 0, 'Client or site meals.');
    insert.run('exp_med', 'Medical', 15000, 1, 20000, 0, 'A receipt is required.');
    insert.run('exp_fuel', 'Fuel', 4000, 500, 8000, 0, 'Fuel for an own vehicle.');
    insert.run('exp_hotel', 'Hotel', 6000, 1, 12000, 0, 'Overnight stay on approved travel.');
  }
  if (!db.prepare('SELECT COUNT(*) AS c FROM claim_events').get().c) {
    db.prepare('SELECT id, status, description, raised_at FROM reimbursements').all().forEach((claim) => {
      db.prepare(`INSERT INTO claim_events (id, claim_id, action, from_status, to_status, detail, actor, created_at)
        VALUES (?, ?, 'Submitted', '', ?, ?, 'S1 HR', ?)`).run(
        crypto.randomUUID(), claim.id, claim.status, claim.description || 'Opening claim', claim.raised_at
      );
    });
  }
  const placeEmployeeCols = db.prepare('PRAGMA table_info(employees)').all().map((row) => row.name);
  if (!placeEmployeeCols.includes('location_id')) db.exec('ALTER TABLE employees ADD COLUMN location_id TEXT');
  const placeAttendanceCols = db.prepare('PRAGMA table_info(attendance)').all().map((row) => row.name);
  if (!placeAttendanceCols.includes('location_id')) db.exec('ALTER TABLE attendance ADD COLUMN location_id TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      parent_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      code TEXT,
      address TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS location_rules (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      leave_type TEXT,
      yearly_quota REAL NOT NULL DEFAULT 0,
      monthly_accrual REAL NOT NULL DEFAULT 0,
      allowance REAL NOT NULL DEFAULT 0,
      notes TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS location_requests (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      employee_id TEXT,
      branch_id TEXT,
      location_id TEXT,
      parent_id TEXT,
      kind TEXT,
      place_name TEXT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL,
      raised_by TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
  `);
  if (db.prepare('SELECT id FROM branches WHERE id = ?').get('br_nx_mum') && !db.prepare('SELECT COUNT(*) AS c FROM locations').get().c) {
    const insertPlace = db.prepare(`INSERT INTO locations (id, client_id, branch_id, parent_id, kind, name, code, address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-01-20T05:00:00.000Z')`);
    insertPlace.run('loc_nx_office', 'cli_nexus', 'br_nx_mum', null, 'Office', 'Mindspace HQ office', 'HQ-OFF', 'Mindspace SEZ, Airoli');
    insertPlace.run('loc_nx_floor', 'cli_nexus', 'br_nx_mum', 'loc_nx_office', 'Floor', 'Level 3', 'HQ-L3', 'Mindspace SEZ, Airoli');
    insertPlace.run('loc_nx_site', 'cli_nexus', 'br_nx_blr', null, 'Site', 'Bellandur delivery site', 'BLR-SITE', 'Outer Ring Road, Bellandur');
    insertPlace.run('loc_nx_unit', 'cli_nexus', 'br_nx_blr', 'loc_nx_site', 'Unit', 'Lab unit A', 'BLR-A', 'Outer Ring Road, Bellandur');
    db.prepare('UPDATE employees SET location_id = ? WHERE id = ?').run('loc_nx_floor', 'emp_aarav');
    db.prepare('UPDATE employees SET location_id = ? WHERE id = ?').run('loc_nx_unit', 'emp_meera');
    const insertRule = db.prepare(`INSERT INTO location_rules (id, client_id, location_id, kind, leave_type, yearly_quota, monthly_accrual, allowance, notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', '2026-01-20T05:00:00.000Z')`);
    insertRule.run('lr_floor_casual', 'cli_nexus', 'loc_nx_floor', 'Leave', 'Casual', 20, 1.5, 0, 'Level 3 casual leave cap.');
    insertRule.run('lr_site_pay', 'cli_nexus', 'loc_nx_site', 'Payroll', '', 0, 0, 2500, 'Bellandur site allowance, including the lab unit.');
  }
  db.prepare(`UPDATE attendance SET location_id = (
      SELECT location_id FROM employees e WHERE e.id = attendance.employee_id
    ) WHERE (location_id IS NULL OR location_id = '')
      AND EXISTS (
        SELECT 1 FROM employees e WHERE e.id = attendance.employee_id AND e.location_id IS NOT NULL AND e.location_id != ''
      )`).run();
  const customCols = db.prepare('PRAGMA table_info(employees)').all().map((row) => row.name);
  if (!customCols.includes('custom_data')) db.exec(`ALTER TABLE employees ADD COLUMN custom_data TEXT NOT NULL DEFAULT ''`);
  const templateCols = db.prepare('PRAGMA table_info(templates)').all().map((row) => row.name);
  if (!templateCols.includes('use_body')) db.exec('ALTER TABLE templates ADD COLUMN use_body INTEGER NOT NULL DEFAULT 0');
  if (!templateCols.includes('mapping')) db.exec(`ALTER TABLE templates ADD COLUMN mapping TEXT NOT NULL DEFAULT ''`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_fields (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL,
      options TEXT,
      required INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS custom_forms (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      field_keys TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_requests (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      reply TEXT,
      raised_by TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
  `);
  if (!db.prepare('SELECT id FROM templates WHERE id = ?').get('tpl_app')) {
    const insertTpl = db.prepare(`INSERT INTO templates (id, owner_role, owner_id, name, category, body, watermark, updated_at, use_body, mapping)
      VALUES (?, 'admin', 's1', ?, ?, ?, 'S1 HR SOLUTION', '2026-10-01T05:00:00.000Z', 0, '')`);
    insertTpl.run('tpl_app', 'Appointment letter', 'appointment', 'Appointed as {{employee.roleTitle}} at {{client.companyName}} from {{employee.joinedOn}}.');
    insertTpl.run('tpl_exp', 'Experience letter', 'experience', 'This certifies that {{employee.fullName}}, {{employee.employeeCode}}, has served as {{employee.roleTitle}} since {{employee.joinedOn}}.');
    insertTpl.run('tpl_sal', 'Salary certificate', 'salarycert', 'Monthly net pay for {{employee.fullName}} is {{pay.net}} for {{period}}.');
  }
  db.prepare(`UPDATE templates SET body = ? WHERE id = 'tpl_pay' AND body NOT LIKE '%{{%'`).run('This payslip for {{employee.fullName}} ({{employee.employeeCode}}) remains subject to statutory reconciliation. Net pay {{pay.net}}.');
  db.prepare(`UPDATE templates SET body = ? WHERE id = 'tpl_id' AND body NOT LIKE '%{{%'`).run('QR identity for {{employee.fullName}} · {{employee.employeeCode}} · {{client.companyName}}. Carry this card at {{employee.branchName}}.');
  if (db.prepare('SELECT id FROM clients WHERE id = ?').get('cli_nexus') && !db.prepare('SELECT COUNT(*) AS c FROM custom_fields').get().c) {
    const insertField = db.prepare(`INSERT INTO custom_fields (id, client_id, field_key, label, field_type, options, required, created_at)
      VALUES (?, 'cli_nexus', ?, ?, ?, ?, ?, '2026-10-01T05:00:00.000Z')`);
    insertField.run('cf_nominee', 'nominee', 'Nominee', 'text', '', 1);
    insertField.run('cf_station', 'workstation', 'Workstation', 'text', '', 0);
    db.prepare(`INSERT INTO custom_forms (id, client_id, name, category, field_keys, created_at)
      VALUES ('frm_join', 'cli_nexus', 'HR letter pack', 'experience', ?, '2026-10-01T05:00:00.000Z')`).run(JSON.stringify(['nominee', 'workstation']));
    db.prepare(`UPDATE employees SET custom_data = ? WHERE id = 'emp_aarav' AND (custom_data IS NULL OR custom_data = '')`).run(JSON.stringify({ nominee: 'Neha Sharma', workstation: 'Level 3, Mindspace' }));
    db.prepare(`INSERT INTO document_requests (id, application_number, client_id, employee_id, kind, message, status, reply, raised_by, created_at, decided_at)
      VALUES ('doc_ask_1', 'APP-DOC-2026-0001', 'cli_nexus', 'emp_aarav', 'ask', 'Please confirm the name printed on my experience letter.', 'Pending company', '', 'Aarav Sharma', '2026-10-11T06:00:00.000Z', '')`).run();
    db.prepare(`INSERT INTO counters(prefix, value) VALUES('DOC', 1) ON CONFLICT(prefix) DO UPDATE SET value = CASE WHEN value < 1 THEN 1 ELSE value END`).run();
  }
  if (db.prepare('SELECT id FROM clients WHERE id = ?').get('cli_nexus') && !db.prepare('SELECT COUNT(*) AS c FROM incentive_rules').get().c) {
    db.prepare(`INSERT INTO incentive_rules (id, client_id, name, kind, component, basis, rate, min_rating, min_tenure_months, department, status, created_at)
      VALUES ('inc_fest', 'cli_nexus', 'Diwali bonus', 'Bonus', 'festivalBonus', 'Fixed', 5000, 0, 3, '', 'Active', '2026-10-01T05:00:00.000Z')`).run();
    db.prepare(`INSERT INTO incentive_rules (id, client_id, name, kind, component, basis, rate, min_rating, min_tenure_months, department, status, created_at)
      VALUES ('inc_perf', 'cli_nexus', 'Quarterly performance pay', 'Performance', 'performanceIncentive', 'Percent of basic', 10, 4, 6, '', 'Active', '2026-10-01T05:00:00.000Z')`).run();
    db.prepare(`INSERT INTO incentive_rules (id, client_id, name, kind, component, basis, rate, min_rating, min_tenure_months, department, status, created_at)
      VALUES ('inc_target', 'cli_nexus', 'Delivery target incentive', 'Target', 'productionIncentive', 'Per target unit', 200, 0, 0, 'ERP Solutions', 'Active', '2026-10-01T05:00:00.000Z')`).run();
  }
  if (!db.prepare('SELECT COUNT(*) AS c FROM asset_events').get().c) {
    db.prepare('SELECT id, status, employee_id, notes FROM assets').all().forEach((asset) => {
      const holder = asset.employee_id ? db.prepare('SELECT full_name FROM employees WHERE id = ?').get(asset.employee_id) : null;
      db.prepare(`INSERT INTO asset_events (id, asset_id, action, from_status, to_status, from_employee, to_employee, detail, actor, created_at)
        VALUES (?, ?, 'Recorded', '', ?, '', ?, ?, 'S1 HR', ?)`).run(
        crypto.randomUUID(), asset.id, asset.status, holder ? holder.full_name : '', asset.notes || 'Opening balance', '2026-01-20T05:00:00.000Z'
      );
    });
  }
  const clientCols = db.prepare('PRAGMA table_info(clients)').all().map((row) => row.name);
  if (!clientCols.includes('onboarding')) db.exec(`ALTER TABLE clients ADD COLUMN onboarding TEXT NOT NULL DEFAULT ''`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_requests (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      plan TEXT,
      fee REAL NOT NULL DEFAULT 0,
      cycle TEXT,
      status TEXT NOT NULL,
      raised_by TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
  `);
  const requestCols = db.prepare('PRAGMA table_info(client_requests)').all().map((row) => row.name);
  if (!requestCols.includes('payment_method')) db.exec(`ALTER TABLE client_requests ADD COLUMN payment_method TEXT NOT NULL DEFAULT ''`);
  if (!requestCols.includes('payment_reference')) db.exec(`ALTER TABLE client_requests ADD COLUMN payment_reference TEXT NOT NULL DEFAULT ''`);
  db.prepare('SELECT id, status, onboarding FROM clients').all().forEach((client) => {
    if (client.onboarding) return;
    const live = client.status === 'Approved';
    const pack = {
      stage: live ? 'Live' : 'Registered',
      legalName: '', cin: '', gstin: '', pan: '', industry: '',
      billingName: '', billingEmail: '', billingPhone: '', billingAddress: '', paymentMode: 'Bank transfer',
      service: live ? 'Workforce operations' : '', contractStart: live ? '2026-01-01' : '', contractEnd: live ? '2026-12-31' : '',
      contractValue: client.id === 'cli_nexus' ? 180000 : 0, terms: '',
      plan: client.id === 'cli_nexus' ? 'hr-essential' : 'hr-easy',
      fee: client.id === 'cli_nexus' ? 180000 : (live ? 75000 : 0),
      cycle: 'Monthly', paymentStatus: live ? 'Paid' : 'Unpaid', paymentMethod: 'Bank transfer', paymentReference: '',
      handoverOwner: live ? 'Ravi Menon' : '', handoverStart: live ? '2026-01-15' : '', handoverDone: live ? '2026-02-01' : '',
      handoverNotes: live ? 'Portal, payroll, and attendance handed to the company desk.' : '',
      closureReason: '', closedOn: '',
      history: [{ at: '2026-01-20T05:00:00.000Z', actor: 'S1 HR', action: 'Recorded', detail: 'Opening onboarding record' }]
    };
    db.prepare('UPDATE clients SET onboarding = ? WHERE id = ?').run(JSON.stringify(pack), client.id);
  });
  const orgEmpCols = db.prepare('PRAGMA table_info(employees)').all().map((row) => row.name);
  if (!orgEmpCols.includes('team_id')) db.exec('ALTER TABLE employees ADD COLUMN team_id TEXT');
  if (!orgEmpCols.includes('desk_role')) db.exec(`ALTER TABLE employees ADD COLUMN desk_role TEXT NOT NULL DEFAULT ''`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      department TEXT,
      branch_id TEXT,
      lead_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS org_policies (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS org_reviews (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      period TEXT NOT NULL,
      rating REAL NOT NULL,
      notes TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS org_roles (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      permissions TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS joining_cases (
      id TEXT PRIMARY KEY,
      application_number TEXT NOT NULL UNIQUE,
      applicant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      job_id TEXT,
      status TEXT NOT NULL,
      joined_on TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS employment_history (
      id TEXT PRIMARY KEY,
      employee_id TEXT,
      applicant_id TEXT,
      client_id TEXT,
      employer TEXT NOT NULL,
      role_title TEXT NOT NULL,
      from_date TEXT,
      to_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );
  `);
  if (db.prepare('SELECT id FROM employees WHERE id = ?').get('emp_meera') && !db.prepare('SELECT COUNT(*) AS c FROM teams').get().c) {
    db.prepare(`INSERT INTO teams (id, client_id, name, department, branch_id, lead_id, status, created_at)
      VALUES ('team_nexus', 'cli_nexus', 'Nexus delivery', 'ERP Solutions', 'br_nx_mum', 'emp_meera', 'Active', '2026-01-20T05:00:00.000Z')`).run();
    db.prepare(`UPDATE employees SET team_id = 'team_nexus', desk_role = 'Engineer' WHERE id = 'emp_aarav'`).run();
    db.prepare(`UPDATE employees SET team_id = 'team_nexus', desk_role = 'Team lead' WHERE id = 'emp_meera'`).run();
    db.prepare(`INSERT INTO org_roles (id, client_id, name, permissions, created_at) VALUES
      ('role_lead', 'cli_nexus', 'Team lead', ?, '2026-01-20T05:00:00.000Z')`).run(JSON.stringify(['people', 'attendance', 'hiring']));
    db.prepare(`INSERT INTO org_roles (id, client_id, name, permissions, created_at) VALUES
      ('role_eng', 'cli_nexus', 'Engineer', ?, '2026-01-20T05:00:00.000Z')`).run(JSON.stringify(['attendance', 'claims']));
    db.prepare(`INSERT INTO org_policies (id, client_id, name, detail, status, created_at) VALUES
      ('pol_prob', 'cli_nexus', 'Probation review', 'Confirm or extend probation at six months. Company desk raises it and the administrator approves.', 'Active', '2026-01-20T05:00:00.000Z')`).run();
    db.prepare(`INSERT INTO org_reviews (id, client_id, period, rating, notes, status, created_at) VALUES
      ('rev_q3', 'cli_nexus', '2026-Q3', 4, 'Delivery team is staffed. Evening coverage is still short.', 'Reviewed', '2026-10-01T05:00:00.000Z')`).run();
    db.prepare(`INSERT INTO employment_history (id, employee_id, applicant_id, client_id, employer, role_title, from_date, to_date, notes, created_at) VALUES
      ('hist_aarav', 'emp_aarav', NULL, 'cli_nexus', 'Northwind Labs', 'Software engineer', '2023-04-01', '2025-12-15', 'Previous employment before Nexus.', '2026-01-20T05:00:00.000Z')`).run();
  }
  if (!db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get('kavya.nair@nexusinfotech.com')) {
    db.prepare(`INSERT INTO users (id, role, email, password_hash, name, phone, title, client_id, employee_id, active, status_text, created_at)
      VALUES ('u_kavya', 'hradmin', 'kavya.nair@nexusinfotech.com', ?, 'Kavya Nair', '+91 98111 44020', 'HR admin', 'cli_nexus', NULL, 1, 'Issued by the super admin and the client admin', '2026-10-01T05:00:00.000Z')`).run(hashPassword('Admin@123'));
  }
  db.prepare("UPDATE users SET status_text = 'Issued by the super admin and the client admin' WHERE id = 'u_kavya' AND active = 1 AND status_text = 'Company HR desk'").run();
}

function openDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    const probe = new DatabaseSync(DB_PATH);
    probe.exec('PRAGMA foreign_keys = ON');
    probe.exec('PRAGMA busy_timeout = 5000');
    const hasMeta = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    const version = hasMeta ? probe.prepare('SELECT value FROM meta WHERE key = ?').get('version') : null;
    if (version && version.value === VERSION) {
      ensureSchema(probe);
      return probe;
    }
    probe.close();
    fs.unlinkSync(DB_PATH);
  }
  const created = new DatabaseSync(DB_PATH);
  created.exec('PRAGMA foreign_keys = ON');
  created.exec('PRAGMA busy_timeout = 5000');
  migrate(created);
  created.exec('BEGIN');
  try {
    seed(created, { hashPassword });
    created.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('version', VERSION);
    created.exec('COMMIT');
  } catch (error) {
    try { created.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    created.close();
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    throw error;
  }
  ensureSchema(created);
  return created;
}

database = openDatabase();

function userFromToken(token) {
  if (!token) return null;
  const row = database.prepare(`SELECT u.*, c.company_name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN clients c ON c.id = u.client_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
  if (!row || !row.active) return null;
  return loadUser(row);
}

function login(portal, email, password) {
  const portalRole = {
    superadmin: 'admin',
    admin: 'hradmin',
    'client-admin': 'client',
    client: 'client',
    employee: 'employee'
  };
  const expected = portalRole[portal];
  if (!expected) fail(400, 'Choose a valid desk');
  const row = database.prepare(`SELECT u.*, c.company_name FROM users u
    LEFT JOIN clients c ON c.id = u.client_id
    WHERE lower(u.email) = lower(?)`).get(clip(email, 120));
  if (!row || !verifyPassword(password, row.password_hash)) fail(401, 'Those credentials were not recognised');
  if (row.role !== expected) {
    const desk = { admin: 'super admin', hradmin: 'admin', client: 'client admin', employee: 'employee' }[row.role] || row.role;
    fail(403, `This account belongs to the ${desk} desk`);
  }
  if (!row.active) {
    if (row.status_text === 'Pending client admin') fail(403, 'The client admin still needs to confirm this admin portal');
    if (row.status_text === 'Pending super admin') fail(403, 'The super admin still needs to confirm this admin portal');
    fail(403, 'Portal access has not been issued for this account');
  }
  const user = loadUser(row);
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  database.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
  return { token, user };
}

function logout(token) {
  if (token) database.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function listNotifications(user, limit = 8) {
  const audiences = audiencesFor(user);
  return database.prepare(`SELECT * FROM notifications WHERE audience IN (${audiences.map(() => '?').join(',')})
    ORDER BY created_at DESC LIMIT ?`).all(...audiences, limit).map((row) => ({
    id: row.id,
    title: row.title,
    message: row.message,
    createdAt: row.created_at,
    read: !!row.read_flag
  }));
}

function markNotificationsRead(user) {
  const audiences = audiencesFor(user);
  database.prepare(`UPDATE notifications SET read_flag = 1 WHERE audience IN (${audiences.map(() => '?').join(',')})`)
    .run(...audiences);
}

function countUnread(user) {
  const audiences = audiencesFor(user);
  return database.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE read_flag = 0 AND audience IN (${audiences.map(() => '?').join(',')})`)
    .get(...audiences).c;
}

function countApprovals(user) {
  if (user.role === 'admin') {
    const pendingClients = database.prepare("SELECT COUNT(*) AS c FROM clients WHERE status = 'Pending'").get().c;
    const leaves = database.prepare("SELECT COUNT(*) AS c FROM leaves WHERE status IN ('Pending','Pending company','Pending admin')").get().c;
    const swaps = database.prepare("SELECT COUNT(*) AS c FROM shift_swaps WHERE status = 'Pending'").get().c;
    const claims = database.prepare("SELECT COUNT(*) AS c FROM reimbursements WHERE status IN ('Pending','Pending company','Pending finance','Ready')").get().c;
    const activities = database.prepare("SELECT COUNT(*) AS c FROM activities WHERE stage = 'Submitted'").get().c;
    let regular = 0;
    try { regular = database.prepare("SELECT COUNT(*) AS c FROM regularizations WHERE status IN ('Pending company','Pending admin')").get().c; } catch (_) { regular = 0; }
    const taskRequests = database.prepare("SELECT COUNT(*) AS c FROM tasks WHERE approval_status IN ('Pending company','Pending admin')").get().c;
    const goalRequests = database.prepare("SELECT COUNT(*) AS c FROM goals WHERE approval_status = 'Pending admin'").get().c;
    const reviewRequests = database.prepare("SELECT COUNT(*) AS c FROM reviews WHERE status = 'Pending admin'").get().c;
    const reportRequests = database.prepare("SELECT COUNT(*) AS c FROM report_requests WHERE status = 'Pending admin'").get().c;
    const incentiveRules = database.prepare("SELECT COUNT(*) AS c FROM incentive_rules WHERE status = 'Pending admin'").get().c;
    const incentiveAwards = database.prepare("SELECT COUNT(*) AS c FROM incentive_awards WHERE status = 'Pending admin' AND eligible = 1").get().c;
    const assetRequests = database.prepare("SELECT COUNT(*) AS c FROM asset_requests WHERE status = 'Pending admin'").get().c;
    const placeRequests = database.prepare("SELECT COUNT(*) AS c FROM location_requests WHERE status = 'Pending admin'").get().c;
    const documentRequests = database.prepare("SELECT COUNT(*) AS c FROM document_requests WHERE status = 'Pending admin'").get().c;
    const clientRequests = database.prepare("SELECT COUNT(*) AS c FROM client_requests WHERE status IN ('Pending verification','Pending approval')").get().c;
    const orgPolicies = database.prepare("SELECT COUNT(*) AS c FROM org_policies WHERE status = 'Pending admin'").get().c;
    const joiningCases = database.prepare("SELECT COUNT(*) AS c FROM joining_cases WHERE status = 'Pending admin'").get().c;
    const adminPortals = database.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'hradmin' AND status_text = 'Pending super admin'").get().c;
    return pendingClients + leaves + swaps + claims + activities + regular + taskRequests + goalRequests + reviewRequests + reportRequests + incentiveRules + incentiveAwards + assetRequests + placeRequests + documentRequests + clientRequests + orgPolicies + joiningCases + adminPortals;
  }
  if (user.role === 'client') {
    const activity = database.prepare("SELECT COUNT(*) AS c FROM activities WHERE client_id = ? AND stage IN ('Submitted','Viewed','Processing','Verified')").get(user.clientId).c;
    const leaves = database.prepare("SELECT COUNT(*) AS c FROM leaves WHERE client_id = ? AND status IN ('Pending','Pending company','Pending admin')").get(user.clientId).c;
    let regular = 0;
    try { regular = database.prepare("SELECT COUNT(*) AS c FROM regularizations WHERE client_id = ? AND status IN ('Pending company','Pending admin')").get(user.clientId).c; } catch (_) { regular = 0; }
    const swaps = database.prepare("SELECT COUNT(*) AS c FROM shift_swaps WHERE client_id = ? AND status = 'Pending'").get(user.clientId).c;
    const taskRequests = database.prepare("SELECT COUNT(*) AS c FROM tasks WHERE client_id = ? AND approval_status IN ('Pending company','Pending admin')").get(user.clientId).c;
    const assetRequests = database.prepare("SELECT COUNT(*) AS c FROM asset_requests WHERE client_id = ? AND status IN ('Pending company','Pending admin')").get(user.clientId).c;
    const claims = database.prepare("SELECT COUNT(*) AS c FROM reimbursements WHERE client_id = ? AND status IN ('Pending','Pending company','Pending finance','Ready')").get(user.clientId).c;
    const placeRequests = database.prepare("SELECT COUNT(*) AS c FROM location_requests WHERE client_id = ? AND status IN ('Pending company','Pending admin')").get(user.clientId).c;
    const documentRequests = database.prepare("SELECT COUNT(*) AS c FROM document_requests WHERE client_id = ? AND status IN ('Pending company','Pending admin')").get(user.clientId).c;
    const joiningCases = database.prepare("SELECT COUNT(*) AS c FROM joining_cases WHERE client_id = ? AND status = 'Pending company'").get(user.clientId).c;
    const adminPortals = user.isHrAdmin ? 0 : database.prepare("SELECT COUNT(*) AS c FROM users WHERE client_id = ? AND role = 'hradmin' AND status_text = 'Pending client admin'").get(user.clientId).c;
    return activity + leaves + swaps + regular + taskRequests + assetRequests + claims + placeRequests + documentRequests + joiningCases + adminPortals;
  }
  const leaves = database.prepare("SELECT COUNT(*) AS c FROM leaves WHERE employee_id = ? AND status = 'Pending'").get(user.employeeId).c;
  const swaps = database.prepare("SELECT COUNT(*) AS c FROM shift_swaps WHERE employee_id = ? AND status = 'Pending'").get(user.employeeId).c;
  const claims = database.prepare("SELECT COUNT(*) AS c FROM reimbursements WHERE employee_id = ? AND status IN ('Pending','Pending company','Pending finance','Ready')").get(user.employeeId).c;
  return leaves + swaps + claims;
}

function listSlides(user) {
  let sql = `SELECT a.*, c.company_name FROM activities a
    LEFT JOIN clients c ON c.id = a.client_id
    WHERE a.type = 'advertise' AND a.active = 1 AND a.stage = 'Live'`;
  const params = [];
  if (user.role !== 'admin') {
    sql += ' AND (a.client_id IS NULL OR a.client_id = ?)';
    params.push(user.clientId);
  }
  sql += ' ORDER BY a.raised_at DESC';
  return database.prepare(sql).all(...params).map((row) => {
    const payload = parse(row.payload, {});
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      companyName: payload.companyName || row.company_name || 'S1 HR Solution',
      link: payload.link || '',
      mediaUrl: payload.mediaUrl || '',
      mediaType: payload.mediaType || 'image'
    };
  });
}

function dashboard(user) {
  const today = kolkataStamp().date;
  const scopeClient = user.role === 'admin' ? '' : user.clientId;
  const presentSql = scopeClient
    ? database.prepare("SELECT COUNT(*) AS c FROM attendance WHERE work_date = ? AND client_id = ? AND status IN ('Present','Late')").get(today, scopeClient).c
    : database.prepare("SELECT COUNT(*) AS c FROM attendance WHERE work_date = ? AND status IN ('Present','Late')").get(today).c;
  const chartRows = database.prepare('SELECT company_name, score_target, score_achieved FROM clients WHERE status != ? ORDER BY company_name')
    .all('Rejected')
    .filter((row) => user.role === 'admin' || row.company_name === user.companyName)
    .map((row) => ({ name: row.company_name, target: Number(row.score_target) || 0, achieved: Number(row.score_achieved) || 0 }));

  const flags = [];
  let flagSql = `SELECT a.work_date, a.status, a.flag, a.penalty_remarks, e.full_name
    FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE a.flag = 'red'`;
  const flagParams = [];
  if (user.role === 'client') { flagSql += ' AND a.client_id = ?'; flagParams.push(user.clientId); }
  if (user.role === 'employee') { flagSql += ' AND a.employee_id = ?'; flagParams.push(user.employeeId); }
  flagSql += ' ORDER BY a.work_date DESC LIMIT 6';
  database.prepare(flagSql).all(...flagParams).forEach((row) => {
    flags.push({ tone: 'red', title: `${row.full_name} · ${row.status}`, detail: `${row.work_date}${row.penalty_remarks ? ` · ${row.penalty_remarks}` : ''}` });
  });
  if (user.role !== 'employee') {
    let warnSql = 'SELECT full_name, warnings, client_id FROM employees';
    const warnParams = [];
    if (user.role === 'client') { warnSql += ' WHERE client_id = ?'; warnParams.push(user.clientId); }
    database.prepare(warnSql).all(...warnParams).forEach((row) => {
      parse(row.warnings, []).forEach((warning) => {
        flags.push({ tone: 'red', title: `Warning · ${row.full_name}`, detail: warning.message });
      });
    });
  }
  database.prepare(`SELECT e.full_name, a.work_date FROM attendance a JOIN employees e ON e.id = a.employee_id
    WHERE a.flag = 'green' ${user.role === 'admin' ? '' : user.role === 'client' ? 'AND a.client_id = ?' : 'AND a.employee_id = ?'}
    ORDER BY a.work_date DESC LIMIT 3`)
    .all(...(user.role === 'admin' ? [] : [user.role === 'client' ? user.clientId : user.employeeId]))
    .forEach((row) => flags.push({ tone: 'green', title: `${row.full_name} on time`, detail: row.work_date }));

  const queue = [];
  if (user.role === 'admin') {
    database.prepare("SELECT id, company_name, application_number FROM clients WHERE status = 'Pending'").all().forEach((row) => {
      queue.push({ href: `#/client/${row.id}`, title: row.company_name, meta: `${row.application_number} · registration` });
    });
    database.prepare("SELECT application_number, employee_name, leave_type FROM leaves WHERE status = 'Pending'").all().forEach((row) => {
      queue.push({ href: '#/approvals', title: `${row.employee_name} · ${row.leave_type} leave`, meta: row.application_number });
    });
    database.prepare("SELECT application_number, title FROM activities WHERE stage = 'Submitted' ORDER BY raised_at DESC LIMIT 4").all().forEach((row) => {
      queue.push({ href: '#/activities', title: row.title, meta: row.application_number });
    });
  }

  let punch = null;
  let company = null;
  if (user.role === 'employee') {
    const row = database.prepare(`SELECT a.*, e.full_name AS employee_name, e.employee_code, c.company_name
      FROM attendance a JOIN employees e ON e.id = a.employee_id JOIN clients c ON c.id = a.client_id
      WHERE a.employee_id = ? AND a.work_date = ?`).get(user.employeeId, today);
    punch = row ? shapeAttendance(row) : null;
    company = user.clientId ? mustClient(user.clientId) : null;
  }
  if (user.role === 'client') company = mustClient(user.clientId);

  const calls = user.role === 'admin'
    ? database.prepare("SELECT * FROM leads WHERE priority = 'High' OR status = 'Priority call' ORDER BY next_call_at LIMIT 4").all().map(shapeLead)
    : [];

  const kpis = [];
  if (user.role === 'admin') {
    kpis.push(
      { label: 'Client companies', value: String(database.prepare('SELECT COUNT(*) AS c FROM clients').get().c), note: 'Including registrations' },
      { label: 'Workforce', value: String(database.prepare('SELECT COUNT(*) AS c FROM employees').get().c), note: 'Active records' },
      { label: 'Open approvals', value: String(countApprovals(user)), note: 'Waiting on the access holder' },
      { label: 'Marked present today', value: String(presentSql), note: today }
    );
  } else if (user.role === 'client') {
    kpis.push(
      { label: 'Branches', value: String(company.branches.length), note: company.companyName },
      { label: 'Staff on record', value: String(company.employeeCount), note: 'Visible to this company desk' },
      { label: 'Open activity', value: String(countApprovals(user)), note: 'Requests still moving' },
      { label: 'Marked present today', value: String(presentSql), note: today }
    );
  } else {
    const employee = mustEmployee(user.employeeId);
    kpis.push(
      { label: 'Shift', value: employee.shiftName, note: `${employee.shiftStart}–${employee.shiftEnd}` },
      { label: 'Open requests', value: String(countApprovals(user)), note: 'Leave, swap, claims' },
      { label: 'Net pay', value: payroll.summarize(employee.payroll).net, note: 'Current payroll card', money: true },
      { label: 'Today', value: punch ? punch.status : 'Not punched', note: today }
    );
  }

  return {
    kpis,
    chart: chartRows,
    flags: flags.slice(0, 8),
    queue: queue.slice(0, 8),
    punch,
    company,
    calls,
    today
  };
}

function bootstrap(user) {
  return {
    user,
    badges: { approvals: countApprovals(user), notices: countUnread(user) },
    notifications: listNotifications(user, 8),
    advertisements: listSlides(user),
    dashboard: dashboard(user)
  };
}

function reference(user) {
  const departments = database.prepare('SELECT * FROM departments ORDER BY name').all().map((row) => ({
    id: row.id, name: row.name, levels: parse(row.levels, [])
  }));
  const shifts = database.prepare(`SELECT * FROM shifts WHERE client_id IS NULL ${user.role === 'admin' ? 'OR client_id IS NOT NULL' : 'OR client_id = ?'} ORDER BY start_time`).all(
    ...(user.role === 'admin' ? [] : [user.clientId || ''])
  ).map((row) => ({
    id: row.id, name: row.name, start: row.start_time, end: row.end_time, clientId: row.client_id || ''
  }));
  const statutory = database.prepare('SELECT * FROM statutory_links ORDER BY name').all().map((row) => ({
    id: row.id, name: row.name, url: row.url, details: row.details
  }));
  let companySql = 'SELECT * FROM clients';
  const params = [];
  if (user.role !== 'admin') {
    companySql += ' WHERE id = ?';
    params.push(user.clientId || '');
  }
  const companies = database.prepare(companySql).all(...params).map((row) => ({
    id: row.id,
    name: row.company_name,
    status: row.status,
    branches: database.prepare('SELECT id, name, city FROM branches WHERE client_id = ? ORDER BY name').all(row.id)
      .map((branch) => ({ id: branch.id, name: branch.name, city: branch.city }))
  }));
  return { departments, shifts, statutory, payrollCatalog: payroll.catalog, companies, bgvSteps: BGV_STEPS, plans: plans.list() };
}

function createDepartment(user, body) {
  assertCompanyDesk(user);
  const name = clip(body.name, 80);
  const levels = Array.isArray(body.levels) ? body.levels.map((level) => clip(level, 80)).filter(Boolean) : [];
  if (!name || !levels.length) fail(400, 'Name the department and at least one designation');
  if (database.prepare('SELECT id FROM departments WHERE lower(name) = lower(?)').get(name)) fail(400, 'That department is already on the desk');
  const id = crypto.randomUUID();
  database.prepare('INSERT INTO departments (id, name, levels) VALUES (?, ?, ?)').run(id, name, JSON.stringify(levels));
  return { id, name, levels };
}

function assignEmployeeDepartment(user, body) {
  assertCompanyDesk(user);
  const code = clip(body.employeeId, 40);
  const row = database.prepare('SELECT id FROM employees WHERE id = ? OR employee_code = ? OR application_number = ?').get(code, code, code);
  if (!row) fail(404, 'No employee matches that employee id');
  const employee = mustEmployee(row.id);
  assertEmployee(user, employee);
  const named = clip(body.newDepartment, 80);
  const departmentName = named || clip(body.department, 80);
  if (!departmentName) fail(400, 'Choose a department or type a new name');
  const existing = database.prepare('SELECT * FROM departments WHERE lower(name) = lower(?)').get(departmentName);
  if (!existing) {
    const levels = [employee.levelName || 'Level 1 - Associate'];
    database.prepare('INSERT INTO departments (id, name, levels) VALUES (?, ?, ?)').run(crypto.randomUUID(), departmentName, JSON.stringify(levels));
  }
  patchRow('employees', employee.id, { department: departmentName });
  notify(`employee:${employee.id}`, 'Department updated', `You are now in ${departmentName}.`);
  notify(`client:${employee.clientId}`, `Department · ${employee.fullName}`, `${employee.employeeCode} is in ${departmentName}.`);
  return mustEmployee(employee.id);
}

function addDesignation(user, body) {
  assertCompanyDesk(user);
  const department = database.prepare('SELECT * FROM departments WHERE id = ?').get(body.departmentId);
  if (!department) fail(404, 'Department was not found');
  const name = clip(body.name, 80);
  if (!name) fail(400, 'Name the designation');
  const levels = parse(department.levels, []);
  if (!levels.includes(name)) levels.push(name);
  patchRow('departments', department.id, { levels: JSON.stringify(levels) });
  return { id: department.id, name: department.name, levels };
}

function registerClient(body, files) {
  const required = ['incorporation', 'gst', 'msme', 'pan', 'trade'];
  for (const key of required) {
    if (!files || !files[key] || !files[key][0]) fail(400, 'Upload incorporation, GST, MSME, PAN, and trade licence');
  }
  if (String(body.consent) !== 'yes') fail(400, 'Tick the consent box before registering');
  const companyName = clip(body.companyName, 140);
  const businessType = clip(body.businessType, 140);
  const officialMail = clip(body.officialMail, 120).toLowerCase();
  const phone = clip(body.phone, 40);
  const city = clip(body.city, 60);
  const state = clip(body.state, 60);
  const country = clip(body.country, 60) || 'India';
  const street = clip(body.address, 180);
  const address = [street, city, state, country].filter(Boolean).join(', ').slice(0, 240);
  const adminName = clip(body.adminName, 80);
  const designation = clip(body.designation, 80);
  const password = String(body.password || '');
  const confirmPassword = String(body.confirmPassword || '');
  if (!companyName || !businessType || !emailOk(officialMail) || !phone || !street) {
    fail(400, 'Company name, business type, official mail, phone, and address are required');
  }
  if (password || confirmPassword) {
    if (password.length < 12) fail(400, 'Use a password of at least 12 characters');
    if (password !== confirmPassword) fail(400, 'Passwords do not match');
    if (database.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(officialMail)) {
      fail(400, 'That email is already used on another desk');
    }
  }
  const plan = chosenPlan(body.plan);
  const payment = subscriptionPayment(body, true);
  const fileMeta = (file) => ({ name: file.originalname, url: `/uploads/${file.filename}`, verified: false });
  const documents = {
    incorporation: fileMeta(files.incorporation[0]),
    gst: fileMeta(files.gst[0]),
    msme: fileMeta(files.msme[0]),
    pan: fileMeta(files.pan[0]),
    trade: fileMeta(files.trade[0]),
    extra: (files.extra || []).map(fileMeta)
  };
  const bytes = required.reduce((sum, key) => sum + files[key][0].size, 0)
    + (files.extra || []).reduce((sum, file) => sum + file.size, 0);
  const id = crypto.randomUUID();
  const applicationNumber = nextNumber('CLI');
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO clients (
    id, application_number, company_name, business_type, official_mail, phone, website, address, status, consent,
    total_budget, position_budgets, storage_used_mb, storage_limit_mb, score_target, score_achieved, score_notes,
    ad_slots, documents, onboarded_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 1, 0, '[]', ?, 1000, 100, 0, ?, 2, ?, ?)`).run(
    id, applicationNumber, companyName, businessType, officialMail, phone, clip(body.website, 160), address,
    bytes / (1024 * 1024),
    'Self-registration received. Waiting for administrator verification.',
    JSON.stringify(documents),
    now
  );
  writeOnboarding(id, {
    plan, stage: 'Registered', paymentMethod: payment.method, paymentReference: payment.reference,
    gstin: clip(body.gstin, 20).toUpperCase(), industry: businessType,
    billingName: adminName, billingEmail: officialMail, billingPhone: phone, billingAddress: address
  }, companyName, 'Plan selected', `${plans.resolve(plan).name} · ${payment.method}`);
  if (password) {
    database.prepare(`INSERT INTO users (id, role, email, password_hash, name, phone, title, client_id, employee_id, active, status_text, created_at)
      VALUES (?, 'client', ?, ?, ?, ?, ?, ?, NULL, 0, 'Pending super admin', ?)`).run(
      crypto.randomUUID(), officialMail, hashPassword(password), adminName || companyName, phone, designation || 'Client admin', id, now
    );
  }
  notify('admin', `New client · ${companyName}`, `${applicationNumber} selected ${plans.resolve(plan).name} and is waiting for document verification.`);
  return mustClient(id);
}

function listClients(user) {
  if (user.role === 'admin') return database.prepare('SELECT * FROM clients ORDER BY onboarded_at DESC').all().map(shapeClient);
  if (!user.clientId) return [];
  const row = database.prepare('SELECT * FROM clients WHERE id = ?').get(user.clientId);
  return row ? [shapeClient(row)] : [];
}

function getClient(user, id) {
  const client = mustClient(id);
  assertClient(user, client.id);
  return client;
}

function setClientStatus(user, id, body) {
  assertAdmin(user);
  const status = clip(body.status, 20);
  if (!['Approved', 'Rejected', 'Pending'].includes(status)) fail(400, 'Status must be Approved, Rejected, or Pending');
  const client = mustClient(id);
  patchRow('clients', id, { status });
  const note = clip(body.notes, 400);
  if (status === 'Approved') writeOnboarding(id, { stage: 'Approved' }, user.name, 'Approved', note);
  if (status === 'Rejected') writeOnboarding(id, { stage: 'Registered' }, user.name, 'Rejected', note);
  notify('admin', `Client ${status.toLowerCase()}`, `${client.companyName} is now ${status}.${note ? ` ${note}` : ''}`);
  notify(`client:${id}`, `Registration ${status.toLowerCase()}`, note || `${client.companyName} is ${status}.`);
  return mustClient(id);
}

function assertPlanCapacity(client, kind) {
  const plan = plans.resolve(client.onboarding && client.onboarding.plan);
  const limit = kind === 'employee' ? plan.employees : plan.clients;
  if (limit == null) return;
  const count = kind === 'employee'
    ? database.prepare('SELECT COUNT(*) AS c FROM employees WHERE client_id = ?').get(client.id).c
    : database.prepare("SELECT COUNT(*) AS c FROM users WHERE client_id = ? AND role IN ('client','hradmin') AND active = 1").get(client.id).c;
  if (count >= limit) {
    const label = kind === 'employee' ? 'employee panel' : 'company panel';
    fail(400, `${plan.name} includes ${limit} ${label}${limit === 1 ? '' : 's'}. This company already uses ${count}.`);
  }
}

function grantClientAccess(user, id, body) {
  assertAdmin(user);
  const client = mustClient(id);
  if (client.status !== 'Approved') fail(400, 'Approve the company before issuing a client login');
  const email = clip(body.email, 120).toLowerCase();
  const name = clip(body.name, 80);
  const password = String(body.password || '');
  if (!emailOk(email) || !name || password.length < 8) fail(400, 'Name, a valid email, and a password of 8 or more characters are required');
  const plan = chosenPlan(body.plan || (client.onboarding && client.onboarding.plan));
  const existing = database.prepare("SELECT * FROM users WHERE client_id = ? AND role = 'client'").get(id);
  const clash = database.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email);
  if (clash && (!existing || clash.id !== existing.id)) fail(400, 'That email is already used on another desk');
  if (existing) {
    patchRow('users', existing.id, {
      email, name, password_hash: hashPassword(password), active: 1, title: clip(body.title, 80) || existing.title
    });
  } else {
    assertPlanCapacity(client, 'client');
    database.prepare(`INSERT INTO users (id, role, email, password_hash, name, phone, title, client_id, employee_id, active, status_text, created_at)
      VALUES (?, 'client', ?, ?, ?, ?, ?, ?, NULL, 1, 'Portal access issued', ?)`).run(
      crypto.randomUUID(), email, hashPassword(password), name, clip(body.phone, 40), clip(body.title, 80) || 'Client user', id, new Date().toISOString()
    );
  }
  writeOnboarding(id, { plan, stage: client.onboarding.stage === 'Live' ? 'Live' : 'Active' }, user.name, 'Account activated', `${email} · ${plans.resolve(plan).name}`);
  notify(`client:${id}`, 'Account activated', `${name} can sign in on the company desk.`);
  return mustClient(id);
}

function grantHrAdminAccess(user, id, body) {
  if (user.isHrAdmin || user.role === 'employee') fail(403, 'The admin portal is issued by the super admin or the client admin');
  if (user.role !== 'admin' && user.role !== 'client') fail(403, 'The admin portal is issued by the super admin or the client admin');
  const client = mustClient(id);
  if (user.role === 'client') assertClient(user, client.id);
  if (client.status !== 'Approved') fail(400, 'Approve the company before issuing an admin portal');
  const email = clip(body.email, 120).toLowerCase();
  const name = clip(body.name, 80);
  const password = String(body.password || '');
  if (!emailOk(email) || !name || password.length < 8) fail(400, 'Name, a valid email, and a password of 8 or more characters are required');
  const existing = database.prepare("SELECT * FROM users WHERE client_id = ? AND role = 'hradmin' AND lower(email) = lower(?)").get(id, email);
  const clash = database.prepare('SELECT id, client_id, role FROM users WHERE lower(email) = lower(?)').get(email);
  if (clash && (!existing || clash.id !== existing.id)) fail(400, 'That email is already used on another desk');
  const waiting = user.role === 'admin' ? 'Pending client admin' : 'Pending super admin';
  if (existing && existing.active && !['Pending client admin', 'Pending super admin'].includes(existing.status_text)) {
    fail(400, 'This admin portal is already active');
  }
  if (existing) {
    patchRow('users', existing.id, {
      name, password_hash: hashPassword(password), active: 0, phone: clip(body.phone, 40),
      title: clip(body.title, 80) || existing.title || 'HR admin', status_text: waiting
    });
  } else {
    assertPlanCapacity(client, 'client');
    database.prepare(`INSERT INTO users (id, role, email, password_hash, name, phone, title, client_id, employee_id, active, status_text, created_at)
      VALUES (?, 'hradmin', ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`).run(
      crypto.randomUUID(), email, hashPassword(password), name, clip(body.phone, 40), clip(body.title, 80) || 'HR admin', id, waiting, new Date().toISOString()
    );
  }
  const other = waiting === 'Pending client admin' ? `client:${id}` : 'admin';
  notify(other, `Admin portal · ${client.companyName}`, `${name} is waiting for confirmation.`);
  notify(user.role === 'admin' ? 'admin' : `client:${id}`, `Admin portal · ${name}`, `Started by the ${user.role === 'admin' ? 'super admin' : 'client admin'}. The other desk confirms it.`);
  return mustClient(id);
}

function confirmHrAdminAccess(user, id, userId) {
  if (user.isHrAdmin || user.role === 'employee') fail(403, 'The admin portal is confirmed by the super admin or the client admin');
  const client = mustClient(id);
  if (user.role === 'client') assertClient(user, client.id);
  const person = database.prepare("SELECT * FROM users WHERE id = ? AND client_id = ? AND role = 'hradmin'").get(userId, id);
  if (!person) fail(404, 'Admin portal was not found');
  if (person.active && !['Pending client admin', 'Pending super admin'].includes(person.status_text)) fail(400, 'This admin portal is already active');
  if (person.status_text === 'Pending client admin') {
    if (user.role !== 'client' || user.isHrAdmin) fail(403, 'The client admin confirms this portal');
  } else if (person.status_text === 'Pending super admin') {
    if (user.role !== 'admin') fail(403, 'The super admin confirms this portal');
  } else fail(400, 'This admin portal is not waiting for confirmation');
  assertPlanCapacity(client, 'client');
  patchRow('users', person.id, { active: 1, status_text: 'Issued by the super admin and the client admin' });
  notify(`client:${id}`, 'Admin portal active', `${person.name} can sign in on the company admin desk.`);
  notify('admin', `Admin portal · ${client.companyName}`, `${person.name} was confirmed by the ${user.role === 'admin' ? 'super admin' : 'client admin'}.`);
  return mustClient(id);
}

function addBranch(user, clientId, body) {
  const client = mustClient(clientId);
  assertClient(user, client.id);
  if (user.role === 'employee') fail(403, 'Branches are maintained by the company or administrator');
  const name = clip(body.name, 80);
  const city = clip(body.city, 60);
  const address = clip(body.address, 180);
  if (!name || !city) fail(400, 'Branch name and city are required');
  const id = crypto.randomUUID();
  database.prepare('INSERT INTO branches (id, client_id, name, city, address, staff_count) VALUES (?, ?, ?, ?, ?, 0)')
    .run(id, clientId, name, city, address);
  return shapeBranch(database.prepare('SELECT * FROM branches WHERE id = ?').get(id));
}

function setScorecard(user, clientId, body) {
  const client = mustClient(clientId);
  assertClient(user, client.id);
  if (user.role === 'employee') fail(403, 'Scorecards are maintained by the company or administrator');
  patchRow('clients', clientId, {
    score_target: Number(body.target) || 0,
    score_achieved: Number(body.achieved) || 0,
    score_notes: clip(body.notes, 400)
  });
  return mustClient(clientId);
}

function setBudgets(user, clientId, body) {
  const client = mustClient(clientId);
  assertClient(user, client.id);
  if (user.role === 'employee') fail(403, 'Budgets are maintained by the company or administrator');
  if (!Array.isArray(body.positionBudgets) || !body.positionBudgets.length) fail(400, 'Add at least one position budget');
  const positionBudgets = body.positionBudgets.map((row) => ({
    position: clip(row.position, 80),
    budget: Number(row.budget) || 0,
    allocated: Number(row.allocated) || 0
  })).filter((row) => row.position);
  const total = positionBudgets.reduce((sum, row) => sum + row.budget, 0);
  patchRow('clients', clientId, { position_budgets: JSON.stringify(positionBudgets), total_budget: Number(body.totalBudget) || total });
  return mustClient(clientId);
}

function setAdSlots(user, clientId, body) {
  assertAdmin(user);
  mustClient(clientId);
  const slots = Math.max(0, Math.min(20, Number(body.adSlots) || 0));
  patchRow('clients', clientId, { ad_slots: slots });
  return mustClient(clientId);
}

function chosenPlan(code) {
  const plan = plans.list().find((item) => item.id === code);
  if (!plan) fail(400, 'Choose a subscription plan');
  return plan.id;
}

function publicPlans() {
  return plans.list();
}

function publicStory() {
  return {
    companies: database.prepare("SELECT COUNT(*) AS c FROM clients WHERE status = 'Approved'").get().c,
    people: database.prepare('SELECT COUNT(*) AS c FROM employees').get().c,
    rating: '4.8'
  };
}

function publicDemo(body) {
  const companyName = clip(body.companyName, 140);
  const contactName = clip(body.contactName, 80);
  const phone = clip(body.phone, 40);
  const email = clip(body.email, 120).toLowerCase();
  const state = clip(body.state, 60);
  const language = clip(body.language, 40);
  if (!companyName || !contactName || !phone || !emailOk(email) || !state) {
    fail(400, 'Company, contact name, mobile, official mail, and state are required');
  }
  const id = crypto.randomUUID();
  const notes = `Demo enquiry. State ${state}. Language ${language || 'Not given'}.`;
  database.prepare(`INSERT INTO leads (id, company_name, contact_name, phone, email, business_type, priority, assigned_to, status, notes, next_call_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'Runwork demo', 'High', 'Ravi Menon', 'Priority call', ?, '', ?)`).run(
    id, companyName, contactName, phone, email, notes, new Date().toISOString()
  );
  notify('admin', `Demo enquiry · ${companyName}`, `${contactName} asked to talk with the team.`);
  return { id, companyName, contactName };
}

function publicNewsletter(body) {
  const email = clip(body.email, 120).toLowerCase();
  if (!emailOk(email)) fail(400, 'Enter a valid email for the newsletter');
  const id = crypto.randomUUID();
  database.prepare(`INSERT INTO leads (id, company_name, contact_name, phone, email, business_type, priority, assigned_to, status, notes, next_call_at, created_at)
    VALUES (?, 'Newsletter', 'Landing page', '', ?, 'Newsletter', 'Normal', 'Ravi Menon', 'New', 'Asked for the Runwork newsletter.', '', ?)`).run(
    id, email, new Date().toISOString()
  );
  return { id, email };
}

function publicApplication(body, file) {
  const fullName = clip(body.fullName, 80);
  const lookingFor = clip(body.lookingFor, 80);
  const phone = clip(body.phone, 40);
  const description = clip(body.description, 400);
  if (!fullName || !lookingFor || !phone || !description) fail(400, 'Name, what you are looking for, mobile, and a short description are required');
  const fileNote = file ? ` Document ${file.originalname}.` : '';
  const id = crypto.randomUUID();
  database.prepare(`INSERT INTO leads (id, company_name, contact_name, phone, email, business_type, priority, assigned_to, status, notes, next_call_at, created_at)
    VALUES (?, 'Hiring enquiry', ?, ?, '', ?, 'Normal', 'Ravi Menon', 'New', ?, '', ?)`).run(
    id, fullName, phone, lookingFor, clip(`${description}${fileNote}`, 400), new Date().toISOString()
  );
  notify('admin', `Hiring enquiry · ${fullName}`, `${lookingFor}. ${description}`);
  return { id, fullName };
}

const PAYMENT_METHODS = ['UPI', 'Bank transfer', 'Card', 'Net banking', 'Cheque'];

function subscriptionPayment(body, required) {
  const method = PAYMENT_METHODS.includes(body.paymentMethod) ? body.paymentMethod : '';
  if (required && !method) fail(400, 'Choose how the subscription will be paid');
  const reference = clip(body.paymentReference, 80);
  if (/\d{12,}/.test(reference)) fail(400, 'Do not enter a card number. Card payments are collected by the super admin');
  return { method: method || 'Bank transfer', reference };
}

function blankOnboarding(stage) {
  return {
    stage: stage || 'Registered',
    legalName: '', cin: '', gstin: '', pan: '', industry: '',
    billingName: '', billingEmail: '', billingPhone: '', billingAddress: '', paymentMode: 'Bank transfer',
    service: '', contractStart: '', contractEnd: '', contractValue: 0, terms: '',
    plan: 'hr-easy', fee: 0, cycle: 'Monthly', paymentStatus: 'Unpaid', paymentMethod: 'Bank transfer', paymentReference: '',
    handoverOwner: '', handoverStart: '', handoverDone: '', handoverNotes: '',
    closureReason: '', closedOn: '',
    history: []
  };
}

function clientOnboarding(row) {
  const base = blankOnboarding(row.status === 'Approved' ? 'Live' : 'Registered');
  return { ...base, ...parse(row.onboarding, {}), history: parse(row.onboarding, {}).history || [] };
}

function writeOnboarding(id, patch, actor, action, detail) {
  const row = database.prepare('SELECT onboarding, status FROM clients WHERE id = ?').get(id);
  const current = clientOnboarding(row);
  const next = { ...current, ...patch };
  next.history = [{ at: new Date().toISOString(), actor: actor || '', action, detail: detail || '' }, ...(current.history || [])].slice(0, 40);
  patchRow('clients', id, { onboarding: JSON.stringify(next) });
}

function updateClientProfile(user, clientId, body) {
  const client = mustClient(clientId);
  assertClient(user, client.id);
  if (user.role === 'employee') fail(403, 'Company details are maintained by the company desk');
  patchRow('clients', clientId, {
    phone: clip(body.phone, 40) || client.phone,
    website: clip(body.website, 160),
    address: clip(body.address, 240) || client.address
  });
  writeOnboarding(clientId, {}, user.name, 'Profile updated', 'Contact details were saved.');
  return mustClient(clientId);
}

function createClientAdmin(user, body) {
  assertAdmin(user);
  const companyName = clip(body.companyName, 140);
  const businessType = clip(body.businessType, 140);
  const officialMail = clip(body.officialMail, 120).toLowerCase();
  const phone = clip(body.phone, 40);
  const address = clip(body.address, 240);
  if (!companyName || !businessType || !emailOk(officialMail) || !phone || !address) {
    fail(400, 'Company name, business type, official mail, phone, and address are required');
  }
  const plan = chosenPlan(body.plan);
  const payment = subscriptionPayment(body, true);
  const id = crypto.randomUUID();
  const applicationNumber = nextNumber('CLI');
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO clients (
    id, application_number, company_name, business_type, official_mail, phone, website, address, status, consent,
    total_budget, position_budgets, storage_used_mb, storage_limit_mb, score_target, score_achieved, score_notes,
    ad_slots, documents, onboarded_at, onboarding
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 1, 0, '[]', 0, 1000, 100, 0, ?, 2, ?, ?, ?)`).run(
    id, applicationNumber, companyName, businessType, officialMail, phone, clip(body.website, 160), address,
    'Registered by the administrator. Documents are still required.',
    JSON.stringify({ incorporation: null, gst: null, msme: null, pan: null, trade: null, extra: [] }),
    now,
    JSON.stringify(blankOnboarding('Registered'))
  );
  writeOnboarding(id, { legalName: companyName, plan, paymentMethod: payment.method, paymentReference: payment.reference }, user.name, 'Registered', `${plans.resolve(plan).name} · ${payment.method}`);
  notify('admin', `Client registered · ${companyName}`, `${applicationNumber} is waiting for documents and verification.`);
  return mustClient(id);
}

function saveClientCase(user, id, body) {
  const client = mustClient(id);
  assertClient(user, client.id);
  if (user.role === 'employee') fail(403, 'Company onboarding stays with the company desk and the administrator');
  if (client.status === 'Closed' || client.onboarding.stage === 'Closed') fail(400, 'This company is closed');
  const section = body.section;
  if (section === 'master') {
    assertAdmin(user);
    const companyName = clip(body.companyName, 140);
    const officialMail = clip(body.officialMail, 120).toLowerCase();
    if (!companyName || !emailOk(officialMail)) fail(400, 'Company name and official mail are required');
    patchRow('clients', id, {
      company_name: companyName,
      business_type: clip(body.businessType, 140) || client.businessType,
      official_mail: officialMail,
      phone: clip(body.phone, 40) || client.phone,
      website: clip(body.website, 160),
      address: clip(body.address, 240) || client.address
    });
    writeOnboarding(id, {}, user.name, 'Master updated', companyName);
  } else if (section === 'organization') {
    writeOnboarding(id, {
      legalName: clip(body.legalName, 140), cin: clip(body.cin, 40), gstin: clip(body.gstin, 20),
      pan: clip(body.pan, 12).toUpperCase(), industry: clip(body.industry, 80)
    }, user.name, 'Organization saved', clip(body.legalName, 140));
  } else if (section === 'billing') {
    writeOnboarding(id, {
      billingName: clip(body.billingName, 80), billingEmail: clip(body.billingEmail, 120),
      billingPhone: clip(body.billingPhone, 40), billingAddress: clip(body.billingAddress, 240),
      paymentMode: PAYMENT_METHODS.includes(body.paymentMode) ? body.paymentMode : 'Bank transfer'
    }, user.name, 'Billing saved', clip(body.billingEmail, 120));
  } else if (section === 'contract') {
    writeOnboarding(id, {
      service: clip(body.service, 160), contractStart: clip(body.contractStart, 10), contractEnd: clip(body.contractEnd, 10),
      contractValue: Math.round(Number(body.contractValue) || 0), terms: clip(body.terms, 400)
    }, user.name, 'Contract saved', clip(body.service, 160));
  } else if (section === 'plan') {
    assertAdmin(user);
    const plan = plans.list().some((item) => item.id === body.plan) ? body.plan : '';
    if (!plan) fail(400, 'Choose a subscription plan');
    const payment = subscriptionPayment(body, true);
    writeOnboarding(id, {
      plan, fee: Math.round(Number(body.fee) || 0),
      cycle: ['Monthly', 'Quarterly', 'Yearly'].includes(body.cycle) ? body.cycle : 'Monthly',
      paymentStatus: ['Unpaid', 'Part paid', 'Paid'].includes(body.paymentStatus) ? body.paymentStatus : 'Unpaid',
      paymentMethod: payment.method, paymentReference: payment.reference
    }, user.name, 'Plan set', `${plan} · ${payment.method} · ${body.paymentStatus || 'Unpaid'}`);
  } else fail(400, 'Choose which part of the record to save');
  notify(`client:${id}`, `Onboarding · ${section}`, `${user.name} updated ${section}.`);
  if (user.role === 'client') notify('admin', `Onboarding · ${client.companyName}`, `${user.name} updated ${section}.`);
  return mustClient(id);
}

function verifyClientDocument(user, id, body) {
  assertAdmin(user);
  const client = mustClient(id);
  const key = ['incorporation', 'gst', 'msme', 'pan', 'trade'].includes(body.key) ? body.key : '';
  if (!key || !client.documents[key] || !client.documents[key].name) fail(400, 'That document is not on file');
  const documents = client.documents;
  documents[key].verified = body.verified !== 'no';
  patchRow('clients', id, { documents: JSON.stringify(documents) });
  writeOnboarding(id, {}, user.name, documents[key].verified ? 'Document verified' : 'Document unchecked', key);
  notify(`client:${id}`, `Document · ${key}`, documents[key].verified ? 'The administrator verified this document.' : 'Verification was removed.');
  return mustClient(id);
}

function addClientDocument(user, id, body, file) {
  assertAdmin(user);
  if (!file) fail(400, 'Choose a file');
  const client = mustClient(id);
  const key = ['incorporation', 'gst', 'msme', 'pan', 'trade'].includes(body.key) ? body.key : '';
  if (!key) fail(400, 'Choose the document type');
  const stored = acceptUpload(user, file);
  const documents = client.documents || {};
  documents[key] = { name: stored.name, url: stored.url, verified: false };
  patchRow('clients', id, { documents: JSON.stringify(documents) });
  writeOnboarding(id, {}, user.name, 'Document uploaded', key);
  notify(`client:${id}`, `Document received · ${key}`, 'The administrator added this file to the company record.');
  return mustClient(id);
}

function advanceClient(user, id, body) {
  assertAdmin(user);
  const client = mustClient(id);
  const step = body.step;
  if (step === 'verify') {
    const missing = ['incorporation', 'gst', 'msme', 'pan', 'trade'].filter((key) => !client.documents[key] || !client.documents[key].verified);
    if (missing.length) fail(400, `Verify these documents first: ${missing.join(', ')}`);
    writeOnboarding(id, { stage: 'Verified' }, user.name, 'Verified', 'Mandatory documents are verified.');
  } else if (step === 'approve') {
    patchRow('clients', id, { status: 'Approved' });
    writeOnboarding(id, { stage: 'Approved' }, user.name, 'Approved', clip(body.notes, 240) || 'Company approved.');
  } else if (step === 'implement') {
    if (!['Active', 'Approved'].includes(client.onboarding.stage) && client.status !== 'Approved') fail(400, 'Approve and activate the account before implementation');
    writeOnboarding(id, {
      stage: 'Implementation',
      handoverOwner: clip(body.handoverOwner, 80) || user.name,
      handoverStart: clip(body.handoverStart, 10) || kolkataStamp().date
    }, user.name, 'Implementation started', clip(body.handoverNotes, 240));
  } else if (step === 'handover') {
    writeOnboarding(id, {
      stage: 'Live',
      handoverDone: clip(body.handoverDone, 10) || kolkataStamp().date,
      handoverNotes: clip(body.handoverNotes, 400) || client.onboarding.handoverNotes
    }, user.name, 'Handover complete', 'The company desk is live.');
  } else if (step === 'close') {
    const reason = clip(body.reason, 240);
    if (!reason) fail(400, 'Give the reason for closure');
    patchRow('clients', id, { status: 'Closed' });
    writeOnboarding(id, { stage: 'Closed', closureReason: reason, closedOn: clip(body.closedOn, 10) || kolkataStamp().date }, user.name, 'Closed', reason);
  } else fail(400, 'Choose the onboarding step');
  notify(`client:${id}`, `Onboarding · ${step}`, `${client.companyName} moved through ${step}.`);
  notify('admin', `Onboarding · ${client.companyName}`, `${step} recorded by ${user.name}.`);
  return mustClient(id);
}

function listClientRequests(user) {
  let sql = `SELECT r.*, c.company_name FROM client_requests r JOIN clients c ON c.id = r.client_id`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE r.client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') fail(403, 'Commercial requests stay with the company and the administrator');
  sql += ' ORDER BY r.created_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, applicationNumber: row.application_number, clientId: row.client_id, companyName: row.company_name,
    kind: row.kind, detail: row.detail, plan: row.plan || '', planName: plans.resolve(row.plan).name, fee: Number(row.fee) || 0, cycle: row.cycle || '',
    paymentMethod: row.payment_method || '', paymentReference: row.payment_reference || '',
    status: row.status, raisedBy: row.raised_by || '', createdAt: row.created_at, decidedAt: row.decided_at || ''
  }));
}

function createClientRequest(user, body) {
  if (user.isHrAdmin) fail(403, 'Subscription changes stay with the client admin');
  if (user.role === 'employee') fail(403, 'Plan requests are raised by the company or the administrator');
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  const client = mustClient(clientId);
  if (user.role === 'client') assertClient(user, client.id);
  const kind = body.kind === 'Plan change' ? 'Plan change' : '';
  const detail = clip(body.detail, 400);
  const plan = plans.list().some((item) => item.id === body.plan) ? body.plan : '';
  if (!kind || !detail || !plan) fail(400, 'Choose the plan and say why it should change');
  const payment = subscriptionPayment(body, true);
  const status = 'Pending verification';
  const id = crypto.randomUUID();
  const number = nextNumber('CLIQ');
  database.prepare(`INSERT INTO client_requests (id, application_number, client_id, kind, detail, plan, fee, cycle, payment_method, payment_reference, status, raised_by, created_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`).run(
    id, number, client.id, kind, detail, plan, Math.round(Number(body.fee) || 0),
    ['Monthly', 'Quarterly', 'Yearly'].includes(body.cycle) ? body.cycle : 'Monthly',
    payment.method, payment.reference, status, user.name, new Date().toISOString()
  );
  notify('admin', `Plan change · ${client.companyName}`, `${number} asks for ${plan} by ${payment.method}. ${detail}`);
  notify(`client:${client.id}`, `Plan change · ${number}`, `${plan} is ${status}.`);
  return listClientRequests(user);
}

function setClientRequest(user, id, body) {
  assertAdmin(user);
  const row = database.prepare('SELECT * FROM client_requests WHERE id = ?').get(id);
  if (!row) fail(404, 'Client request was not found');
  const decision = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Approved or Rejected');
  let next = decision;
  if (decision === 'Approved' && row.status === 'Pending verification') next = 'Pending approval';
  else if (decision === 'Approved' && row.status === 'Pending approval') next = 'Approved';
  else if (decision === 'Rejected' && ['Pending verification', 'Pending approval'].includes(row.status)) next = 'Rejected';
  else fail(400, 'This request is already closed');
  patchRow('client_requests', id, { status: next, decided_at: new Date().toISOString() });
  if (next === 'Approved') {
    writeOnboarding(row.client_id, { plan: row.plan, fee: row.fee, cycle: row.cycle, paymentStatus: 'Unpaid', paymentMethod: row.payment_method || 'Bank transfer', paymentReference: row.payment_reference || '' }, user.name, 'Plan changed', `${row.plan} · ${row.cycle} · ${row.payment_method || 'Bank transfer'}`);
  }
  notify(`client:${row.client_id}`, `${next} · ${row.application_number}`, `${row.kind} is ${next}.`);
  notify('admin', `${next} · ${row.application_number}`, `${row.plan} is ${next}.`);
  return listClientRequests(user);
}

function listEmployees(user, filter = {}) {
  const where = [];
  const params = [];
  if (user.role === 'employee') { where.push('e.id = ?'); params.push(user.employeeId); }
  else if (user.role === 'client') { where.push('e.client_id = ?'); params.push(user.clientId); }
  else if (filter.clientId) { where.push('e.client_id = ?'); params.push(filter.clientId); }
  if (filter.department) { where.push('e.department = ?'); params.push(filter.department); }
  if (filter.branchId) { where.push('e.branch_id = ?'); params.push(filter.branchId); }
  const sql = `${employeeSql} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.full_name`;
  return database.prepare(sql).all(...params).map(shapeEmployee);
}

function getEmployee(user, id) {
  const employee = mustEmployee(id);
  assertEmployee(user, employee);
  return employee;
}

function createEmployee(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : body.clientId;
  const client = mustClient(clientId);
  if (user.role === 'client') assertClient(user, client.id);
  if (client.status !== 'Approved') fail(400, 'Issue workforce only for an approved company');
  assertPlanCapacity(client, 'employee');
  const branch = database.prepare('SELECT * FROM branches WHERE id = ? AND client_id = ?').get(body.branchId, client.id);
  if (!branch) fail(400, 'Choose a branch that belongs to this company');
  const shift = database.prepare('SELECT * FROM shifts WHERE id = ?').get(body.shiftId);
  if (!shift) fail(400, 'Choose a shift');
  const fullName = clip(body.fullName, 80);
  const email = clip(body.email, 120).toLowerCase();
  const hiringSource = HIRING.includes(body.hiringSource) ? body.hiringSource : '';
  if (!fullName || !emailOk(email) || !clip(body.department, 80) || !clip(body.levelName, 80) || !clip(body.roleTitle, 80) || !hiringSource) {
    fail(400, 'Name, email, department, level, role, and hiring source are required');
  }
  const hasLogin = user.role === 'admin' && !!body.hasLogin;
  const password = String(body.password || '');
  if (hasLogin && password.length < 8) fail(400, 'A portal password needs 8 or more characters, or leave login turned off');
  if (hasLogin && database.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email)) {
    fail(400, 'That email already has a login');
  }
  const payrollData = {
    basicSalary: Number(body.basicSalary) || 0,
    hra: Number(body.hra) || 0,
    specialAllowance: Number(body.specialAllowance) || 0,
    employeePf: Number(body.employeePf) || 0,
    employeeEsic: Number(body.employeeEsic) || 0,
    tds: Number(body.tds) || 0,
    otRate: Number(body.otRate) || 0,
    paidDays: Number(body.paidDays) || 0,
    presentDays: Number(body.presentDays) || 0
  };
  const statutory = {
    pfUan: clip(body.pfUan, 20),
    esicNumber: clip(body.esicNumber, 20),
    panNumber: clip(body.panNumber, 12).toUpperCase(),
    bloodGroup: clip(body.bloodGroup, 8)
  };
  const id = crypto.randomUUID();
  const nowCode = nextNumber('EMPCODE').replace('APP-EMPCODE-2026-', 'EMP-2026-');
  return transaction(() => {
    database.prepare(`INSERT INTO employees (
      id, employee_code, application_number, client_id, branch_id, full_name, email, phone, emergency_name, emergency_phone,
      photo_url, department, level_name, role_title, shift_id, reporting_manager, hiring_source, source_company, reputed_company,
      bgv_status, has_login, payroll, statutory, documents, warnings, status, joined_on
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'Onboarding', ?)`).run(
      id, nowCode, nextNumber('EMP'), client.id, branch.id, fullName, email, clip(body.phone, 40),
      clip(body.emergencyName, 80), clip(body.emergencyPhone, 40), clip(body.photoUrl, 240),
      clip(body.department, 80), clip(body.levelName, 80), clip(body.roleTitle, 80), shift.id,
      clip(body.reportingManager, 80), hiringSource, clip(body.sourceCompany, 120), clip(body.reputedCompany, 120) || client.companyName,
      'Processing', hasLogin ? 1 : 0, JSON.stringify(payrollData), JSON.stringify(statutory),
      JSON.stringify({ aadhaar: { name: '', url: '' }, pan: { name: '', url: '' }, marksheet: { name: '', url: '' }, bank: { name: '', url: '' } }),
      clip(body.joinedOn, 10) || kolkataStamp().date
    );
    const joined = clip(body.joinedOn, 10) || kolkataStamp().date;
    patchRow('employees', id, { workflow: JSON.stringify(blankWorkflow(joined)) });
    database.prepare(`INSERT INTO lifecycle_events (id, employee_id, kind, event_date, notes, from_value, to_value, created_at)
      VALUES (?, ?, 'Onboarding', ?, 'Employee joining recorded.', '', ?, ?)`).run(
      crypto.randomUUID(), id, joined, client.companyName, new Date().toISOString()
    );
    database.prepare('UPDATE branches SET staff_count = staff_count + 1 WHERE id = ?').run(branch.id);
    if (hasLogin) {
      database.prepare(`INSERT INTO users (id, role, email, password_hash, name, phone, title, client_id, employee_id, active, status_text, created_at)
        VALUES (?, 'employee', ?, ?, ?, ?, ?, ?, ?, 1, 'Login issued by administrator', ?)`).run(
        crypto.randomUUID(), email, hashPassword(password), fullName, clip(body.phone, 40), clip(body.roleTitle, 80),
        client.id, id, new Date().toISOString()
      );
    }
    notify('admin', `Workforce added · ${fullName}`, `${nowCode} joined ${client.companyName} and is in onboarding.`);
    notify(`client:${client.id}`, `New joiner · ${fullName}`, `${nowCode} is in onboarding.`);
    return mustEmployee(id);
  });
}

function updateEmployee(user, id, body) {
  assertCompanyDesk(user);
  const current = mustEmployee(id);
  assertEmployee(user, current);
  const branchId = body.branchId || current.branchId;
  const branch = database.prepare('SELECT * FROM branches WHERE id = ? AND client_id = ?').get(branchId, current.clientId);
  if (!branch) fail(400, 'That branch is not on this company');
  const shift = database.prepare('SELECT id FROM shifts WHERE id = ?').get(body.shiftId || current.shiftId);
  if (!shift) fail(400, 'Choose a shift');
  if (branchId !== current.branchId) {
    database.prepare('UPDATE branches SET staff_count = MAX(staff_count - 1, 0) WHERE id = ?').run(current.branchId);
    database.prepare('UPDATE branches SET staff_count = staff_count + 1 WHERE id = ?').run(branchId);
  }
  patchRow('employees', id, {
    full_name: clip(body.fullName, 80) || current.fullName,
    phone: clip(body.phone, 40),
    emergency_name: clip(body.emergencyName, 80),
    emergency_phone: clip(body.emergencyPhone, 40),
    photo_url: body.photoUrl != null ? clip(body.photoUrl, 240) : current.photoUrl,
    department: clip(body.department, 80) || current.department,
    level_name: clip(body.levelName, 80) || current.levelName,
    role_title: clip(body.roleTitle, 80) || current.roleTitle,
    shift_id: shift.id,
    branch_id: branchId,
    reporting_manager: clip(body.reportingManager, 80),
    hiring_source: HIRING.includes(body.hiringSource) ? body.hiringSource : current.hiringSource,
    source_company: clip(body.sourceCompany, 120),
    reputed_company: clip(body.reputedCompany, 120),
    bgv_status: ['Not started', 'Processing', 'Positive', 'Negative'].includes(body.bgvStatus) ? body.bgvStatus : current.bgvStatus
  });
  if (body.statutory) {
    patchRow('employees', id, { statutory: JSON.stringify({
      pfUan: clip(body.statutory.pfUan, 20),
      esicNumber: clip(body.statutory.esicNumber, 20),
      panNumber: clip(body.statutory.panNumber, 12).toUpperCase(),
      bloodGroup: clip(body.statutory.bloodGroup, 8)
    }) });
  }
  return mustEmployee(id);
}

function setPayroll(user, id, body) {
  assertAdmin(user);
  mustEmployee(id);
  const current = parse(database.prepare('SELECT payroll FROM employees WHERE id = ?').get(id).payroll, {});
  const next = { ...current };
  for (const group of payroll.catalog) {
    for (const [key] of group.fields) {
      if (body[key] != null && body[key] !== '') next[key] = Number(body[key]) || 0;
    }
  }
  patchRow('employees', id, { payroll: JSON.stringify(next) });
  return mustEmployee(id);
}

function addWarning(user, id, body) {
  assertCompanyDesk(user);
  const employee = mustEmployee(id);
  assertEmployee(user, employee);
  const message = clip(body.message, 400);
  if (!message) fail(400, 'Write the warning text');
  const warnings = employee.warnings.concat({ id: crypto.randomUUID(), message, at: new Date().toISOString() });
  patchRow('employees', id, { warnings: JSON.stringify(warnings) });
  notify(`employee:${id}`, 'Warning on your record', message);
  return mustEmployee(id);
}

function setEmployeeLogin(user, id, body) {
  assertAdmin(user);
  const employee = mustEmployee(id);
  const enable = !!body.hasLogin;
  const existing = database.prepare("SELECT * FROM users WHERE employee_id = ? AND role = 'employee'").get(id);
  if (!enable) {
    patchRow('employees', id, { has_login: 0 });
    if (existing) patchRow('users', existing.id, { active: 0 });
    return mustEmployee(id);
  }
  const password = String(body.password || '');
  if (password.length < 8) fail(400, 'Set a password of 8 or more characters');
  if (existing) {
    patchRow('users', existing.id, { active: 1, password_hash: hashPassword(password), name: employee.fullName });
  } else {
    if (database.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(employee.email)) {
      fail(400, 'That employee email already belongs to a login');
    }
    database.prepare(`INSERT INTO users (id, role, email, password_hash, name, phone, title, client_id, employee_id, active, status_text, created_at)
      VALUES (?, 'employee', ?, ?, ?, ?, ?, ?, ?, 1, 'Login issued by administrator', ?)`).run(
      crypto.randomUUID(), employee.email, hashPassword(password), employee.fullName, employee.phone,
      employee.roleTitle, employee.clientId, employee.id, new Date().toISOString()
    );
  }
  patchRow('employees', id, { has_login: 1 });
  return mustEmployee(id);
}

const attendanceSql = `SELECT a.*, e.full_name AS employee_name, e.employee_code, c.company_name,
  b.name AS branch_name, loc.name AS location_name, loc.kind AS location_kind
  FROM attendance a
  JOIN employees e ON e.id = a.employee_id
  JOIN clients c ON c.id = a.client_id
  JOIN branches b ON b.id = e.branch_id
  LEFT JOIN locations loc ON loc.id = a.location_id`;

function listAttendance(user, filter = {}) {
  const where = [];
  const params = [];
  if (user.role === 'employee') { where.push('a.employee_id = ?'); params.push(user.employeeId); }
  else if (user.role === 'client') { where.push('a.client_id = ?'); params.push(user.clientId); }
  else if (filter.clientId) { where.push('a.client_id = ?'); params.push(filter.clientId); }
  if (filter.employeeId && user.role !== 'employee') { where.push('a.employee_id = ?'); params.push(filter.employeeId); }
  if (filter.date) { where.push('a.work_date = ?'); params.push(filter.date); }
  if (filter.branchId) { where.push('e.branch_id = ?'); params.push(filter.branchId); }
  if (filter.locationId) { where.push('a.location_id = ?'); params.push(filter.locationId); }
  const sql = `${attendanceSql} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.work_date DESC, a.in_time DESC LIMIT 300`;
  return database.prepare(sql).all(...params).map(shapeAttendance);
}

function attendanceRules(clientId) {
  const row = database.prepare('SELECT * FROM attendance_rules WHERE client_id = ?').get(clientId);
  if (!row) return { lateGrace: 10, earlyGrace: 10, otAfter: 0, modes: ['Web', 'Manual', 'QR', 'ID card', 'Biometric', 'Roster'] };
  return {
    lateGrace: Number(row.late_grace) || 0,
    earlyGrace: Number(row.early_grace) || 0,
    otAfter: Number(row.ot_after) || 0,
    modes: [...new Set([...parse(row.modes, []), 'Web', 'Manual', 'QR', 'ID card', 'Biometric', 'Roster'])]
  };
}

function clockOn(date, hhmm) {
  if (!hhmm) return '';
  return `${date}T${hhmm}:00+05:30`;
}

function localMinutes(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{2}:\d{2}$/.test(text)) return minutes(text);
  if (text.includes('+05:30')) return minutes(text.slice(11, 16));
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  const part = date.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return minutes(part);
}

function judgePunch(shiftStart, shiftEnd, inIso, outIso, rules) {
  const start = minutes(shiftStart);
  let end = minutes(shiftEnd);
  const inM = localMinutes(inIso);
  const outM = localMinutes(outIso);
  const overnight = end <= start;
  if (overnight) end += 1440;
  const late = inM != null && inM > start + rules.lateGrace;
  let early = false;
  let otHours = 0;
  if (outM != null) {
    let compare = outM;
    if (overnight && compare < start) compare += 1440;
    early = compare < end - rules.earlyGrace;
    otHours = Math.round((Math.max(0, compare - end - rules.otAfter) / 60) * 100) / 100;
  }
  return { late, early, otHours };
}

function employeeByCode(code) {
  const raw = String(code || '').trim();
  const employeeCode = raw.startsWith('S1HR|') ? (raw.split('|')[1] || '').trim() : raw;
  if (!employeeCode) return null;
  const row = database.prepare(`${employeeSql} WHERE lower(e.employee_code) = lower(?) OR e.application_number = ?`).get(employeeCode, employeeCode);
  return row ? shapeEmployee(row) : null;
}

function captureAttendance(user, body) {
  const method = ['Manual', 'QR', 'ID card', 'Web'].includes(body.method) ? body.method : 'Manual';
  let employee;
  if (user.role === 'employee' || (!body.employeeId && user.employeeId)) {
    employee = mustEmployee(user.employeeId);
    if (method === 'QR' || method === 'ID card') {
      const scanned = employeeByCode(body.code);
      if (!scanned) fail(404, method === 'QR' ? 'That QR code was not recognised' : 'That ID card was not recognised');
      if (scanned.id !== employee.id) fail(403, 'This card belongs to another employee');
    }
  } else {
    assertCompanyDesk(user);
    if (method === 'Manual' || method === 'Web') {
      const targetId = body.employeeId || user.employeeId;
      if (!targetId) {
        const emp = database.prepare('SELECT id FROM employees WHERE lower(email) = lower(?)').get(user.email);
        if (emp) employee = mustEmployee(emp.id);
        else fail(400, 'Choose the employee for a manual punch');
      } else {
        employee = mustEmployee(targetId);
      }
    } else {
      employee = employeeByCode(body.code);
      if (!employee) fail(404, method === 'QR' ? 'That QR code was not recognised' : 'That ID card was not recognised');
    }
    assertEmployee(user, employee);
  }
  if (employee.status !== 'Active') fail(400, 'This workforce record is not active');
  const stamp = kolkataStamp();
  const existing = database.prepare('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?').get(employee.id, stamp.date);
  const lat = body.lat == null || body.lat === '' ? null : Number(body.lat);
  const lng = body.lng == null || body.lng === '' ? null : Number(body.lng);
  const located = lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng);
  const place = located ? ` Location ${lat.toFixed(5)}, ${lng.toFixed(5)}.` : '';
  const action = body.action === 'out' ? 'out' : (body.action === 'in' ? 'in' : (existing && existing.in_time && !existing.out_time ? 'out' : 'in'));
  const note = `${method} ${action === 'in' ? 'punch in' : 'punch out'} at ${stamp.time} by ${user.name}.${place}`;
  if (action === 'in') {
    if (existing && existing.in_time) fail(400, `${employee.fullName} is already punched in today`);
    const rules = attendanceRules(employee.clientId);
    const judged = judgePunch(employee.shiftStart, employee.shiftEnd, stamp.iso, '', rules);
    const id = crypto.randomUUID();
    database.prepare(`INSERT INTO attendance (
      id, employee_id, client_id, work_date, shift_name, in_time, out_time, in_lat, in_lng, out_lat, out_lng,
      location_note, status, penalty, penalty_remarks, ot_hours, ot_amount, lop_days, flag, mode
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, 0, '', 0, 0, 0, ?, ?)`).run(
      id, employee.id, employee.clientId, stamp.date, employee.shiftName, stamp.iso,
      located ? lat : null, located ? lng : null, note, judged.late ? 'Late' : 'Present',
      judged.late ? 'red' : 'green', method
    );
    stampAttendancePlace(employee.id, stamp.date, employee.locationId);
    if (user.role !== 'employee') notify(`employee:${employee.id}`, `Punched in · ${stamp.time}`, `${method} punch by ${user.name}.`);
    return shapeAttendance(database.prepare(`${attendanceSql} WHERE a.id = ?`).get(id));
  }
  if (!existing || !existing.in_time) fail(400, `${employee.fullName} has not punched in today`);
  if (existing.out_time) fail(400, `${employee.fullName} is already punched out today`);
  const rules = attendanceRules(employee.clientId);
  const judged = judgePunch(employee.shiftStart, employee.shiftEnd, existing.in_time, stamp.iso, rules);
  const otAmount = Math.round(judged.otHours * (Number(employee.payroll.otRate) || 0));
  const status = judged.late ? 'Late' : (judged.early ? 'Early' : 'Present');
  database.prepare(`UPDATE attendance SET out_time = ?, out_lat = ?, out_lng = ?, location_note = ?, ot_hours = ?, ot_amount = ?, status = ?, flag = ?, mode = ? WHERE id = ?`)
    .run(stamp.iso, located ? lat : null, located ? lng : null, `${existing.location_note} ${note}`, judged.otHours, otAmount, status, status === 'Present' ? 'green' : 'red', method, existing.id);
  stampAttendancePlace(employee.id, stamp.date, employee.locationId);
  if (user.role !== 'employee') notify(`employee:${employee.id}`, `Punched out · ${stamp.time}`, `${method} punch by ${user.name}.`);
  return shapeAttendance(database.prepare(`${attendanceSql} WHERE a.id = ?`).get(existing.id));
}

function punch(user, body) {
  if (user.role === 'employee' || user.employeeId) {
    return captureAttendance(user, { ...body, method: body.method || 'Manual' });
  }
  if (body.employeeId) {
    return captureAttendance(user, { ...body, method: body.method || 'Manual' });
  }
  const emp = database.prepare('SELECT id FROM employees WHERE lower(email) = lower(?)').get(user.email);
  if (emp) {
    return captureAttendance(user, { ...body, employeeId: emp.id, method: body.method || 'Manual' });
  }
  fail(403, 'Punch attendance requires an employee record or selecting an employee');
}

async function getEmployeeQr(user, employeeId) {
  let employee;
  if (user.role === 'employee') {
    employee = mustEmployee(user.employeeId);
  } else if (employeeId) {
    employee = mustEmployee(employeeId);
    assertEmployee(user, employee);
  } else if (user.employeeId) {
    employee = mustEmployee(user.employeeId);
  } else {
    const emp = database.prepare('SELECT id FROM employees WHERE lower(email) = lower(?)').get(user.email);
    if (emp) employee = mustEmployee(emp.id);
    else {
      // Pick first employee in client company if client desk
      if (user.clientId) {
        const first = database.prepare('SELECT id FROM employees WHERE client_id = ? LIMIT 1').get(user.clientId);
        if (first) employee = mustEmployee(first.id);
      }
      if (!employee) fail(404, 'No employee record found for QR code generation');
    }
  }
  const code = employee.employeeCode;
  const qrDataUrl = await QRCode.toDataURL(code, { width: 280, margin: 2 });
  return {
    employeeId: employee.id,
    employeeCode: employee.employeeCode,
    fullName: employee.fullName,
    companyName: employee.companyName,
    shiftName: employee.shiftName,
    qrDataUrl
  };
}

function updateAttendance(user, id, body) {
  assertCompanyDesk(user);
  const row = database.prepare('SELECT * FROM attendance WHERE id = ?').get(id);
  if (!row) fail(404, 'Attendance row was not found');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This attendance belongs to another company');
  const penalty = Number(body.penalty) || 0;
  const lopDays = Number(body.lopDays) || 0;
  const otAmount = body.otAmount == null || body.otAmount === '' ? row.ot_amount : Number(body.otAmount) || 0;
  const flag = penalty > 0 || lopDays > 0 || row.status === 'Late' || row.status === 'Absent' ? 'red' : 'green';
  patchRow('attendance', id, {
    penalty, lop_days: lopDays, ot_amount: otAmount, penalty_remarks: clip(body.penaltyRemarks, 240), flag
  });
  return shapeAttendance(database.prepare(`${attendanceSql} WHERE a.id = ?`).get(id));
}

function listScoped(user, table) {
  let sql = `SELECT * FROM ${table}`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') { sql += ' WHERE employee_id = ?'; params.push(user.employeeId); }
  sql += ' ORDER BY raised_at DESC';
  return database.prepare(sql).all(...params);
}

function shapeLeave(row) {
  return {
    id: row.id, applicationNumber: row.application_number, employeeId: row.employee_id, clientId: row.client_id,
    employeeName: row.employee_name, leaveType: row.leave_type, fromDate: row.from_date, toDate: row.to_date,
    reason: row.reason, status: row.status, approver: row.approver || '', raisedAt: row.raised_at, decidedAt: row.decided_at || ''
  };
}
function shapeSwap(row) {
  return {
    id: row.id, applicationNumber: row.application_number, employeeId: row.employee_id, clientId: row.client_id,
    employeeName: row.employee_name, fromShift: row.from_shift, toShift: row.to_shift, swapDate: row.swap_date,
    reason: row.reason, status: row.status, approver: row.approver || '', raisedAt: row.raised_at, decidedAt: row.decided_at || ''
  };
}
function shapeClaim(row) {
  const detail = parse(row.detail, {});
  return {
    id: row.id, applicationNumber: row.application_number, employeeId: row.employee_id, clientId: row.client_id,
    employeeName: row.employee_name, companyName: row.company_name || '', category: row.category,
    amount: Number(row.amount) || 0, description: row.description, expenseDate: row.expense_date || '',
    fromPlace: detail.from || '', toPlace: detail.to || '', mode: detail.mode || '', km: Number(detail.km) || 0,
    rate: Number(detail.rate) || 0, receiptUrl: row.receipt_url || '', receiptName: row.receipt_name || '',
    status: row.status, remarks: row.remarks || '', financeNote: row.finance_note || '', approver: row.approver || '',
    raisedAt: row.raised_at, decidedAt: row.decided_at || ''
  };
}

function listLeaves(user) { return listScoped(user, 'leaves').map(shapeLeave); }
function listSwaps(user) { return listScoped(user, 'shift_swaps').map(shapeSwap); }
function listReimbursements(user) {
  let sql = `SELECT r.*, c.company_name FROM reimbursements r LEFT JOIN clients c ON c.id = r.client_id`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE r.client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') { sql += ' WHERE r.employee_id = ?'; params.push(user.employeeId); }
  sql += ' ORDER BY r.raised_at DESC';
  return database.prepare(sql).all(...params).map(shapeClaim);
}

function createLeave(user, body) {
  if (user.role !== 'employee') fail(403, 'Leave is raised from the employee desk');
  const employee = mustEmployee(user.employeeId);
  const leaveType = clip(body.leaveType, 40);
  const fromDate = clip(body.fromDate, 10);
  const toDate = clip(body.toDate, 10);
  const reason = clip(body.reason, 400);
  if (!leaveType || !fromDate || !toDate || !reason) fail(400, 'Leave type, dates, and reason are required');
  const placeRule = ruleFor(employee.locationId, 'Leave', leaveType);
  if (placeRule && placeRule.yearly_quota > 0) {
    const year = fromDate.slice(0, 4);
    const used = database.prepare(`SELECT from_date, to_date FROM leaves WHERE employee_id = ? AND leave_type = ? AND status != 'Rejected' AND substr(from_date, 1, 4) = ?`).all(employee.id, leaveType, year);
    const days = used.reduce((sum, row) => sum + leaveDays(row.from_date, row.to_date), 0) + leaveDays(fromDate, toDate);
    if (days > placeRule.yearly_quota) fail(400, `${leaveType} at ${employee.locationName || 'this location'} is capped at ${placeRule.yearly_quota} days`);
  }
  const id = crypto.randomUUID();
  const number = nextNumber('LEV');
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO leaves (id, application_number, employee_id, client_id, employee_name, leave_type, from_date, to_date, reason, status, approver, raised_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending company', '', ?, '')`).run(id, number, employee.id, employee.clientId, employee.fullName, leaveType, fromDate, toDate, reason, now);
  notify('admin', `Leave · ${employee.fullName}`, `${number} is with the company desk first.`);
  notify(`client:${employee.clientId}`, `Leave · ${employee.fullName}`, `${number} needs the company approval before the administrator.`);
  insertMessage({ channel: `company:${employee.clientId}`, clientId: employee.clientId, senderId: user.id, senderName: user.name, senderRole: user.role, body: `${employee.fullName} raised leave ${number} (${leaveType}, ${fromDate} to ${toDate}).` });
  return shapeLeave(database.prepare('SELECT * FROM leaves WHERE id = ?').get(id));
}

function createSwap(user, body) {
  if (user.role !== 'employee') fail(403, 'Shift swaps are raised from the employee desk');
  const employee = mustEmployee(user.employeeId);
  const toShift = clip(body.toShift, 40);
  const swapDate = clip(body.swapDate, 10);
  const reason = clip(body.reason, 400);
  if (!toShift || !swapDate || !reason) fail(400, 'Target shift, date, and reason are required');
  const id = crypto.randomUUID();
  const number = nextNumber('SWP');
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO shift_swaps (id, application_number, employee_id, client_id, employee_name, from_shift, to_shift, swap_date, reason, status, approver, raised_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', '', ?, '')`).run(
    id, number, employee.id, employee.clientId, employee.fullName, employee.shiftName, toShift, swapDate, reason, now
  );
  notify('admin', `Shift swap · ${employee.fullName}`, `${number} asks for ${toShift} on ${swapDate}.`);
  notify(`client:${employee.clientId}`, `Shift swap · ${employee.fullName}`, `${number} is waiting for the client admin or the company admin.`);
  return shapeSwap(database.prepare('SELECT * FROM shift_swaps WHERE id = ?').get(id));
}

function recordClaimEvent(claimId, action, fromStatus, toStatus, detail, actor) {
  database.prepare(`INSERT INTO claim_events (id, claim_id, action, from_status, to_status, detail, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), claimId, action, fromStatus || '', toStatus || '', clip(detail, 400), actor || '', new Date().toISOString()
  );
}

function expensePolicy(clientId, category) {
  return database.prepare('SELECT * FROM expense_policies WHERE client_id = ? AND category = ?').get(clientId, category);
}

function listExpensePolicies(user) {
  let sql = `SELECT p.*, c.company_name FROM expense_policies p LEFT JOIN clients c ON c.id = p.client_id`;
  const params = [];
  if (user.role === 'client' || user.role === 'employee') { sql += ' WHERE p.client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') {
    const me = database.prepare('SELECT client_id FROM employees WHERE id = ?').get(user.employeeId);
    params[0] = me ? me.client_id : '';
  }
  sql += ' ORDER BY p.category';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, companyName: row.company_name || '', category: row.category,
    maxAmount: Number(row.max_amount) || 0, receiptAbove: Number(row.receipt_above) || 0,
    monthlyCap: Number(row.monthly_cap) || 0, perKm: Number(row.per_km) || 0, notes: row.notes || ''
  }));
}

function saveExpensePolicy(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  const client = mustClient(clientId);
  if (user.role === 'client') assertClient(user, client.id);
  const category = EXPENSE_CATEGORIES.includes(body.category) ? body.category : '';
  const maxAmount = Math.round(Number(body.maxAmount) || 0);
  const receiptAbove = Math.round(Number(body.receiptAbove) || 0);
  const monthlyCap = Math.round(Number(body.monthlyCap) || 0);
  const perKm = Math.round(Number(body.perKm) || 0);
  if (!category || maxAmount <= 0) fail(400, 'Choose a category and a maximum amount');
  const notes = clip(body.notes, 240);
  const existing = database.prepare('SELECT id FROM expense_policies WHERE client_id = ? AND category = ?').get(client.id, category);
  if (existing) patchRow('expense_policies', existing.id, { max_amount: maxAmount, receipt_above: receiptAbove, monthly_cap: monthlyCap, per_km: perKm, notes });
  else {
    database.prepare(`INSERT INTO expense_policies (id, client_id, category, max_amount, receipt_above, monthly_cap, per_km, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), client.id, category, maxAmount, receiptAbove, monthlyCap, perKm, notes, new Date().toISOString());
  }
  notify(`client:${client.id}`, `Expense policy · ${category}`, `Maximum ${maxAmount}. Receipt above ${receiptAbove}.`);
  return listExpensePolicies(user);
}

function createReimbursement(user, body) {
  let employee;
  if (user.role === 'employee') employee = mustEmployee(user.employeeId);
  else {
    assertCompanyDesk(user);
    employee = mustEmployee(body.employeeId);
    if (user.role === 'client' && employee.clientId !== user.clientId) fail(403, 'That person is not on this company');
  }
  const category = EXPENSE_CATEGORIES.includes(body.category) ? body.category : '';
  const description = clip(body.description, 400);
  const expenseDate = clip(body.expenseDate, 10);
  if (!category || !description || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) fail(400, 'Category, date, and description are required');
  const policy = expensePolicy(employee.clientId, category);
  const fromPlace = clip(body.from, 80);
  const toPlace = clip(body.to, 80);
  const mode = TRAVEL_MODES.includes(body.mode) ? body.mode : '';
  const km = Math.round(Number(body.km) || 0);
  let amount = Math.round(Number(body.amount) || 0);
  let rate = 0;
  if (category === 'Travel' && (!fromPlace || !toPlace || !mode)) fail(400, 'Travel needs the from, to, and mode');
  if (category === 'E-bike') {
    if (km <= 0) fail(400, 'Enter the kilometres ridden');
    if (policy && policy.per_km > 0) {
      rate = policy.per_km;
      amount = Math.round(km * rate);
    }
  }
  if (amount <= 0) fail(400, 'Enter an amount greater than zero');
  if (policy && policy.max_amount > 0 && amount > policy.max_amount) fail(400, `${category} is capped at ₹${policy.max_amount}`);
  const receiptUrl = clip(body.receiptUrl, 240);
  const receiptName = clip(body.receiptName, 120);
  if (policy && policy.receipt_above > 0 && amount >= policy.receipt_above && !receiptUrl) fail(400, `A receipt is required for ${category} at or above ₹${policy.receipt_above}`);
  if (policy && policy.monthly_cap > 0) {
    const spent = database.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM reimbursements
      WHERE employee_id = ? AND category = ? AND status != 'Rejected'
      AND substr(CASE WHEN expense_date != '' THEN expense_date ELSE raised_at END, 1, 7) = ?`).get(employee.id, category, expenseDate.slice(0, 7));
    if ((Number(spent.total) || 0) + amount > policy.monthly_cap) fail(400, `${category} would pass the monthly cap of ₹${policy.monthly_cap}`);
  }
  const status = user.role === 'employee' ? 'Pending company' : 'Pending finance';
  const id = crypto.randomUUID();
  const number = nextNumber('RMB');
  const now = new Date().toISOString();
  const detail = JSON.stringify({ from: fromPlace, to: toPlace, mode, km, rate });
  database.prepare(`INSERT INTO reimbursements (id, application_number, employee_id, client_id, employee_name, category, amount, description, receipt_url, receipt_name, expense_date, detail, status, remarks, finance_note, approver, raised_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, '')`).run(
    id, number, employee.id, employee.clientId, employee.fullName, category, amount, description, receiptUrl, receiptName, expenseDate, detail, status, now
  );
  recordClaimEvent(id, 'Submitted', '', status, description, user.name);
  notify(`employee:${employee.id}`, `Claim received · ${number}`, `${category} for ₹${amount} is ${status}.`);
  notify(`client:${employee.clientId}`, `Expense claim · ${employee.fullName}`, `${number} · ${category} · ₹${amount}.`);
  notify('admin', `Expense claim · ${number}`, `${employee.fullName} · ${category} is ${status}.`);
  return shapeClaim(database.prepare(`SELECT r.*, c.company_name FROM reimbursements r LEFT JOIN clients c ON c.id = r.client_id WHERE r.id = ?`).get(id));
}

function listClaimEvents(user, id) {
  const claim = database.prepare('SELECT * FROM reimbursements WHERE id = ?').get(id);
  if (!claim) fail(404, 'Claim was not found');
  if (user.role === 'client' && claim.client_id !== user.clientId) fail(403, 'This claim belongs to another company');
  if (user.role === 'employee' && claim.employee_id !== user.employeeId) fail(403, 'This claim is not yours');
  return database.prepare('SELECT * FROM claim_events WHERE claim_id = ? ORDER BY created_at').all(id).map((row) => ({
    id: row.id, action: row.action, fromStatus: row.from_status || '', toStatus: row.to_status || '',
    detail: row.detail || '', actor: row.actor || '', createdAt: row.created_at
  }));
}

function decide(user, table, id, status, shaper) {
  assertAdmin(user);
  if (!['Approved', 'Rejected'].includes(status)) fail(400, 'Choose Approved or Rejected');
  const row = database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) fail(404, 'Request was not found');
  patchRow(table, id, { status, approver: user.name, decided_at: new Date().toISOString(), ...(table === 'reimbursements' ? { remarks: clip(arguments[4] && arguments[4].remarks, 240) } : {}) });
  notify(`employee:${row.employee_id}`, `${status} · ${row.application_number}`, `${user.name} marked this request ${status}.`);
  return shaper(database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
}

function leaveDays(fromDate, toDate) {
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 1;
  return Math.round((end - start) / 86400000) + 1;
}

function setLeaveStatus(user, id, body) {
  const existing = database.prepare('SELECT * FROM leaves WHERE id = ?').get(id);
  if (!existing) fail(404, 'Leave was not found');
  const decision = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Approved or Rejected');
  if (user.role === 'employee') fail(403, 'Leave is approved by the client admin and the company admin');
  if (user.role === 'client' && existing.client_id !== user.clientId) fail(403, 'This leave belongs to another company');
  if (user.role !== 'client') assertAdmin(user);
  if (!['Pending', 'Pending company', 'Pending admin'].includes(existing.status)) fail(400, 'This leave is already closed');
  patchRow('leaves', id, { status: decision, approver: user.name, decided_at: new Date().toISOString() });
  const balanceKey = { Casual: 'casual', Sick: 'sick', Earned: 'earned' }[existing.leave_type];
  if (existing.status !== 'Approved' && decision === 'Approved' && balanceKey) {
    const employee = database.prepare('SELECT leave_balance FROM employees WHERE id = ?').get(existing.employee_id);
    const balance = parse(employee && employee.leave_balance, { casual: 12, sick: 8, earned: 15 });
    balance[balanceKey] = Math.max(0, (Number(balance[balanceKey]) || 0) - leaveDays(existing.from_date, existing.to_date));
    patchRow('employees', existing.employee_id, { leave_balance: JSON.stringify(balance) });
  }
  notify(`employee:${existing.employee_id}`, `${decision} · ${existing.application_number}`, `${user.name} marked this leave ${decision}.`);
  notify(`client:${existing.client_id}`, `${decision} · ${existing.application_number}`, `${existing.employee_name}'s leave is ${decision}.`);
  return shapeLeave(database.prepare('SELECT * FROM leaves WHERE id = ?').get(id));
}
function setSwapStatus(user, id, body) {
  const row = database.prepare('SELECT * FROM shift_swaps WHERE id = ?').get(id);
  if (!row) fail(404, 'Shift swap was not found');
  if (user.role === 'employee') fail(403, 'Shift swaps are approved by the client admin and the company admin');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This swap belongs to another company');
  if (user.role !== 'client') assertAdmin(user);
  const status = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!status) fail(400, 'Choose Approved or Rejected');
  if (row.status !== 'Pending') fail(400, 'This swap is already closed');
  patchRow('shift_swaps', id, { status, approver: user.name, decided_at: new Date().toISOString() });
  notify(`employee:${row.employee_id}`, `${status} · ${row.application_number}`, `${user.name} marked this shift swap ${status}.`);
  notify(`client:${row.client_id}`, `${status} · ${row.application_number}`, `${row.employee_name}'s shift swap is ${status}.`);
  return shapeSwap(database.prepare('SELECT * FROM shift_swaps WHERE id = ?').get(id));
}
function setReimbursementStatus(user, id, body) {
  if (user.role === 'employee') fail(403, 'Claims are approved by the client admin and the company admin');
  const row = database.prepare('SELECT * FROM reimbursements WHERE id = ?').get(id);
  if (!row) fail(404, 'Reimbursement was not found');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This claim belongs to another company');
  if (user.role !== 'client') assertAdmin(user);
  const asked = ['Approved', 'Rejected', 'Processed'].includes(body.status) ? body.status : '';
  if (!asked) fail(400, 'Choose Approved, Rejected, or Processed');
  const note = clip(body.remarks, 240);
  let next = '';
  if (asked === 'Rejected') {
    if (!OPEN_CLAIMS.includes(row.status)) fail(400, 'This claim is already closed');
    next = 'Rejected';
  } else if (asked === 'Processed') {
    if (row.status !== 'Ready') fail(400, 'Verify the claim before processing payment');
    next = 'Processed';
  } else if (['Pending', 'Pending company'].includes(row.status)) next = 'Pending finance';
  else if (row.status === 'Pending finance') next = 'Ready';
  else fail(400, 'This claim is already closed');
  const patch = { status: next, approver: user.name, decided_at: new Date().toISOString(), remarks: note || row.remarks || '' };
  if (row.status === 'Pending finance' && next === 'Ready') patch.finance_note = note || 'Finance verified';
  patchRow('reimbursements', id, patch);
  const action = next === 'Pending finance' ? 'Company approved' : (next === 'Ready' ? 'Finance verified' : (next === 'Processed' ? 'Processed' : 'Rejected'));
  recordClaimEvent(id, action, row.status, next, note, user.name);
  notify(`employee:${row.employee_id}`, `${next} · ${row.application_number}`, note || `${row.category} is ${next}.`);
  notify(`client:${row.client_id}`, `${next} · ${row.application_number}`, `${row.employee_name} · ${row.category} is ${next}.`);
  if (next === 'Pending finance') notify('admin', `Finance check · ${row.application_number}`, `${row.employee_name} · ₹${row.amount} is ready to verify.`);
  return shapeClaim(database.prepare(`SELECT r.*, c.company_name FROM reimbursements r LEFT JOIN clients c ON c.id = r.client_id WHERE r.id = ?`).get(id));
}

function listApplicants(user) {
  let sql = 'SELECT * FROM applicants';
  const params = [];
  if (user.role === 'client') { sql += ' WHERE client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') fail(403, 'Applicant tracking stays with the company and control desks');
  sql += ' ORDER BY raised_at DESC';
  return database.prepare(sql).all(...params).map(shapeApplicant);
}
function shapeApplicant(row) {
  return {
    id: row.id, applicationNumber: row.application_number, clientId: row.client_id, fullName: row.full_name,
    email: row.email || '', phone: row.phone || '', position: row.position, source: row.source,
    sourceCompany: row.source_company || '', stage: row.stage, bgvRequired: !!row.bgv_required,
    notes: row.notes || '', raisedAt: row.raised_at, resumeUrl: row.resume_url || '', resumeName: row.resume_name || '',
    offerStatus: row.offer_status || 'None', jobId: row.job_id || ''
  };
}
function createApplicant(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : body.clientId;
  const client = mustClient(clientId);
  const fullName = clip(body.fullName, 80);
  const position = clip(body.position, 80);
  const source = HIRING.includes(body.source) ? body.source : '';
  if (!fullName || !position || !source) fail(400, 'Name, position, and hiring source are required');
  const id = crypto.randomUUID();
  const number = nextNumber('ATS');
  database.prepare(`INSERT INTO applicants (id, application_number, client_id, full_name, email, phone, position, source, source_company, stage, bgv_required, notes, raised_at, resume_url, resume_name, offer_status, job_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Applied', ?, ?, ?, ?, ?, 'None', ?)`).run(
    id, number, client.id, fullName, clip(body.email, 120), clip(body.phone, 40), position, source,
    clip(body.sourceCompany, 120), body.bgvRequired ? 1 : 0, clip(body.notes, 400), new Date().toISOString(),
    clip(body.resumeUrl, 240), clip(body.resumeName, 140), clip(body.jobId, 40) || null
  );
  notify('admin', `Applicant · ${fullName}`, `${number} for ${position} at ${client.companyName}.`);
  notify(`client:${client.id}`, `Applicant · ${fullName}`, `${number} is on the tracker.`);
  return shapeApplicant(database.prepare('SELECT * FROM applicants WHERE id = ?').get(id));
}
function setApplicantStage(user, id, body) {
  assertCompanyDesk(user);
  const stages = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected'];
  if (!stages.includes(body.stage)) fail(400, 'Unknown hiring stage');
  const row = database.prepare('SELECT * FROM applicants WHERE id = ?').get(id);
  if (!row) fail(404, 'Applicant was not found');
  if (user.role === 'client') {
    if (row.client_id !== user.clientId) fail(403, 'This applicant belongs to another company');
    if (['Offer', 'Hired'].includes(body.stage)) fail(403, 'Offer and hire are confirmed by the administrator');
  }
  patchRow('applicants', id, { stage: body.stage, offer_status: body.stage === 'Offer' ? 'Pending admin' : row.offer_status });
  notify(`client:${row.client_id}`, `Hiring · ${row.full_name}`, `${row.application_number} moved to ${body.stage}.`);
  if (body.stage === 'Offer') notify('admin', `Offer · ${row.full_name}`, `${row.application_number} is waiting to be issued.`);
  if (body.stage === 'Hired') ensureJoining(database.prepare('SELECT * FROM applicants WHERE id = ?').get(id), user.name);
  return shapeApplicant(database.prepare('SELECT * FROM applicants WHERE id = ?').get(id));
}
function setApplicantResume(user, id, body) {
  assertCompanyDesk(user);
  const row = database.prepare('SELECT * FROM applicants WHERE id = ?').get(id);
  if (!row) fail(404, 'Applicant was not found');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This applicant belongs to another company');
  const url = clip(body.resumeUrl, 240);
  if (!url) fail(400, 'Upload the resume first');
  patchRow('applicants', id, { resume_url: url, resume_name: clip(body.resumeName, 140) || 'Resume' });
  return shapeApplicant(database.prepare('SELECT * FROM applicants WHERE id = ?').get(id));
}
function setOffer(user, id, body) {
  const row = database.prepare('SELECT * FROM applicants WHERE id = ?').get(id);
  if (!row) fail(404, 'Applicant was not found');
  if (user.role === 'client') {
    if (row.client_id !== user.clientId) fail(403, 'This applicant belongs to another company');
    patchRow('applicants', id, { offer_status: 'Pending admin', stage: 'Offer' });
    notify('admin', `Offer request · ${row.full_name}`, `${row.application_number} is ready to issue.`);
  } else {
    assertAdmin(user);
    const status = ['Issued', 'Accepted', 'Declined', 'Rejected'].includes(body.status) ? body.status : '';
    if (!status) fail(400, 'Choose Issued, Accepted, or Declined');
    patchRow('applicants', id, { offer_status: status, stage: status === 'Accepted' ? 'Hired' : 'Offer' });
    notify(`client:${row.client_id}`, `Offer ${status} · ${row.full_name}`, `${row.application_number} is ${status}.`);
    if (status === 'Accepted') ensureJoining(database.prepare('SELECT * FROM applicants WHERE id = ?').get(id), user.name);
  }
  return shapeApplicant(database.prepare('SELECT * FROM applicants WHERE id = ?').get(id));
}

function listRequisitions(user) {
  assertCompanyDesk(user);
  let sql = `SELECT r.*, c.company_name FROM requisitions r JOIN clients c ON c.id = r.client_id`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE r.client_id = ?'; params.push(user.clientId); }
  sql += ' ORDER BY r.created_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, applicationNumber: row.application_number, clientId: row.client_id, companyName: row.company_name,
    kind: row.kind, position: row.position, openings: row.openings, department: row.department || '',
    justification: row.justification || '', status: row.status, raisedBy: row.raised_by || '', createdAt: row.created_at
  }));
}
function createRequisition(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  const client = mustClient(clientId);
  const position = clip(body.position, 80);
  const kind = body.kind === 'S1 HR' ? 'S1 HR' : 'Internal';
  if (!position) fail(400, 'Position is required');
  const status = kind === 'Internal' ? 'Approved' : 'Pending admin';
  const id = crypto.randomUUID();
  const number = nextNumber('REQ');
  database.prepare(`INSERT INTO requisitions (id, application_number, client_id, kind, position, openings, department, justification, status, raised_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, number, client.id, kind, position, Math.max(1, Number(body.openings) || 1), clip(body.department, 80),
    clip(body.justification, 400), status, user.name, new Date().toISOString()
  );
  notify(`client:${client.id}`, `Requisition · ${position}`, `${number} is ${status}.`);
  notify('admin', kind === 'S1 HR' ? `Manpower request · ${position}` : `Internal requisition · ${position}`, `${client.companyName} · ${number}.`);
  return listRequisitions(user);
}
function setRequisition(user, id, body) {
  const row = database.prepare('SELECT * FROM requisitions WHERE id = ?').get(id);
  if (!row) fail(404, 'Requisition was not found');
  const decision = ['Approved', 'Rejected', 'Filled'].includes(body.status) ? body.status : '';
  if (!decision) fail(400, 'Choose Approved, Rejected, or Filled');
  if (user.role === 'client') {
    if (row.client_id !== user.clientId) fail(403, 'This requisition belongs to another company');
    if (row.kind === 'S1 HR' && decision === 'Approved') fail(403, 'S1 HR confirms this request');
  } else assertAdmin(user);
  patchRow('requisitions', id, { status: decision });
  notify(`client:${row.client_id}`, `Requisition ${decision}`, `${row.application_number} · ${row.position}.`);
  return listRequisitions(user);
}

function employee360(user, id) {
  const employee = getEmployee(user, id);
  const attendance = listAttendance(user, { employeeId: id }).slice(0, 8);
  const leaves = listLeaves(user).filter((row) => row.employeeId === id);
  const assets = listAssets(user).filter((row) => row.employeeId === id);
  const tasks = listTasks(user).filter((row) => row.employeeId === id);
  const goals = listGoals(user).filter((row) => row.employeeId === id);
  const reviews = listReviews(user).filter((row) => row.employeeId === id);
  const claims = listReimbursements(user).filter((row) => row.employeeId === id);
  return {
    key: employee.employeeCode,
    applicationNumber: employee.applicationNumber,
    employee,
    attendance,
    leaves,
    assets,
    tasks,
    goals,
    reviews,
    claims
  };
}

function listActivities(user, type) {
  let sql = `SELECT a.*, c.company_name FROM activities a LEFT JOIN clients c ON c.id = a.client_id WHERE 1 = 1`;
  const params = [];
  if (type) { sql += ' AND a.type = ?'; params.push(type); }
  if (user.role !== 'admin') {
    sql += ' AND (a.client_id IS NULL OR a.client_id = ?)';
    params.push(user.clientId || '');
  }
  sql += ' ORDER BY a.raised_at DESC';
  return database.prepare(sql).all(...params).map(shapeActivity);
}

function createActivity(user, body) {
  const type = clip(body.type, 20);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  let clientId = null;
  let title = '';
  let description = clip(body.description, 800);
  let payload = {};
  let stage = 'Submitted';
  let prefix = 'BGV';
  let active = 1;

  if (type === 'bgv') {
    if (user.role === 'employee') fail(403, 'BGV is raised by the company or the administrator');
    clientId = user.role === 'client' ? user.clientId : body.clientId;
    mustClient(clientId);
    const services = (Array.isArray(body.services) ? body.services : []).filter((step) => BGV_STEPS.includes(step));
    if (!services.length) fail(400, 'Choose at least one verification step');
    const candidateName = clip(body.candidateName, 80);
    if (!candidateName) fail(400, 'Candidate name is required');
    title = `BGV · ${candidateName}`;
    payload = { candidateName, services, steps: services.map((name) => ({ name, docName: '', docUrl: '', done: false })), files: [] };
    prefix = 'BGV';
  } else if (type === 'service' && body.kind === 'catalog') {
    assertAdmin(user);
    title = clip(body.title, 120);
    if (!title || !description) fail(400, 'Service name and description are required');
    payload = { kind: 'catalog', owner: 'S1 HR Solution' };
    stage = 'Published';
    prefix = 'SRV';
  } else if (type === 'service') {
    if (user.role === 'employee') fail(403, 'Service requests are raised from the company desk');
    clientId = user.role === 'client' ? user.clientId : body.clientId;
    mustClient(clientId);
    const service = database.prepare("SELECT * FROM activities WHERE id = ? AND type = 'service'").get(body.serviceId);
    if (!service) fail(404, 'That service is not on the desk');
    title = `Service request · ${service.title}`;
    payload = { kind: 'request', serviceId: service.id, serviceName: service.title, files: [], steps: [] };
    prefix = 'SRV';
  } else if (type === 'device' && body.kind === 'catalog') {
    assertAdmin(user);
    title = clip(body.title, 120);
    if (!title || !description) fail(400, 'Product name and description are required');
    payload = { kind: 'catalog', model: clip(body.model, 60), modeOptions: ['Buy', 'Rent'] };
    stage = 'Published';
    prefix = 'DEV';
  } else if (type === 'device') {
    if (user.role === 'employee') fail(403, 'Device orders are raised from the company desk');
    clientId = user.role === 'client' ? user.clientId : body.clientId;
    const client = mustClient(clientId);
    const product = database.prepare("SELECT * FROM activities WHERE id = ? AND type = 'device'").get(body.productId);
    if (!product) fail(404, 'That product is not on the desk');
    const mode = body.mode === 'Rent' ? 'Rent' : 'Buy';
    title = `Device order · ${product.title}`;
    description = description || `${client.companyName} asked to ${mode.toLowerCase()} ${product.title}.`;
    payload = {
      kind: 'order', productId: product.id, productName: product.title,
      model: clip(body.model, 60) || parse(product.payload, {}).model || '',
      mode, documentName: clip(body.documentName, 120), documentUrl: clip(body.documentUrl, 240), files: []
    };
    prefix = 'DEV';
  } else if (type === 'manpower') {
    if (user.role === 'employee') fail(403, 'Manpower requests are raised from the company desk');
    clientId = user.role === 'client' ? user.clientId : body.clientId;
    mustClient(clientId);
    const engagement = body.engagement === 'On roll' ? 'On roll' : body.engagement === 'Third party' ? 'Third party' : '';
    if (!engagement) fail(400, 'Choose Third party or On roll');
    const positions = (Array.isArray(body.positions) ? body.positions : []).map((row) => ({
      name: clip(row.name, 80), count: Number(row.count) || 0, budget: Number(row.budget) || 0
    })).filter((row) => row.name);
    if (!positions.length) fail(400, 'Add at least one position');
    const totalBudget = Number(body.totalBudget) || positions.reduce((sum, row) => sum + row.budget, 0);
    title = `Manpower · ${positions[0].name}`;
    payload = { engagement, totalBudget, positions, remarks: clip(body.remarks, 400) };
    prefix = 'MAN';
  } else if (type === 'advertise') {
    if (user.role === 'employee') fail(403, 'Slides are posted by the company or the administrator');
    title = clip(body.title, 120);
    if (!title || !description) fail(400, 'Slide title and description are required');
    if (user.role === 'client') {
      clientId = user.clientId;
      const client = mustClient(clientId);
      const count = database.prepare("SELECT COUNT(*) AS c FROM activities WHERE type = 'advertise' AND client_id = ?").get(clientId).c;
      if (count >= client.adSlots) fail(400, `This company can keep ${client.adSlots} slide${client.adSlots === 1 ? '' : 's'}. Ask the administrator to raise the cap.`);
      stage = 'Pending';
      active = 0;
      payload = { mediaUrl: clip(body.mediaUrl, 240), mediaType: body.mediaType === 'video' ? 'video' : 'image', link: clip(body.link, 240), companyName: client.companyName };
    } else {
      clientId = body.clientId || null;
      if (clientId) mustClient(clientId);
      stage = body.stage === 'Pending' ? 'Pending' : 'Live';
      active = stage === 'Live' ? 1 : 0;
      const companyName = clientId ? mustClient(clientId).companyName : 'S1 HR Solution';
      payload = { mediaUrl: clip(body.mediaUrl, 240), mediaType: body.mediaType === 'video' ? 'video' : 'image', link: clip(body.link, 240), companyName };
    }
    prefix = 'ADV';
  } else {
    fail(400, 'Unknown activity type');
  }

  const number = nextNumber(prefix);
  database.prepare(`INSERT INTO activities (id, application_number, type, client_id, title, description, payload, stage, result, active, raised_by, raised_by_name, raised_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`).run(
    id, number, type, clientId, title, description, JSON.stringify(payload), stage, active, user.id, user.name, now, now
  );
  if (stage !== 'Published') {
    notify('admin', title, `${number} was raised by ${user.name}.`);
    insertMessage({
      channel: 'activities', clientId, senderId: user.id, senderName: user.name, senderRole: user.role,
      body: `${title} · ${number} is on the activity desk.`
    });
  }
  return shapeActivity(database.prepare(`SELECT a.*, c.company_name FROM activities a LEFT JOIN clients c ON c.id = a.client_id WHERE a.id = ?`).get(id));
}

function updateActivity(user, id, body) {
  assertAdmin(user);
  const row = database.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  if (!row) fail(404, 'Activity was not found');
  const payload = parse(row.payload, {});
  let stage = row.stage;
  let result = row.result || '';
  let active = row.active;
  if (row.type === 'advertise') {
    if (body.stage) stage = ['Pending', 'Live', 'Paused'].includes(body.stage) ? body.stage : stage;
    active = stage === 'Live' ? 1 : 0;
    if (body.link != null) payload.link = clip(body.link, 240);
    if (body.mediaUrl != null) payload.mediaUrl = clip(body.mediaUrl, 240);
    if (body.description) patchRow('activities', id, { description: clip(body.description, 800) });
  } else if (payload.kind === 'catalog' || stage === 'Published') {
    if (body.description) patchRow('activities', id, { description: clip(body.description, 800) });
  } else {
    if (body.advance) {
      const index = PIPELINE.indexOf(stage);
      stage = PIPELINE[Math.min(index + 1, PIPELINE.length - 1)] || 'Viewed';
      if (index < 0) stage = 'Viewed';
    } else if (body.stage && PIPELINE.includes(body.stage)) stage = body.stage;
    if (body.result) {
      if (!['Positive', 'Negative'].includes(body.result)) fail(400, 'Result is Positive or Negative');
      if (stage !== 'Final Report') fail(400, 'Move the request to Final Report before setting the result');
      result = body.result;
    }
  }
  patchRow('activities', id, { stage, result, active, payload: JSON.stringify(payload), updated_at: new Date().toISOString() });
  if (row.client_id) notify(`client:${row.client_id}`, `${row.application_number} updated`, `Stage is now ${stage}${result ? ` · ${result}` : ''}.`);
  return shapeActivity(database.prepare(`SELECT a.*, c.company_name FROM activities a LEFT JOIN clients c ON c.id = a.client_id WHERE a.id = ?`).get(id));
}

function addActivityFile(user, id, file, meta) {
  const row = database.prepare('SELECT * FROM activities WHERE id = ?').get(id);
  if (!row) fail(404, 'Activity was not found');
  if (user.role === 'employee') fail(403, 'Documents on an activity are added by the company or administrator');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This activity belongs to another company');
  const payload = parse(row.payload, {});
  const entry = {
    stepName: clip(meta.stepName, 120),
    docName: clip(meta.docName, 120) || file.originalname,
    url: `/uploads/${file.filename}`,
    at: new Date().toISOString()
  };
  payload.files = payload.files || [];
  payload.files.push(entry);
  if (Array.isArray(payload.steps) && entry.stepName) {
    payload.steps = payload.steps.map((step) => step.name === entry.stepName ? { ...step, docName: entry.docName, docUrl: entry.url, done: true } : step);
  }
  patchRow('activities', id, { payload: JSON.stringify(payload), updated_at: entry.at });
  if (user.clientId) {
    database.prepare('UPDATE clients SET storage_used_mb = storage_used_mb + ? WHERE id = ?').run(file.size / (1024 * 1024), user.clientId);
  }
  return shapeActivity(database.prepare(`SELECT a.*, c.company_name FROM activities a LEFT JOIN clients c ON c.id = a.client_id WHERE a.id = ?`).get(id));
}

function channelsFor(user) {
  const channels = [
    { id: 'desk', label: 'Operations desk', kind: 'group', icon: '⚡', description: 'Central operational dispatch & approvals' },
    { id: 'activities', label: 'Activity requests', kind: 'group', icon: '📋', description: 'Background checks, store requisitions & broadcasts' }
  ];
  if (user.role === 'admin' || user.role === 'superadmin') {
    database.prepare('SELECT id, company_name FROM clients ORDER BY company_name').all().forEach((row) => {
      channels.push({ id: `company:${row.id}`, label: row.company_name, kind: 'company', icon: '🏢', description: `${row.company_name} corporate room` });
    });
    channels.push(
      { id: 'posh', label: 'POSH thoughts', kind: 'group', icon: '🛡️', description: 'Confidential prevention of sexual harassment desk' },
      { id: 'queries', label: 'Query desk', kind: 'group', icon: '💬', description: 'General employee inquiries & helpdesk' }
    );
  } else {
    channels.splice(1, 0, { id: `company:${user.clientId}`, label: 'Company group', kind: 'company', icon: '🏢', description: 'Internal team announcements & updates' });
    if (user.role === 'employee') {
      channels.push({ id: 'posh', label: 'POSH thoughts', kind: 'group', icon: '🛡️', description: 'Confidential POSH grievance cell' });
    }
    channels.push({ id: 'queries', label: 'Query desk', kind: 'group', icon: '💬', description: 'Workplace query & escalation desk' });
  }

  // Load existing Direct Message conversations for this user
  try {
    const dmRows = database.prepare(`
      SELECT channel, MAX(created_at) as last_msg_at,
             (SELECT body FROM messages m2 WHERE m2.channel = m1.channel ORDER BY m2.created_at DESC LIMIT 1) as last_body
      FROM messages m1
      WHERE channel LIKE 'dm:%'
        AND (channel LIKE 'dm:' || ? || ':%' OR channel LIKE '%:' || ?)
      GROUP BY channel
      ORDER BY last_msg_at DESC
    `).all(user.id, user.id);

    dmRows.forEach((dm) => {
      const parts = dm.channel.split(':');
      const otherId = parts[1] === user.id ? parts[2] : parts[1];
      const otherUser = database.prepare(`
        SELECT u.id, u.name, u.role, u.title, u.status_text, e.department, e.role_title, c.company_name
        FROM users u
        LEFT JOIN employees e ON e.id = u.employee_id
        LEFT JOIN clients c ON c.id = u.client_id
        WHERE u.id = ?
      `).get(otherId);

      if (otherUser) {
        channels.push({
          id: dm.channel,
          label: otherUser.name,
          kind: 'dm',
          icon: '👤',
          role: otherUser.role,
          title: otherUser.title || otherUser.role_title || otherUser.role,
          department: otherUser.department || (otherUser.company_name ? `${otherUser.company_name}` : 'Direct Contact'),
          statusText: otherUser.status_text || 'Available on Runwork One',
          lastMsg: dm.last_body || '',
          lastTime: dm.last_msg_at,
          otherUserId: otherUser.id
        });
      }
    });
  } catch (_) {}

  return channels;
}

function searchUsers(user, query = '') {
  const q = String(query || '').trim().toLowerCase();
  let sql = `
    SELECT u.id, u.name, u.email, u.phone, u.role, u.title, u.status_text, u.client_id, u.employee_id,
           e.department, e.role_title, c.company_name
    FROM users u
    LEFT JOIN employees e ON e.id = u.employee_id
    LEFT JOIN clients c ON c.id = u.client_id
    WHERE u.active = 1 AND u.id != ?
  `;
  const params = [user.id];

  // Role visibility permissions
  if (user.role === 'client' || user.role === 'employee') {
    sql += ` AND (u.client_id = ? OR u.role IN ('admin', 'superadmin', 'hradmin'))`;
    params.push(user.clientId);
  }

  if (q) {
    sql += ` AND (
      LOWER(u.name) LIKE ? OR
      LOWER(u.email) LIKE ? OR
      LOWER(COALESCE(u.title, '')) LIKE ? OR
      LOWER(COALESCE(e.department, '')) LIKE ? OR
      LOWER(COALESCE(e.role_title, '')) LIKE ? OR
      LOWER(COALESCE(c.company_name, '')) LIKE ?
    )`;
    const wildcard = `%${q}%`;
    params.push(wildcard, wildcard, wildcard, wildcard, wildcard, wildcard);
  }

  sql += ` ORDER BY u.name ASC LIMIT 50`;
  const rows = database.prepare(sql).all(...params);

  return rows.map((row) => {
    let roleLabel = 'Team Member';
    if (row.role === 'superadmin') roleLabel = 'Super Admin';
    else if (row.role === 'admin') roleLabel = 'Central Admin Desk';
    else if (row.role === 'hradmin') roleLabel = 'HR Operations';
    else if (row.role === 'client') roleLabel = 'Client Admin';
    else if (row.role === 'employee') roleLabel = row.role_title || 'Colleague';

    const dmChannel = `dm:${[user.id, row.id].sort().join(':')}`;

    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone || '',
      role: row.role,
      roleLabel,
      title: row.title || roleLabel,
      department: row.department || (row.company_name ? `${row.company_name} Desk` : 'Operations'),
      companyName: row.company_name || 'S1 HR Network',
      statusText: row.status_text || 'Available on Runwork One',
      dmChannel,
      isOnline: true
    };
  });
}

function generateContextualReply(recipient, text, sender) {
  const lower = String(text || '').toLowerCase();
  const firstName = (sender.name || 'Team member').split(' ')[0];

  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey') || lower.includes('good morning') || lower.includes('good afternoon')) {
    return `Hello ${firstName}! ${recipient.name} here (${recipient.title || recipient.role}). How can I assist you on the workspace today?`;
  }
  if (lower.includes('leave') || lower.includes('holiday') || lower.includes('vacation') || lower.includes('off')) {
    return `Hi ${firstName}, I have noted your leave enquiry. The attendance coverage is mapped on the desk and the approval chain will update your status shortly.`;
  }
  if (lower.includes('shift') || lower.includes('timing') || lower.includes('swap') || lower.includes('roster')) {
    return `Got it, ${firstName}. Shift update received. Please remember to clock your geo-verified punch marking when reporting on-site.`;
  }
  if (lower.includes('salary') || lower.includes('payslip') || lower.includes('pay') || lower.includes('deduction') || lower.includes('bonus')) {
    return `Understood, ${firstName}. The monthly payroll reconciliation is logged. Your detailed payslip breakdown is ready for download in your vault.`;
  }
  if (lower.includes('doc') || lower.includes('vault') || lower.includes('kyc') || lower.includes('id') || lower.includes('aadhaar')) {
    return `Noted. All records uploaded to your Digital Employee Vault are securely archived with 100% compliance audit check.`;
  }
  if (lower.includes('thank') || lower.includes('ok') || lower.includes('okay') || lower.includes('sure') || lower.includes('got it')) {
    return `Glad to help, ${firstName}! Reach out anytime if you need anything else on Runwork.`;
  }
  return `Hi ${firstName}, received your message regarding "${clip(text, 50)}". I am reviewing this on the desk now.`;
}

function listMessages(user, channel) {
  if (channel && channel.startsWith('dm:')) {
    const parts = channel.split(':');
    if (parts.length !== 3 || (parts[1] !== user.id && parts[2] !== user.id)) {
      fail(403, 'That direct message conversation is not accessible');
    }
  } else if (!channelsFor(user).some((item) => item.id === channel)) {
    fail(403, 'That messenger group is not open on this desk');
  }

  let sql = 'SELECT * FROM messages WHERE channel = ?';
  const params = [channel];
  if (!channel.startsWith('dm:') && user.role !== 'admin' && user.role !== 'superadmin' && channel !== 'desk' && !channel.startsWith('company:')) {
    sql += ' AND (client_id IS NULL OR client_id = ?)';
    params.push(user.clientId);
  }
  sql += ' ORDER BY created_at ASC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, channel: row.channel, clientId: row.client_id || '', senderId: row.sender_id, senderName: row.sender_name,
    senderRole: row.sender_role, body: row.body, createdAt: row.created_at
  }));
}

function sendMessage(user, body) {
  const channel = clip(body.channel, 80);
  const text = clip(body.body, 2000);
  if (!text) fail(400, 'Write a message');

  let isDm = false;
  let recipientId = null;
  if (channel && channel.startsWith('dm:')) {
    const parts = channel.split(':');
    if (parts.length !== 3 || (parts[1] !== user.id && parts[2] !== user.id)) {
      fail(403, 'That direct message conversation is not accessible');
    }
    isDm = true;
    recipientId = parts[1] === user.id ? parts[2] : parts[1];
  } else if (!channelsFor(user).some((item) => item.id === channel)) {
    fail(403, 'That messenger group is not open on this desk');
  }

  const clientId = channel.startsWith('company:') ? channel.split(':')[1] : (user.clientId || null);
  const msg = insertMessage({ channel, clientId, senderId: user.id, senderName: user.name, senderRole: user.role, body: text });

  // Intelligent real-time communication response in DMs if autoReply is enabled
  if (isDm && recipientId && body.autoReply !== false) {
    const recipient = database.prepare('SELECT id, name, role, title, status_text FROM users WHERE id = ?').get(recipientId);
    if (recipient) {
      setTimeout(() => {
        try {
          const replyText = generateContextualReply(recipient, text, user);
          if (replyText) {
            insertMessage({
              channel,
              clientId,
              senderId: recipient.id,
              senderName: recipient.name,
              senderRole: recipient.role,
              body: replyText
            });
          }
        } catch (_) {}
      }, 1000);
    }
  }

  return msg;
}

function updateProfile(user, body) {
  const name = clip(body.name, 80) || user.name;
  const phone = clip(body.phone, 40);
  const statusText = clip(body.statusText, 140);
  patchRow('users', user.id, { name, phone, status_text: statusText });
  if (user.role === 'employee') {
    const employeePatch = {
      phone,
      emergency_name: clip(body.emergencyName, 80),
      emergency_phone: clip(body.emergencyPhone, 40)
    };
    if (body.photoUrl != null) employeePatch.photo_url = clip(body.photoUrl, 240);
    patchRow('employees', user.employeeId, employeePatch);
  }
  const fresh = database.prepare(`SELECT u.*, c.company_name FROM users u LEFT JOIN clients c ON c.id = u.client_id WHERE u.id = ?`).get(user.id);
  return loadUser(fresh);
}

function listTickets(user) {
  let sql = 'SELECT * FROM tickets';
  const params = [];
  if (user.role !== 'admin') { sql += ' WHERE client_id = ?'; params.push(user.clientId); }
  sql += ' ORDER BY raised_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    ...shapeTicket(row),
    replies: database.prepare('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at').all(row.id).map((reply) => ({
      id: reply.id, senderName: reply.sender_name, body: reply.body, createdAt: reply.created_at
    }))
  }));
}
function shapeTicket(row) {
  return {
    id: row.id, applicationNumber: row.application_number, raisedByName: row.raised_by_name, clientId: row.client_id || '',
    subject: row.subject, body: row.body, status: row.status, raisedAt: row.raised_at
  };
}
function createTicket(user, body) {
  const subject = clip(body.subject, 140);
  const text = clip(body.body, 800);
  if (!subject || !text) fail(400, 'Subject and details are required');
  const id = crypto.randomUUID();
  const number = nextNumber('TCK');
  database.prepare(`INSERT INTO tickets (id, application_number, raised_by, raised_by_name, client_id, subject, body, status, raised_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Open', ?)`).run(id, number, user.id, user.name, user.clientId || null, subject, text, new Date().toISOString());
  notify('admin', `Query · ${subject}`, `${number} from ${user.name}.`);
  insertMessage({ channel: 'queries', clientId: user.clientId || null, senderId: user.id, senderName: user.name, senderRole: user.role, body: `${subject} · ${number}. ${text}` });
  return listTickets(user).find((ticket) => ticket.id === id);
}
function replyTicket(user, id, body) {
  const ticket = database.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  if (!ticket) fail(404, 'Query was not found');
  if (user.role !== 'admin' && ticket.client_id !== user.clientId) fail(403, 'This query is outside your desk');
  const text = clip(body.body, 800);
  if (!text) fail(400, 'Write a reply');
  database.prepare('INSERT INTO ticket_replies (id, ticket_id, sender_name, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), id, user.name, text, new Date().toISOString());
  if (body.status && user.role === 'admin' && ['Open', 'Closed'].includes(body.status)) patchRow('tickets', id, { status: body.status });
  return listTickets(user).find((item) => item.id === id);
}

function listPosh(user) {
  if (user.role === 'client') fail(403, 'POSH notes stay between the employee and the administrator');
  let sql = 'SELECT * FROM posh_alarms';
  const params = [];
  if (user.role === 'employee') { sql += ' WHERE employee_id = ?'; params.push(user.employeeId); }
  sql += ' ORDER BY raised_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, applicationNumber: row.application_number, raisedByName: row.raised_by_name, clientId: row.client_id || '',
    message: row.message, status: row.status, raisedAt: row.raised_at
  }));
}
function createPosh(user, body) {
  if (user.role !== 'employee') fail(403, 'POSH alarms are raised from the employee desk');
  const message = clip(body.message, 800);
  if (!message) fail(400, 'Describe what should be reviewed');
  const id = crypto.randomUUID();
  const number = nextNumber('POS');
  database.prepare(`INSERT INTO posh_alarms (id, application_number, raised_by, raised_by_name, client_id, employee_id, message, status, raised_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Open', ?)`).run(id, number, user.id, user.name, user.clientId, user.employeeId, message, new Date().toISOString());
  notify('admin', 'POSH alarm', `${number} was filed confidentially by ${user.name}.`);
  insertMessage({ channel: 'posh', clientId: user.clientId, senderId: user.id, senderName: user.name, senderRole: user.role, body: `${number}: ${message}` });
  return listPosh(user).find((row) => row.id === id);
}
function setPoshStatus(user, id, body) {
  assertAdmin(user);
  if (!['Open', 'In review', 'Closed'].includes(body.status)) fail(400, 'Unknown POSH status');
  const row = database.prepare('SELECT * FROM posh_alarms WHERE id = ?').get(id);
  if (!row) fail(404, 'POSH note was not found');
  patchRow('posh_alarms', id, { status: body.status });
  notify(`employee:${row.employee_id}`, `POSH ${row.application_number}`, `Status is now ${body.status}.`);
  return listPosh(user).find((item) => item.id === id);
}

function shapeLead(row) {
  return {
    id: row.id, companyName: row.company_name, contactName: row.contact_name, phone: row.phone || '', email: row.email || '',
    businessType: row.business_type || '', priority: row.priority, assignedTo: row.assigned_to || '', status: row.status,
    notes: row.notes || '', nextCallAt: row.next_call_at || '', createdAt: row.created_at
  };
}
function listLeads(user) {
  assertAdmin(user);
  return database.prepare('SELECT * FROM leads ORDER BY created_at DESC').all().map(shapeLead);
}
function createLead(user, body) {
  assertAdmin(user);
  const companyName = clip(body.companyName, 140);
  const contactName = clip(body.contactName, 80);
  if (!companyName || !contactName) fail(400, 'Company and contact name are required');
  const id = crypto.randomUUID();
  database.prepare(`INSERT INTO leads (id, company_name, contact_name, phone, email, business_type, priority, assigned_to, status, notes, next_call_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, companyName, contactName, clip(body.phone, 40), clip(body.email, 120), clip(body.businessType, 80),
    body.priority === 'High' ? 'High' : 'Normal', clip(body.assignedTo, 80) || user.name,
    body.priority === 'High' ? 'Priority call' : 'New', clip(body.notes, 400), clip(body.nextCallAt, 30), new Date().toISOString()
  );
  return shapeLead(database.prepare('SELECT * FROM leads WHERE id = ?').get(id));
}
function updateLead(user, id, body) {
  assertAdmin(user);
  const row = database.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!row) fail(404, 'Lead was not found');
  patchRow('leads', id, {
    status: clip(body.status, 40) || row.status,
    assigned_to: clip(body.assignedTo, 80) || row.assigned_to,
    notes: body.notes != null ? clip(body.notes, 400) : row.notes,
    priority: body.priority === 'High' ? 'High' : body.priority === 'Normal' ? 'Normal' : row.priority,
    next_call_at: body.nextCallAt != null ? clip(body.nextCallAt, 30) : row.next_call_at
  });
  return shapeLead(database.prepare('SELECT * FROM leads WHERE id = ?').get(id));
}

function listTasks(user) {
  let sql = `SELECT t.*, e.full_name, c.company_name FROM tasks t
    LEFT JOIN employees e ON e.id = t.employee_id
    LEFT JOIN clients c ON c.id = t.client_id`;
  const params = [];
  if (user.role === 'employee') { sql += ' WHERE t.employee_id = ?'; params.push(user.employeeId); }
  else if (user.role === 'client') { sql += ' WHERE t.client_id = ?'; params.push(user.clientId); }
  else assertCompanyDesk(user);
  sql += ' ORDER BY t.due_date, t.created_at DESC';
  return database.prepare(sql).all(...params).map(shapeTask);
}
function shapeTask(row) {
  const today = kolkataStamp().date;
  return {
    id: row.id, title: row.title, description: row.description || '', assignee: row.assignee || row.full_name || '',
    employeeId: row.employee_id || '', employeeName: row.full_name || row.assignee || '',
    clientId: row.client_id || '', companyName: row.company_name || '',
    dueDate: row.due_date || '', priority: row.priority || 'Normal', progress: Number(row.progress) || 0,
    performanceScore: Number(row.performance_score) || 0, photoUrl: row.photo_url || '',
    status: row.status, approvalStatus: row.approval_status || 'Approved', createdAt: row.created_at,
    overdue: row.status !== 'Done' && row.due_date && row.due_date < today
  };
}
function createTask(user, body) {
  if (user.role === 'employee') {
    body.employeeId = user.employeeId;
    body.request = 'yes';
  } else assertCompanyDesk(user);
  const title = clip(body.title, 140);
  const dueDate = clip(body.dueDate, 10);
  if (!title || !dueDate) fail(400, 'Title and deadline are required');
  const employee = body.employeeId ? mustEmployee(body.employeeId) : null;
  if (employee) assertEmployee(user, employee);
  const clientId = employee ? employee.clientId : (user.role === 'client' ? user.clientId : (clip(body.clientId, 40) || null));
  if (clientId) mustClient(clientId);
  if (user.role === 'client' && clientId !== user.clientId) fail(403, 'Assign work only inside your company');
  const assignee = employee ? employee.fullName : clip(body.assignee, 80);
  const priority = ['Low', 'Normal', 'High', 'Urgent'].includes(body.priority) ? body.priority : 'Normal';
  const duplicate = database.prepare(`SELECT id FROM tasks WHERE lower(title) = lower(?) AND ifnull(employee_id,'') = ifnull(?,'') AND ifnull(due_date,'') = ifnull(?,'')`).get(title, employee ? employee.id : '', dueDate);
  if (duplicate) fail(409, 'This task is already on the desk for that person and date');
  const requested = body.request === true || body.request === 'yes';
  const approval = user.role === 'employee' ? 'Pending company' : (requested && user.role !== 'admin' ? 'Pending admin' : 'Approved');
  const id = crypto.randomUUID();
  database.prepare(`INSERT INTO tasks (id, title, description, assignee, client_id, due_date, performance_score, photo_url, status, created_at, priority, employee_id, progress, approval_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(
    id, title, clip(body.description, 800), assignee, clientId, dueDate,
    Number(body.performanceScore) || 0, clip(body.photoUrl, 240), approval === 'Approved' ? 'Open' : 'Requested',
    new Date().toISOString(), priority, employee ? employee.id : null, approval
  );
  const audience = employee ? `employee:${employee.id}` : (clientId ? `client:${clientId}` : 'admin');
  notify(audience, approval === 'Approved' ? `Task assigned · ${title}` : `Task request · ${title}`, `${user.name} set ${priority} priority, due ${dueDate}.`);
  if (user.role === 'employee') notify(`client:${clientId}`, `Task request · ${title}`, `${user.name} asked for this task.`);
  if (user.role === 'client') notify('admin', `Task · ${title}`, approval === 'Approved' ? 'The company desk assigned a task.' : 'A task request is waiting for approval.');
  return shapeTask(database.prepare(`SELECT t.*, e.full_name, c.company_name FROM tasks t LEFT JOIN employees e ON e.id = t.employee_id LEFT JOIN clients c ON c.id = t.client_id WHERE t.id = ?`).get(id));
}
function updateTask(user, id, body) {
  const row = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row) fail(404, 'Task was not found');
  if (user.role === 'employee') {
    if (row.employee_id !== user.employeeId) fail(403, 'This task is not assigned to you');
    if ((row.approval_status || 'Approved') !== 'Approved') fail(400, 'This task is still waiting for approval');
  } else {
    assertCompanyDesk(user);
    if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This task belongs to another company');
  }
  const progress = body.progress == null || body.progress === '' ? row.progress : Math.max(0, Math.min(100, Number(body.progress) || 0));
  const status = ['Open', 'In progress', 'Done'].includes(body.status) ? body.status : row.status;
  if ((row.approval_status || 'Approved') !== 'Approved' && status !== row.status) fail(400, 'Approve the task before tracking it');
  const priority = ['Low', 'Normal', 'High', 'Urgent'].includes(body.priority) ? body.priority : row.priority;
  patchRow('tasks', id, {
    status, progress, priority,
    performance_score: body.performanceScore == null || body.performanceScore === '' ? row.performance_score : Number(body.performanceScore) || 0
  });
  if (status === 'Done' && row.status !== 'Done') {
    notify(row.employee_id ? `employee:${row.employee_id}` : 'admin', `Task done · ${row.title}`, `${user.name} closed this task.`);
    if (row.client_id) notify(`client:${row.client_id}`, `Task done · ${row.title}`, `${row.assignee || 'The assignee'} is marked done.`);
  }
  return shapeTask(database.prepare(`SELECT t.*, e.full_name, c.company_name FROM tasks t LEFT JOIN employees e ON e.id = t.employee_id LEFT JOIN clients c ON c.id = t.client_id WHERE t.id = ?`).get(id));
}
function setTaskApproval(user, id, body) {
  const row = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row) fail(404, 'Task was not found');
  const decision = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Approved or Rejected');
  if (user.role === 'employee') fail(403, 'Task requests are approved by the client admin and the company admin');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This task belongs to another company');
  if (user.role !== 'client') assertAdmin(user);
  if (!['Pending company', 'Pending admin'].includes(row.approval_status)) fail(400, 'This task is not waiting');
  patchRow('tasks', id, { approval_status: decision, status: decision === 'Approved' ? 'Open' : 'Rejected' });
  if (row.client_id) notify(`client:${row.client_id}`, `${decision} · ${row.title}`, `${user.name} ${decision.toLowerCase()} the task request.`);
  if (row.employee_id) notify(`employee:${row.employee_id}`, `${decision} · ${row.title}`, decision === 'Approved' ? 'This task is now on your list.' : 'This task request was rejected.');
  return listTasks(user);
}

function listGoals(user) {
  let sql = `SELECT g.*, e.full_name FROM goals g JOIN employees e ON e.id = g.employee_id`;
  const params = [];
  if (user.role === 'employee') { sql += ' WHERE g.employee_id = ?'; params.push(user.employeeId); }
  else if (user.role === 'client') { sql += ' WHERE g.client_id = ?'; params.push(user.clientId); }
  else assertCompanyDesk(user);
  sql += ' ORDER BY g.period DESC, e.full_name';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, employeeId: row.employee_id, employeeName: row.full_name,
    title: row.title, kpi: row.kpi, target: row.target, achieved: row.achieved, period: row.period,
    status: row.status, approvalStatus: row.approval_status, createdAt: row.created_at,
    attainment: row.target ? Math.round((row.achieved / row.target) * 100) : 0
  }));
}
function saveGoal(user, body) {
  assertCompanyDesk(user);
  const employee = mustEmployee(body.employeeId);
  assertEmployee(user, employee);
  const title = clip(body.title, 120);
  const kpi = clip(body.kpi, 80);
  if (!title || !kpi) fail(400, 'Goal title and KPI name are required');
  const approval = user.role === 'admin' ? 'Approved' : 'Pending admin';
  const id = crypto.randomUUID();
  database.prepare(`INSERT INTO goals (id, client_id, employee_id, title, kpi, target, achieved, period, status, approval_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, employee.clientId, employee.id, title, kpi, Number(body.target) || 0, Number(body.achieved) || 0,
    clip(body.period, 20) || kolkataStamp().date.slice(0, 7), approval === 'Approved' ? 'Active' : 'Proposed', approval, new Date().toISOString()
  );
  notify(`employee:${employee.id}`, `Goal · ${title}`, `${kpi} target ${Number(body.target) || 0}.`);
  if (user.role === 'client') notify('admin', `Goal request · ${title}`, `${employee.fullName} has a KPI waiting for approval.`);
  return listGoals(user);
}
function setGoalStatus(user, id, body) {
  const row = database.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!row) fail(404, 'Goal was not found');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This goal belongs to another company');
  if (body.achieved != null && body.achieved !== '' && (row.status === 'Active' || row.approval_status === 'Approved')) {
    assertCompanyDesk(user);
    patchRow('goals', id, { achieved: Number(body.achieved) || 0 });
  }
  if (body.status) {
    assertAdmin(user);
    const decision = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
    if (!decision) fail(400, 'Choose Approved or Rejected');
    patchRow('goals', id, { approval_status: decision, status: decision === 'Approved' ? 'Active' : 'Rejected' });
    notify(`client:${row.client_id}`, `${decision} · ${row.title}`, `The KPI for this goal is ${decision.toLowerCase()}.`);
    notify(`employee:${row.employee_id}`, `${decision} · ${row.title}`, `Your goal is ${decision.toLowerCase()}.`);
  }
  return listGoals(user);
}

function listKras(user) {
  let sql = `SELECT k.*, e.full_name FROM kras k JOIN employees e ON e.id = k.employee_id`;
  const params = [];
  if (user.role === 'employee') { sql += ' WHERE k.employee_id = ?'; params.push(user.employeeId); }
  else if (user.role === 'client') { sql += ' WHERE k.client_id = ?'; params.push(user.clientId); }
  else assertCompanyDesk(user);
  sql += ' ORDER BY e.full_name, k.weight DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, employeeId: row.employee_id, employeeName: row.full_name,
    title: row.title, weight: row.weight, description: row.description || '', createdAt: row.created_at
  }));
}
function saveKra(user, body) {
  assertCompanyDesk(user);
  const employee = mustEmployee(body.employeeId);
  assertEmployee(user, employee);
  const title = clip(body.title, 120);
  const weight = Number(body.weight) || 0;
  if (!title || weight <= 0 || weight > 100) fail(400, 'KRA title and a weight from 1 to 100 are required');
  database.prepare('INSERT INTO kras (id, client_id, employee_id, title, weight, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    crypto.randomUUID(), employee.clientId, employee.id, title, weight, clip(body.description, 400), new Date().toISOString()
  );
  notify(`employee:${employee.id}`, `KRA · ${title}`, `Weight ${weight}%. ${clip(body.description, 160)}`);
  return listKras(user);
}

function listReviews(user) {
  let sql = `SELECT r.*, e.full_name FROM reviews r JOIN employees e ON e.id = r.employee_id`;
  const params = [];
  if (user.role === 'employee') { sql += ' WHERE r.employee_id = ?'; params.push(user.employeeId); }
  else if (user.role === 'client') { sql += ' WHERE r.client_id = ?'; params.push(user.clientId); }
  else assertCompanyDesk(user);
  sql += ' ORDER BY r.created_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, employeeId: row.employee_id, employeeName: row.full_name,
    period: row.period, reviewer: row.reviewer, rating: row.rating, appraisal: row.appraisal || '',
    comments: row.comments || '', status: row.status, createdAt: row.created_at
  }));
}
function saveReview(user, body) {
  const employee = mustEmployee(user.role === 'employee' ? user.employeeId : body.employeeId);
  if (user.role !== 'employee') assertCompanyDesk(user);
  assertEmployee(user, employee);
  const period = clip(body.period, 20);
  const rating = Number(body.rating) || 0;
  if (!period) fail(400, 'Period is required');
  if (user.role !== 'employee' && (rating < 1 || rating > 5)) fail(400, 'A rating from 1 to 5 is required');
  const status = user.role === 'employee' ? 'Pending company' : 'Final';
  database.prepare(`INSERT INTO reviews (id, client_id, employee_id, period, reviewer, rating, appraisal, comments, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), employee.clientId, employee.id, period, user.name, rating,
    clip(body.appraisal, 800) || (user.role === 'employee' ? 'Review requested by the employee.' : ''),
    clip(body.comments, 400), status, new Date().toISOString()
  );
  notify(`client:${employee.clientId}`, `Review · ${period}`, status === 'Pending company' ? `${employee.fullName} asked for an appraisal.` : `${user.name} recorded a review.`);
  if (status === 'Pending admin') notify('admin', `Appraisal · ${employee.fullName}`, `${period} is waiting for final approval.`);
  if (status === 'Final') notify(`employee:${employee.id}`, `Review · ${period}`, `Rated ${rating} of 5.`);
  return listReviews(user);
}
function setReviewStatus(user, id, body) {
  const row = database.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
  if (!row) fail(404, 'Review was not found');
  if (user.role === 'client') {
    if (row.client_id !== user.clientId) fail(403, 'This review belongs to another company');
    if (!['Pending company', 'Pending admin'].includes(row.status)) fail(400, 'This appraisal is already closed');
    const decision = body.status === 'Rejected' ? 'Rejected' : 'Final';
    const rating = body.rating == null || body.rating === '' ? row.rating : Number(body.rating) || 0;
    if (decision !== 'Rejected' && (rating < 1 || rating > 5)) fail(400, 'Add a rating from 1 to 5');
    patchRow('reviews', id, { status: decision, rating: decision === 'Rejected' ? row.rating : rating, reviewer: user.name, appraisal: clip(body.appraisal, 800) || row.appraisal });
    notify(`employee:${row.employee_id}`, `${decision} · ${row.period}`, `${user.name} marked this appraisal ${decision.toLowerCase()}.`);
    return listReviews(user);
  }
  assertAdmin(user);
  const decision = body.status === 'Final' || body.status === 'Approved' ? 'Final' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Final or Rejected');
  patchRow('reviews', id, { status: decision });
  notify(`employee:${row.employee_id}`, `${decision} · ${row.period}`, `Your appraisal is ${decision.toLowerCase()}.`);
  notify(`client:${row.client_id}`, `${decision} · ${row.period}`, `The review was marked ${decision}.`);
  return listReviews(user);
}

function performanceAnalytics(user) {
  const tasks = listTasks(user);
  const goals = listGoals(user).filter((goal) => goal.status === 'Active');
  const reviews = listReviews(user).filter((review) => review.status === 'Final');
  const open = tasks.filter((task) => task.status !== 'Done' && task.status !== 'Rejected');
  const done = tasks.filter((task) => task.status === 'Done');
  const attainment = goals.length ? Math.round(goals.reduce((sum, goal) => sum + Math.min(goal.attainment, 100), 0) / goals.length) : 0;
  const avgRating = reviews.length ? Math.round((reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length) * 10) / 10 : 0;
  const priorities = ['Low', 'Normal', 'High', 'Urgent'].map((name) => ({ name, count: open.filter((task) => task.priority === name).length }));
  return {
    open: open.length,
    done: done.length,
    overdue: tasks.filter((task) => task.overdue).length,
    avgProgress: open.length ? Math.round(open.reduce((sum, task) => sum + task.progress, 0) / open.length) : 0,
    attainment,
    avgRating,
    reviews: reviews.length,
    priorities
  };
}

function listTemplates(user) {
  let sql = 'SELECT * FROM templates';
  const params = [];
  if (user.role === 'client') { sql += " WHERE owner_role = 'admin' OR owner_id = ?"; params.push(user.clientId); }
  if (user.role === 'employee') { sql += " WHERE owner_role = 'admin' OR owner_id = ?"; params.push(user.clientId || ''); }
  sql += ' ORDER BY category, name';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, ownerRole: row.owner_role, ownerId: row.owner_id, name: row.name, category: row.category,
    body: row.body || '', watermark: row.watermark || '', useBody: !!row.use_body, mapping: row.mapping || '', updatedAt: row.updated_at
  }));
}
function saveTemplate(user, body, id) {
  if (user.role === 'employee') fail(403, 'Templates are kept by the company and the administrator');
  const name = clip(body.name, 80);
  const category = clip(body.category, 40);
  const allowed = ['payslip', 'offer', 'idcard', 'relieving', 'appointment', 'experience', 'salarycert', 'invoice', 'quotation', 'warning'];
  if (!name || !allowed.includes(category)) fail(400, 'Name and a known template type are required');
  const record = {
    name, category, body: clip(body.body, 2000), watermark: clip(body.watermark, 60) || 'S1 HR SOLUTION',
    use_body: body.useBody === 'yes' || body.useBody === true || body.useBody === '1' ? 1 : 0,
    mapping: clip(body.mapping, 500), updated_at: new Date().toISOString()
  };
  if (id) {
    const existing = database.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!existing) fail(404, 'Template was not found');
    if (user.role === 'client' && existing.owner_id !== user.clientId) fail(403, 'This template belongs to another desk');
    patchRow('templates', id, record);
    return listTemplates(user).find((item) => item.id === id);
  }
  const newId = crypto.randomUUID();
  database.prepare(`INSERT INTO templates (id, owner_role, owner_id, name, category, body, watermark, use_body, mapping, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId, user.role === 'admin' ? 'admin' : 'client', user.role === 'admin' ? 's1' : user.clientId, record.name, record.category, record.body, record.watermark, record.use_body, record.mapping, record.updated_at);
  return listTemplates(user).find((item) => item.id === newId);
}

function search(user, q) {
  const raw = clip(q, 80);
  if (raw.length < 2) fail(400, 'Type at least 2 characters');
  const term = `%${raw.replace(/[%_]/g, '')}%`;
  const clients = user.role === 'employee' ? [] : database.prepare(`SELECT id, company_name, application_number, status FROM clients
    WHERE (company_name LIKE ? OR application_number LIKE ? OR official_mail LIKE ?) ${user.role === 'client' ? 'AND id = ?' : ''} LIMIT 12`)
    .all(...(user.role === 'client' ? [term, term, term, user.clientId] : [term, term, term]))
    .map((row) => ({ href: `#/client/${row.id}`, label: row.company_name, meta: `${row.application_number} · ${row.status}` }));
  let employeeSql = `SELECT id, full_name, employee_code, application_number, role_title FROM employees WHERE (full_name LIKE ? OR employee_code LIKE ? OR email LIKE ? OR application_number LIKE ?)`;
  const employeeParams = [term, term, term, term];
  if (user.role === 'client') { employeeSql += ' AND client_id = ?'; employeeParams.push(user.clientId); }
  if (user.role === 'employee') { employeeSql += ' AND id = ?'; employeeParams.push(user.employeeId); }
  const employees = database.prepare(`${employeeSql} LIMIT 12`).all(...employeeParams)
    .map((row) => ({ href: `#/employee/${row.id}`, label: row.full_name, meta: `${row.employee_code} · ${row.application_number} · ${row.role_title}` }));
  let activitySql = `SELECT id, title, application_number, type FROM activities WHERE (title LIKE ? OR application_number LIKE ?)`;
  const activityParams = [term, term];
  if (user.role !== 'admin') { activitySql += ' AND (client_id IS NULL OR client_id = ?)'; activityParams.push(user.clientId || ''); }
  const activities = database.prepare(`${activitySql} LIMIT 12`).all(...activityParams)
    .map((row) => ({ href: '#/activities', label: row.title, meta: `${row.application_number} · ${row.type}` }));
  const leads = user.role === 'admin'
    ? database.prepare('SELECT id, company_name, contact_name FROM leads WHERE company_name LIKE ? OR contact_name LIKE ? LIMIT 8').all(term, term)
      .map((row) => ({ href: '#/leads', label: row.company_name, meta: row.contact_name }))
    : [];
  const applicants = user.role === 'employee' ? [] : database.prepare(`SELECT id, full_name, application_number, position FROM applicants
    WHERE (full_name LIKE ? OR application_number LIKE ? OR email LIKE ?) ${user.role === 'client' ? 'AND client_id = ?' : ''} LIMIT 8`)
    .all(...(user.role === 'client' ? [term, term, term, user.clientId] : [term, term, term]))
    .map((row) => ({ href: '#/hiring', label: row.full_name, meta: `${row.application_number} · ${row.position}` }));
  const requisitions = user.role === 'employee' ? [] : database.prepare(`SELECT id, position, application_number, kind FROM requisitions
    WHERE (position LIKE ? OR application_number LIKE ?) ${user.role === 'client' ? 'AND client_id = ?' : ''} LIMIT 8`)
    .all(...(user.role === 'client' ? [term, term, user.clientId] : [term, term]))
    .map((row) => ({ href: '#/hiring', label: row.position, meta: `${row.application_number} · ${row.kind}` }));
  return { clients, employees, applicants, requisitions, activities, leads };
}

function exportRows(user, entity) {
  if (user.role === 'employee') fail(403, 'Bulk sheets are issued to the company and control desks');
  if (entity === 'clients') {
    return listClients(user).map((client) => ({
      applicationNumber: client.applicationNumber, company: client.companyName, businessType: client.businessType,
      email: client.officialMail, phone: client.phone, status: client.status, budget: client.totalBudget,
      score: `${client.scoreAchieved}/${client.scoreTarget}`, rating: client.rating
    }));
  }
  if (entity === 'employees') {
    return listEmployees(user).map((employee) => ({
      employeeId: employee.employeeCode, applicationNumber: employee.applicationNumber, name: employee.fullName,
      company: employee.companyName, branch: employee.branchName, department: employee.department, level: employee.levelName,
      role: employee.roleTitle, shift: employee.shiftName, hiring: employee.hiringSource, sourceCompany: employee.sourceCompany,
      bgv: employee.bgvStatus, login: employee.hasLogin ? 'Yes' : 'No', netPay: employee.pay.net
    }));
  }
  if (entity === 'payroll') {
    return listEmployees(user).map((employee) => ({
      employeeId: employee.employeeCode, name: employee.fullName, company: employee.companyName,
      gross: employee.pay.earnTotal, deductions: employee.pay.dedTotal, net: employee.pay.net,
      employer: employee.pay.employer.reduce((sum, line) => sum + line.amount, 0),
      paidDays: employee.pay.attendance.paidDays, presentDays: employee.pay.attendance.presentDays,
      lopDays: employee.pay.attendance.lopDays, otHours: employee.pay.attendance.otHours,
      netFullAndFinal: employee.pay.settlement.find((line) => line.key === 'netFfAmount')?.amount || 0
    }));
  }
  if (entity === 'leaves') {
    return listLeaves(user).map((row) => ({
      applicationNumber: row.applicationNumber, employee: row.employeeName, type: row.leaveType,
      from: row.fromDate, to: row.toDate, status: row.status, raisedAt: row.raisedAt, reason: row.reason
    }));
  }
  if (entity === 'attendance') {
    return listAttendance(user).map((row) => ({
      date: row.workDate, employee: row.employeeName, employeeId: row.employeeCode, company: row.companyName,
      shift: row.shiftName, inTime: row.inTime, outTime: row.outTime, status: row.status, mode: row.mode, flag: row.flag,
      penalty: row.penalty, remarks: row.penaltyRemarks, otHours: row.otHours, otAmount: row.otAmount, lopDays: row.lopDays,
      branch: row.branchName, place: row.locationName, location: row.locationNote
    }));
  }
  if (entity === 'hr') {
    return listClients(user).map((client) => {
      const people = listEmployees(user).filter((person) => person.clientId === client.id);
      return {
        company: client.companyName, applicationNumber: client.applicationNumber, status: client.status,
        branches: client.branches.length, staff: people.length, budget: client.totalBudget,
        score: `${client.scoreAchieved}/${client.scoreTarget}`, rating: client.rating
      };
    });
  }
  if (entity === 'onboarding') {
    return listEmployees(user).filter((person) => person.status === 'Onboarding' || (person.workflow && person.workflow.current === 'Onboarding')).map((person) => ({
      employeeId: person.employeeCode, applicationNumber: person.applicationNumber, name: person.fullName,
      company: person.companyName, department: person.department, role: person.roleTitle, joinedOn: person.joinedOn,
      stage: person.workflow && person.workflow.current ? person.workflow.current : person.status, bgv: person.bgvStatus
    }));
  }
  if (entity === 'recruitment') {
    const applicants = listApplicants(user).map((row) => ({
      record: 'Applicant', number: row.applicationNumber, name: row.fullName, position: row.position,
      source: row.source, stage: row.stage, offer: row.offerStatus, resume: row.resumeName || ''
    }));
    const seats = listRequisitions(user).map((row) => ({
      record: row.kind === 'S1 HR' ? 'S1 HR request' : 'Internal requisition', number: row.applicationNumber, name: row.companyName,
      position: row.position, source: row.kind, stage: row.status, offer: '', resume: `${row.openings} seats`
    }));
    return applicants.concat(seats);
  }
  if (entity === 'performance') {
    return listTasks(user).map((task) => ({
      employee: task.employeeName, company: task.companyName, task: task.title, priority: task.priority,
      due: task.dueDate, progress: task.progress, status: task.status, approval: task.approvalStatus, overdue: task.overdue ? 'Yes' : 'No'
    }));
  }
  if (entity === 'assets') {
    return listAssets(user).map((row) => ({
      code: row.assetCode, name: row.name, category: row.category, status: row.status,
      company: row.companyName, with: row.employeeName || 'In store', issued: row.issuedOn, serial: row.serialNo
    }));
  }
  if (entity === 'reimbursements') {
    return listReimbursements(user).map((row) => ({
      number: row.applicationNumber, employee: row.employeeName, company: row.companyName, category: row.category,
      date: row.expenseDate, amount: row.amount, from: row.fromPlace, to: row.toPlace, mode: row.mode, km: row.km,
      status: row.status, receipt: row.receiptName || '', description: row.description, finance: row.financeNote
    }));
  }
  if (entity === 'dataentry') {
    return listActivities(user).map((row) => ({
      number: row.applicationNumber, type: row.type, title: row.title, company: row.companyName,
      stage: row.stage, result: row.result || '', raisedBy: row.raisedByName || '', raisedAt: row.raisedAt
    }));
  }
  if (entity === 'operations') {
    return listActivities(user).map((row) => ({
      number: row.applicationNumber, desk: row.type, title: row.title, company: row.companyName,
      stage: row.stage, result: row.result || '', updatedAt: row.updatedAt
    }));
  }
  if (entity === 'exits') {
    return listEmployees(user).filter((person) => ['Separated', 'Exit', 'Full and final'].includes(person.status) || (person.exitCase && person.exitCase.reason)).map((person) => ({
      employeeId: person.employeeCode, name: person.fullName, company: person.companyName, status: person.status,
      lastWorkingDay: person.exitCase.lastWorkingDay || '', reason: person.exitCase.reason || '',
      fnf: person.exitCase.fnfStatus || '', assetClearance: person.exitCase.assetClearance || '', payrollClearance: person.exitCase.payrollClearance || ''
    }));
  }
  if (entity === 'incentives') {
    return listAwards(user).map((row) => ({
      number: row.applicationNumber, employee: row.employeeName, company: row.companyName, period: row.period,
      kind: row.kind, component: row.component, eligible: row.eligible ? 'Yes' : 'No', amount: row.amount,
      status: row.status, detail: row.detail
    }));
  }
  if (entity === 'locations') return locationReport(user);
  fail(404, 'That sheet is not available');
}

function managementDashboard(user) {
  if (user.role === 'employee') fail(403, 'Management figures stay with the company and control desks');
  const people = listEmployees(user);
  const tasks = listTasks(user);
  const reviews = listReviews(user).filter((row) => row.status === 'Final');
  const today = kolkataStamp().date;
  return {
    companies: listClients(user).length,
    workforce: people.length,
    onboarding: people.filter((person) => person.status === 'Onboarding' || (person.workflow && person.workflow.current === 'Onboarding')).length,
    presentToday: listAttendance(user, { date: today }).filter((row) => ['Present', 'Late', 'Early'].includes(row.status)).length,
    openLeaves: listLeaves(user).filter((row) => String(row.status).startsWith('Pending')).length,
    payrollNet: people.reduce((sum, person) => sum + (person.pay.net || 0), 0),
    openTasks: tasks.filter((task) => !['Done', 'Rejected'].includes(task.status)).length,
    avgRating: reviews.length ? Math.round((reviews.reduce((sum, row) => sum + row.rating, 0) / reviews.length) * 10) / 10 : 0,
    assetsOut: listAssets(user).filter((row) => row.status === 'Allocated').length,
    assetsRepair: listAssets(user).filter((row) => row.status === 'Repair').length,
    assetsLost: listAssets(user).filter((row) => ['Lost', 'Damaged'].includes(row.status)).length,
    openClaims: listReimbursements(user).filter((row) => OPEN_CLAIMS.includes(row.status)).length,
    exits: people.filter((person) => ['Separated', 'Exit', 'Full and final'].includes(person.status)).length,
    applicants: listApplicants(user).filter((row) => !['Hired', 'Rejected'].includes(row.stage)).length
  };
}

function listReportRequests(user) {
  if (user.role === 'employee') fail(403, 'Report requests stay with the company and control desks');
  let sql = `SELECT r.*, c.company_name FROM report_requests r JOIN clients c ON c.id = r.client_id`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE r.client_id = ?'; params.push(user.clientId); }
  sql += ' ORDER BY r.created_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, applicationNumber: row.application_number, clientId: row.client_id, companyName: row.company_name,
    reportName: row.report_name, period: row.period, reason: row.reason, status: row.status,
    raisedBy: row.raised_by, createdAt: row.created_at, decidedAt: row.decided_at || ''
  }));
}

function createReportRequest(user, body) {
  if (user.role !== 'client' && user.role !== 'admin') fail(403, 'Report requests are raised from a company or control desk');
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  const client = mustClient(clientId);
  const reportName = clip(body.reportName, 80);
  const reason = clip(body.reason, 400);
  if (!reportName || !reason) fail(400, 'Choose the report and say why it is needed');
  const id = crypto.randomUUID();
  const number = nextNumber('RPT');
  const status = user.role === 'admin' ? 'Approved' : 'Pending admin';
  database.prepare(`INSERT INTO report_requests (id, application_number, client_id, report_name, period, reason, status, raised_by, created_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, number, client.id, reportName, clip(body.period, 20), reason, status, user.name, new Date().toISOString(), status === 'Approved' ? new Date().toISOString() : ''
  );
  notify('admin', `Report request · ${reportName}`, `${client.companyName} · ${number}.`);
  notify(`client:${client.id}`, `Report request · ${reportName}`, `${number} is ${status}.`);
  return listReportRequests(user);
}

function setReportRequest(user, id, body) {
  assertAdmin(user);
  const row = database.prepare('SELECT * FROM report_requests WHERE id = ?').get(id);
  if (!row) fail(404, 'Report request was not found');
  const decision = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Approved or Rejected');
  patchRow('report_requests', id, { status: decision, decided_at: new Date().toISOString() });
  notify(`client:${row.client_id}`, `${decision} · ${row.report_name}`, `${row.application_number} is ${decision}. Download it from Reports.`);
  return listReportRequests(user);
}

function findTemplate(category, clientId) {
  return database.prepare(`SELECT * FROM templates WHERE category = ? AND ((owner_role = 'client' AND owner_id = ?) OR owner_role = 'admin')
    ORDER BY CASE owner_role WHEN 'client' THEN 0 ELSE 1 END LIMIT 1`).get(category, clientId || '');
}

const LETTER_KINDS = ['payslip', 'offer', 'idcard', 'appointment', 'experience', 'salarycert', 'relieving', 'ask'];
const TEMPLATE_TOKENS = [
  'employee.fullName', 'employee.employeeCode', 'employee.roleTitle', 'employee.department', 'employee.levelName',
  'employee.branchName', 'employee.locationName', 'employee.joinedOn', 'employee.email', 'employee.phone',
  'employee.reportingManager', 'employee.status', 'client.companyName', 'client.address',
  'pay.net', 'pay.earnTotal', 'pay.dedTotal', 'today', 'period', 'custom.nominee', 'custom.workstation'
];

function applyTokens(text, bag) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path) => {
    const value = path.split('.').reduce((obj, key) => (obj == null ? '' : obj[key]), bag);
    return value == null ? '' : String(value);
  });
}

function money(value) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function templateBag(employee, client, today, period) {
  return {
    employee: {
      fullName: employee.fullName, employeeCode: employee.employeeCode, roleTitle: employee.roleTitle,
      department: employee.department, levelName: employee.levelName, branchName: employee.branchName,
      locationName: employee.locationName || '', joinedOn: employee.joinedOn, email: employee.email,
      phone: employee.phone, reportingManager: employee.reportingManager, status: employee.status
    },
    client: { companyName: client.companyName, address: client.address || '' },
    pay: { net: money(employee.pay.net), earnTotal: money(employee.pay.earnTotal), dedTotal: money(employee.pay.dedTotal) },
    custom: employee.custom || {},
    today,
    period
  };
}

function documentModel(user, kind, id) {
  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'long', year: 'numeric' });
  const period = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'long', year: 'numeric' });
  if (['payslip', 'offer', 'idcard', 'relieving', 'appointment', 'experience', 'salarycert'].includes(kind)) {
    const employee = mustEmployee(id);
    assertEmployee(user, employee);
    if (user.role === 'employee' && kind !== 'payslip') {
      const approved = database.prepare(`SELECT id FROM document_requests WHERE employee_id = ? AND kind = ? AND status = 'Approved'`).get(employee.id, kind);
      if (!approved) fail(403, 'Ask HR to approve this letter before it can be opened');
    }
    const client = mustClient(employee.clientId);
    const template = findTemplate(kind, employee.clientId);
    const bag = templateBag(employee, client, today, period);
    const note = applyTokens(template ? template.body : '', bag);
    return {
      kind, employee, client, pay: employee.pay, today, period,
      watermark: template ? template.watermark : 'S1 HR SOLUTION',
      note: template && template.use_body ? '' : note,
      customBody: template && template.use_body ? note : '',
      qrText: `S1HR|${employee.employeeCode}|${employee.fullName}|${client.companyName}`,
      number: employee.applicationNumber
    };
  }
  if (['invoice', 'quotation'].includes(kind)) {
    if (user.role === 'employee') fail(403, 'Invoices are opened from the company or control desk');
    const client = mustClient(id);
    assertClient(user, client.id);
    const template = findTemplate(kind, client.id);
    return {
      kind, client, today, period,
      watermark: template ? template.watermark : 'S1 HR SOLUTION',
      note: template ? applyTokens(template.body, { client: { companyName: client.companyName, address: client.address || '' }, today, period, employee: {}, pay: {}, custom: {} }) : '',
      customBody: '',
      number: client.applicationNumber
    };
  }
  fail(404, 'That document is not on the desk');
}

const LIFECYCLE = ['Probation', 'Confirmation', 'Transfer', 'Promotion', 'Separation', 'Full and final'];
const ASSET_STATUS = ['In store', 'Allocated', 'Returned', 'Repair', 'Lost', 'Damaged'];
const JOB_STATUS = ['Open', 'Paused', 'Closed'];

function listLifecycle(user, employeeId) {
  const employee = mustEmployee(employeeId);
  assertEmployee(user, employee);
  return database.prepare('SELECT * FROM lifecycle_events WHERE employee_id = ? ORDER BY event_date, created_at').all(employeeId).map((row) => ({
    id: row.id, employeeId: row.employee_id, kind: row.kind, eventDate: row.event_date,
    notes: row.notes || '', fromValue: row.from_value || '', toValue: row.to_value || '', createdAt: row.created_at
  }));
}

function addLifecycle(user, employeeId, body) {
  assertCompanyDesk(user);
  const employee = mustEmployee(employeeId);
  assertEmployee(user, employee);
  const kind = LIFECYCLE.includes(body.kind) ? body.kind : '';
  const eventDate = clip(body.eventDate, 10);
  if (!kind || !eventDate) fail(400, 'Choose a lifecycle step and a date');
  const id = crypto.randomUUID();
  database.prepare(`INSERT INTO lifecycle_events (id, employee_id, kind, event_date, notes, from_value, to_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, employee.id, kind, eventDate, clip(body.notes, 400), clip(body.fromValue, 80), clip(body.toValue, 80), new Date().toISOString()
  );
  if (kind === 'Separation') patchRow('employees', employee.id, { status: 'Separated' });
  if (kind === 'Full and final') patchRow('employees', employee.id, { status: 'Full and final' });
  if (kind === 'Confirmation') patchRow('employees', employee.id, { status: 'Active' });
  if (kind === 'Probation') patchRow('employees', employee.id, { status: 'Probation' });
  notify(`employee:${employee.id}`, kind, `${kind} was recorded for ${eventDate}.`);
  return listLifecycle(user, employeeId);
}

const DOC_KINDS = ['aadhaar', 'pan', 'marksheet', 'bank', 'offer', 'appointment', 'relieving', 'other'];

function setEmployeeDocument(user, id, body) {
  assertCompanyDesk(user);
  const employee = mustEmployee(id);
  assertEmployee(user, employee);
  const kind = DOC_KINDS.includes(body.kind) ? body.kind : '';
  const url = clip(body.url, 240);
  if (!kind || !url) fail(400, 'Choose the document type and upload the file');
  const documents = { ...employee.documents };
  const file = { name: clip(body.name, 140) || 'Document', url };
  if (kind === 'other') documents.extra = (documents.extra || []).concat(file);
  else documents[kind] = file;
  patchRow('employees', id, { documents: JSON.stringify(documents) });
  return mustEmployee(id);
}

function updateWorkflow(user, id, body) {
  assertCompanyDesk(user);
  const employee = mustEmployee(id);
  assertEmployee(user, employee);
  const name = PROCESS.includes(body.step) ? body.step : '';
  const status = ['Pending', 'In progress', 'Completed'].includes(body.status) ? body.status : '';
  if (!name || !status) fail(400, 'Choose a process step and a status');
  const workflow = employee.workflow && employee.workflow.steps ? employee.workflow : blankWorkflow(employee.joinedOn);
  const step = workflow.steps.find((item) => item.name === name);
  if (!step) fail(400, 'That step is not on this process');
  step.status = status;
  step.date = clip(body.date, 10) || kolkataStamp().date;
  step.notes = clip(body.notes, 400);
  step.by = user.name;
  step.fromValue = clip(body.fromValue, 80);
  step.toValue = clip(body.toValue, 80);
  if (name === 'Promotion' && step.toValue) {
    patchRow('employees', id, { role_title: step.toValue });
  }
  if (name === 'Transfer' && body.branchId) {
    const branch = database.prepare('SELECT * FROM branches WHERE id = ? AND client_id = ?').get(body.branchId, employee.clientId);
    if (!branch) fail(400, 'Choose a branch on this company');
    if (branch.id !== employee.branchId) {
      database.prepare('UPDATE branches SET staff_count = MAX(staff_count - 1, 0) WHERE id = ?').run(employee.branchId);
      database.prepare('UPDATE branches SET staff_count = staff_count + 1 WHERE id = ?').run(branch.id);
      patchRow('employees', id, { branch_id: branch.id });
    }
    step.toValue = branch.name;
  }
  const main = ['Onboarding', 'Probation', 'Confirmation', 'Separation', 'Exit'];
  if (main.includes(name) && (status === 'In progress' || status === 'Completed')) {
    const index = main.indexOf(name);
    workflow.steps.forEach((item) => {
      const at = main.indexOf(item.name);
      if (at >= 0 && at < index && item.status !== 'Completed') {
        item.status = 'Completed';
        if (!item.date) item.date = step.date;
      }
    });
    workflow.current = name;
    if (status === 'Completed' && name !== 'Confirmation' && index < main.length - 1) {
      const next = workflow.steps.find((item) => item.name === main[index + 1]);
      if (next && next.status === 'Pending') {
        next.status = 'In progress';
        if (!next.date) next.date = step.date;
        workflow.current = next.name;
      }
    }
  } else {
    const open = workflow.steps.find((item) => item.status === 'In progress') || workflow.steps.find((item) => item.status === 'Pending');
    workflow.current = open ? open.name : name;
  }
  let employeeStatus = workflow.current;
  if (name === 'Confirmation' && status === 'Completed') employeeStatus = 'Active';
  if (name === 'Separation' && status !== 'Pending') employeeStatus = status === 'Completed' ? 'Separated' : 'Separation';
  if (name === 'Exit' && status === 'Completed') employeeStatus = 'Full and final';
  if (name === 'Exit' && status === 'In progress') employeeStatus = 'Exit';
  if (name === 'Probation' && status === 'In progress') employeeStatus = 'Probation';
  if (name === 'Onboarding' && status === 'In progress') employeeStatus = 'Onboarding';
  if (name === 'Transfer' || name === 'Promotion') employeeStatus = employee.status;
  patchRow('employees', id, { workflow: JSON.stringify(workflow), status: employeeStatus });
  database.prepare(`INSERT INTO lifecycle_events (id, employee_id, kind, event_date, notes, from_value, to_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), id, name === 'Exit' ? 'Full and final' : name, step.date, step.notes, step.fromValue, step.toValue, new Date().toISOString()
  );
  notify(`employee:${id}`, `${name} · ${status}`, step.notes || `${user.name} marked ${name} as ${status}.`);
  return mustEmployee(id);
}

function saveExit(user, id, body) {
  assertCompanyDesk(user);
  const employee = mustEmployee(id);
  assertEmployee(user, employee);
  const fnfStatus = ['Draft', 'In review', 'Settled'].includes(body.fnfStatus) ? body.fnfStatus : 'Draft';
  const exitCase = {
    lastWorkingDay: clip(body.lastWorkingDay, 10),
    reason: clip(body.reason, 240),
    noticeServed: body.noticeServed === 'yes' || body.noticeServed === true ? 'Yes' : 'No',
    assetClearance: body.assetClearance === 'Done' ? 'Done' : 'Pending',
    documentHandover: body.documentHandover === 'Done' ? 'Done' : 'Pending',
    payrollClearance: body.payrollClearance === 'Done' ? 'Done' : 'Pending',
    fnfStatus,
    notes: clip(body.notes, 400),
    updatedAt: new Date().toISOString(),
    updatedBy: user.name
  };
  if (!exitCase.reason) fail(400, 'Record why the person is leaving');
  const workflow = employee.workflow && employee.workflow.steps ? employee.workflow : blankWorkflow(employee.joinedOn);
  const separation = workflow.steps.find((step) => step.name === 'Separation');
  const exitStep = workflow.steps.find((step) => step.name === 'Exit');
  if (separation && separation.status === 'Pending') {
    separation.status = 'In progress';
    separation.date = exitCase.lastWorkingDay || kolkataStamp().date;
    separation.by = user.name;
  }
  if (exitStep) {
    exitStep.status = fnfStatus === 'Settled' ? 'Completed' : 'In progress';
    exitStep.date = exitCase.lastWorkingDay || kolkataStamp().date;
    exitStep.notes = exitCase.notes || exitCase.reason;
    exitStep.by = user.name;
  }
  workflow.current = fnfStatus === 'Settled' ? 'Exit' : 'Separation';
  patchRow('employees', id, {
    exit_case: JSON.stringify(exitCase),
    workflow: JSON.stringify(workflow),
    status: fnfStatus === 'Settled' ? 'Full and final' : 'Exit'
  });
  notify('admin', `Exit · ${employee.fullName}`, `${employee.fullName} is ${fnfStatus === 'Settled' ? 'settled' : 'in the exit process'}.`);
  return mustEmployee(id);
}

function orgStructure(user) {
  assertCompanyDesk(user);
  const people = listEmployees(user).map((person) => ({
    id: person.id,
    fullName: person.fullName,
    photoUrl: person.photoUrl || '',
    department: person.department,
    levelName: person.levelName,
    roleTitle: person.roleTitle,
    reportingManager: person.reportingManager,
    branchId: person.branchId,
    branchName: person.branchName,
    locationName: person.locationName,
    shiftId: person.shiftId,
    shiftName: person.shiftName,
    companyName: person.companyName,
    clientId: person.clientId,
    hasLogin: person.hasLogin,
    teamId: person.teamId || '',
    deskRole: person.deskRole || '',
    status: person.status,
    stage: person.workflow && person.workflow.current ? person.workflow.current : person.status
  }));
  const departments = database.prepare('SELECT * FROM departments ORDER BY name').all().map((row) => {
    const levels = parse(row.levels, []);
    return {
      id: row.id,
      name: row.name,
      levels,
      headcount: people.filter((person) => person.department === row.name).length
    };
  });
  return {
    departments,
    people,
    teams: listTeams(user),
    policies: listOrgPolicies(user),
    reviews: listOrgReviews(user),
    roles: listOrgRoles(user),
    portals: [
      { name: 'Administrator', access: 'All companies, final approval, payroll, plans, and closure' },
      { name: 'Company desk', access: 'Own people, attendance, hiring requests, expenses, and organisation' },
      { name: 'Employee desk', access: 'Own attendance, leave, claims, and letters after approval' }
    ]
  };
}

function listTeams(user) {
  let sql = `SELECT t.*, c.company_name, b.name AS branch_name, e.full_name AS lead_name
    FROM teams t JOIN clients c ON c.id = t.client_id
    LEFT JOIN branches b ON b.id = t.branch_id
    LEFT JOIN employees e ON e.id = t.lead_id WHERE 1 = 1`;
  const params = [];
  if (user.role === 'client') { sql += ' AND t.client_id = ?'; params.push(user.clientId); }
  sql += ' ORDER BY t.name';
  const people = listEmployees(user);
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, companyName: row.company_name, name: row.name,
    department: row.department || '', branchId: row.branch_id || '', branchName: row.branch_name || '',
    leadId: row.lead_id || '', leadName: row.lead_name || '', status: row.status,
    members: people.filter((person) => person.teamId === row.id).map((person) => ({ id: person.id, fullName: person.fullName, deskRole: person.deskRole }))
  }));
}

function saveTeam(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  const client = mustClient(clientId);
  if (user.role === 'client') assertClient(user, client.id);
  const name = clip(body.name, 80);
  if (!name) fail(400, 'Name the team');
  let leadId = clip(body.leadId, 40);
  if (leadId) {
    const lead = mustEmployee(leadId);
    if (lead.clientId !== client.id) fail(400, 'The lead is not on this company');
  }
  const id = crypto.randomUUID();
  database.prepare(`INSERT INTO teams (id, client_id, name, department, branch_id, lead_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Active', ?)`).run(
    id, client.id, name, clip(body.department, 80), clip(body.branchId, 40) || null, leadId || null, new Date().toISOString()
  );
  notify(`client:${client.id}`, `Team · ${name}`, 'A team was formed.');
  notify('admin', `Team · ${name}`, `${client.companyName} formed a team.`);
  return listTeams(user);
}

function assignOrg(user, body) {
  assertCompanyDesk(user);
  const employee = mustEmployee(body.employeeId);
  assertEmployee(user, employee);
  const patch = {};
  if (body.department) patch.department = clip(body.department, 80);
  if (body.levelName) patch.level_name = clip(body.levelName, 80);
  if (body.roleTitle) patch.role_title = clip(body.roleTitle, 80);
  if (body.reportingManager) patch.reporting_manager = clip(body.reportingManager, 80);
  if (body.deskRole != null) patch.desk_role = clip(body.deskRole, 40);
  if (body.teamId != null) {
    if (body.teamId) {
      const team = database.prepare('SELECT * FROM teams WHERE id = ?').get(body.teamId);
      if (!team || team.client_id !== employee.clientId) fail(400, 'That team is not on this company');
    }
    patch.team_id = clip(body.teamId, 40) || null;
  }
  if (body.shiftId) {
    const shift = database.prepare('SELECT id FROM shifts WHERE id = ?').get(body.shiftId);
    if (!shift) fail(400, 'Choose a shift');
    patch.shift_id = shift.id;
  }
  if (body.branchId && body.branchId !== employee.branchId) {
    const branch = database.prepare('SELECT * FROM branches WHERE id = ? AND client_id = ?').get(body.branchId, employee.clientId);
    if (!branch) fail(400, 'That branch is not on this company');
    database.prepare('UPDATE branches SET staff_count = MAX(staff_count - 1, 0) WHERE id = ?').run(employee.branchId);
    database.prepare('UPDATE branches SET staff_count = staff_count + 1 WHERE id = ?').run(branch.id);
    patch.branch_id = branch.id;
  }
  if (!Object.keys(patch).length && !body.locationId) fail(400, 'Choose what to assign');
  if (Object.keys(patch).length) patchRow('employees', employee.id, patch);
  if (body.locationId) assignEmployeeLocation(user, employee.id, body.locationId);
  notify(`employee:${employee.id}`, 'Organisation assignment', 'Your department, team, shift, or manager was updated.');
  notify(`client:${employee.clientId}`, `Assignment · ${employee.fullName}`, 'The organisation map was updated.');
  return mustEmployee(employee.id);
}

function listOrgPolicies(user) {
  let sql = `SELECT p.*, c.company_name FROM org_policies p JOIN clients c ON c.id = p.client_id`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE p.client_id = ?'; params.push(user.clientId); }
  sql += ' ORDER BY p.created_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, companyName: row.company_name, name: row.name, detail: row.detail, status: row.status
  }));
}

function saveOrgPolicy(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  const client = mustClient(clientId);
  if (user.role === 'client') assertClient(user, client.id);
  const name = clip(body.name, 80);
  const detail = clip(body.detail, 400);
  if (!name || !detail) fail(400, 'Name the policy and describe it');
  const status = user.role === 'admin' ? 'Active' : 'Pending admin';
  database.prepare(`INSERT INTO org_policies (id, client_id, name, detail, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), client.id, name, detail, status, new Date().toISOString()
  );
  notify('admin', `Organisation policy · ${name}`, `${client.companyName}: ${status}.`);
  notify(`client:${client.id}`, `Policy · ${name}`, status === 'Active' ? 'The policy is active.' : 'Waiting for the administrator.');
  return listOrgPolicies(user);
}

function setOrgPolicy(user, id, body) {
  assertAdmin(user);
  const row = database.prepare('SELECT * FROM org_policies WHERE id = ?').get(id);
  if (!row) fail(404, 'Policy was not found');
  const status = body.status === 'Active' ? 'Active' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!status) fail(400, 'Choose Active or Rejected');
  patchRow('org_policies', id, { status });
  notify(`client:${row.client_id}`, `Policy ${status}`, `${row.name} is ${status}.`);
  return listOrgPolicies(user);
}

function listOrgReviews(user) {
  let sql = `SELECT r.*, c.company_name FROM org_reviews r JOIN clients c ON c.id = r.client_id`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE r.client_id = ?'; params.push(user.clientId); }
  sql += ' ORDER BY r.created_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, companyName: row.company_name, period: row.period,
    rating: Number(row.rating) || 0, notes: row.notes || '', status: row.status
  }));
}

function saveOrgReview(user, body) {
  assertAdmin(user);
  const client = mustClient(body.clientId);
  const period = clip(body.period, 20);
  const notes = clip(body.notes, 400);
  if (!period || !notes) fail(400, 'Period and review notes are required');
  database.prepare(`INSERT INTO org_reviews (id, client_id, period, rating, notes, status, created_at) VALUES (?, ?, ?, ?, ?, 'Reviewed', ?)`).run(
    crypto.randomUUID(), client.id, period, Math.max(1, Math.min(5, Number(body.rating) || 1)), notes, new Date().toISOString()
  );
  notify(`client:${client.id}`, `Organisation review · ${period}`, notes);
  return listOrgReviews(user);
}

function saveOrgRole(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  const client = mustClient(clientId);
  if (user.role === 'client') assertClient(user, client.id);
  const name = clip(body.name, 40);
  const permissions = String(body.permissions || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!name || !permissions.length) fail(400, 'Name the role and its permissions');
  database.prepare(`INSERT INTO org_roles (id, client_id, name, permissions, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), client.id, name, JSON.stringify(permissions), new Date().toISOString()
  );
  notify(`client:${client.id}`, `Role · ${name}`, permissions.join(', '));
  return listOrgRoles(user);
}

function listOrgRoles(user) {
  let sql = 'SELECT * FROM org_roles';
  const params = [];
  if (user.role === 'client') { sql += ' WHERE client_id = ?'; params.push(user.clientId); }
  sql += ' ORDER BY name';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, name: row.name, permissions: parse(row.permissions, [])
  }));
}

function listAssets(user) {
  let sql = `SELECT a.*, e.full_name, c.company_name FROM assets a
    LEFT JOIN employees e ON e.id = a.employee_id
    LEFT JOIN clients c ON c.id = a.client_id`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE a.client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') { sql += ' WHERE a.employee_id = ?'; params.push(user.employeeId); }
  sql += ' ORDER BY a.asset_code';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, assetCode: row.asset_code, name: row.name, category: row.category, serialNo: row.serial_no || '',
    status: row.status, clientId: row.client_id || '', companyName: row.company_name || '',
    employeeId: row.employee_id || '', employeeName: row.full_name || '', notes: row.notes || '',
    issuedOn: row.issued_on || '', returnedOn: row.returned_on || ''
  }));
}

function saveAsset(user, body, id) {
  if (user.role === 'employee') fail(403, 'Assets are issued by the company or the administrator');
  const name = clip(body.name, 80);
  const category = clip(body.category, 40);
  const status = ASSET_STATUS.includes(body.status) ? body.status : 'In store';
  if (!name || !category) fail(400, 'Asset name and category are required');
  let clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  if (clientId) mustClient(clientId);
  if (user.role === 'client') assertClient(user, clientId);
  let employeeId = clip(body.employeeId, 40);
  if (employeeId) {
    const employee = mustEmployee(employeeId);
    if (clientId && employee.clientId !== clientId) fail(400, 'That person is not on this company');
    clientId = employee.clientId;
  }
  if (status === 'Allocated' && !employeeId) fail(400, 'Choose the employee who receives this asset');
  const record = {
    name, category, serial_no: clip(body.serialNo, 40), status, client_id: clientId || null,
    employee_id: employeeId || null, notes: clip(body.notes, 240),
    issued_on: status === 'Allocated' ? (clip(body.issuedOn, 10) || kolkataStamp().date) : clip(body.issuedOn, 10),
    returned_on: ['Returned', 'Lost', 'Damaged'].includes(status) ? (clip(body.returnedOn, 10) || kolkataStamp().date) : ''
  };
  if (id) {
    const existing = database.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    if (!existing) fail(404, 'Asset was not found');
    if (user.role === 'client' && existing.client_id !== user.clientId) fail(403, 'This asset belongs to another company');
    patchRow('assets', id, record);
    recordAssetEvent(id, 'Updated', existing.status, record.status, employeeName(existing.employee_id), employeeName(record.employee_id), record.notes, user.name);
  } else {
    const assetId = crypto.randomUUID();
    database.prepare(`INSERT INTO assets (id, asset_code, name, category, serial_no, status, client_id, employee_id, notes, issued_on, returned_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      assetId, nextNumber('AST').replace('APP-AST-2026-', 'AST-2026-'),
      record.name, record.category, record.serial_no, record.status, record.client_id, record.employee_id,
      record.notes, record.issued_on, record.returned_on
    );
    recordAssetEvent(assetId, 'Recorded', '', record.status, '', employeeName(record.employee_id), record.notes || 'Added to the asset master', user.name);
  }
  return listAssets(user);
}

function recordAssetEvent(assetId, action, fromStatus, toStatus, fromEmployee, toEmployee, detail, actor) {
  database.prepare(`INSERT INTO asset_events (id, asset_id, action, from_status, to_status, from_employee, to_employee, detail, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), assetId, action, fromStatus || '', toStatus || '', fromEmployee || '', toEmployee || '', clip(detail, 400), actor || '', new Date().toISOString()
  );
}

function employeeName(id) {
  if (!id) return '';
  const row = database.prepare('SELECT full_name FROM employees WHERE id = ?').get(id);
  return row ? row.full_name : '';
}

function listAssetEvents(user, assetId) {
  const asset = database.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  if (!asset) fail(404, 'Asset was not found');
  if (user.role === 'client' && asset.client_id !== user.clientId) fail(403, 'This asset belongs to another company');
  if (user.role === 'employee' && asset.employee_id !== user.employeeId) fail(403, 'This asset is not with you');
  return database.prepare('SELECT * FROM asset_events WHERE asset_id = ? ORDER BY created_at').all(assetId).map((row) => ({
    id: row.id, action: row.action, fromStatus: row.from_status || '', toStatus: row.to_status || '',
    fromEmployee: row.from_employee || '', toEmployee: row.to_employee || '', detail: row.detail || '',
    actor: row.actor || '', createdAt: row.created_at
  }));
}

function moveAsset(user, id, body) {
  if (user.role === 'employee') fail(403, 'Asset movements are made by the company desk or the administrator');
  const asset = database.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!asset) fail(404, 'Asset was not found');
  if (user.role === 'client' && asset.client_id !== user.clientId) fail(403, 'This asset belongs to another company');
  const action = ['Allocate', 'Return', 'Reissue', 'Transfer', 'Repair', 'Lost', 'Damaged'].includes(body.action) ? body.action : '';
  if (!action) fail(400, 'Choose a movement');
  const detail = clip(body.detail, 400);
  let employeeId = clip(body.employeeId, 40);
  if (['Allocate', 'Reissue', 'Transfer'].includes(action)) {
    if (!employeeId) fail(400, 'Choose the employee');
    const employee = mustEmployee(employeeId);
    if (asset.client_id && employee.clientId !== asset.client_id) fail(400, 'That person is not on this company');
    if (action === 'Reissue' && !['Returned', 'In store', 'Repair'].includes(asset.status)) fail(400, 'Return or repair the asset before reissuing it');
    if (action === 'Transfer' && asset.status !== 'Allocated') fail(400, 'Only an allocated asset can be transferred');
    if (action === 'Transfer' && employeeId === asset.employee_id) fail(400, 'Choose a different employee');
  }
  const fromName = employeeName(asset.employee_id);
  const toName = employeeName(employeeId);
  const next = { status: asset.status, employee_id: asset.employee_id, issued_on: asset.issued_on, returned_on: asset.returned_on || '', notes: detail || asset.notes };
  if (action === 'Allocate' || action === 'Reissue' || action === 'Transfer') {
    next.status = 'Allocated';
    next.employee_id = employeeId;
    next.issued_on = kolkataStamp().date;
    next.returned_on = '';
  }
  if (action === 'Return') {
    next.status = 'Returned';
    next.employee_id = null;
    next.returned_on = kolkataStamp().date;
  }
  if (action === 'Repair') next.status = 'Repair';
  if (action === 'Lost') { next.status = 'Lost'; next.returned_on = kolkataStamp().date; }
  if (action === 'Damaged') { next.status = 'Damaged'; next.returned_on = kolkataStamp().date; }
  patchRow('assets', id, next);
  recordAssetEvent(id, action, asset.status, next.status, fromName, toName, detail, user.name);
  const holder = next.employee_id || asset.employee_id;
  if (holder) notify(`employee:${holder}`, `Asset ${action.toLowerCase()}`, `${asset.name} is now ${next.status}.`);
  if (asset.client_id) notify(`client:${asset.client_id}`, `Asset ${action.toLowerCase()} · ${asset.asset_code}`, detail || `${asset.name} moved by ${user.name}.`);
  notify('admin', `Asset ${action.toLowerCase()} · ${asset.asset_code}`, `${asset.name} is ${next.status}.`);
  return listAssets(user);
}

function listAssetPeople(user) {
  let clientId = user.clientId || '';
  if (user.role === 'employee') {
    const me = database.prepare('SELECT client_id FROM employees WHERE id = ?').get(user.employeeId);
    clientId = me ? me.client_id : '';
  }
  if (user.role === 'admin' && !clientId) {
    return database.prepare('SELECT id, full_name, client_id FROM employees ORDER BY full_name').all().map((row) => ({
      id: row.id, fullName: row.full_name, clientId: row.client_id
    }));
  }
  return database.prepare('SELECT id, full_name, client_id FROM employees WHERE client_id = ? ORDER BY full_name').all(clientId).map((row) => ({
    id: row.id, fullName: row.full_name, clientId: row.client_id
  }));
}

function listAssetRequests(user) {
  let sql = `SELECT r.*, a.name AS asset_name, a.asset_code, e.full_name, d.full_name AS destination_name FROM asset_requests r
    JOIN assets a ON a.id = r.asset_id
    LEFT JOIN employees e ON e.id = r.employee_id
    LEFT JOIN employees d ON d.id = r.destination_employee_id WHERE 1 = 1`;
  const params = [];
  if (user.role === 'client') { sql += ' AND r.client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') { sql += ' AND (r.employee_id = ? OR r.raised_by = ?)'; params.push(user.employeeId, user.name); }
  sql += ' ORDER BY r.created_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, applicationNumber: row.application_number, assetId: row.asset_id, assetName: row.asset_name,
    assetCode: row.asset_code, clientId: row.client_id, employeeId: row.employee_id || '', employeeName: row.full_name || '',
    destinationEmployeeId: row.destination_employee_id || '', destinationName: row.destination_name || '',
    action: row.action, detail: row.detail, status: row.status, raisedBy: row.raised_by || '', createdAt: row.created_at, decidedAt: row.decided_at || ''
  }));
}

function createAssetRequest(user, body) {
  const asset = database.prepare('SELECT * FROM assets WHERE id = ?').get(body.assetId);
  if (!asset) fail(404, 'Asset was not found');
  if (user.role === 'employee' && asset.employee_id !== user.employeeId) fail(403, 'You can request a change only for an asset you hold');
  if (user.role === 'client' && asset.client_id !== user.clientId) fail(403, 'This asset belongs to another company');
  if (!['admin', 'client', 'employee'].includes(user.role)) fail(403, 'Sign in to raise an asset request');
  const action = ['Change', 'Return', 'Repair', 'Transfer', 'Reissue', 'Lost', 'Damaged'].includes(body.action) ? body.action : '';
  const detail = clip(body.detail, 400);
  if (!action || !detail) fail(400, 'Choose the change and describe it');
  let destinationId = ['Transfer', 'Reissue'].includes(action) ? clip(body.employeeId, 40) : '';
  if (['Transfer', 'Reissue'].includes(action)) {
    if (!destinationId) fail(400, 'Choose the employee who should receive this asset');
    const destination = mustEmployee(destinationId);
    if (asset.client_id && destination.clientId !== asset.client_id) fail(400, 'That person is not on this company');
    if (action === 'Transfer' && destinationId === asset.employee_id) fail(400, 'Choose a different employee');
  }
  const employeeId = asset.employee_id || (user.role === 'employee' ? user.employeeId : null);
  const status = user.role === 'employee' ? 'Pending company' : 'Pending admin';
  const id = crypto.randomUUID();
  const number = nextNumber('ARS');
  database.prepare(`INSERT INTO asset_requests (id, application_number, asset_id, client_id, employee_id, destination_employee_id, action, detail, status, raised_by, created_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`).run(
    id, number, asset.id, asset.client_id, employeeId || null, destinationId || null, action, detail, status, user.name, new Date().toISOString()
  );
  notify(`client:${asset.client_id}`, `Asset request · ${asset.asset_code}`, `${number} · ${action}. ${detail}`);
  notify('admin', `Asset request · ${asset.asset_code}`, `${number} is ${status}.`);
  if (employeeId) notify(`employee:${employeeId}`, `Asset request · ${number}`, `${action} was sent for approval.`);
  return listAssetRequests(user);
}

function setAssetRequest(user, id, body) {
  const row = database.prepare('SELECT * FROM asset_requests WHERE id = ?').get(id);
  if (!row) fail(404, 'Asset request was not found');
  const decision = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Approved or Rejected');
  if (user.role === 'employee') fail(403, 'Asset requests are approved by the client admin and the company admin');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This request belongs to another company');
  if (user.role !== 'client') assertAdmin(user);
  if (!['Pending company', 'Pending admin'].includes(row.status)) fail(400, 'This request is already closed');
  if (decision === 'Approved') {
    if (row.action === 'Change') recordAssetEvent(row.asset_id, 'Change', '', '', '', '', row.detail, user.name);
    else moveAsset(user, row.asset_id, { action: row.action, employeeId: body.employeeId || row.destination_employee_id || row.employee_id, detail: row.detail });
  }
  patchRow('asset_requests', id, { status: decision, decided_at: new Date().toISOString() });
  notify(`client:${row.client_id}`, `${decision} · ${row.application_number}`, `${row.action} is ${decision}.`);
  if (row.employee_id) notify(`employee:${row.employee_id}`, `${decision} · ${row.application_number}`, `${row.action} is ${decision}.`);
  return listAssetRequests(user);
}

function listHolidays(user) {
  let sql = 'SELECT h.*, c.company_name FROM holidays h LEFT JOIN clients c ON c.id = h.client_id';
  const params = [];
  if (user.role !== 'admin') {
    sql += ' WHERE h.client_id IS NULL OR h.client_id = ?';
    params.push(user.clientId || '');
  }
  sql += ' ORDER BY h.holiday_date';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, date: row.holiday_date, name: row.name, clientId: row.client_id || '', companyName: row.company_name || 'All companies'
  }));
}

function addHoliday(user, body) {
  if (user.role === 'employee') fail(403, 'Holiday calendars are kept by the company and the administrator');
  const name = clip(body.name, 80);
  const date = clip(body.date, 10);
  if (!name || !date) fail(400, 'Holiday name and date are required');
  const clientId = user.role === 'client' ? user.clientId : (clip(body.clientId, 40) || null);
  if (clientId) mustClient(clientId);
  database.prepare('INSERT INTO holidays (id, holiday_date, name, client_id) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), date, name, clientId);
  return listHolidays(user);
}

function listJobs(user) {
  if (user.role === 'employee') fail(403, 'Job openings stay with the company and control desks');
  let sql = `SELECT j.*, c.company_name FROM jobs j JOIN clients c ON c.id = j.client_id`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE j.client_id = ?'; params.push(user.clientId); }
  sql += ' ORDER BY j.created_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, applicationNumber: row.application_number, clientId: row.client_id, companyName: row.company_name,
    title: row.title, description: row.description || '', openings: row.openings, status: row.status, createdAt: row.created_at
  }));
}

function saveJob(user, body, id) {
  if (user.role === 'employee') fail(403, 'Job openings stay with the company and control desks');
  const title = clip(body.title, 80);
  const status = JOB_STATUS.includes(body.status) ? body.status : 'Open';
  const openings = Math.max(1, Number(body.openings) || 1);
  if (!title) fail(400, 'Job title is required');
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  mustClient(clientId);
  if (user.role === 'client') assertClient(user, clientId);
  if (id) {
    const existing = database.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!existing) fail(404, 'Job was not found');
    if (user.role === 'client' && existing.client_id !== user.clientId) fail(403, 'This opening belongs to another company');
    patchRow('jobs', id, { title, description: clip(body.description, 400), openings, status, client_id: clientId });
  } else {
    database.prepare(`INSERT INTO jobs (id, application_number, client_id, title, description, openings, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      crypto.randomUUID(), nextNumber('JOB'), clientId, title, clip(body.description, 400), openings, status, new Date().toISOString()
    );
  }
  return listJobs(user);
}

function recruitmentAnalytics(user) {
  if (user.role === 'employee') fail(403, 'Recruitment figures stay with the company and control desks');
  const applicants = listApplicants(user);
  const jobs = listJobs(user);
  const stages = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected'];
  return {
    openings: jobs.filter((job) => job.status === 'Open').length,
    seats: jobs.filter((job) => job.status === 'Open').reduce((sum, job) => sum + job.openings, 0),
    applicants: applicants.length,
    byStage: stages.map((stage) => ({ stage, count: applicants.filter((row) => row.stage === stage).length })),
    offers: applicants.filter((row) => row.offerStatus && row.offerStatus !== 'None').length,
    joining: listJoining(user).filter((row) => row.status !== 'Rejected').length
  };
}

function ensureJoining(applicant, actor) {
  const existing = database.prepare('SELECT id FROM joining_cases WHERE applicant_id = ? AND status != ?').get(applicant.id, 'Rejected');
  if (existing) return;
  const id = crypto.randomUUID();
  const number = nextNumber('JOIN');
  database.prepare(`INSERT INTO joining_cases (id, application_number, applicant_id, client_id, job_id, status, joined_on, notes, created_at, decided_at)
    VALUES (?, ?, ?, ?, ?, 'Pending company', '', ?, ?, '')`).run(
    id, number, applicant.id, applicant.client_id, applicant.job_id || null, 'Hired and waiting for the company desk.', new Date().toISOString()
  );
  notify(`client:${applicant.client_id}`, `Joining · ${applicant.full_name}`, `${number} is waiting for the company desk.`);
  notify('admin', `Joining · ${applicant.full_name}`, `${number} opened by ${actor}.`);
}

function listJoining(user) {
  if (user.role === 'employee') fail(403, 'Joining stays with the company and control desks');
  let sql = `SELECT j.*, a.full_name, a.position, a.application_number AS applicant_number, c.company_name
    FROM joining_cases j JOIN applicants a ON a.id = j.applicant_id JOIN clients c ON c.id = j.client_id WHERE 1 = 1`;
  const params = [];
  if (user.role === 'client') { sql += ' AND j.client_id = ?'; params.push(user.clientId); }
  sql += ' ORDER BY j.created_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, applicationNumber: row.application_number, applicantId: row.applicant_id, applicantName: row.full_name,
    applicantNumber: row.applicant_number, position: row.position, clientId: row.client_id, companyName: row.company_name,
    status: row.status, joinedOn: row.joined_on || '', notes: row.notes || ''
  }));
}

function setJoining(user, id, body) {
  const row = database.prepare('SELECT * FROM joining_cases WHERE id = ?').get(id);
  if (!row) fail(404, 'Joining case was not found');
  const applicant = database.prepare('SELECT * FROM applicants WHERE id = ?').get(row.applicant_id);
  const decision = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Approved or Rejected');
  if (user.role === 'client') {
    if (row.client_id !== user.clientId) fail(403, 'This joining belongs to another company');
    if (row.status !== 'Pending company') fail(400, 'The company step is already complete');
    const next = decision === 'Approved' ? 'Pending admin' : 'Rejected';
    patchRow('joining_cases', id, { status: next, decided_at: new Date().toISOString(), notes: clip(body.notes, 240) || row.notes });
    notify('admin', `Joining · ${applicant.full_name}`, `${row.application_number} is ${next}.`);
    return listJoining(user);
  }
  assertAdmin(user);
  if (decision === 'Rejected') {
    patchRow('joining_cases', id, { status: 'Rejected', decided_at: new Date().toISOString() });
  } else if (['Pending company', 'Pending admin'].includes(row.status)) {
    const joinedOn = clip(body.joinedOn, 10) || kolkataStamp().date;
    patchRow('joining_cases', id, { status: 'Joined', joined_on: joinedOn, decided_at: new Date().toISOString(), notes: clip(body.notes, 240) || row.notes });
    const company = database.prepare('SELECT company_name FROM clients WHERE id = ?').get(row.client_id);
    database.prepare(`INSERT INTO employment_history (id, employee_id, applicant_id, client_id, employer, role_title, from_date, to_date, notes, created_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, '', ?, ?)`).run(
      crypto.randomUUID(), applicant.id, row.client_id, company ? company.company_name : '',
      applicant.position, joinedOn, 'Joined through recruitment.', new Date().toISOString()
    );
  } else fail(400, 'This joining is already closed');
  notify(`client:${row.client_id}`, `Joining · ${applicant.full_name}`, `${row.application_number} is ${decision === 'Rejected' ? 'Rejected' : 'Joined'}.`);
  return listJoining(user);
}

function listEmploymentHistory(user) {
  if (user.role === 'employee') {
    return database.prepare('SELECT * FROM employment_history WHERE employee_id = ? ORDER BY from_date').all(user.employeeId).map(shapeHistory);
  }
  let sql = 'SELECT * FROM employment_history WHERE 1 = 1';
  const params = [];
  if (user.role === 'client') { sql += ' AND client_id = ?'; params.push(user.clientId); }
  sql += ' ORDER BY from_date DESC';
  return database.prepare(sql).all(...params).map(shapeHistory);
}

function shapeHistory(row) {
  return {
    id: row.id, employeeId: row.employee_id || '', applicantId: row.applicant_id || '', clientId: row.client_id || '',
    employer: row.employer, roleTitle: row.role_title, fromDate: row.from_date || '', toDate: row.to_date || '', notes: row.notes || ''
  };
}

function addEmploymentHistory(user, body) {
  assertCompanyDesk(user);
  const employee = body.employeeId ? mustEmployee(body.employeeId) : null;
  if (employee && user.role === 'client') assertClient(user, employee.clientId);
  const employer = clip(body.employer, 120);
  const roleTitle = clip(body.roleTitle, 80);
  if (!employer || !roleTitle) fail(400, 'Employer and role are required');
  const clientId = employee ? employee.clientId : (user.role === 'client' ? user.clientId : clip(body.clientId, 40));
  database.prepare(`INSERT INTO employment_history (id, employee_id, applicant_id, client_id, employer, role_title, from_date, to_date, notes, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), employee ? employee.id : null, clientId, employer, roleTitle,
    clip(body.fromDate, 10), clip(body.toDate, 10), clip(body.notes, 240), new Date().toISOString()
  );
  if (employee) notify(`employee:${employee.id}`, 'Employment history', `${roleTitle} at ${employer} was added.`);
  return listEmploymentHistory(user);
}

function listRules(user) {
  if (user.role === 'employee' || user.role === 'client') {
    const row = database.prepare(`SELECT r.*, c.company_name FROM attendance_rules r JOIN clients c ON c.id = r.client_id WHERE r.client_id = ?`).get(user.clientId);
    return row ? [shapeRules(row)] : [];
  }
  assertCompanyDesk(user);
  return database.prepare(`SELECT r.*, c.company_name FROM attendance_rules r JOIN clients c ON c.id = r.client_id ORDER BY c.company_name`).all().map(shapeRules);
}

function shapeRules(row) {
  return {
    clientId: row.client_id,
    companyName: row.company_name,
    lateGrace: row.late_grace,
    earlyGrace: row.early_grace,
    otAfter: row.ot_after,
    modes: parse(row.modes, [])
  };
}

function saveRules(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  mustClient(clientId);
  const modes = ['Web', 'Manual', 'Biometric', 'Roster'].filter((mode) => (body.modes || ['Web', 'Manual', 'Biometric', 'Roster']).includes(mode));
  database.prepare(`INSERT INTO attendance_rules (client_id, late_grace, early_grace, ot_after, modes) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET late_grace = excluded.late_grace, early_grace = excluded.early_grace, ot_after = excluded.ot_after, modes = excluded.modes`).run(
    clientId, Math.max(0, Number(body.lateGrace) || 0), Math.max(0, Number(body.earlyGrace) || 0), Math.max(0, Number(body.otAfter) || 0), JSON.stringify(modes.length ? modes : ['Web'])
  );
  notify(`client:${clientId}`, 'Attendance rules updated', 'Late, early, overtime, and attendance modes were saved.');
  return listRules(user.role === 'admin' ? user : { ...user, role: 'client', clientId });
}

function saveShift(user, body) {
  assertCompanyDesk(user);
  const name = clip(body.name, 40);
  const start = clip(body.start, 5);
  const end = clip(body.end, 5);
  if (!name || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) fail(400, 'Shift name and times like 09:30 are required');
  const clientId = user.role === 'client' ? user.clientId : (clip(body.clientId, 40) || null);
  if (clientId) mustClient(clientId);
  if (body.id) {
    const existing = database.prepare('SELECT * FROM shifts WHERE id = ?').get(body.id);
    if (!existing) fail(404, 'Shift was not found');
    if (user.role === 'client' && existing.client_id !== user.clientId) fail(403, 'Shared shifts are kept by the administrator');
    patchRow('shifts', body.id, { name, start_time: start, end_time: end });
  } else {
    database.prepare('INSERT INTO shifts (id, name, start_time, end_time, client_id) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), name, start, end, clientId);
  }
  return reference(user).shifts;
}

function listRoster(user, query) {
  const from = clip(query.from, 10);
  const to = clip(query.to, 10);
  let sql = `SELECT r.*, e.full_name, s.name AS shift_name, s.start_time, s.end_time
    FROM roster r JOIN employees e ON e.id = r.employee_id JOIN shifts s ON s.id = r.shift_id`;
  const params = [];
  if (user.role === 'employee') { sql += ' WHERE r.employee_id = ?'; params.push(user.employeeId); }
  else if (user.role === 'client') { sql += ' WHERE r.client_id = ?'; params.push(user.clientId); }
  else sql += ' WHERE 1 = 1';
  if (from) { sql += ' AND r.work_date >= ?'; params.push(from); }
  if (to) { sql += ' AND r.work_date <= ?'; params.push(to); }
  sql += ' ORDER BY r.work_date, e.full_name';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, employeeId: row.employee_id, employeeName: row.full_name, clientId: row.client_id,
    workDate: row.work_date, shiftId: row.shift_id, shiftName: row.shift_name, start: row.start_time, end: row.end_time
  }));
}

function saveRoster(user, body) {
  assertCompanyDesk(user);
  const employee = mustEmployee(body.employeeId);
  assertEmployee(user, employee);
  const shift = database.prepare('SELECT * FROM shifts WHERE id = ?').get(body.shiftId);
  if (!shift) fail(400, 'Choose a shift');
  if (shift.client_id && shift.client_id !== employee.clientId) fail(400, 'That shift belongs to another company');
  const workDate = clip(body.workDate, 10);
  if (!workDate) fail(400, 'Choose the roster date');
  const existing = database.prepare('SELECT id FROM roster WHERE employee_id = ? AND work_date = ?').get(employee.id, workDate);
  if (existing) patchRow('roster', existing.id, { shift_id: shift.id });
  else {
    database.prepare('INSERT INTO roster (id, employee_id, client_id, work_date, shift_id) VALUES (?, ?, ?, ?, ?)').run(
      crypto.randomUUID(), employee.id, employee.clientId, workDate, shift.id
    );
  }
  return listRoster(user, { from: workDate, to: workDate });
}

function timesheet(user, query) {
  const month = clip(query.month, 7) || kolkataStamp().date.slice(0, 7);
  let sql = `${attendanceSql} WHERE a.work_date LIKE ?`;
  const params = [`${month}%`];
  if (user.role === 'client') { sql += ' AND a.client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') { sql += ' AND a.employee_id = ?'; params.push(user.employeeId); }
  sql += ' ORDER BY a.work_date, e.full_name';
  const rows = database.prepare(sql).all(...params).map((row) => {
    const shaped = shapeAttendance(row);
    const start = shaped.inTime ? new Date(shaped.inTime).getTime() : 0;
    const end = shaped.outTime ? new Date(shaped.outTime).getTime() : 0;
    shaped.hours = start && end && end > start ? Math.round(((end - start) / 3600000) * 100) / 100 : 0;
    return shaped;
  });
  const totals = rows.reduce((sum, row) => ({
    hours: Math.round((sum.hours + row.hours) * 100) / 100,
    otHours: Math.round((sum.otHours + row.otHours) * 100) / 100,
    late: sum.late + (row.status === 'Late' ? 1 : 0),
    early: sum.early + (row.status === 'Early' ? 1 : 0)
  }), { hours: 0, otHours: 0, late: 0, early: 0 });
  return { month, rows, totals };
}

function markAttendance(user, body) {
  assertCompanyDesk(user);
  const employee = mustEmployee(body.employeeId);
  assertEmployee(user, employee);
  const rules = attendanceRules(employee.clientId);
  const mode = rules.modes.includes(body.mode) ? body.mode : '';
  if (!mode || mode === 'Web') fail(400, 'Choose Manual, Biometric, or Roster');
  const workDate = clip(body.workDate, 10);
  const inTime = clockOn(workDate, clip(body.inTime, 5));
  const outTime = clockOn(workDate, clip(body.outTime, 5));
  if (!workDate || !inTime) fail(400, 'Date and in-time are required');
  const judged = judgePunch(employee.shiftStart, employee.shiftEnd, inTime, outTime, rules);
  const status = judged.late ? 'Late' : (judged.early ? 'Early' : 'Present');
  const otAmount = Math.round(judged.otHours * (Number(employee.payroll.otRate) || 0));
  const note = `${mode} mark by ${user.name}`;
  const existing = database.prepare('SELECT id FROM attendance WHERE employee_id = ? AND work_date = ?').get(employee.id, workDate);
  if (existing) {
    database.prepare(`UPDATE attendance SET in_time = ?, out_time = ?, status = ?, ot_hours = ?, ot_amount = ?, flag = ?, mode = ?, location_note = ? WHERE id = ?`).run(
      inTime, outTime || null, status, judged.otHours, otAmount, status === 'Present' ? 'green' : 'red', mode, note, existing.id
    );
  } else {
    database.prepare(`INSERT INTO attendance (
      id, employee_id, client_id, work_date, shift_name, in_time, out_time, in_lat, in_lng, out_lat, out_lng,
      location_note, status, penalty, penalty_remarks, ot_hours, ot_amount, lop_days, flag, mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0, '', ?, ?, 0, ?, ?)`).run(
      crypto.randomUUID(), employee.id, employee.clientId, workDate, employee.shiftName, inTime, outTime || null,
      note, status, judged.otHours, otAmount, status === 'Present' ? 'green' : 'red', mode
    );
  }
  stampAttendancePlace(employee.id, workDate, employee.locationId);
  notify(`employee:${employee.id}`, `Attendance marked · ${workDate}`, `${mode} attendance was recorded by ${user.name}.`);
  return listAttendance(user, { date: workDate, employeeId: employee.id });
}

function shapeRegularization(row) {
  return {
    id: row.id, applicationNumber: row.application_number, employeeId: row.employee_id, clientId: row.client_id,
    employeeName: row.employee_name, workDate: row.work_date, requestedIn: row.requested_in || '', requestedOut: row.requested_out || '',
    mode: row.mode, reason: row.reason, status: row.status, companyApprover: row.company_approver || '',
    adminApprover: row.admin_approver || '', raisedAt: row.raised_at, decidedAt: row.decided_at || ''
  };
}

function listRegularizations(user) {
  let sql = 'SELECT * FROM regularizations';
  const params = [];
  if (user.role === 'client') { sql += ' WHERE client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') { sql += ' WHERE employee_id = ?'; params.push(user.employeeId); }
  sql += ' ORDER BY raised_at DESC';
  return database.prepare(sql).all(...params).map(shapeRegularization);
}

function createRegularization(user, body) {
  if (user.role !== 'employee') fail(403, 'Regularization is raised from the employee desk');
  const employee = mustEmployee(user.employeeId);
  const workDate = clip(body.workDate, 10);
  const reason = clip(body.reason, 400);
  const requestedIn = clip(body.inTime, 5);
  if (!workDate || !reason || !/^\d{2}:\d{2}$/.test(requestedIn)) fail(400, 'Date, in-time, and reason are required');
  const id = crypto.randomUUID();
  const number = nextNumber('REG');
  database.prepare(`INSERT INTO regularizations (
    id, application_number, employee_id, client_id, employee_name, work_date, requested_in, requested_out, mode, reason, status, company_approver, admin_approver, raised_at, decided_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Web', ?, 'Pending company', '', '', ?, '')`).run(
    id, number, employee.id, employee.clientId, employee.fullName, workDate, requestedIn, clip(body.outTime, 5), reason, new Date().toISOString()
  );
  notify(`client:${employee.clientId}`, `Regularization · ${employee.fullName}`, `${number} is waiting for the company desk.`);
  notify('admin', `Regularization · ${employee.fullName}`, `${number} will reach you after the company desk.`);
  return shapeRegularization(database.prepare('SELECT * FROM regularizations WHERE id = ?').get(id));
}

function applyRegularization(row) {
  const employee = mustEmployee(row.employee_id);
  const rules = attendanceRules(employee.clientId);
  const inTime = clockOn(row.work_date, row.requested_in);
  const outTime = row.requested_out ? clockOn(row.work_date, row.requested_out) : '';
  const judged = judgePunch(employee.shiftStart, employee.shiftEnd, inTime, outTime, rules);
  const status = judged.late ? 'Late' : (judged.early ? 'Early' : 'Present');
  const otAmount = Math.round(judged.otHours * (Number(employee.payroll.otRate) || 0));
  const existing = database.prepare('SELECT id FROM attendance WHERE employee_id = ? AND work_date = ?').get(employee.id, row.work_date);
  const note = `Regularized ${row.application_number}`;
  if (existing) {
    database.prepare(`UPDATE attendance SET in_time = ?, out_time = ?, status = ?, ot_hours = ?, ot_amount = ?, flag = ?, mode = ?, location_note = ? WHERE id = ?`).run(
      inTime, outTime || null, status, judged.otHours, otAmount, status === 'Present' ? 'green' : 'red', 'Web', note, existing.id
    );
  } else {
    database.prepare(`INSERT INTO attendance (
      id, employee_id, client_id, work_date, shift_name, in_time, out_time, in_lat, in_lng, out_lat, out_lng,
      location_note, status, penalty, penalty_remarks, ot_hours, ot_amount, lop_days, flag, mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0, '', ?, ?, 0, ?, 'Web')`).run(
      crypto.randomUUID(), employee.id, employee.clientId, row.work_date, employee.shiftName, inTime, outTime || null,
      note, status, judged.otHours, otAmount, status === 'Present' ? 'green' : 'red'
    );
  }
  stampAttendancePlace(employee.id, row.work_date, employee.locationId);
}

function setRegularization(user, id, body) {
  const row = database.prepare('SELECT * FROM regularizations WHERE id = ?').get(id);
  if (!row) fail(404, 'Regularization was not found');
  const decision = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Approved or Rejected');
  if (user.role === 'employee') fail(403, 'Regularization is approved by the client admin and the company admin');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This request belongs to another company');
  if (user.role !== 'client') assertAdmin(user);
  if (!['Pending company', 'Pending admin'].includes(row.status)) fail(400, 'This regularization is already closed');
  if (decision === 'Approved') applyRegularization(row);
  patchRow('regularizations', id, { status: decision, admin_approver: user.name, decided_at: new Date().toISOString() });
  notify(`employee:${row.employee_id}`, `${decision} · ${row.application_number}`, `${user.name} marked this regularization ${decision}.`);
  notify(`client:${row.client_id}`, `${decision} · ${row.application_number}`, `${row.employee_name}'s regularization is ${decision}.`);
  return shapeRegularization(database.prepare('SELECT * FROM regularizations WHERE id = ?').get(id));
}

function listPolicies(user) {
  let sql = `SELECT p.*, c.company_name FROM leave_policies p JOIN clients c ON c.id = p.client_id`;
  const params = [];
  if (user.role === 'employee' || user.role === 'client') { sql += ' WHERE p.client_id = ?'; params.push(user.clientId || ''); }
  else assertCompanyDesk(user);
  sql += ' ORDER BY c.company_name, p.leave_type';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, companyName: row.company_name, leaveType: row.leave_type,
    yearlyQuota: row.yearly_quota, monthlyAccrual: row.monthly_accrual, carryForward: row.carry_forward, paid: !!row.paid
  }));
}

function savePolicy(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  mustClient(clientId);
  const leaveType = clip(body.leaveType, 40);
  if (!leaveType) fail(400, 'Name the leave type');
  const existing = database.prepare('SELECT id FROM leave_policies WHERE client_id = ? AND leave_type = ?').get(clientId, leaveType);
  const record = {
    yearly_quota: Number(body.yearlyQuota) || 0,
    monthly_accrual: Number(body.monthlyAccrual) || 0,
    carry_forward: Number(body.carryForward) || 0,
    paid: body.paid === 'no' || body.paid === false ? 0 : 1
  };
  if (existing) patchRow('leave_policies', existing.id, record);
  else {
    database.prepare('INSERT INTO leave_policies (id, client_id, leave_type, yearly_quota, monthly_accrual, carry_forward, paid) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      crypto.randomUUID(), clientId, leaveType, record.yearly_quota, record.monthly_accrual, record.carry_forward, record.paid
    );
  }
  return listPolicies(user);
}

function accrualBoard(user) {
  const people = listEmployees(user);
  const policies = listPolicies(user);
  const year = kolkataStamp().date.slice(0, 4);
  return people.map((person) => {
    const types = policies.filter((policy) => policy.clientId === person.clientId).map((policy) => {
      const key = { Casual: 'casual', Sick: 'sick', Earned: 'earned' }[policy.leaveType];
      const accrued = database.prepare('SELECT COALESCE(SUM(days), 0) AS days FROM leave_accruals WHERE employee_id = ? AND leave_type = ? AND period LIKE ?').get(person.id, policy.leaveType, `${year}-%`).days;
      const approved = database.prepare(`SELECT from_date, to_date FROM leaves WHERE employee_id = ? AND leave_type = ? AND status = 'Approved' AND from_date LIKE ?`).all(person.id, policy.leaveType, `${year}-%`);
      const used = approved.reduce((sum, row) => sum + leaveDays(row.from_date, row.to_date), 0);
      return {
        leaveType: policy.leaveType,
        yearlyQuota: policy.yearlyQuota,
        monthlyAccrual: policy.monthlyAccrual,
        carryForward: policy.carryForward,
        accrued,
        used,
        balance: key ? (person.leaveBalance[key] || 0) : 0
      };
    });
    return { id: person.id, fullName: person.fullName, companyName: person.companyName, types };
  });
}

function runAccrual(user, body) {
  assertCompanyDesk(user);
  const period = clip(body.period, 7) || kolkataStamp().date.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) fail(400, 'Use a month like 2026-10');
  const people = listEmployees(user);
  const policies = listPolicies(user).filter((policy) => policy.monthlyAccrual > 0);
  let posted = 0;
  people.forEach((person) => {
    policies.filter((policy) => policy.clientId === person.clientId).forEach((policy) => {
      const already = database.prepare('SELECT id FROM leave_accruals WHERE employee_id = ? AND leave_type = ? AND period = ?').get(person.id, policy.leaveType, period);
      if (already) return;
      const key = { Casual: 'casual', Sick: 'sick', Earned: 'earned' }[policy.leaveType];
      if (!key) return;
      const accrued = database.prepare('SELECT COALESCE(SUM(days), 0) AS days FROM leave_accruals WHERE employee_id = ? AND leave_type = ? AND period LIKE ?').get(person.id, policy.leaveType, `${period.slice(0, 4)}-%`).days;
      const room = Math.max(0, policy.yearlyQuota - accrued);
      const days = Math.min(policy.monthlyAccrual, room);
      if (!days) return;
      const balance = { ...person.leaveBalance };
      balance[key] = Math.round(((Number(balance[key]) || 0) + days) * 100) / 100;
      person.leaveBalance = balance;
      patchRow('employees', person.id, { leave_balance: JSON.stringify(balance) });
      database.prepare('INSERT INTO leave_accruals (id, employee_id, client_id, leave_type, period, days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        crypto.randomUUID(), person.id, person.clientId, policy.leaveType, period, days, new Date().toISOString()
      );
      posted += 1;
    });
  });
  notify(user.role === 'client' ? `client:${user.clientId}` : 'admin', 'Leave accrual posted', `${posted} accrual lines were added for ${period}.`);
  return { period, posted, board: accrualBoard(user) };
}

function complianceFor(employee) {
  const raw = employee.payroll || {};
  const pay = employee.pay || { earnTotal: 0 };
  const has = (key) => Number(raw[key]) > 0;
  const items = [];
  if (Number(raw.basicSalary) > 0 && !has('employeePf')) items.push({ level: 'fail', text: 'Employee PF is missing' });
  if (pay.earnTotal > 0 && pay.earnTotal <= 21000 && !has('employeeEsic')) items.push({ level: 'fail', text: 'ESIC is missing under the ₹21,000 ceiling' });
  if (pay.earnTotal > 15000 && !has('professionalTax')) items.push({ level: 'note', text: 'Professional tax is not on the card' });
  if (pay.earnTotal > 50000 && !has('tds')) items.push({ level: 'note', text: 'TDS is not on the card' });
  if (!has('labourWelfareFund')) items.push({ level: 'note', text: 'Labour welfare fund is not on the card' });
  if (Number(raw.otHours) > 0 && !has('overtime')) items.push({ level: 'fail', text: 'Overtime hours are recorded without overtime pay' });
  const bonus = ['bonus', 'exGratia', 'festivalBonus', 'joiningBonus', 'retentionBonus', 'referralBonus'].some(has);
  return { employeeId: employee.id, employeeName: employee.fullName, ok: !items.some((item) => item.level === 'fail'), items, hasBonus: bonus, hasArrears: has('arrears'), net: pay.net, gross: pay.earnTotal, deductions: pay.dedTotal };
}

function payrollSnapshot(user, clientId) {
  const people = listEmployees(user).filter((person) => !clientId || person.clientId === clientId);
  const checks = people.map(complianceFor);
  return {
    headcount: people.length,
    gross: checks.reduce((sum, row) => sum + row.gross, 0),
    deductions: checks.reduce((sum, row) => sum + row.deductions, 0),
    net: checks.reduce((sum, row) => sum + row.net, 0),
    checks
  };
}

function shapeRun(row) {
  return {
    id: row.id, clientId: row.client_id, companyName: row.company_name || '', period: row.period, status: row.status,
    headcount: row.headcount, gross: row.gross, deductions: row.deductions, net: row.net,
    checks: parse(row.checks, []), submittedBy: row.submitted_by || '', approvedBy: row.approved_by || '', createdAt: row.created_at
  };
}

function listPayrollRuns(user) {
  let sql = `SELECT r.*, c.company_name FROM payroll_runs r JOIN clients c ON c.id = r.client_id`;
  const params = [];
  if (user.role === 'admin') { /* all */ }
  else { sql += ' WHERE r.client_id = ?'; params.push(user.clientId || ''); }
  sql += ' ORDER BY r.period DESC';
  return database.prepare(sql).all(...params).map(shapeRun);
}

function submitPayroll(user, body) {
  if (user.role === 'employee') fail(403, 'Payroll is submitted by the company desk or the administrator');
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  const client = mustClient(clientId);
  const period = clip(body.period, 7) || kolkataStamp().date.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) fail(400, 'Use a month like 2026-10');
  const snap = payrollSnapshot(user.role === 'admin' ? user : { ...user, role: 'client', clientId }, clientId);
  const fails = snap.checks.filter((row) => !row.ok).length;
  const status = user.role === 'admin' && body.finalise === 'yes' ? 'Processed' : 'Pending admin';
  if (status === 'Processed' && fails) fail(400, 'Clear the compliance failures before processing payroll');
  const existing = database.prepare('SELECT * FROM payroll_runs WHERE client_id = ? AND period = ?').get(clientId, period);
  const checks = JSON.stringify(snap.checks);
  if (existing) {
    if (existing.status === 'Processed') fail(400, 'This month is already processed');
    patchRow('payroll_runs', existing.id, {
      status, headcount: snap.headcount, gross: snap.gross, deductions: snap.deductions, net: snap.net, checks,
      submitted_by: user.name, approved_by: status === 'Processed' ? user.name : ''
    });
  } else {
    database.prepare(`INSERT INTO payroll_runs (id, client_id, period, status, headcount, gross, deductions, net, checks, submitted_by, approved_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      crypto.randomUUID(), clientId, period, status, snap.headcount, snap.gross, snap.deductions, snap.net, checks,
      user.name, status === 'Processed' ? user.name : '', new Date().toISOString()
    );
  }
  notify(`client:${clientId}`, `Payroll ${period}`, `${client.companyName} is ${status}.`);
  if (status === 'Pending admin') notify('admin', `Payroll ${period}`, `${client.companyName} is waiting for processing.`);
  if (status === 'Processed') notify('admin', `Payroll processed · ${period}`, `${client.companyName} payslips are locked for this month.`);
  return listPayrollRuns(user);
}

function setPayrollRun(user, id, body) {
  assertAdmin(user);
  const row = database.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id);
  if (!row) fail(404, 'Payroll run was not found');
  const decision = body.status === 'Processed' || body.status === 'Approved' ? 'Processed' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Processed or Rejected');
  if (decision === 'Processed') {
    const checks = parse(row.checks, []);
    if (checks.some((item) => item.ok === false)) fail(400, 'Clear the compliance failures before processing payroll');
  }
  patchRow('payroll_runs', id, { status: decision, approved_by: user.name });
  notify(`client:${row.client_id}`, `Payroll ${row.period}`, `The administrator marked this run ${decision}.`);
  return listPayrollRuns(user);
}

function payrollCompliance(user) {
  return payrollSnapshot(user, user.role === 'admin' ? '' : user.clientId).checks;
}

function shapePayrollRequest(row) {
  return {
    id: row.id, applicationNumber: row.application_number, employeeId: row.employee_id, clientId: row.client_id,
    employeeName: row.employee_name, period: row.period, component: row.component, message: row.message,
    status: row.status, raisedAt: row.raised_at, decidedAt: row.decided_at || ''
  };
}

function listPayrollRequests(user) {
  let sql = 'SELECT * FROM payroll_requests';
  const params = [];
  if (user.role === 'client') { sql += ' WHERE client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') { sql += ' WHERE employee_id = ?'; params.push(user.employeeId); }
  sql += ' ORDER BY raised_at DESC';
  return database.prepare(sql).all(...params).map(shapePayrollRequest);
}

function createPayrollRequest(user, body) {
  if (user.role !== 'employee') fail(403, 'Payroll queries are raised from the employee desk');
  const employee = mustEmployee(user.employeeId);
  const component = clip(body.component, 80);
  const message = clip(body.message, 400);
  const period = clip(body.period, 7) || kolkataStamp().date.slice(0, 7);
  if (!component || !message) fail(400, 'Name the component and describe the query');
  const id = crypto.randomUUID();
  const number = nextNumber('PAY');
  database.prepare(`INSERT INTO payroll_requests (id, application_number, employee_id, client_id, employee_name, period, component, message, status, raised_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending company', ?, '')`).run(
    id, number, employee.id, employee.clientId, employee.fullName, period, component, message, new Date().toISOString()
  );
  notify(`client:${employee.clientId}`, `Payroll query · ${employee.fullName}`, `${number} is about ${component}.`);
  notify('admin', `Payroll query · ${employee.fullName}`, `${number} will reach you after the company desk.`);
  return shapePayrollRequest(database.prepare('SELECT * FROM payroll_requests WHERE id = ?').get(id));
}

function setPayrollRequest(user, id, body) {
  const row = database.prepare('SELECT * FROM payroll_requests WHERE id = ?').get(id);
  if (!row) fail(404, 'Payroll query was not found');
  const decision = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Approved or Rejected');
  if (user.role === 'employee') fail(403, 'Payroll queries are approved by the client admin and the company admin');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This query belongs to another company');
  if (user.role !== 'client') assertAdmin(user);
  if (!['Pending company', 'Pending admin'].includes(row.status)) fail(400, 'This query is already closed');
  patchRow('payroll_requests', id, { status: decision, decided_at: new Date().toISOString() });
  notify(`employee:${row.employee_id}`, `${decision} · ${row.application_number}`, `${user.name} marked this payroll query ${decision}.`);
  notify(`client:${row.client_id}`, `${decision} · ${row.application_number}`, `${row.employee_name}'s payroll query is ${decision}.`);
  return listPayrollRequests(user);
}

const INCENTIVE_COMPONENTS = ['bonus', 'festivalBonus', 'joiningBonus', 'retentionBonus', 'referralBonus', 'exGratia', 'performanceIncentive', 'productionIncentive', 'salesIncentive'];

function tenureMonths(joinedOn, period) {
  if (!joinedOn || !/^\d{4}-\d{2}/.test(joinedOn) || !/^\d{4}-\d{2}/.test(period)) return 0;
  const [jy, jm] = joinedOn.slice(0, 7).split('-').map(Number);
  const [py, pm] = period.slice(0, 7).split('-').map(Number);
  return (py - jy) * 12 + (pm - jm);
}

function shapeRule(row) {
  return {
    id: row.id, clientId: row.client_id, companyName: row.company_name || '', name: row.name, kind: row.kind,
    component: row.component, basis: row.basis, rate: row.rate, minRating: row.min_rating,
    minTenureMonths: row.min_tenure_months, department: row.department || '', status: row.status, createdAt: row.created_at
  };
}

function listIncentiveRules(user) {
  assertCompanyDesk(user);
  let sql = `SELECT r.*, c.company_name FROM incentive_rules r JOIN clients c ON c.id = r.client_id`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE r.client_id = ?'; params.push(user.clientId); }
  sql += ' ORDER BY c.company_name, r.name';
  return database.prepare(sql).all(...params).map(shapeRule);
}

function saveIncentiveRule(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  mustClient(clientId);
  const name = clip(body.name, 80);
  const kind = ['Bonus', 'Target', 'Performance'].includes(body.kind) ? body.kind : '';
  const basis = ['Fixed', 'Percent of basic', 'Per target unit', 'Rating multiple'].includes(body.basis) ? body.basis : '';
  const component = INCENTIVE_COMPONENTS.includes(body.component) ? body.component : '';
  if (!name || !kind || !basis || !component) fail(400, 'Name, kind, basis, and payroll component are required');
  const status = user.role === 'admin' ? 'Active' : 'Pending admin';
  database.prepare(`INSERT INTO incentive_rules (id, client_id, name, kind, component, basis, rate, min_rating, min_tenure_months, department, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), clientId, name, kind, component, basis, Number(body.rate) || 0,
    Number(body.minRating) || 0, Math.max(0, Number(body.minTenureMonths) || 0), clip(body.department, 80), status, new Date().toISOString()
  );
  notify(`client:${clientId}`, `Incentive rule · ${name}`, `Status ${status}.`);
  if (status !== 'Active') notify('admin', `Incentive rule · ${name}`, 'A bonus or incentive rule is waiting for approval.');
  return listIncentiveRules(user);
}

function setIncentiveRule(user, id, body) {
  assertAdmin(user);
  const row = database.prepare('SELECT * FROM incentive_rules WHERE id = ?').get(id);
  if (!row) fail(404, 'Incentive rule was not found');
  const status = ['Active', 'Paused', 'Rejected'].includes(body.status) ? body.status : '';
  if (!status) fail(400, 'Choose Active, Paused, or Rejected');
  patchRow('incentive_rules', id, { status });
  notify(`client:${row.client_id}`, `Rule ${status} · ${row.name}`, `The administrator marked this rule ${status}.`);
  return listIncentiveRules(user);
}

function shapeAward(row) {
  return {
    id: row.id, applicationNumber: row.application_number, ruleId: row.rule_id || '', clientId: row.client_id,
    companyName: row.company_name || '', employeeId: row.employee_id, employeeName: row.full_name || '',
    period: row.period, kind: row.kind, component: row.component, eligible: !!row.eligible, amount: row.amount,
    detail: row.detail || '', status: row.status, requested: !!row.requested, createdAt: row.created_at, decidedAt: row.decided_at || ''
  };
}

function listAwards(user, period) {
  assertCompanyDesk(user);
  let sql = `SELECT a.*, e.full_name, c.company_name FROM incentive_awards a
    JOIN employees e ON e.id = a.employee_id JOIN clients c ON c.id = a.client_id WHERE 1 = 1`;
  const params = [];
  if (user.role === 'client') { sql += ' AND a.client_id = ?'; params.push(user.clientId); }
  if (period) { sql += ' AND a.period = ?'; params.push(period); }
  sql += ' ORDER BY a.created_at DESC';
  return database.prepare(sql).all(...params).map(shapeAward);
}

function priceRule(rule, employee, period) {
  const basic = Number(employee.payroll.basicSalary) || 0;
  const tenure = tenureMonths(employee.joinedOn, period);
  if (rule.min_tenure_months && tenure < rule.min_tenure_months) {
    return { eligible: false, amount: 0, detail: `Tenure ${tenure} months is under ${rule.min_tenure_months}.` };
  }
  if (rule.department && employee.department !== rule.department) {
    return { eligible: false, amount: 0, detail: `${employee.department} is outside ${rule.department}.` };
  }
  if (rule.kind === 'Bonus') {
    const amount = rule.basis === 'Percent of basic' ? Math.round(basic * Number(rule.rate) / 100) : Math.round(Number(rule.rate) || 0);
    return { eligible: amount > 0, amount, detail: `${rule.basis} on basic ${basic}.` };
  }
  if (rule.kind === 'Target') {
    const goal = database.prepare(`SELECT * FROM goals WHERE employee_id = ? AND status = 'Active' ORDER BY created_at DESC LIMIT 1`).get(employee.id);
    if (!goal || !Number(goal.target)) return { eligible: false, amount: 0, detail: 'No active target is on the goal card.' };
    const ratio = Number(goal.achieved) / Number(goal.target);
    if (rule.basis === 'Per target unit') {
      const amount = Math.round(Number(goal.achieved) * Number(rule.rate));
      return { eligible: amount > 0, amount, detail: `${goal.achieved} × ${rule.rate} against ${goal.title}.` };
    }
    if (ratio < 1) return { eligible: false, amount: 0, detail: `${goal.title} is at ${Math.round(ratio * 100)}% of target.` };
    const amount = Math.round(basic * Number(rule.rate) / 100);
    return { eligible: amount > 0, amount, detail: `${goal.title} met. ${rule.rate}% of basic.` };
  }
  const review = database.prepare(`SELECT * FROM reviews WHERE employee_id = ? AND status = 'Final' ORDER BY created_at DESC LIMIT 1`).get(employee.id);
  if (!review) return { eligible: false, amount: 0, detail: 'No final performance rating yet.' };
  if (Number(review.rating) < Number(rule.min_rating)) {
    return { eligible: false, amount: 0, detail: `Rating ${review.rating} is under ${rule.min_rating}.` };
  }
  const amount = rule.basis === 'Rating multiple'
    ? Math.round(Number(review.rating) * Number(rule.rate))
    : Math.round(basic * Number(rule.rate) / 100 * (Number(review.rating) / 5));
  return { eligible: amount > 0, amount, detail: `Rating ${review.rating}/5 for ${review.period}.` };
}

function calculateIncentives(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  mustClient(clientId);
  const period = clip(body.period, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) fail(400, 'Use a month like 2026-10');
  const rules = database.prepare(`SELECT * FROM incentive_rules WHERE client_id = ? AND status = 'Active'`).all(clientId);
  if (!rules.length) fail(400, 'No active incentive rules for this company');
  const people = listEmployees(user).filter((person) => person.clientId === clientId);
  let created = 0;
  rules.forEach((rule) => {
    people.forEach((person) => {
      const existing = database.prepare('SELECT id FROM incentive_awards WHERE rule_id = ? AND employee_id = ? AND period = ?').get(rule.id, person.id, period);
      if (existing) return;
      const priced = priceRule(rule, person, period);
      const status = user.role === 'admin' && body.submit === 'yes' && priced.eligible ? 'Pending admin' : 'Calculated';
      database.prepare(`INSERT INTO incentive_awards (id, application_number, rule_id, client_id, employee_id, period, kind, component, eligible, amount, detail, status, requested, created_at, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '')`).run(
        crypto.randomUUID(), nextNumber('INC'), rule.id, clientId, person.id, period, rule.kind, rule.component,
        priced.eligible ? 1 : 0, priced.amount, `${rule.name}. ${priced.detail}`, status, new Date().toISOString()
      );
      created += 1;
    });
  });
  notify(`client:${clientId}`, `Incentives calculated · ${period}`, `${created} lines were priced.`);
  return listAwards(user, period);
}

function submitIncentives(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  const period = clip(body.period, 7);
  const rows = database.prepare(`SELECT * FROM incentive_awards WHERE client_id = ? AND period = ? AND status = 'Calculated' AND eligible = 1`).all(clientId, period);
  rows.forEach((row) => patchRow('incentive_awards', row.id, { status: 'Pending admin' }));
  if (rows.length) notify('admin', `Incentives · ${period}`, `${rows.length} eligible lines are waiting to post to payroll.`);
  return listAwards(user, period);
}

function postAwardToPayroll(award) {
  const employee = mustEmployee(award.employee_id);
  const next = { ...employee.payroll };
  next[award.component] = Math.round((Number(next[award.component]) || 0) + Number(award.amount));
  patchRow('employees', award.employee_id, { payroll: JSON.stringify(next) });
  patchRow('incentive_awards', award.id, { status: 'Posted', decided_at: new Date().toISOString() });
  notify(`employee:${award.employee_id}`, `Incentive posted · ${award.period}`, `${award.amount} added to ${award.component}.`);
}

function setIncentiveAward(user, id, body) {
  const row = database.prepare('SELECT * FROM incentive_awards WHERE id = ?').get(id);
  if (!row) fail(404, 'Incentive line was not found');
  const decision = body.status === 'Approved' || body.status === 'Posted' ? 'Posted' : (body.status === 'Rejected' ? 'Rejected' : (body.status === 'Pending admin' ? 'Pending admin' : ''));
  if (user.role === 'client') {
    if (row.client_id !== user.clientId) fail(403, 'This line belongs to another company');
    if (row.status !== 'Pending company') fail(400, 'The company step is already complete');
    const next = body.status === 'Rejected' ? 'Rejected' : 'Pending admin';
    patchRow('incentive_awards', id, { status: next, decided_at: new Date().toISOString() });
    notify(`employee:${row.employee_id}`, `${next} · ${row.application_number}`, `${user.name} completed the company step.`);
    if (next === 'Pending admin') notify('admin', `Incentive · ${row.application_number}`, 'Waiting to post to payroll.');
    return listAwards(user);
  }
  assertAdmin(user);
  if (!decision) fail(400, 'Choose Posted or Rejected');
  if (!['Calculated', 'Pending admin', 'Pending company'].includes(row.status)) fail(400, 'This line is already closed');
  if (decision === 'Posted') {
    if (!row.eligible || !Number(row.amount)) fail(400, 'Only an eligible amount can be posted');
    postAwardToPayroll(row);
    notify(`client:${row.client_id}`, `Incentive posted · ${row.period}`, `${row.application_number} is on the salary card.`);
  } else {
    patchRow('incentive_awards', id, { status: 'Rejected', decided_at: new Date().toISOString() });
    notify(`client:${row.client_id}`, `Incentive rejected · ${row.application_number}`, 'The line was not posted to payroll.');
    notify(`employee:${row.employee_id}`, `Incentive rejected · ${row.application_number}`, 'This incentive was not added to pay.');
  }
  return listAwards(user);
}

function requestIncentive(user, body) {
  assertCompanyDesk(user);
  const employee = mustEmployee(body.employeeId);
  assertEmployee(user, employee);
  const component = INCENTIVE_COMPONENTS.includes(body.component) ? body.component : '';
  const amount = Math.round(Number(body.amount) || 0);
  const period = clip(body.period, 7);
  const detail = clip(body.detail, 400);
  if (!component || amount <= 0 || !/^\d{4}-\d{2}$/.test(period) || !detail) fail(400, 'Component, amount, month, and reason are required');
  const status = user.role === 'admin' ? 'Pending admin' : 'Pending admin';
  const id = crypto.randomUUID();
  database.prepare(`INSERT INTO incentive_awards (id, application_number, rule_id, client_id, employee_id, period, kind, component, eligible, amount, detail, status, requested, created_at, decided_at)
    VALUES (?, ?, NULL, ?, ?, ?, 'Bonus', ?, 1, ?, ?, ?, 1, ?, '')`).run(
    id, nextNumber('INC'), employee.clientId, employee.id, period, component, amount, detail,
    user.role === 'admin' ? 'Pending admin' : 'Pending admin', new Date().toISOString()
  );
  if (user.role === 'client') {
    patchRow('incentive_awards', id, { status: 'Pending admin' });
    notify('admin', `Incentive request · ${employee.fullName}`, `${amount} for ${period} is waiting to post.`);
  }
  notify(`employee:${employee.id}`, `Incentive request · ${period}`, detail);
  return listAwards(user, period);
}

function listCustomFields(user) {
  let sql = `SELECT f.*, c.company_name FROM custom_fields f JOIN clients c ON c.id = f.client_id`;
  const params = [];
  const clientId = user.role === 'employee'
    ? (database.prepare('SELECT client_id FROM employees WHERE id = ?').get(user.employeeId) || {}).client_id
    : (user.role === 'client' ? user.clientId : '');
  if (user.role !== 'admin') { sql += ' WHERE f.client_id = ?'; params.push(clientId || ''); }
  sql += ' ORDER BY f.label';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, companyName: row.company_name, key: row.field_key, label: row.label,
    type: row.field_type, options: parse(row.options, []), required: !!row.required
  }));
}

function saveCustomField(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  const client = mustClient(clientId);
  if (user.role === 'client') assertClient(user, client.id);
  const key = String(body.key || '').trim().toLowerCase();
  const label = clip(body.label, 80);
  const type = ['text', 'number', 'date', 'select'].includes(body.type) ? body.type : '';
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(key) || !label || !type) fail(400, 'Use a short field key, a label, and a type');
  const options = type === 'select' ? String(body.options || '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 12) : [];
  if (type === 'select' && !options.length) fail(400, 'A select field needs options');
  const required = body.required === 'yes' || body.required === true || body.required === '1' ? 1 : 0;
  const existing = database.prepare('SELECT id FROM custom_fields WHERE client_id = ? AND field_key = ?').get(client.id, key);
  if (existing) patchRow('custom_fields', existing.id, { label, field_type: type, options: JSON.stringify(options), required });
  else {
    database.prepare(`INSERT INTO custom_fields (id, client_id, field_key, label, field_type, options, required, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), client.id, key, label, type, JSON.stringify(options), required, new Date().toISOString());
  }
  notify(`client:${client.id}`, `Custom field · ${label}`, `{{custom.${key}}} can be used on a letter.`);
  return listCustomFields(user);
}

function listCustomForms(user) {
  let sql = `SELECT f.*, c.company_name FROM custom_forms f JOIN clients c ON c.id = f.client_id`;
  const params = [];
  const clientId = user.role === 'employee'
    ? (database.prepare('SELECT client_id FROM employees WHERE id = ?').get(user.employeeId) || {}).client_id
    : (user.role === 'client' ? user.clientId : '');
  if (user.role !== 'admin') { sql += ' WHERE f.client_id = ?'; params.push(clientId || ''); }
  sql += ' ORDER BY f.name';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, companyName: row.company_name, name: row.name, category: row.category,
    fieldKeys: parse(row.field_keys, [])
  }));
}

function saveCustomForm(user, body) {
  assertCompanyDesk(user);
  const clientId = user.role === 'client' ? user.clientId : clip(body.clientId, 40);
  const client = mustClient(clientId);
  if (user.role === 'client') assertClient(user, client.id);
  const name = clip(body.name, 80);
  const category = LETTER_KINDS.includes(body.category) ? body.category : '';
  const keys = String(body.fieldKeys || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!name || !category || !keys.length) fail(400, 'Name the form, choose the letter, and list the field keys');
  const known = database.prepare('SELECT field_key FROM custom_fields WHERE client_id = ?').all(client.id).map((row) => row.field_key);
  if (keys.some((key) => !known.includes(key))) fail(400, 'Every field key must already exist for this company');
  const existing = database.prepare('SELECT id FROM custom_forms WHERE client_id = ? AND name = ?').get(client.id, name);
  if (existing) patchRow('custom_forms', existing.id, { category, field_keys: JSON.stringify(keys) });
  else {
    database.prepare(`INSERT INTO custom_forms (id, client_id, name, category, field_keys, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), client.id, name, category, JSON.stringify(keys), new Date().toISOString());
  }
  notify('admin', `Custom form · ${name}`, `${client.companyName} linked it to ${category}.`);
  return listCustomForms(user);
}

function setCustomData(user, employeeId, body) {
  const employee = mustEmployee(employeeId);
  assertEmployee(user, employee);
  const fields = database.prepare('SELECT * FROM custom_fields WHERE client_id = ?').all(employee.clientId);
  const next = { ...(employee.custom || {}) };
  fields.forEach((field) => {
    if (body[field.field_key] == null) return;
    next[field.field_key] = clip(body[field.field_key], 120);
  });
  fields.forEach((field) => {
    if (field.required && !next[field.field_key]) fail(400, `${field.label} is required`);
  });
  patchRow('employees', employee.id, { custom_data: JSON.stringify(next) });
  notify(`client:${employee.clientId}`, `Employee fields · ${employee.fullName}`, 'Custom details were updated and can map onto letters.');
  return mustEmployee(employee.id);
}

function listDocumentRequests(user) {
  let sql = `SELECT r.*, e.full_name, e.employee_code FROM document_requests r JOIN employees e ON e.id = r.employee_id WHERE 1 = 1`;
  const params = [];
  if (user.role === 'client') { sql += ' AND r.client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') { sql += ' AND r.employee_id = ?'; params.push(user.employeeId); }
  sql += ' ORDER BY r.created_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, applicationNumber: row.application_number, clientId: row.client_id, employeeId: row.employee_id,
    employeeName: row.full_name, employeeCode: row.employee_code, kind: row.kind, message: row.message,
    status: row.status, reply: row.reply || '', raisedBy: row.raised_by || '', createdAt: row.created_at, decidedAt: row.decided_at || ''
  }));
}

function createDocumentRequest(user, body) {
  const kind = LETTER_KINDS.includes(body.kind) ? body.kind : '';
  const message = clip(body.message, 400);
  if (!kind || !message) fail(400, 'Choose the letter or Ask HR, and say what you need');
  const employee = user.role === 'employee' ? mustEmployee(user.employeeId) : mustEmployee(body.employeeId);
  if (user.role === 'client') assertClient(user, employee.clientId);
  if (user.role !== 'employee') assertCompanyDesk(user);
  const status = user.role === 'employee' ? 'Pending company' : 'Pending admin';
  const id = crypto.randomUUID();
  const number = nextNumber('DOC');
  database.prepare(`INSERT INTO document_requests (id, application_number, client_id, employee_id, kind, message, status, reply, raised_by, created_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, '')`).run(id, number, employee.clientId, employee.id, kind, message, status, user.name, new Date().toISOString());
  notify(`client:${employee.clientId}`, `HR document · ${number}`, `${employee.fullName} asked for ${kind}. ${message}`);
  notify('admin', `HR document · ${number}`, `${kind} is ${status}.`);
  notify(`employee:${employee.id}`, `Request received · ${number}`, `${kind} was sent for approval.`);
  return listDocumentRequests(user);
}

function setDocumentRequest(user, id, body) {
  const row = database.prepare('SELECT * FROM document_requests WHERE id = ?').get(id);
  if (!row) fail(404, 'Document request was not found');
  const decision = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Approved or Rejected');
  const reply = clip(body.reply, 400);
  if (user.role === 'employee') fail(403, 'Document requests are approved by the client admin and the company admin');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This request belongs to another company');
  if (user.role !== 'client') assertAdmin(user);
  if (!['Pending company', 'Pending admin'].includes(row.status)) fail(400, 'This request is already closed');
  patchRow('document_requests', id, { status: decision, reply, decided_at: new Date().toISOString() });
  const ready = decision === 'Approved' && row.kind !== 'ask' ? ' The letter can now be opened.' : '';
  notify(`employee:${row.employee_id}`, `${decision} · ${row.application_number}`, (reply || `${row.kind} is ${decision}.`) + ready);
  notify(`client:${row.client_id}`, `${decision} · ${row.application_number}`, `${row.kind} is ${decision}.`);
  return listDocumentRequests(user);
}

function templateTokens() {
  return TEMPLATE_TOKENS;
}

function stampAttendancePlace(employeeId, workDate, locationId) {
  if (!locationId) return;
  database.prepare('UPDATE attendance SET location_id = ? WHERE employee_id = ? AND work_date = ?').run(locationId, employeeId, workDate);
}

function applyLocationPay(row, pay) {
  const rule = ruleFor(row.location_id, 'Payroll');
  const amount = rule ? Number(rule.allowance) || 0 : 0;
  if (!amount || pay.earnings.some((line) => line.key === 'locationAllowance')) return pay;
  const earnings = pay.earnings.concat([{ key: 'locationAllowance', label: 'Location allowance', amount }]);
  const earnTotal = pay.earnTotal + amount;
  return { ...pay, earnings, earnTotal, net: earnTotal - pay.dedTotal };
}

function locationChain(locationId) {
  const chain = [];
  let id = locationId || '';
  while (id && chain.length < 6) {
    const row = database.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    if (!row) break;
    chain.push(row);
    id = row.parent_id || '';
  }
  return chain;
}

function ruleFor(locationId, kind, leaveType = '') {
  for (const place of locationChain(locationId)) {
    const rule = leaveType
      ? database.prepare(`SELECT * FROM location_rules WHERE location_id = ? AND kind = ? AND leave_type = ? AND status = 'Active'`).get(place.id, kind, leaveType)
      : database.prepare(`SELECT * FROM location_rules WHERE location_id = ? AND kind = ? AND status = 'Active' ORDER BY allowance DESC`).get(place.id, kind);
    if (rule) return rule;
  }
  return null;
}

function shapeLocation(row) {
  return {
    id: row.id, clientId: row.client_id, companyName: row.company_name || '', branchId: row.branch_id,
    branchName: row.branch_name || '', parentId: row.parent_id || '', parentName: row.parent_name || '',
    kind: row.kind, name: row.name, code: row.code || '', address: row.address || '', createdAt: row.created_at
  };
}

function listLocations(user) {
  let sql = `SELECT l.*, c.company_name, b.name AS branch_name, p.name AS parent_name
    FROM locations l
    JOIN clients c ON c.id = l.client_id
    JOIN branches b ON b.id = l.branch_id
    LEFT JOIN locations p ON p.id = l.parent_id`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE l.client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') {
    const me = database.prepare('SELECT client_id FROM employees WHERE id = ?').get(user.employeeId);
    sql += ' WHERE l.client_id = ?';
    params.push(me ? me.client_id : '');
  }
  sql += ' ORDER BY b.name, l.kind, l.name';
  return database.prepare(sql).all(...params).map(shapeLocation);
}

function saveLocation(user, body) {
  assertCompanyDesk(user);
  const branch = database.prepare('SELECT * FROM branches WHERE id = ?').get(body.branchId);
  if (!branch) fail(400, 'Choose a branch');
  if (user.role === 'client' && branch.client_id !== user.clientId) fail(403, 'That branch belongs to another company');
  const kind = LOCATION_KINDS.includes(body.kind) ? body.kind : '';
  const name = clip(body.name, 80);
  if (!kind || !name) fail(400, 'Choose an office, site, unit, or floor, and name it');
  let parentId = clip(body.parentId, 40);
  if (kind === 'Floor' || kind === 'Unit') {
    if (!parentId) fail(400, 'A unit or floor needs a parent place');
    const parent = database.prepare('SELECT * FROM locations WHERE id = ?').get(parentId);
    if (!parent || parent.branch_id !== branch.id) fail(400, 'The parent place is not on this branch');
    if (kind === 'Unit' && !['Office', 'Site'].includes(parent.kind)) fail(400, 'A unit sits under an office or a site');
    if (kind === 'Floor' && !['Office', 'Site', 'Unit'].includes(parent.kind)) fail(400, 'A floor sits under an office, site, or unit');
  } else parentId = '';
  const id = crypto.randomUUID();
  database.prepare(`INSERT INTO locations (id, client_id, branch_id, parent_id, kind, name, code, address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, branch.client_id, branch.id, parentId || null, kind, name, clip(body.code, 20), clip(body.address, 180), new Date().toISOString()
  );
  notify(`client:${branch.client_id}`, `${kind} added · ${name}`, `${branch.name} now includes this place.`);
  notify('admin', `${kind} added · ${name}`, `${branch.name}.`);
  return listLocations(user);
}

function listLocationRules(user) {
  let sql = `SELECT r.*, l.name AS location_name, l.kind AS location_kind, b.name AS branch_name, c.company_name
    FROM location_rules r
    JOIN locations l ON l.id = r.location_id
    JOIN branches b ON b.id = l.branch_id
    JOIN clients c ON c.id = r.client_id`;
  const params = [];
  if (user.role === 'client') { sql += ' WHERE r.client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') {
    const me = database.prepare('SELECT client_id FROM employees WHERE id = ?').get(user.employeeId);
    sql += ' WHERE r.client_id = ?';
    params.push(me ? me.client_id : '');
  }
  sql += ' ORDER BY b.name, l.name, r.kind';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, clientId: row.client_id, companyName: row.company_name, locationId: row.location_id,
    locationName: row.location_name, locationKind: row.location_kind, branchName: row.branch_name,
    kind: row.kind, leaveType: row.leave_type || '', yearlyQuota: Number(row.yearly_quota) || 0,
    monthlyAccrual: Number(row.monthly_accrual) || 0, allowance: Number(row.allowance) || 0,
    notes: row.notes || '', status: row.status
  }));
}

function saveLocationRule(user, body) {
  assertCompanyDesk(user);
  const place = database.prepare('SELECT * FROM locations WHERE id = ?').get(body.locationId);
  if (!place) fail(404, 'Place was not found');
  if (user.role === 'client' && place.client_id !== user.clientId) fail(403, 'That place belongs to another company');
  const kind = body.kind === 'Payroll' ? 'Payroll' : (body.kind === 'Leave' ? 'Leave' : '');
  if (!kind) fail(400, 'Choose a leave rule or a payroll rule');
  const leaveType = kind === 'Leave' ? clip(body.leaveType, 40) : '';
  if (kind === 'Leave' && !leaveType) fail(400, 'Name the leave type');
  const record = {
    yearly_quota: kind === 'Leave' ? Number(body.yearlyQuota) || 0 : 0,
    monthly_accrual: kind === 'Leave' ? Number(body.monthlyAccrual) || 0 : 0,
    allowance: kind === 'Payroll' ? Math.round(Number(body.allowance) || 0) : 0,
    notes: clip(body.notes, 240),
    status: 'Active'
  };
  if (kind === 'Payroll' && record.allowance <= 0) fail(400, 'Enter the location allowance');
  const existing = database.prepare('SELECT id FROM location_rules WHERE location_id = ? AND kind = ? AND leave_type = ?').get(place.id, kind, leaveType);
  if (existing) patchRow('location_rules', existing.id, record);
  else {
    database.prepare(`INSERT INTO location_rules (id, client_id, location_id, kind, leave_type, yearly_quota, monthly_accrual, allowance, notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)`).run(
      crypto.randomUUID(), place.client_id, place.id, kind, leaveType, record.yearly_quota, record.monthly_accrual, record.allowance, record.notes, new Date().toISOString()
    );
  }
  notify(`client:${place.client_id}`, `${kind} rule · ${place.name}`, record.notes || 'The location rule was saved.');
  notify('admin', `${kind} rule · ${place.name}`, record.notes || 'The location rule was saved.');
  return listLocationRules(user);
}

function assignEmployeeLocation(user, employeeId, locationId) {
  assertCompanyDesk(user);
  const employee = mustEmployee(employeeId);
  assertEmployee(user, employee);
  const place = database.prepare('SELECT * FROM locations WHERE id = ?').get(locationId);
  if (!place) fail(404, 'Place was not found');
  if (place.client_id !== employee.clientId) fail(400, 'That place is not on this company');
  if (place.branch_id !== employee.branchId) {
    database.prepare('UPDATE branches SET staff_count = MAX(staff_count - 1, 0) WHERE id = ?').run(employee.branchId);
    database.prepare('UPDATE branches SET staff_count = staff_count + 1 WHERE id = ?').run(place.branch_id);
  }
  patchRow('employees', employee.id, { location_id: place.id, branch_id: place.branch_id });
  database.prepare(`UPDATE attendance SET location_id = ? WHERE employee_id = ? AND work_date = ?`).run(place.id, employee.id, kolkataStamp().date);
  notify(`employee:${employee.id}`, `Location · ${place.name}`, `You are now at ${place.kind} ${place.name}.`);
  notify(`client:${employee.clientId}`, `Location · ${employee.fullName}`, `${employee.fullName} is at ${place.name}.`);
  notify('admin', `Location · ${employee.fullName}`, `${place.kind} ${place.name}.`);
  return mustEmployee(employee.id);
}

function listLocationRequests(user) {
  let sql = `SELECT r.*, e.full_name, l.name AS location_name, b.name AS branch_name
    FROM location_requests r
    LEFT JOIN employees e ON e.id = r.employee_id
    LEFT JOIN locations l ON l.id = r.location_id
    LEFT JOIN branches b ON b.id = r.branch_id
    WHERE 1 = 1`;
  const params = [];
  if (user.role === 'client') { sql += ' AND r.client_id = ?'; params.push(user.clientId); }
  if (user.role === 'employee') { sql += ' AND r.employee_id = ?'; params.push(user.employeeId); }
  sql += ' ORDER BY r.created_at DESC';
  return database.prepare(sql).all(...params).map((row) => ({
    id: row.id, applicationNumber: row.application_number, clientId: row.client_id, employeeId: row.employee_id || '',
    employeeName: row.full_name || '', locationId: row.location_id || '', locationName: row.location_name || row.place_name || '',
    branchId: row.branch_id || '', branchName: row.branch_name || '', parentId: row.parent_id || '',
    kind: row.kind || '', placeName: row.place_name || '', action: row.action, detail: row.detail,
    status: row.status, raisedBy: row.raised_by || '', createdAt: row.created_at, decidedAt: row.decided_at || ''
  }));
}

function createLocationRequest(user, body) {
  const action = body.action === 'Open' ? 'Open' : (body.action === 'Assign' ? 'Assign' : '');
  const detail = clip(body.detail, 400);
  if (!action || !detail) fail(400, 'Choose the request and describe it');
  let clientId = '';
  let employeeId = null;
  let locationId = clip(body.locationId, 40);
  let branchId = clip(body.branchId, 40);
  let parentId = clip(body.parentId, 40);
  let kind = LOCATION_KINDS.includes(body.kind) ? body.kind : '';
  let placeName = clip(body.placeName, 80);
  let status = 'Pending admin';
  if (action === 'Assign') {
    if (user.role !== 'employee' && user.role !== 'client' && user.role !== 'admin') fail(403, 'Sign in to request a location');
    const employee = user.role === 'employee' ? mustEmployee(user.employeeId) : mustEmployee(body.employeeId);
    if (user.role === 'client') assertClient(user, employee.clientId);
    const place = database.prepare('SELECT * FROM locations WHERE id = ?').get(locationId);
    if (!place || place.client_id !== employee.clientId) fail(400, 'Choose a place on this company');
    clientId = employee.clientId;
    employeeId = employee.id;
    branchId = place.branch_id;
    placeName = place.name;
    kind = place.kind;
    status = user.role === 'employee' ? 'Pending company' : 'Pending admin';
  } else {
    assertCompanyDesk(user);
    const branch = database.prepare('SELECT * FROM branches WHERE id = ?').get(branchId);
    if (!branch) fail(400, 'Choose a branch');
    if (user.role === 'client' && branch.client_id !== user.clientId) fail(403, 'That branch belongs to another company');
    if (!kind || !placeName) fail(400, 'Name the office, site, unit, or floor');
    clientId = branch.client_id;
    locationId = '';
    status = 'Pending admin';
  }
  const id = crypto.randomUUID();
  const number = nextNumber('LOC');
  database.prepare(`INSERT INTO location_requests (id, application_number, client_id, employee_id, branch_id, location_id, parent_id, kind, place_name, action, detail, status, raised_by, created_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`).run(
    id, number, clientId, employeeId, branchId || null, locationId || null, parentId || null, kind, placeName, action, detail, status, user.name, new Date().toISOString()
  );
  notify(`client:${clientId}`, `Location request · ${number}`, `${action} · ${placeName}. ${detail}`);
  notify('admin', `Location request · ${number}`, `${action} is ${status}.`);
  if (employeeId) notify(`employee:${employeeId}`, `Location request · ${number}`, `${action} was sent for approval.`);
  return listLocationRequests(user);
}

function setLocationRequest(user, id, body) {
  const row = database.prepare('SELECT * FROM location_requests WHERE id = ?').get(id);
  if (!row) fail(404, 'Location request was not found');
  const decision = body.status === 'Approved' ? 'Approved' : (body.status === 'Rejected' ? 'Rejected' : '');
  if (!decision) fail(400, 'Choose Approved or Rejected');
  if (user.role === 'employee') fail(403, 'Location requests are approved by the client admin and the company admin');
  if (user.role === 'client' && row.client_id !== user.clientId) fail(403, 'This request belongs to another company');
  if (user.role !== 'client') assertAdmin(user);
  if (!['Pending company', 'Pending admin'].includes(row.status)) fail(400, 'This request is already closed');
  if (decision === 'Approved' && row.action === 'Assign') assignEmployeeLocation(user, row.employee_id, row.location_id);
  if (decision === 'Approved' && row.action === 'Open') {
    saveLocation(user, { branchId: row.branch_id, parentId: row.parent_id, kind: row.kind, name: row.place_name, address: row.detail });
  }
  patchRow('location_requests', id, { status: decision, decided_at: new Date().toISOString() });
  notify(`client:${row.client_id}`, `${decision} · ${row.application_number}`, `${row.action} is ${decision}.`);
  if (row.employee_id) notify(`employee:${row.employee_id}`, `${decision} · ${row.application_number}`, `${row.place_name} is ${decision}.`);
  return listLocationRequests(user);
}

function locationReport(user) {
  const places = listLocations(user);
  const people = listEmployees(user);
  const today = kolkataStamp().date;
  const attendance = listAttendance(user, { date: today });
  return places.map((place) => {
    const here = people.filter((person) => person.locationId === place.id);
    const present = attendance.filter((row) => row.locationId === place.id && ['Present', 'Late', 'Early'].includes(row.status)).length;
    const leave = ruleFor(place.id, 'Leave');
    const pay = ruleFor(place.id, 'Payroll');
    return {
      branch: place.branchName, kind: place.kind, place: place.name, parent: place.parentName, code: place.code,
      employees: here.length, presentToday: present,
      leaveRule: leave ? `${leave.leave_type} ${leave.yearly_quota}` : '',
      allowance: pay ? Number(pay.allowance) || 0 : 0
    };
  });
}

function acceptUpload(user, file) {
  const mb = file.size / (1024 * 1024);
  if (user && user.clientId) {
    const client = database.prepare('SELECT storage_used_mb, storage_limit_mb FROM clients WHERE id = ?').get(user.clientId);
    if (client && client.storage_used_mb + mb > client.storage_limit_mb) fail(400, 'Company storage is full');
    database.prepare('UPDATE clients SET storage_used_mb = storage_used_mb + ? WHERE id = ?').run(mb, user.clientId);
  }
  return { name: file.originalname, url: `/uploads/${file.filename}`, size: file.size };
}

module.exports = {
  userFromToken, login, logout, bootstrap, reference, publicPlans, publicStory, publicDemo, publicNewsletter, publicApplication, dashboard, createDepartment, assignEmployeeDepartment, registerClient, createClientAdmin, saveClientCase, verifyClientDocument, addClientDocument, advanceClient, listClientRequests, createClientRequest, setClientRequest,
  listClients, getClient, setClientStatus, grantClientAccess, grantHrAdminAccess, confirmHrAdminAccess, addBranch, setScorecard, setBudgets, setAdSlots, updateClientProfile,
  listEmployees, getEmployee, createEmployee, updateEmployee, setPayroll, addWarning, setEmployeeLogin,
  listAttendance, punch, captureAttendance, updateAttendance, listLeaves, createLeave, setLeaveStatus, listSwaps, createSwap, setSwapStatus,
  listReimbursements, createReimbursement, setReimbursementStatus, listExpensePolicies, saveExpensePolicy, listClaimEvents, listApplicants, createApplicant, setApplicantStage, setApplicantResume, setOffer, listRequisitions, createRequisition, setRequisition, employee360,
  listActivities, createActivity, updateActivity, addActivityFile, channelsFor, listMessages, sendMessage, updateProfile, searchUsers, onMessage,
  listTickets, createTicket, replyTicket, listPosh, createPosh, setPoshStatus, listLeads, createLead, updateLead,
  listTasks, createTask, updateTask, setTaskApproval, listGoals, saveGoal, setGoalStatus, listKras, saveKra, listReviews, saveReview, setReviewStatus, performanceAnalytics, listTemplates, saveTemplate, search, exportRows, documentModel,
  listLifecycle, addLifecycle, setEmployeeDocument, updateWorkflow, saveExit, orgStructure, addDesignation,
  listRules, saveRules, saveShift, listRoster, saveRoster, timesheet, markAttendance,
  listRegularizations, createRegularization, setRegularization, listPolicies, savePolicy, accrualBoard, runAccrual,
  listAssets, saveAsset, listHolidays, addHoliday, listJobs, saveJob, recruitmentAnalytics, listJoining, setJoining, listEmploymentHistory, addEmploymentHistory,
  listTeams, saveTeam, assignOrg, listOrgPolicies, saveOrgPolicy, setOrgPolicy, listOrgReviews, saveOrgReview, saveOrgRole,
  listPayrollRuns, submitPayroll, setPayrollRun, payrollCompliance, listPayrollRequests, createPayrollRequest, setPayrollRequest,
  managementDashboard, listReportRequests, createReportRequest, setReportRequest,
  listIncentiveRules, saveIncentiveRule, setIncentiveRule, listAwards, calculateIncentives, submitIncentives, setIncentiveAward, requestIncentive,
  listAssetEvents, moveAsset, listAssetPeople, listAssetRequests, createAssetRequest, setAssetRequest,
  listLocations, saveLocation, listLocationRules, saveLocationRule, assignEmployeeLocation, listLocationRequests, createLocationRequest, setLocationRequest, locationReport,
  listCustomFields, saveCustomField, listCustomForms, saveCustomForm, setCustomData, listDocumentRequests, createDocumentRequest, setDocumentRequest, templateTokens,
  markNotificationsRead, acceptUpload, getEmployeeQr
};
