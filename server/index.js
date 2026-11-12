const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const documents = require('./documents');

const app = express();
const PORT = process.env.PORT || 4080;
const publicDir = path.join(__dirname, '..', 'public');
const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const allowedExt = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.xls', '.xlsx', '.doc', '.docx']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExt.has(ext)) return cb(new Error('Upload PDF, JPG, Excel, or Word files'));
    cb(null, true);
  }
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '4mb' }));
app.use('/uploads', express.static(uploadDir));

function tokenFrom(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.query && req.query.token) return req.query.token;
  return '';
}

function auth(req, res, next) {
  const user = db.userFromToken(tokenFrom(req));
  if (!user) return res.status(401).json({ success: false, error: 'Sign in required' });
  req.user = user;
  next();
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function unlinkAll(files) {
  if (!files) return;
  const list = Array.isArray(files) ? files : Object.values(files).flat();
  list.forEach((file) => { if (file && file.path) fs.unlink(file.path, () => {}); });
}

app.get('/api/health', (req, res) => {
  res.json({ success: true, service: 'S1 HR Solution', time: new Date().toISOString() });
});

app.post('/api/auth/login', wrap(async (req, res) => {
  const result = db.login(req.body.portal, req.body.email, req.body.password);
  res.json({ success: true, ...result });
}));

app.post('/api/auth/logout', auth, wrap(async (req, res) => {
  db.logout(tokenFrom(req));
  res.json({ success: true });
}));

app.get('/api/bootstrap', auth, wrap(async (req, res) => {
  res.json({ success: true, data: db.bootstrap(req.user) });
}));

app.get('/api/reference', auth, wrap(async (req, res) => {
  res.json({ success: true, data: db.reference(req.user) });
}));

app.get('/api/dashboard', auth, wrap(async (req, res) => {
  res.json({ success: true, data: db.dashboard(req.user) });
}));

app.get('/api/public/plans', wrap(async (req, res) => {
  res.json({ success: true, data: db.publicPlans() });
}));

app.get('/api/public/story', wrap(async (req, res) => {
  res.json({ success: true, data: db.publicStory() });
}));

app.post('/api/public/demo', wrap(async (req, res) => {
  res.status(201).json({ success: true, data: db.publicDemo(req.body) });
}));

app.post('/api/public/newsletter', wrap(async (req, res) => {
  res.status(201).json({ success: true, data: db.publicNewsletter(req.body) });
}));

app.post('/api/public/apply', upload.single('documents'), wrap(async (req, res) => {
  try {
    res.status(201).json({ success: true, data: db.publicApplication(req.body, req.file) });
  } catch (error) {
    if (req.file) unlinkAll([req.file]);
    throw error;
  }
}));

app.post('/api/public/register', upload.fields([
  { name: 'incorporation', maxCount: 1 },
  { name: 'gst', maxCount: 1 },
  { name: 'msme', maxCount: 1 },
  { name: 'pan', maxCount: 1 },
  { name: 'trade', maxCount: 1 },
  { name: 'extra', maxCount: 5 }
]), wrap(async (req, res) => {
  try {
    const client = db.registerClient(req.body, req.files);
    res.status(201).json({ success: true, data: client });
  } catch (error) {
    unlinkAll(req.files);
    throw error;
  }
}));

app.post('/api/upload', auth, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'Choose a file' });
  try {
    res.json({ success: true, file: db.acceptUpload(req.user, req.file) });
  } catch (error) {
    unlinkAll([req.file]);
    throw error;
  }
}));

