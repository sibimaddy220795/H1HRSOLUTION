function ins(db, table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  db.prepare(sql).run(...keys.map((key) => row[key]));
}

function json(value) {
  return JSON.stringify(value);
}

function doc(name, verified) {
  return { name, url: '', verified: !!verified };
}

function seed(db, { hashPassword }) {
  const adminPass = hashPassword('Admin@123');
  const clientPass = hashPassword('Client@123');
  const employeePass = hashPassword('Employee@123');

  [
    { id: 'dep_erp', name: 'ERP Solutions', levels: ['Level 1 - Systems Associate', 'Level 2 - Analyst', 'Level 3 - Lead'] },
    { id: 'dep_ops', name: 'Team Operations', levels: ['Level 1 - Associate', 'Level 2 - Supervisor', 'Level 3 - Manager'] },
    { id: 'dep_people', name: 'People & Compliance', levels: ['Level 1 - Executive', 'Level 2 - Partner'] },
    { id: 'dep_clinical', name: 'Clinical Services', levels: ['Level 1 - Technician', 'Level 2 - Specialist'] }
  ].forEach((row) => ins(db, 'departments', { id: row.id, name: row.name, levels: json(row.levels) }));

  [
    ['sh_gen', 'General', '09:30', '18:30'],
    ['sh_morn', 'Morning', '06:00', '14:00'],
    ['sh_eve', 'Evening', '14:00', '22:00'],
    ['sh_night', 'Night', '22:00', '06:00']
  ].forEach(([id, name, start, end]) => ins(db, 'shifts', { id, name, start_time: start, end_time: end }));

  [
    ['st_pf', 'EPFO member portal', 'https://unifiedportal-mem.epfindia.gov.in/memberinterface/', 'Provident fund member login'],
    ['st_pfe', 'EPFO employer portal', 'https://unifiedportal-emp.epfindia.gov.in/epfo/', 'Employer PF establishment login'],
    ['st_esic', 'ESIC portal', 'https://portal.esic.gov.in/', 'Employees State Insurance login'],
    ['st_tds', 'TRACES', 'https://www.tdscpc.gov.in/', 'TDS statements and downloads'],
    ['st_it', 'Income tax e-filing', 'https://www.incometax.gov.in/', 'PAN and TDS related filing'],
    ['st_shram', 'Shram Suvidha', 'https://shramsuvidha.gov.in/', 'Labour inspection and returns']
  ].forEach(([id, name, url, details]) => ins(db, 'statutory_links', { id, name, url, details }));

  ins(db, 'clients', {
    id: 'cli_nexus',
    application_number: 'APP-CLI-2026-0001',
    company_name: 'Nexus Infotech Solutions Pvt Ltd',
    business_type: 'Information technology and cloud services',
    official_mail: 'corporate@nexusinfotech.com',
    phone: '+91 98765 43210',
    website: 'https://nexusinfotech.com',
    address: 'Tower 4, Mindspace SEZ, Airoli, Navi Mumbai, Maharashtra 400708',
    status: 'Approved',
    consent: 1,
    total_budget: 4500000,
    position_budgets: json([
      { position: 'Cloud architect', budget: 1500000, allocated: 1200000 },
      { position: 'Fullstack engineers', budget: 2000000, allocated: 1850000 },
      { position: 'DevOps specialist', budget: 1000000, allocated: 850000 }
    ]),
    storage_used_mb: 68.4,
    storage_limit_mb: 1000,
    score_target: 120,
    score_achieved: 114,
    score_notes: 'Workforce output is close to the quarterly milestone.',
    ad_slots: 3,
    documents: json({
      incorporation: doc('Nexus_Certificate_of_Incorporation.pdf', true),
      gst: doc('Nexus_GSTIN_27AAACN1234F1Z5.pdf', true),
      msme: doc('Nexus_Udyam_MSME.pdf', true),
      pan: doc('Nexus_Company_PAN.pdf', true),
      trade: doc('Navi_Mumbai_Trade_License.pdf', true),
      extra: [doc('Fire_Safety_NOC.pdf', true)]
    }),
    onboarded_at: '2026-01-15T05:00:00.000Z'
  });

  ins(db, 'clients', {
    id: 'cli_zenith',
    application_number: 'APP-CLI-2026-0002',
    company_name: 'Zenith Retail & Logistics Corp',
    business_type: 'Supply chain and retail operations',
    official_mail: 'hr@zenithlogistics.in',
    phone: '+91 98220 11223',
    website: 'https://zenithlogistics.in',
    address: 'Warehouse Complex 12, Bhiwandi Logistics Hub, Thane 421302',
    status: 'Approved',
    consent: 1,
    total_budget: 3200000,
    position_budgets: json([
      { position: 'Logistics supervisor', budget: 1200000, allocated: 1100000 },
      { position: 'Warehouse operators', budget: 2000000, allocated: 1680000 }
    ]),
    storage_used_mb: 41.2,
    storage_limit_mb: 1000,
    score_target: 95,
    score_achieved: 82,
    score_notes: 'Shift attendance improved this month. Evening coverage is still short.',
    ad_slots: 2,
    documents: json({
      incorporation: doc('Zenith_Incorporation.pdf', true),
      gst: doc('Zenith_GST.pdf', true),
      msme: doc('Zenith_MSME.pdf', true),
      pan: doc('Zenith_PAN.pdf', true),
      trade: doc('Bhiwandi_Trade_Permit.pdf', true),
      extra: []
    }),
    onboarded_at: '2026-02-10T08:45:00.000Z'
  });

  ins(db, 'clients', {
    id: 'cli_apex',
    application_number: 'APP-CLI-2026-0003',
    company_name: 'Apex Healthcare & Diagnostics',
    business_type: 'Healthcare and clinical services',
    official_mail: 'operations@apexhealth.org',
    phone: '+91 97112 33445',
    website: 'https://apexhealth.org',
    address: 'Plot 88, Anna Salai, Guindy, Chennai, Tamil Nadu 600032',
    status: 'Pending',
    consent: 1,
    total_budget: 2800000,
    position_budgets: json([
      { position: 'Lab pathologist', budget: 1600000, allocated: 0 },
      { position: 'Medical technician', budget: 1200000, allocated: 0 }
    ]),
    storage_used_mb: 8.6,
    storage_limit_mb: 1000,
    score_target: 80,
    score_achieved: 0,
    score_notes: 'Self-registration received. Mandatory documents are waiting for verification.',
    ad_slots: 1,
    documents: json({
      incorporation: doc('Apex_Incorporation.pdf', false),
      gst: doc('Apex_GST.pdf', false),
      msme: doc('Apex_MSME.pdf', false),
      pan: doc('Apex_PAN.pdf', false),
      trade: doc('Chennai_Health_License.pdf', false),
      extra: [doc('Clinical_Establishment_NOC.pdf', false)]
    }),
    onboarded_at: '2026-10-09T06:10:00.000Z'
  });

  [
    ['br_nx_mum', 'cli_nexus', 'Mumbai headquarters', 'Mumbai', 'Mindspace SEZ, Airoli', 2],
    ['br_nx_blr', 'cli_nexus', 'Bangalore innovation lab', 'Bengaluru', 'Outer Ring Road, Bellandur', 1],
    ['br_zn_thn', 'cli_zenith', 'Thane Bhiwandi hub', 'Thane', 'Bhiwandi Complex 12', 1],
    ['br_ap_che', 'cli_apex', 'Chennai central clinic', 'Chennai', 'Anna Salai, Guindy', 0]
  ].forEach(([id, clientId, name, city, address, staff]) => ins(db, 'branches', {
    id, client_id: clientId, name, city, address, staff_count: staff
  }));

  const people = [
    {
      id: 'emp_aarav',
      employee_code: 'EMP-2026-0001',
      application_number: 'APP-EMP-2026-0001',
      client_id: 'cli_nexus',
      branch_id: 'br_nx_mum',
      full_name: 'Aarav Sharma',
      email: 'aarav.sharma@nexusinfotech.com',
      phone: '+91 98111 22001',
      emergency_name: 'Neha Sharma',
      emergency_phone: '+91 98111 22009',
      department: 'ERP Solutions',
      level_name: 'Level 2 - Analyst',
      role_title: 'Fullstack engineer',
      shift_id: 'sh_gen',
      reporting_manager: 'Priya Shah',
      hiring_source: 'Direct',
      source_company: '',
      reputed_company: 'Nexus Infotech Solutions Pvt Ltd',
      bgv_status: 'Positive',
      has_login: 1,
      payroll: {
        basicSalary: 48000, hra: 19200, specialAllowance: 8000, conveyanceAllowance: 3000,
        employeePf: 5760, professionalTax: 200, tds: 2200, employerPf: 5760, employerEps: 3999,
        paidDays: 26, presentDays: 24, otHours: 6, otRate: 320, payableDays: 26
      },
      statutory: { pfUan: '101234567890', esicNumber: 'N/A', panNumber: 'ABCPS1234Q', bloodGroup: 'B+' },
      warnings: [],
      joined_on: '2026-03-02'
    },
    {
      id: 'emp_meera',
      employee_code: 'EMP-2026-0002',
      application_number: 'APP-EMP-2026-0002',
      client_id: 'cli_nexus',
      branch_id: 'br_nx_blr',
      full_name: 'Meera Iyer',
      email: 'meera.iyer@nexusinfotech.com',
      phone: '+91 98450 11820',
      emergency_name: 'Lakshmi Iyer',
      emergency_phone: '+91 98450 11821',
      department: 'People & Compliance',
      level_name: 'Level 1 - Executive',
      role_title: 'Compliance executive',
      shift_id: 'sh_gen',
      reporting_manager: 'Priya Shah',
      hiring_source: 'Assigned',
      source_company: 'Northstar Staffing',
      reputed_company: 'Nexus Infotech Solutions Pvt Ltd',
      bgv_status: 'Processing',
      has_login: 1,
      payroll: {
        basicSalary: 22000, hra: 8800, employeePf: 2640, employeeEsic: 413, professionalTax: 200,
        employerPf: 2640, employerEsic: 1100, paidDays: 26, presentDays: 23, lopDays: 0, otHours: 0, otRate: 180
      },
      statutory: { pfUan: '101998877665', esicNumber: '3312345678', panNumber: 'AHGPI4455L', bloodGroup: 'O+' },
      warnings: [],
      joined_on: '2026-04-16'
    },
    {
      id: 'emp_kabir',
      employee_code: 'EMP-2026-0003',
      application_number: 'APP-EMP-2026-0003',
      client_id: 'cli_zenith',
      branch_id: 'br_zn_thn',
      full_name: 'Kabir Joshi',
      email: 'kabir.joshi@zenithlogistics.in',
      phone: '+91 97654 30012',
      emergency_name: 'Ruta Joshi',
      emergency_phone: '+91 97654 30018',
      department: 'Team Operations',
      level_name: 'Level 2 - Supervisor',
      role_title: 'Logistics supervisor',
      shift_id: 'sh_morn',
      reporting_manager: 'Imran Qureshi',
      hiring_source: 'Sourcing company',
      source_company: 'Harbour Workforce',
      reputed_company: 'Zenith Retail & Logistics Corp',
      bgv_status: 'Positive',
      has_login: 1,
      payroll: {
        basicSalary: 26000, hra: 6000, shiftAllowance: 1500, employeePf: 3120, lopDeduction: 1000,
        employerPf: 3120, paidDays: 26, presentDays: 24, lopDays: 1, otHours: 3, otRate: 200
      },
      statutory: { pfUan: '101112223334', esicNumber: '2711122233', panNumber: 'ALCPJ7788K', bloodGroup: 'A+' },
      warnings: [],
      joined_on: '2026-05-04'
    },
    {
      id: 'emp_lina',
      employee_code: 'EMP-2026-0004',
      application_number: 'APP-EMP-2026-0004',
      client_id: 'cli_nexus',
      branch_id: 'br_nx_mum',
      full_name: 'Lina Dsouza',
      email: 'lina.dsouza@nexusinfotech.com',
      phone: '+91 99200 44110',
      emergency_name: 'Maria Dsouza',
      emergency_phone: '+91 99200 44119',
      department: 'ERP Solutions',
      level_name: 'Level 1 - Systems Associate',
      role_title: 'Systems associate',
      shift_id: 'sh_eve',
      reporting_manager: 'Aarav Sharma',
      hiring_source: 'Direct',
      source_company: '',
      reputed_company: 'Nexus Infotech Solutions Pvt Ltd',
      bgv_status: 'Processing',
      has_login: 0,
      payroll: {
        basicSalary: 30000, hra: 12000, employeePf: 3600, salaryAdvanceRecovery: 2000, lateComingDeduction: 500,
        employerPf: 3600, paidDays: 26, presentDays: 21, otHours: 0, otRate: 220
      },
      statutory: { pfUan: '101556677889', esicNumber: 'N/A', panNumber: 'BXZPD2211M', bloodGroup: 'AB+' },
      warnings: [{ id: 'warn_1', message: 'Repeated late punches on the evening shift. Written caution issued.', at: '2026-10-08T12:30:00.000Z' }],
      joined_on: '2026-06-20'
    }
  ];

  people.forEach((person) => ins(db, 'employees', {
    id: person.id,
    employee_code: person.employee_code,
    application_number: person.application_number,
    client_id: person.client_id,
    branch_id: person.branch_id,
    full_name: person.full_name,
    email: person.email,
    phone: person.phone,
    emergency_name: person.emergency_name,
    emergency_phone: person.emergency_phone,
    photo_url: '',
    department: person.department,
    level_name: person.level_name,
    role_title: person.role_title,
    shift_id: person.shift_id,
    reporting_manager: person.reporting_manager,
    hiring_source: person.hiring_source,
    source_company: person.source_company,
    reputed_company: person.reputed_company,
    bgv_status: person.bgv_status,
    has_login: person.has_login,
    payroll: json(person.payroll),
    statutory: json(person.statutory),
    documents: json({
      aadhaar: doc(`${person.full_name.replace(/\s/g, '_')}_Aadhaar.pdf`, true),
      pan: doc(`${person.full_name.replace(/\s/g, '_')}_PAN.pdf`, true),
      marksheet: doc(`${person.full_name.replace(/\s/g, '_')}_Marksheet.pdf`, true),
      bank: doc(`${person.full_name.replace(/\s/g, '_')}_Bank.pdf`, false)
    }),
    warnings: json(person.warnings),
    status: 'Active',
    joined_on: person.joined_on
  }));

  [
    ['u_admin', 'admin', 'ravi.menon@s1hrsolution.com', adminPass, 'Ravi Menon', '+91 98200 10001', 'Principal administrator', null, null, 'At the control desk'],
    ['u_priya', 'client', 'priya.shah@nexusinfotech.com', clientPass, 'Priya Shah', '+91 98765 43211', 'Client HR head', 'cli_nexus', null, 'Reviewing Bangalore hiring'],
    ['u_imran', 'client', 'imran.qureshi@zenithlogistics.in', clientPass, 'Imran Qureshi', '+91 98220 11224', 'Operations head', 'cli_zenith', null, 'Warehouse roster week'],
    ['u_aarav', 'employee', 'aarav.sharma@nexusinfotech.com', employeePass, 'Aarav Sharma', '+91 98111 22001', 'Fullstack engineer', 'cli_nexus', 'emp_aarav', 'Available on the general shift'],
    ['u_meera', 'employee', 'meera.iyer@nexusinfotech.com', employeePass, 'Meera Iyer', '+91 98450 11820', 'Compliance executive', 'cli_nexus', 'emp_meera', 'On site in Bengaluru'],
    ['u_kabir', 'employee', 'kabir.joshi@zenithlogistics.in', employeePass, 'Kabir Joshi', '+91 97654 30012', 'Logistics supervisor', 'cli_zenith', 'emp_kabir', 'Morning shift lead']
  ].forEach(([id, role, email, password, name, phone, title, clientId, employeeId, status]) => ins(db, 'users', {
    id,
    role,
    email,
    password_hash: password,
    name,
    phone,
    title,
    client_id: clientId,
    employee_id: employeeId,
    active: 1,
    status_text: status,
    created_at: '2026-09-01T04:00:00.000Z'
  }));

  const punches = [
    ['att_1', 'emp_aarav', 'cli_nexus', '2026-10-08', 'General', '2026-10-08T03:52:00.000Z', '2026-10-08T13:05:00.000Z', 19.1176, 72.999, 'On time at Mumbai HQ', 'Present', 0, '', 0.5, 160, 0, 'green'],
    ['att_2', 'emp_aarav', 'cli_nexus', '2026-10-09', 'General', '2026-10-09T03:48:00.000Z', '2026-10-09T13:10:00.000Z', 19.1176, 72.999, 'On time at Mumbai HQ', 'Present', 0, '', 0.6, 192, 0, 'green'],
    ['att_3', 'emp_meera', 'cli_nexus', '2026-10-08', 'General', '2026-10-08T04:02:00.000Z', '2026-10-08T12:40:00.000Z', 12.925, 77.676, 'Bellandur lab', 'Present', 0, '', 0, 0, 0, 'green'],
    ['att_4', 'emp_meera', 'cli_nexus', '2026-10-09', 'General', '2026-10-09T04:18:00.000Z', '2026-10-09T12:45:00.000Z', 12.925, 77.676, 'Arrived after the general shift start', 'Late', 0, 'Arrived 18 minutes after shift start.', 0, 0, 0, 'red'],
    ['att_5', 'emp_kabir', 'cli_zenith', '2026-10-08', 'Morning', '2026-10-08T00:28:00.000Z', '2026-10-08T08:32:00.000Z', 19.296, 73.063, 'Bhiwandi gate', 'Present', 0, '', 0, 0, 0, 'green'],
    ['att_6', 'emp_kabir', 'cli_zenith', '2026-10-09', 'Morning', '2026-10-09T00:40:00.000Z', '2026-10-09T08:20:00.000Z', 19.296, 73.063, 'Bhiwandi gate', 'Present', 0, '', 0, 0, 0, 'green'],
    ['att_7', 'emp_lina', 'cli_nexus', '2026-10-08', 'Evening', '2026-10-08T09:05:00.000Z', '2026-10-08T16:40:00.000Z', 19.119, 73.002, 'Evening shift late punch', 'Late', 500, 'Penalty marked for late coming.', 0, 0, 0, 'red'],
    ['att_8', 'emp_lina', 'cli_nexus', '2026-10-09', 'Evening', '2026-10-09T08:32:00.000Z', '2026-10-09T16:35:00.000Z', 19.119, 73.002, 'Evening shift on time', 'Present', 0, '', 0, 0, 0, 'green']
  ];
  punches.forEach((row) => ins(db, 'attendance', {
    id: row[0], employee_id: row[1], client_id: row[2], work_date: row[3], shift_name: row[4],
    in_time: row[5], out_time: row[6], in_lat: row[7], in_lng: row[8], out_lat: row[7], out_lng: row[8],
    location_note: row[9], status: row[10], penalty: row[11], penalty_remarks: row[12],
    ot_hours: row[13], ot_amount: row[14], lop_days: row[15], flag: row[16]
  }));

  ins(db, 'leaves', {
    id: 'lev_1', application_number: 'APP-LEV-2026-0001', employee_id: 'emp_aarav', client_id: 'cli_nexus',
    employee_name: 'Aarav Sharma', leave_type: 'Casual', from_date: '2026-10-16', to_date: '2026-10-16',
    reason: 'Family appointment in the afternoon. One day is enough.', status: 'Pending', approver: '',
    raised_at: '2026-10-09T08:00:00.000Z', decided_at: ''
  });
  ins(db, 'leaves', {
    id: 'lev_2', application_number: 'APP-LEV-2026-0002', employee_id: 'emp_kabir', client_id: 'cli_zenith',
    employee_name: 'Kabir Joshi', leave_type: 'Sick', from_date: '2026-10-03', to_date: '2026-10-03',
    reason: 'Fever. Returned the next morning shift.', status: 'Approved', approver: 'Ravi Menon',
    raised_at: '2026-10-02T12:00:00.000Z', decided_at: '2026-10-02T14:00:00.000Z'
  });

  ins(db, 'shift_swaps', {
    id: 'swp_1', application_number: 'APP-SWP-2026-0001', employee_id: 'emp_meera', client_id: 'cli_nexus',
    employee_name: 'Meera Iyer', from_shift: 'General', to_shift: 'Morning', swap_date: '2026-10-14',
    reason: 'Need the morning shift for a statutory filing window.', status: 'Pending', approver: '',
    raised_at: '2026-10-09T09:20:00.000Z', decided_at: ''
  });

  ins(db, 'reimbursements', {
    id: 'rmb_1', application_number: 'APP-RMB-2026-0001', employee_id: 'emp_aarav', client_id: 'cli_nexus',
    employee_name: 'Aarav Sharma', category: 'Client visit travel', amount: 2450,
    description: 'Cab from Airoli HQ to the client workshop and back.', receipt_url: '',
    status: 'Pending', remarks: '', raised_at: '2026-10-08T15:00:00.000Z', decided_at: ''
  });

  ins(db, 'applicants', {
    id: 'ats_1', application_number: 'APP-ATS-2026-0001', client_id: 'cli_nexus', full_name: 'Neel Kapoor',
    email: 'neel.kapoor@mail.test', phone: '+91 90000 11101', position: 'Cloud engineer',
    source: 'Sourcing company', source_company: 'Northstar Staffing', stage: 'Screening', bgv_required: 1,
    notes: 'Assigned to the Bangalore lab requisition.', raised_at: '2026-10-06T06:00:00.000Z'
  });
  ins(db, 'applicants', {
    id: 'ats_2', application_number: 'APP-ATS-2026-0002', client_id: 'cli_zenith', full_name: 'Sara Mathew',
    email: 'sara.mathew@mail.test', phone: '+91 90000 22202', position: 'Warehouse supervisor',
    source: 'Direct', source_company: '', stage: 'Interview', bgv_required: 1,
    notes: 'Direct application for the Bhiwandi hub.', raised_at: '2026-10-07T07:30:00.000Z'
  });

  ins(db, 'activities', {
    id: 'act_bgv', application_number: 'APP-BGV-2026-0001', type: 'bgv', client_id: 'cli_nexus',
    title: 'BGV · Neel Kapoor', description: 'Background verification before the cloud engineer offer.',
    payload: json({
      candidateName: 'Neel Kapoor',
      services: ['Backend call coordination', 'Residential address verification', 'Previous employment verification'],
      steps: [
        { name: 'Backend call coordination', docName: 'Call_log_Neel.pdf', docUrl: '', done: true },
        { name: 'Residential address verification', docName: '', docUrl: '', done: false },
        { name: 'Previous employment verification', docName: '', docUrl: '', done: false }
      ],
      files: []
    }),
    stage: 'Processing', result: '', active: 1, raised_by: 'u_priya', raised_by_name: 'Priya Shah',
    raised_at: '2026-10-07T05:00:00.000Z', updated_at: '2026-10-08T05:00:00.000Z'
  });

  ins(db, 'activities', {
    id: 'act_srv_cat', application_number: 'APP-SRV-2026-0001', type: 'service', client_id: null,
    title: 'Payroll statutory audit', description: 'PF, ESIC, and TDS reconciliation for a closed month, with a written observation note.',
    payload: json({ kind: 'catalog', owner: 'S1 HR Solution' }),
    stage: 'Published', result: '', active: 1, raised_by: 'u_admin', raised_by_name: 'Ravi Menon',
    raised_at: '2026-09-20T05:00:00.000Z', updated_at: '2026-09-20T05:00:00.000Z'
  });

  ins(db, 'activities', {
    id: 'act_srv_req', application_number: 'APP-SRV-2026-0002', type: 'service', client_id: 'cli_zenith',
    title: 'Service request · Payroll statutory audit', description: 'Zenith asked to avail the statutory audit for September wages.',
    payload: json({ kind: 'request', serviceId: 'act_srv_cat', serviceName: 'Payroll statutory audit', files: [], steps: [] }),
    stage: 'Submitted', result: '', active: 1, raised_by: 'u_imran', raised_by_name: 'Imran Qureshi',
    raised_at: '2026-10-08T06:40:00.000Z', updated_at: '2026-10-08T06:40:00.000Z'
  });

  ins(db, 'activities', {
    id: 'act_dev_cat', application_number: 'APP-DEV-2026-0001', type: 'device', client_id: null,
    title: 'Face attendance terminal', description: 'Wall-mounted attendance terminal with shift-wise punch export. Model S1-AT200.',
    payload: json({ kind: 'catalog', model: 'S1-AT200', modeOptions: ['Buy', 'Rent'] }),
    stage: 'Published', result: '', active: 1, raised_by: 'u_admin', raised_by_name: 'Ravi Menon',
    raised_at: '2026-09-12T05:00:00.000Z', updated_at: '2026-09-12T05:00:00.000Z'
  });

  ins(db, 'activities', {
    id: 'act_dev_ord', application_number: 'APP-DEV-2026-0002', type: 'device', client_id: 'cli_nexus',
    title: 'Device order · Face attendance terminal', description: 'Nexus requested a rental unit for the Mumbai headquarters lobby.',
    payload: json({
      kind: 'order', productId: 'act_dev_cat', productName: 'Face attendance terminal', model: 'S1-AT200',
      mode: 'Rent', documentName: 'Lobby_layout.pdf', documentUrl: '', files: []
    }),
    stage: 'Viewed', result: '', active: 1, raised_by: 'u_priya', raised_by_name: 'Priya Shah',
    raised_at: '2026-10-06T09:00:00.000Z', updated_at: '2026-10-07T04:00:00.000Z'
  });

  ins(db, 'activities', {
    id: 'act_man', application_number: 'APP-MAN-2026-0001', type: 'manpower', client_id: 'cli_zenith',
    title: 'Manpower · Warehouse associates', description: 'Third-party hiring for the festive outbound week.',
    payload: json({
      engagement: 'Third party',
      totalBudget: 1800000,
      positions: [{ name: 'Warehouse associate', count: 12, budget: 1800000 }],
      remarks: 'On-roll supervisors stay with Zenith. Associates are third party.'
    }),
    stage: 'Submitted', result: '', active: 1, raised_by: 'u_imran', raised_by_name: 'Imran Qureshi',
    raised_at: '2026-10-09T03:30:00.000Z', updated_at: '2026-10-09T03:30:00.000Z'
  });

  ins(db, 'activities', {
    id: 'act_ad_1', application_number: 'APP-ADV-2026-0001', type: 'advertise', client_id: null,
    title: 'October compliance window', description: 'PF, ESIC, and TDS filings for September wages close this week. Clients can raise a statutory audit from Activities.',
    payload: json({ mediaUrl: '', mediaType: 'image', link: '', companyName: 'S1 HR Solution' }),
    stage: 'Live', result: '', active: 1, raised_by: 'u_admin', raised_by_name: 'Ravi Menon',
    raised_at: '2026-10-01T04:00:00.000Z', updated_at: '2026-10-01T04:00:00.000Z'
  });

  ins(db, 'activities', {
    id: 'act_ad_2', application_number: 'APP-ADV-2026-0002', type: 'advertise', client_id: 'cli_nexus',
    title: 'Bengaluru lab is hiring', description: 'Nexus is staffing cloud and fullstack roles for the Bellandur lab. Employee referrals can be noted with the HR head.',
    payload: json({ mediaUrl: '', mediaType: 'image', link: '', companyName: 'Nexus Infotech Solutions Pvt Ltd' }),
    stage: 'Live', result: '', active: 1, raised_by: 'u_priya', raised_by_name: 'Priya Shah',
    raised_at: '2026-10-05T06:00:00.000Z', updated_at: '2026-10-05T06:00:00.000Z'
  });

  const messages = [
    ['msg_1', 'desk', null, 'u_admin', 'Ravi Menon', 'admin', 'Control desk is open. New client registrations and activity requests land here and in the activity channel.', '2026-10-09T04:00:00.000Z'],
    ['msg_2', 'company:cli_nexus', 'cli_nexus', 'u_priya', 'Priya Shah', 'client', 'Bangalore lab referrals can be sent to me before Friday. Please keep BGV documents named clearly.', '2026-10-09T06:15:00.000Z'],
    ['msg_3', 'company:cli_nexus', 'cli_nexus', 'u_aarav', 'Aarav Sharma', 'employee', 'I have raised one day of casual leave for 16 October and a travel reimbursement from the workshop.', '2026-10-09T08:10:00.000Z'],
    ['msg_4', 'activities', 'cli_zenith', 'u_imran', 'Imran Qureshi', 'client', 'Manpower request APP-MAN-2026-0001 is in. Twelve third-party warehouse associates, budget 18 lakh.', '2026-10-09T03:31:00.000Z'],
    ['msg_5', 'posh', 'cli_nexus', 'u_meera', 'Meera Iyer', 'employee', 'I have filed a confidential POSH note for the administrator. Please keep it off the company group.', '2026-10-08T11:00:00.000Z'],
    ['msg_6', 'queries', 'cli_zenith', 'u_kabir', 'Kabir Joshi', 'employee', 'Query raised on the Diwali week roster. Morning shift coverage needs two extra names.', '2026-10-08T02:20:00.000Z']
  ];
  messages.forEach((row) => ins(db, 'messages', {
    id: row[0], channel: row[1], client_id: row[2], sender_id: row[3], sender_name: row[4],
    sender_role: row[5], body: row[6], created_at: row[7]
  }));

  ins(db, 'tickets', {
    id: 'tck_1', application_number: 'APP-TCK-2026-0001', raised_by: 'u_kabir', raised_by_name: 'Kabir Joshi',
    client_id: 'cli_zenith', subject: 'Diwali week morning roster',
    body: 'Two morning-shift loaders are on approved leave. Please confirm cover before 13 October.',
    status: 'Open', raised_at: '2026-10-08T02:20:00.000Z'
  });
  ins(db, 'ticket_replies', {
    id: 'tckr_1', ticket_id: 'tck_1', sender_name: 'Ravi Menon',
    body: 'Received. Zenith operations can propose names; the control desk will confirm the swap before it is published.',
    created_at: '2026-10-08T05:00:00.000Z'
  });

  ins(db, 'posh_alarms', {
    id: 'pos_1', application_number: 'APP-POS-2026-0001', raised_by: 'u_meera', raised_by_name: 'Meera Iyer',
    client_id: 'cli_nexus', employee_id: 'emp_meera',
    message: 'A colleague made repeated personal remarks during the team meet. I want this reviewed confidentially by the administrator.',
    status: 'Open', raised_at: '2026-10-08T11:00:00.000Z'
  });

  ins(db, 'leads', {
    id: 'lead_1', company_name: 'Harbour Clinics', contact_name: 'Dr. Ananya Rao', phone: '+91 98400 77881',
    email: 'ananya.rao@harbourclinics.test', business_type: 'Diagnostics', priority: 'High',
    assigned_to: 'Ravi Menon', status: 'Priority call', notes: 'Asked for a manpower and payroll walkthrough for two centres.',
    next_call_at: '2026-10-10T08:30:00.000Z', created_at: '2026-10-08T04:00:00.000Z'
  });
  ins(db, 'leads', {
    id: 'lead_2', company_name: 'Fieldnote Retail', contact_name: 'Sanjay Kulkarni', phone: '+91 98230 66554',
    email: 'sanjay@fieldnote.test', business_type: 'Retail operations', priority: 'Normal',
    assigned_to: 'Ravi Menon', status: 'New', notes: 'Wants quotation for 40 store associates.',
    next_call_at: '2026-10-15T06:00:00.000Z', created_at: '2026-10-07T04:00:00.000Z'
  });

  ins(db, 'tasks', {
    id: 'task_1', title: 'October attendance audit', description: 'Compare late flags with penalty remarks before payroll lock.',
    assignee: 'Ravi Menon', client_id: 'cli_nexus', due_date: '2026-10-18', performance_score: 86,
    photo_url: '', status: 'Open', created_at: '2026-10-06T04:00:00.000Z'
  });

  ins(db, 'templates', {
    id: 'tpl_pay', owner_role: 'admin', owner_id: 's1', name: 'Standard payslip', category: 'payslip',
    body: 'This payslip is generated from the S1 payroll desk and remains subject to statutory reconciliation.',
    watermark: 'S1 HR SOLUTION', updated_at: '2026-09-01T04:00:00.000Z'
  });
  ins(db, 'templates', {
    id: 'tpl_offer', owner_role: 'admin', owner_id: 's1', name: 'Standard offer', category: 'offer',
    body: 'Appointment is subject to document verification and a positive background report.',
    watermark: 'S1 HR SOLUTION', updated_at: '2026-09-01T04:00:00.000Z'
  });
  ins(db, 'templates', {
    id: 'tpl_rel', owner_role: 'admin', owner_id: 's1', name: 'Relieving letter', category: 'relieving',
    body: 'Relieving is issued after asset clearance and full-and-final review.',
    watermark: 'S1 HR SOLUTION', updated_at: '2026-09-01T04:00:00.000Z'
  });
  ins(db, 'templates', {
    id: 'tpl_id', owner_role: 'admin', owner_id: 's1', name: 'Identity card', category: 'idcard',
    body: 'Carry this card on the assigned branch. Report a lost card to the company desk.',
    watermark: 'S1 HR SOLUTION', updated_at: '2026-09-01T04:00:00.000Z'
  });
  ins(db, 'templates', {
    id: 'tpl_inv', owner_role: 'admin', owner_id: 's1', name: 'Client invoice', category: 'invoice',
    body: 'Position-wise budget converted to an illustrative invoice for the client company.',
    watermark: 'S1 HR SOLUTION', updated_at: '2026-09-01T04:00:00.000Z'
  });
  ins(db, 'templates', {
    id: 'tpl_quo', owner_role: 'admin', owner_id: 's1', name: 'Client quotation', category: 'quotation',
    body: 'Quotation follows the position-wise budget currently saved on the company record.',
    watermark: 'S1 HR SOLUTION', updated_at: '2026-09-01T04:00:00.000Z'
  });

  [
    ['nt_1', 'admin', 'Apex Healthcare is waiting', 'APP-CLI-2026-0003 self-registered and needs document verification.', '2026-10-09T06:10:00.000Z'],
    ['nt_2', 'admin', 'Leave request', 'Aarav Sharma asked for casual leave on 16 October.', '2026-10-09T08:00:00.000Z'],
    ['nt_3', 'admin', 'Manpower request', 'Zenith asked for 12 third-party warehouse associates.', '2026-10-09T03:31:00.000Z'],
    ['nt_4', 'client:cli_nexus', 'Broadcast is live', 'The Bengaluru hiring slide is on the 30-second desk banner.', '2026-10-05T06:00:00.000Z'],
    ['nt_5', 'employee:emp_aarav', 'Reimbursement received', 'Your travel claim APP-RMB-2026-0001 is with the access holder.', '2026-10-08T15:00:00.000Z'],
    ['nt_6', 'admin', 'POSH alarm', 'A confidential note was filed from the Nexus company group.', '2026-10-08T11:00:00.000Z']
  ].forEach(([id, audience, title, message, created]) => ins(db, 'notifications', {
    id, audience, title, message, created_at: created, read_flag: 0
  }));

  const counters = {
    CLI: 3, EMP: 4, EMPCODE: 4, BGV: 1, SRV: 2, DEV: 2, MAN: 1, ADV: 2,
    LEV: 2, SWP: 1, RMB: 1, ATS: 2, TCK: 1, POS: 1, BR: 4
  };
  Object.entries(counters).forEach(([prefix, value]) => ins(db, 'counters', { prefix, value }));
}

module.exports = { seed };
