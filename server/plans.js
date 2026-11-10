function feature(name, access) {
  return { name, access: access || 'full' };
}

function limited(name) {
  return feature(name, 'limited');
}

const blueFeatures = [
  feature('Employee management'),
  feature('Attendance and leave'),
  limited('Cloud data management'),
  feature('Payroll management'),
  feature('Shift swap'),
  limited('IoT integrations'),
  feature('Manpower recruitment'),
  limited('API integrations'),
  feature('Entry and exit management'),
  feature('Audit and compliance reports'),
  feature('Go Flexi'),
  feature('Basic HR reports')
];

const PLANS = [
  {
    id: 'hr-easy', family: 'Small', name: 'HR Easy',
    clients: 1, employees: 1, clientLabel: '1 company panel · 1 employee panel',
    features: [
      limited('Employee management'),
      feature('RunWork One — Home and My Service'),
      feature('Attendance'),
      limited('Cloud data management'),
      limited('Payroll management'),
      limited('Shift swap'),
      limited('IoT integrations'),
      feature('Basic HR reports')
    ]
  },
  {
    id: 'hr-basic', family: 'Small', name: 'HR Basic',
    clients: 3, employees: 3, clientLabel: 'Up to 3 company panels · 3 employee panels',
    features: [
      limited('Employee management'),
      feature('RunWork One — Home and My Service'),
      limited('Attendance and leave'),
      limited('Cloud data management'),
      limited('Payroll management'),
      limited('Shift swap'),
      limited('IoT integrations'),
      feature('Go Flexi'),
      feature('Basic HR reports')
    ]
  },
  {
    id: 'hr-core', family: 'Small', name: 'HR Core',
    clients: 5, employees: 25, clientLabel: 'Up to 5 company panels · 25 employee panels',
    features: [
      limited('Employee management'),
      feature('RunWork One'),
      limited('Attendance and leave'),
      limited('Cloud data management'),
      limited('Payroll management'),
      limited('Shift swap'),
      limited('IoT integrations'),
      feature('Task and performance'),
      feature('ATS'),
      feature('Manpower recruitment'),
      feature('HR announcements'),
      feature('Schedule appointments'),
      feature('Bonus and incentive execution'),
      feature('Go Flexi'),
      feature('Basic HR reports')
    ]
  },
  {
    id: 'hr-blue-a', family: 'Small', name: 'HR Blue Core A',
    clients: 1, employees: 5, note: 'Sized to employee strength',
    clientLabel: '1 company panel · 5 employee panels',
    features: blueFeatures
  },
  {
    id: 'hr-blue-b', family: 'Small', name: 'HR Blue Core B',
    clients: 2, employees: 10, note: 'Sized to employee strength',
    clientLabel: 'Up to 2 company panels · 10 employee panels',
    features: blueFeatures
  },
  {
    id: 'hr-blue-c', family: 'Small', name: 'HR Blue Core C',
    clients: 3, employees: 15, note: 'Sized to employee strength',
    clientLabel: 'Up to 3 company panels · 15 employee panels',
    features: blueFeatures
  },
  {
    id: 'hr-essential', family: 'Medium', name: 'HR Essential',
    clients: 10, employees: null, clientLabel: 'Up to 10 company panels · unlimited employees',
    features: [
      feature('Employee management'),
      feature('RunWork One'),
      limited('Attendance and leave'),
      limited('Cloud data management'),
      limited('Payroll management'),
      limited('Shift swap'),
      limited('Task and performance'),
      feature('ATS'),
      limited('Manpower recruitment'),
      limited('Team management'),
      limited('HR announcements'),
      feature('Schedule appointments'),
      limited('Employee data migration'),
      limited('Multiple location management'),
      limited('Asset management'),
      feature('Reimbursement management'),
      limited('Customized templates'),
      feature('Go Flexi'),
      limited('Basic HR reports and analytics')
    ]
  },
  {
    id: 'hr-select', family: 'Medium', name: 'HR Select',
    clients: 10, employees: null, clientLabel: 'Up to 10 company panels · unlimited employees',
    features: [
      feature('Employee management'),
      feature('RunWork One'),
      feature('Attendance and leave'),
      limited('Cloud data management'),
      limited('Payroll management'),
      limited('Shift swap'),
      feature('Task and performance'),
      feature('ATS'),
      feature('Manpower recruitment'),
      limited('Team management'),
      limited('HR announcements'),
      feature('Schedule appointments'),
      limited('Employee data migration'),
      limited('Multiple location management'),
      limited('Asset management'),
      feature('Reimbursement management'),
      limited('Customized templates'),
      feature('Go Flexi'),
      feature('Basic HR reports and analytics')
    ]
  },
  {
    id: 'hr-professional', family: 'Medium', name: 'HR Professional',
    clients: 20, employees: null, clientLabel: 'Up to 20 company panels · unlimited employees',
    features: [
      feature('Employee management'),
      feature('RunWork One'),
      feature('Attendance and leave'),
      limited('Cloud data management'),
      limited('Payroll management'),
      feature('Shift swap'),
      feature('Task and performance'),
      feature('ATS'),
      feature('Manpower recruitment'),
      limited('Team management'),
      feature('HR announcements'),
      feature('Schedule appointments'),
      limited('Employee data migration'),
      feature('Audit and compliance reports'),
      limited('Multiple location management'),
      limited('Asset management'),
      feature('Reimbursement management'),
      limited('Customized templates'),
      feature('Go Flexi'),
      limited('Enhanced HR reports and analytics')
    ]
  },
  {
    id: 'hr-elite', family: 'Medium', name: 'HR Elite',
    clients: 20, employees: null, clientLabel: 'Up to 20 company panels · unlimited employees',
    features: [
      feature('Employee management'),
      feature('RunWork One'),
      feature('Attendance and leave'),
      limited('Cloud data management'),
      limited('Payroll management'),
      feature('Shift swap'),
      feature('Task and performance'),
      limited('Manpower request'),
      limited('BGV'),
      feature('ATS'),
      feature('Manpower recruitment'),
      limited('Team management'),
      feature('HR announcements'),
      feature('Schedule appointments'),
      limited('Employee data migration'),
      limited('Business reports'),
      feature('Audit and compliance reports'),
      limited('Multiple location management'),
      limited('Asset management'),
      feature('Reimbursement management'),
      feature('Customized templates'),
      feature('Go Flexi'),
      feature('Enhanced HR reports and analytics')
    ]
  },
  {
    id: 'hr-prime', family: 'Large', name: 'HR Prime',
    clients: 30, employees: null, clientLabel: 'Up to 30 company panels · unlimited employees',
    features: [
      feature('Employee management'),
      feature('RunWork One'),
      feature('Attendance and leave'),
      limited('Cloud data management'),
      limited('Payroll management'),
      limited('Shift swap'),
      feature('Task and performance'),
      limited('Manpower request'),
      limited('BGV'),
      feature('ATS'),
      feature('Manpower recruitment'),
      limited('Team management'),
      feature('HR announcements'),
      feature('Schedule appointments'),
      limited('Employee data migration'),
      feature('Multi-entity management'),
      limited('Business reports'),
      limited('API integrations'),
      feature('Audit and compliance reports'),
      limited('Multiple location management'),
      limited('Asset management'),
      feature('Reimbursement management'),
      feature('Customized templates'),
      feature('Go Flexi'),
      feature('Enhanced HR reports and analytics')
    ]
  },
  {
    id: 'hr-enterprise', family: 'Large', name: 'HR Enterprise',
    clients: 40, employees: null, clientLabel: 'Up to 40 company panels · unlimited employees',
    features: [
      feature('Employee management'),
      feature('RunWork One'),
      feature('Attendance and leave'),
      limited('Cloud data management'),
      limited('Payroll management'),
      feature('Shift swap'),
      feature('Task and performance'),
      limited('Manpower request'),
      limited('BGV'),
      feature('ATS'),
      feature('Manpower recruitment'),
      limited('Team management'),
      feature('HR announcements'),
      feature('Schedule appointments'),
      limited('IoT integrations'),
      limited('Employee data migration'),
      feature('Multi-entity management'),
      limited('Business reports'),
      limited('API integrations'),
      feature('Audit and compliance reports'),
      limited('Multiple location management'),
      limited('Asset management'),
      feature('Reimbursement management'),
      feature('Customized templates'),
      feature('Dedicated implementation support'),
      feature('Go Flexi'),
      feature('Full HR reports and analytics')
    ]
  },
  {
    id: 'hr-v-prime', family: 'Large', name: 'HR V Prime',
    clients: 50, employees: null, clientLabel: 'Up to 50 company panels · unlimited employees',
    features: [
      feature('Employee management'),
      feature('RunWork One'),
      feature('Attendance and leave'),
      limited('Cloud data management'),
      feature('Payroll management'),
      feature('Shift swap'),
      feature('Task and performance'),
      limited('Manpower request'),
      limited('BGV'),
      feature('ATS'),
      feature('Manpower recruitment'),
      feature('Team management'),
      feature('HR announcements'),
      feature('Schedule appointments'),
      limited('IoT integrations'),
      limited('Employee data migration'),
      feature('Multi-entity management'),
      feature('Business reports'),
      limited('API integrations'),
      feature('Audit and compliance reports'),
      limited('Multiple location management'),
      feature('Asset management'),
      feature('Reimbursement management'),
      feature('Customized templates'),
      feature('Dedicated implementation support'),
      feature('Go Flexi'),
      feature('Full HR reports and analytics')
    ]
  }
];

const LEGACY = {
  Starter: 'hr-easy',
  Growth: 'hr-basic',
  Retainer: 'hr-essential',
  Enterprise: 'hr-enterprise',
  'hr-startup': 'hr-core'
};

function resolve(code) {
  const id = LEGACY[code] || code || 'hr-easy';
  return PLANS.find((plan) => plan.id === id) || PLANS[0];
}

function list() {
  return PLANS;
}

module.exports = { PLANS, resolve, list };