app.get('/api/clients', auth, wrap(async (req, res) => res.json({ success: true, data: db.listClients(req.user) })));
app.post('/api/clients', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createClientAdmin(req.user, req.body) })));
app.get('/api/clients/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.getClient(req.user, req.params.id) })));
app.put('/api/clients/:id/status', auth, wrap(async (req, res) => res.json({ success: true, data: db.setClientStatus(req.user, req.params.id, req.body) })));
app.post('/api/clients/:id/access', auth, wrap(async (req, res) => res.json({ success: true, data: db.grantClientAccess(req.user, req.params.id, req.body) })));
app.post('/api/clients/:id/admin-access', auth, wrap(async (req, res) => res.json({ success: true, data: db.grantHrAdminAccess(req.user, req.params.id, req.body) })));
app.put('/api/clients/:id/admin-access/:userId', auth, wrap(async (req, res) => res.json({ success: true, data: db.confirmHrAdminAccess(req.user, req.params.id, req.params.userId) })));
app.post('/api/clients/:id/branches', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.addBranch(req.user, req.params.id, req.body) })));
app.put('/api/clients/:id/scorecard', auth, wrap(async (req, res) => res.json({ success: true, data: db.setScorecard(req.user, req.params.id, req.body) })));
app.put('/api/clients/:id/budgets', auth, wrap(async (req, res) => res.json({ success: true, data: db.setBudgets(req.user, req.params.id, req.body) })));
app.put('/api/clients/:id/slots', auth, wrap(async (req, res) => res.json({ success: true, data: db.setAdSlots(req.user, req.params.id, req.body) })));
app.put('/api/clients/:id/profile', auth, wrap(async (req, res) => res.json({ success: true, data: db.updateClientProfile(req.user, req.params.id, req.body) })));
app.put('/api/clients/:id/case', auth, wrap(async (req, res) => res.json({ success: true, data: db.saveClientCase(req.user, req.params.id, req.body) })));
app.put('/api/clients/:id/documents/:key', auth, wrap(async (req, res) => res.json({ success: true, data: db.verifyClientDocument(req.user, req.params.id, { ...req.body, key: req.params.key }) })));
app.post('/api/clients/:id/documents', auth, upload.single('file'), wrap(async (req, res) => {
  try {
    res.status(201).json({ success: true, data: db.addClientDocument(req.user, req.params.id, req.body, req.file) });
  } catch (error) {
    if (req.file) unlinkAll({ file: [req.file] });
    throw error;
  }
}));
app.put('/api/clients/:id/onboarding', auth, wrap(async (req, res) => res.json({ success: true, data: db.advanceClient(req.user, req.params.id, req.body) })));
app.get('/api/client-requests', auth, wrap(async (req, res) => res.json({ success: true, data: db.listClientRequests(req.user) })));
app.post('/api/client-requests', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createClientRequest(req.user, req.body) })));
app.put('/api/client-requests/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setClientRequest(req.user, req.params.id, req.body) })));

app.get('/api/employees', auth, wrap(async (req, res) => res.json({ success: true, data: db.listEmployees(req.user, req.query) })));
app.get('/api/employees/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.getEmployee(req.user, req.params.id) })));
app.post('/api/employees', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createEmployee(req.user, req.body) })));
app.put('/api/employees/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.updateEmployee(req.user, req.params.id, req.body) })));
app.put('/api/employees/:id/payroll', auth, wrap(async (req, res) => res.json({ success: true, data: db.setPayroll(req.user, req.params.id, req.body) })));
app.post('/api/employees/:id/warnings', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.addWarning(req.user, req.params.id, req.body) })));
app.put('/api/employees/:id/login', auth, wrap(async (req, res) => res.json({ success: true, data: db.setEmployeeLogin(req.user, req.params.id, req.body) })));
app.get('/api/employees/:id/lifecycle', auth, wrap(async (req, res) => res.json({ success: true, data: db.listLifecycle(req.user, req.params.id) })));
app.post('/api/employees/:id/lifecycle', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.addLifecycle(req.user, req.params.id, req.body) })));
app.post('/api/employees/:id/documents', auth, wrap(async (req, res) => res.json({ success: true, data: db.setEmployeeDocument(req.user, req.params.id, req.body) })));
app.put('/api/employees/:id/workflow', auth, wrap(async (req, res) => res.json({ success: true, data: db.updateWorkflow(req.user, req.params.id, req.body) })));
app.put('/api/employees/:id/exit', auth, wrap(async (req, res) => res.json({ success: true, data: db.saveExit(req.user, req.params.id, req.body) })));
app.get('/api/organization', auth, wrap(async (req, res) => res.json({ success: true, data: db.orgStructure(req.user) })));
app.post('/api/teams', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveTeam(req.user, req.body) })));
app.post('/api/organization/assign', auth, wrap(async (req, res) => res.json({ success: true, data: db.assignOrg(req.user, req.body) })));
app.post('/api/org-policies', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveOrgPolicy(req.user, req.body) })));
app.put('/api/org-policies/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setOrgPolicy(req.user, req.params.id, req.body) })));
app.post('/api/org-reviews', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveOrgReview(req.user, req.body) })));
app.post('/api/org-roles', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveOrgRole(req.user, req.body) })));
app.get('/api/recruitment/analytics', auth, wrap(async (req, res) => res.json({ success: true, data: db.recruitmentAnalytics(req.user) })));
app.get('/api/joining', auth, wrap(async (req, res) => res.json({ success: true, data: db.listJoining(req.user) })));
app.put('/api/joining/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setJoining(req.user, req.params.id, req.body) })));
app.get('/api/employment-history', auth, wrap(async (req, res) => res.json({ success: true, data: db.listEmploymentHistory(req.user) })));
app.post('/api/employment-history', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.addEmploymentHistory(req.user, req.body) })));
app.get('/api/locations/report', auth, wrap(async (req, res) => res.json({ success: true, data: db.locationReport(req.user) })));
app.get('/api/locations', auth, wrap(async (req, res) => res.json({ success: true, data: db.listLocations(req.user) })));
app.post('/api/locations', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveLocation(req.user, req.body) })));
app.post('/api/locations/assign', auth, wrap(async (req, res) => res.json({ success: true, data: db.assignEmployeeLocation(req.user, req.body.employeeId, req.body.locationId) })));
app.get('/api/location-rules', auth, wrap(async (req, res) => res.json({ success: true, data: db.listLocationRules(req.user) })));
app.post('/api/location-rules', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveLocationRule(req.user, req.body) })));
app.get('/api/location-requests', auth, wrap(async (req, res) => res.json({ success: true, data: db.listLocationRequests(req.user) })));
app.post('/api/location-requests', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createLocationRequest(req.user, req.body) })));
app.put('/api/location-requests/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setLocationRequest(req.user, req.params.id, req.body) })));
app.post('/api/designations', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.addDesignation(req.user, req.body) })));

app.get('/api/assets', auth, wrap(async (req, res) => res.json({ success: true, data: db.listAssets(req.user) })));
app.post('/api/assets', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveAsset(req.user, req.body) })));
app.put('/api/assets/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.saveAsset(req.user, req.body, req.params.id) })));
app.post('/api/assets/:id/move', auth, wrap(async (req, res) => res.json({ success: true, data: db.moveAsset(req.user, req.params.id, req.body) })));
app.get('/api/assets/:id/history', auth, wrap(async (req, res) => res.json({ success: true, data: db.listAssetEvents(req.user, req.params.id) })));
app.get('/api/asset-people', auth, wrap(async (req, res) => res.json({ success: true, data: db.listAssetPeople(req.user) })));
app.get('/api/asset-requests', auth, wrap(async (req, res) => res.json({ success: true, data: db.listAssetRequests(req.user) })));
app.post('/api/asset-requests', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createAssetRequest(req.user, req.body) })));
app.put('/api/asset-requests/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setAssetRequest(req.user, req.params.id, req.body) })));

app.get('/api/holidays', auth, wrap(async (req, res) => res.json({ success: true, data: db.listHolidays(req.user) })));
app.post('/api/holidays', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.addHoliday(req.user, req.body) })));

app.get('/api/jobs', auth, wrap(async (req, res) => res.json({ success: true, data: db.listJobs(req.user) })));
app.post('/api/jobs', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveJob(req.user, req.body) })));
app.put('/api/jobs/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.saveJob(req.user, req.body, req.params.id) })));

app.get('/api/attendance', auth, wrap(async (req, res) => res.json({ success: true, data: db.listAttendance(req.user, req.query) })));
app.get('/api/attendance/my-qr', auth, wrap(async (req, res) => res.json({ success: true, data: await db.getEmployeeQr(req.user, req.query.employeeId) })));
app.post('/api/attendance/punch', auth, wrap(async (req, res) => res.json({ success: true, data: db.punch(req.user, req.body) })));
app.post('/api/attendance/capture', auth, wrap(async (req, res) => res.json({ success: true, data: db.captureAttendance(req.user, req.body) })));
app.get('/api/attendance/timesheet', auth, wrap(async (req, res) => res.json({ success: true, data: db.timesheet(req.user, req.query) })));
app.post('/api/attendance/mark', auth, wrap(async (req, res) => res.json({ success: true, data: db.markAttendance(req.user, req.body) })));
app.get('/api/attendance/rules', auth, wrap(async (req, res) => res.json({ success: true, data: db.listRules(req.user) })));
app.put('/api/attendance/rules', auth, wrap(async (req, res) => res.json({ success: true, data: db.saveRules(req.user, req.body) })));
app.put('/api/attendance/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.updateAttendance(req.user, req.params.id, req.body) })));
app.post('/api/shifts', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveShift(req.user, req.body) })));
app.get('/api/roster', auth, wrap(async (req, res) => res.json({ success: true, data: db.listRoster(req.user, req.query) })));
app.post('/api/roster', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveRoster(req.user, req.body) })));
app.get('/api/regularizations', auth, wrap(async (req, res) => res.json({ success: true, data: db.listRegularizations(req.user) })));
app.post('/api/regularizations', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createRegularization(req.user, req.body) })));
app.put('/api/regularizations/:id/status', auth, wrap(async (req, res) => res.json({ success: true, data: db.setRegularization(req.user, req.params.id, req.body) })));
app.get('/api/leave-policies', auth, wrap(async (req, res) => res.json({ success: true, data: db.listPolicies(req.user) })));
app.post('/api/leave-policies', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.savePolicy(req.user, req.body) })));
app.get('/api/leave-accrual', auth, wrap(async (req, res) => res.json({ success: true, data: db.accrualBoard(req.user) })));
app.post('/api/leave-accrual', auth, wrap(async (req, res) => res.json({ success: true, data: db.runAccrual(req.user, req.body) })));

app.get('/api/leaves', auth, wrap(async (req, res) => res.json({ success: true, data: db.listLeaves(req.user) })));
app.post('/api/leaves', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createLeave(req.user, req.body) })));
app.put('/api/leaves/:id/status', auth, wrap(async (req, res) => res.json({ success: true, data: db.setLeaveStatus(req.user, req.params.id, req.body) })));

app.get('/api/shift-swaps', auth, wrap(async (req, res) => res.json({ success: true, data: db.listSwaps(req.user) })));
app.post('/api/shift-swaps', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createSwap(req.user, req.body) })));
app.put('/api/shift-swaps/:id/status', auth, wrap(async (req, res) => res.json({ success: true, data: db.setSwapStatus(req.user, req.params.id, req.body) })));

app.get('/api/expense-policies', auth, wrap(async (req, res) => res.json({ success: true, data: db.listExpensePolicies(req.user) })));
app.post('/api/expense-policies', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveExpensePolicy(req.user, req.body) })));
app.get('/api/reimbursements', auth, wrap(async (req, res) => res.json({ success: true, data: db.listReimbursements(req.user) })));
app.post('/api/reimbursements', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createReimbursement(req.user, req.body) })));
app.get('/api/reimbursements/:id/history', auth, wrap(async (req, res) => res.json({ success: true, data: db.listClaimEvents(req.user, req.params.id) })));
app.put('/api/reimbursements/:id/status', auth, wrap(async (req, res) => res.json({ success: true, data: db.setReimbursementStatus(req.user, req.params.id, req.body) })));

app.get('/api/applicants', auth, wrap(async (req, res) => res.json({ success: true, data: db.listApplicants(req.user) })));
app.post('/api/applicants', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createApplicant(req.user, req.body) })));
app.put('/api/applicants/:id/stage', auth, wrap(async (req, res) => res.json({ success: true, data: db.setApplicantStage(req.user, req.params.id, req.body) })));
app.put('/api/applicants/:id/resume', auth, wrap(async (req, res) => res.json({ success: true, data: db.setApplicantResume(req.user, req.params.id, req.body) })));
app.put('/api/applicants/:id/offer', auth, wrap(async (req, res) => res.json({ success: true, data: db.setOffer(req.user, req.params.id, req.body) })));
app.get('/api/requisitions', auth, wrap(async (req, res) => res.json({ success: true, data: db.listRequisitions(req.user) })));
app.post('/api/requisitions', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createRequisition(req.user, req.body) })));
app.put('/api/requisitions/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setRequisition(req.user, req.params.id, req.body) })));
app.get('/api/employees/:id/360', auth, wrap(async (req, res) => res.json({ success: true, data: db.employee360(req.user, req.params.id) })));

app.get('/api/activities', auth, wrap(async (req, res) => res.json({ success: true, data: db.listActivities(req.user, req.query.type) })));
app.post('/api/activities', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createActivity(req.user, req.body) })));
app.put('/api/activities/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.updateActivity(req.user, req.params.id, req.body) })));
app.post('/api/activities/:id/files', auth, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'Choose a file' });
  try {
    res.json({ success: true, data: db.addActivityFile(req.user, req.params.id, req.file, req.body) });
  } catch (error) {
    unlinkAll([req.file]);
    throw error;
  }
}));

const sseClients = new Map();

if (typeof db.onMessage === 'function') {
  db.onMessage((msg) => {
    const payload = `data: ${JSON.stringify(msg)}\n\n`;
    for (const [clientId, client] of sseClients.entries()) {
      try {
        const user = client.user;
        let allowed = false;
        if (msg.channel.startsWith('dm:')) {
          const parts = msg.channel.split(':');
          allowed = parts[1] === user.id || parts[2] === user.id;
        } else if (msg.channel === 'desk' || msg.channel === 'activities' || msg.channel === 'queries' || msg.channel === 'posh') {
          allowed = true;
        } else if (msg.channel.startsWith('company:')) {
          allowed = user.role === 'admin' || user.role === 'superadmin' || msg.channel === `company:${user.clientId}`;
        }
        if (allowed) {
          client.res.write(payload);
        }
      } catch (_) {}
    }
  });
}

app.get('/api/messages/channels', auth, wrap(async (req, res) => res.json({ success: true, data: db.channelsFor(req.user) })));
app.get('/api/messages/users', auth, wrap(async (req, res) => res.json({ success: true, data: db.searchUsers(req.user, req.query.q) })));
app.get('/api/messages', auth, wrap(async (req, res) => res.json({ success: true, data: db.listMessages(req.user, req.query.channel) })));
app.post('/api/messages', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.sendMessage(req.user, req.body) })));
app.get('/api/messages/stream', auth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write(': connected\n\n');

  const clientId = crypto.randomUUID();
  sseClients.set(clientId, { user: req.user, res });

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
  });
});
app.put('/api/profile', auth, wrap(async (req, res) => res.json({ success: true, data: db.updateProfile(req.user, req.body) })));

app.get('/api/tickets', auth, wrap(async (req, res) => res.json({ success: true, data: db.listTickets(req.user) })));
app.post('/api/tickets', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createTicket(req.user, req.body) })));
app.post('/api/tickets/:id/reply', auth, wrap(async (req, res) => res.json({ success: true, data: db.replyTicket(req.user, req.params.id, req.body) })));

app.get('/api/posh', auth, wrap(async (req, res) => res.json({ success: true, data: db.listPosh(req.user) })));
app.post('/api/posh', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createPosh(req.user, req.body) })));
app.put('/api/posh/:id/status', auth, wrap(async (req, res) => res.json({ success: true, data: db.setPoshStatus(req.user, req.params.id, req.body) })));

app.get('/api/leads', auth, wrap(async (req, res) => res.json({ success: true, data: db.listLeads(req.user) })));
app.post('/api/leads', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createLead(req.user, req.body) })));
app.put('/api/leads/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.updateLead(req.user, req.params.id, req.body) })));

app.get('/api/tasks', auth, wrap(async (req, res) => res.json({ success: true, data: db.listTasks(req.user) })));
app.post('/api/tasks', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createTask(req.user, req.body) })));
app.put('/api/tasks/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.updateTask(req.user, req.params.id, req.body) })));
app.put('/api/tasks/:id/approval', auth, wrap(async (req, res) => res.json({ success: true, data: db.setTaskApproval(req.user, req.params.id, req.body) })));
app.get('/api/goals', auth, wrap(async (req, res) => res.json({ success: true, data: db.listGoals(req.user) })));
app.post('/api/goals', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveGoal(req.user, req.body) })));
app.put('/api/goals/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setGoalStatus(req.user, req.params.id, req.body) })));
app.get('/api/kras', auth, wrap(async (req, res) => res.json({ success: true, data: db.listKras(req.user) })));
app.post('/api/kras', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveKra(req.user, req.body) })));
app.get('/api/reviews', auth, wrap(async (req, res) => res.json({ success: true, data: db.listReviews(req.user) })));
app.post('/api/reviews', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveReview(req.user, req.body) })));
app.put('/api/reviews/:id/status', auth, wrap(async (req, res) => res.json({ success: true, data: db.setReviewStatus(req.user, req.params.id, req.body) })));
app.get('/api/performance', auth, wrap(async (req, res) => res.json({ success: true, data: db.performanceAnalytics(req.user) })));
app.get('/api/payroll/runs', auth, wrap(async (req, res) => res.json({ success: true, data: db.listPayrollRuns(req.user) })));
app.post('/api/payroll/runs', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.submitPayroll(req.user, req.body) })));
app.put('/api/payroll/runs/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setPayrollRun(req.user, req.params.id, req.body) })));
app.get('/api/payroll/compliance', auth, wrap(async (req, res) => res.json({ success: true, data: db.payrollCompliance(req.user) })));
app.get('/api/payroll/requests', auth, wrap(async (req, res) => res.json({ success: true, data: db.listPayrollRequests(req.user) })));
app.post('/api/payroll/requests', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createPayrollRequest(req.user, req.body) })));
app.put('/api/payroll/requests/:id/status', auth, wrap(async (req, res) => res.json({ success: true, data: db.setPayrollRequest(req.user, req.params.id, req.body) })));

app.get('/api/template-tokens', auth, wrap(async (req, res) => res.json({ success: true, data: db.templateTokens() })));
app.get('/api/custom-fields', auth, wrap(async (req, res) => res.json({ success: true, data: db.listCustomFields(req.user) })));
app.post('/api/custom-fields', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveCustomField(req.user, req.body) })));
app.get('/api/custom-forms', auth, wrap(async (req, res) => res.json({ success: true, data: db.listCustomForms(req.user) })));
app.post('/api/custom-forms', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveCustomForm(req.user, req.body) })));
app.put('/api/employees/:id/custom', auth, wrap(async (req, res) => res.json({ success: true, data: db.setCustomData(req.user, req.params.id, req.body) })));
app.get('/api/document-requests', auth, wrap(async (req, res) => res.json({ success: true, data: db.listDocumentRequests(req.user) })));
app.post('/api/document-requests', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createDocumentRequest(req.user, req.body) })));
app.put('/api/document-requests/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setDocumentRequest(req.user, req.params.id, req.body) })));
app.get('/api/templates', auth, wrap(async (req, res) => res.json({ success: true, data: db.listTemplates(req.user) })));
app.post('/api/templates', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveTemplate(req.user, req.body) })));
app.put('/api/templates/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.saveTemplate(req.user, req.body, req.params.id) })));

app.post('/api/departments', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createDepartment(req.user, req.body) })));
app.post('/api/departments/assign', auth, wrap(async (req, res) => res.json({ success: true, data: db.assignEmployeeDepartment(req.user, req.body) })));
app.post('/api/notifications/read', auth, wrap(async (req, res) => {
  db.markNotificationsRead(req.user);
  res.json({ success: true });
}));

app.get('/api/search', auth, wrap(async (req, res) => res.json({ success: true, data: db.search(req.user, req.query.q || '') })));

app.get('/api/reports/dashboard', auth, wrap(async (req, res) => res.json({ success: true, data: db.managementDashboard(req.user) })));
app.get('/api/report-requests', auth, wrap(async (req, res) => res.json({ success: true, data: db.listReportRequests(req.user) })));
app.post('/api/report-requests', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.createReportRequest(req.user, req.body) })));
app.put('/api/report-requests/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setReportRequest(req.user, req.params.id, req.body) })));
app.get('/api/incentives/rules', auth, wrap(async (req, res) => res.json({ success: true, data: db.listIncentiveRules(req.user) })));
app.post('/api/incentives/rules', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.saveIncentiveRule(req.user, req.body) })));
app.put('/api/incentives/rules/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setIncentiveRule(req.user, req.params.id, req.body) })));
app.get('/api/incentives/awards', auth, wrap(async (req, res) => res.json({ success: true, data: db.listAwards(req.user, req.query.period) })));
app.post('/api/incentives/calculate', auth, wrap(async (req, res) => res.json({ success: true, data: db.calculateIncentives(req.user, req.body) })));
app.post('/api/incentives/submit', auth, wrap(async (req, res) => res.json({ success: true, data: db.submitIncentives(req.user, req.body) })));
app.put('/api/incentives/awards/:id', auth, wrap(async (req, res) => res.json({ success: true, data: db.setIncentiveAward(req.user, req.params.id, req.body) })));
app.post('/api/incentives/requests', auth, wrap(async (req, res) => res.status(201).json({ success: true, data: db.requestIncentive(req.user, req.body) })));
app.get('/api/export/:entity', auth, wrap(async (req, res) => {
  const rows = db.exportRows(req.user, req.params.entity);
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'S1');
  const filename = `s1-${req.params.entity}.${format === 'csv' ? 'csv' : 'xlsx'}`;
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(XLSX.utils.sheet_to_csv(sheet));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
}));

app.get('/api/documents/:kind/:id', auth, wrap(async (req, res) => {
  const model = db.documentModel(req.user, req.params.kind, req.params.id);
  res.type('html').send(documents.render(model));
}));

const loginCopy = {
  superadmin: {
    kicker: 'Super admin',
    title: 'Control desk',
    lede: 'Approve companies, set subscriptions, issue portal access, and clear requests that still need a final decision.',
    email: 'ravi.menon@s1hrsolution.com',
    password: 'Admin@123',
    who: 'Ravi Menon, super administrator'
  },
  admin: {
    kicker: 'Admin',
    title: 'Company HR desk',
    lede: 'People, attendance, payroll, and approvals for the one company that issued this login. Subscriptions stay with the client admin.',
    email: 'kavya.nair@nexusinfotech.com',
    password: 'Admin@123',
    who: 'Kavya Nair, Nexus Infotech HR admin'
  },
  'client-admin': {
    kicker: 'Client admin',
    title: 'Subscription desk',
    lede: 'Choose the plan, request a change, and run the company the super administrator has approved.',
    email: 'priya.shah@nexusinfotech.com',
    password: 'Client@123',
    who: 'Priya Shah, Nexus Infotech. Zenith uses imran.qureshi@zenithlogistics.in with the same password.'
  },
  employee: {
    kicker: 'Employee',
    title: 'People desk',
    lede: 'Punch attendance with time and location, raise leave and shift requests, and download payslips and letters.',
    email: 'aarav.sharma@nexusinfotech.com',
    password: 'Employee@123',
    who: 'Aarav Sharma. Meera Iyer and Kabir Joshi use the same password on their own emails.'
  }
};

app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/register', (req, res) => res.sendFile(path.join(publicDir, 'register.html')));
app.get('/workspace', (req, res) => res.sendFile(path.join(publicDir, 'workspace.html')));
app.get('/login/:portal', (req, res) => {
  const portal = req.params.portal === 'client' ? 'client-admin' : req.params.portal;
  const copy = loginCopy[portal];
  if (!copy) return res.redirect('/');
  const html = fs.readFileSync(path.join(publicDir, 'login.html'), 'utf8')
    .replaceAll('{{portal}}', portal)
    .replaceAll('{{kicker}}', copy.kicker)
    .replaceAll('{{title}}', copy.title)
    .replaceAll('{{lede}}', copy.lede)
    .replaceAll('{{email}}', copy.email)
    .replaceAll('{{password}}', copy.password)
    .replaceAll('{{who}}', copy.who);
  res.type('html').send(html);
});

app.use(express.static(publicDir, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js') || filePath.endsWith('.html') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ success: false, error: 'That service was not found' });
  res.redirect('/');
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.message && error.message.includes('Upload') ? 400 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ success: false, error: error.message || 'The desk could not complete that' });
});

app.listen(PORT, () => {
  console.log(`S1 HR Solution is running at http://localhost:${PORT}`);
  console.log(`Super admin   http://localhost:${PORT}/login/superadmin`);
  console.log(`Client admin  http://localhost:${PORT}/login/client-admin`);
  console.log(`Admin desk    http://localhost:${PORT}/login/admin`);
  console.log(`Employee desk http://localhost:${PORT}/login/employee`);
});
