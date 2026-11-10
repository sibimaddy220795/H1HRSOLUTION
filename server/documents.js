const QRCode = require('qrcode');

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[char]));
}

function inr(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function qrMark(text) {
  const code = QRCode.create(String(text || 'S1HR'), { errorCorrectionLevel: 'M' });
  const size = code.modules.size;
  const cells = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (code.modules.get(x, y)) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
    }
  }
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code">${cells.join('')}</svg>`;
}

function customLetter(model) {
  const employee = model.employee || {};
  const paragraphs = esc(model.customBody).split(/\n{2,}/).map((part) => `<p>${part.replace(/\n/g, '<br/>')}</p>`).join('');
  const card = model.kind === 'idcard' ? `<div class="card"><div><p>${esc(employee.fullName)}</p><p><strong>${esc(employee.employeeCode)}</strong></p></div>${qrMark(model.qrText)}</div>` : '';
  const body = `${letterhead(model, model.kind || 'Letter')}<h1>${esc(model.kind || 'Letter')}</h1>${paragraphs}${card}`;
  return shell({ title: `${model.kind} · ${employee.fullName || ''}`, watermark: model.watermark, body });
}

function shell({ title, watermark, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${esc(title)}</title>
  <style>
    @page { size: A4; margin: 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #1c1915; font: 14px/1.5 "Segoe UI", sans-serif; background: #efeae2; }
    .sheet { position: relative; max-width: 820px; margin: 24px auto; background: #fffdf9; padding: 42px 46px 56px; border: 1px solid #e4d9c8; }
    .watermark { position: absolute; inset: 34% 6% auto; text-align: center; font: 600 64px/1 Georgia, serif; letter-spacing: .12em; color: rgba(27,58,75,.08); transform: rotate(-18deg); pointer-events: none; }
    .letterhead { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #1b3a4b; padding-bottom: 16px; }
    .brand { font: 600 28px/1 Georgia, serif; letter-spacing: -.03em; }
    .brand span { display: block; margin-top: 4px; font: 11px/1.4 "Segoe UI", sans-serif; letter-spacing: .16em; text-transform: uppercase; color: #6e675e; }
    .meta { text-align: right; font-size: 12px; color: #6e675e; }
    h1 { font: 600 30px/1.15 Georgia, serif; margin: 26px 0 8px; }
    h2 { font-size: 13px; letter-spacing: .14em; text-transform: uppercase; color: #8d6a3f; margin: 28px 0 8px; }
    p { margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #eadfd0; text-align: left; vertical-align: top; }
    th { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #6e675e; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .totals { margin-top: 8px; }
    .totals div { display: flex; justify-content: space-between; padding: 6px 0; }
    .net { margin-top: 8px; padding-top: 8px; border-top: 2px solid #1b3a4b; font: 600 20px/1.3 Georgia, serif; display: flex; justify-content: space-between; }
    .note { margin-top: 22px; color: #6e675e; font-size: 12px; }
    .card { width: 420px; margin: 28px auto; border: 1px solid #1b3a4b; padding: 22px; display: grid; grid-template-columns: 1fr 108px; gap: 16px; }
    .card svg { width: 108px; height: 108px; fill: #1b3a4b; background: #fff; }
    .actions { max-width: 820px; margin: 0 auto 24px; text-align: right; }
    button { border: 0; background: #1b3a4b; color: white; padding: 10px 14px; border-radius: 8px; cursor: pointer; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
    @media print { body { background: white; } .sheet { margin: 0; border: 0; } .actions { display: none; } }
  </style>
</head>
<body>
  <div class="actions"><button onclick="print()">Print or save as PDF</button></div>
  <article class="sheet">
    <div class="watermark">${esc(watermark || 'S1 HR SOLUTION')}</div>
    ${body}
  </article>
</body>
</html>`;
}

function letterhead(model, kicker) {
  const client = model.client || {};
  return `<header class="letterhead">
    <div class="brand">S1 HR Solution<span>${esc(kicker)}</span></div>
    <div class="meta">
      <strong>${esc(client.companyName || 'Client company')}</strong><br/>
      ${esc(client.address || '')}<br/>
      ${esc(client.officialMail || '')}<br/>
      ${esc(model.number || '')}
    </div>
  </header>`;
}

function linesTable(lines) {
  if (!lines.length) return '<p>No amounts recorded in this group.</p>';
  return `<table>
    <thead><tr><th>Component</th><th class="num">Amount</th></tr></thead>
    <tbody>
      ${lines.map((line) => `<tr><td>${esc(line.label)}</td><td class="num">${inr(line.amount)}</td></tr>`).join('')}
    </tbody>
  </table>`;
}

function payslip(model) {
  const employee = model.employee;
  const pay = model.pay;
  const body = `
    ${letterhead(model, 'Payslip')}
    <h1>Payslip</h1>
    <p>${esc(model.period)} · ${esc(employee.fullName)} · ${esc(employee.employeeCode)}</p>
    <table>
      <tbody>
        <tr><th>Designation</th><td>${esc(employee.roleTitle)}</td><th>Department</th><td>${esc(employee.department)}</td></tr>
        <tr><th>Level</th><td>${esc(employee.levelName)}</td><th>Paid days</th><td>${esc(pay.attendance.paidDays || '—')}</td></tr>
        <tr><th>PAN</th><td>${esc(employee.statutory.panNumber || '—')}</td><th>PF UAN</th><td>${esc(employee.statutory.pfUan || '—')}</td></tr>
        <tr><th>ESIC</th><td>${esc(employee.statutory.esicNumber || '—')}</td><th>Present days</th><td>${esc(pay.attendance.presentDays || '—')}</td></tr>
      </tbody>
    </table>
    <div class="cols">
      <div><h2>Earnings</h2>${linesTable(pay.earnings)}</div>
      <div><h2>Deductions</h2>${linesTable(pay.deductions)}</div>
    </div>
    <div class="totals">
      <div><span>Gross earnings</span><strong>${inr(pay.earnTotal)}</strong></div>
      <div><span>Total deductions</span><strong>${inr(pay.dedTotal)}</strong></div>
    </div>
    <div class="net"><span>Net pay</span><span>${inr(pay.net)}</span></div>
    <h2>Employer contributions</h2>
    ${linesTable(pay.employer)}
    <p class="note">${esc(model.note || 'Generated by the S1 payroll desk for the employee record on file.')}</p>`;
  return shell({ title: `Payslip · ${employee.fullName}`, watermark: model.watermark, body });
}

function offer(model) {
  const employee = model.employee;
  const body = `
    ${letterhead(model, 'Offer of employment')}
    <h1>Offer letter</h1>
    <p>${esc(model.today)}</p>
    <p>Dear ${esc(employee.fullName)},</p>
    <p>${esc(model.client.companyName)} is pleased to offer you the position of <strong>${esc(employee.roleTitle)}</strong> in ${esc(employee.department)}, ${esc(employee.levelName)}. You will report to ${esc(employee.reportingManager || 'the reporting manager on record')} and work from ${esc(employee.branchName)}.</p>
    <p>The indicative monthly gross on this record is <strong>${inr(model.pay.earnTotal)}</strong>, subject to PF, ESIC, TDS, and the other components maintained on your payroll card. Hiring source: ${esc(employee.hiringSource)}${employee.sourceCompany ? ` · ${esc(employee.sourceCompany)}` : ''}.</p>
    <p>This offer follows application ${esc(employee.applicationNumber)} and employee id ${esc(employee.employeeCode)}. Joining date on record: ${esc(employee.joinedOn)}.</p>
    <p>Please keep your identity, education, and bank documents current. Background verification remains a condition of continued deployment.</p>
    <p>Yours sincerely,<br/>S1 HR Solution<br/>For ${esc(model.client.companyName)}</p>
    <p class="note">${esc(model.note || '')}</p>`;
  return shell({ title: `Offer · ${employee.fullName}`, watermark: model.watermark, body });
}

function idcard(model) {
  const employee = model.employee;
  const body = `
    ${letterhead(model, 'Identity card')}
    <h1>Employee identity card</h1>
    <div class="card">
      <div>
        <p style="letter-spacing:.14em;text-transform:uppercase;font-size:11px;color:#8d6a3f;">${esc(model.client.companyName)}</p>
        <h1 style="margin-top:8px;">${esc(employee.fullName)}</h1>
        <p>${esc(employee.roleTitle)}<br/>${esc(employee.department)} · ${esc(employee.levelName)}</p>
        <p><strong>${esc(employee.employeeCode)}</strong><br/>
        Blood group ${esc(employee.statutory.bloodGroup || '—')}<br/>
        Emergency ${esc(employee.emergencyName || '—')} · ${esc(employee.emergencyPhone || '—')}<br/>
        Branch ${esc(employee.branchName)}</p>
      </div>
      ${qrMark(model.qrText || employee.employeeCode)}
    </div>
    <p class="note">The QR code carries the employee id ${esc(employee.employeeCode)}. ${esc(model.note || '')}</p>`;
  return shell({ title: `ID card · ${employee.fullName}`, watermark: model.watermark, body });
}

function relieving(model) {
  const employee = model.employee;
  const body = `
    ${letterhead(model, 'Relieving letter')}
    <h1>Relieving letter</h1>
    <p>${esc(model.today)}</p>
    <p>This is to record that ${esc(employee.fullName)}, ${esc(employee.employeeCode)}, served ${esc(model.client.companyName)} as ${esc(employee.roleTitle)} in ${esc(employee.department)}. The joining date on the workforce record is ${esc(employee.joinedOn)}.</p>
    <p>Background verification status on file: ${esc(employee.bgvStatus)}. Reporting manager: ${esc(employee.reportingManager || '—')}.</p>
    <h2>Full and final lines on record</h2>
    ${linesTable(model.pay.settlement)}
    <p>We confirm that the operational record can be closed once statutory dues, asset returns, and notice recovery are reconciled by the access holder.</p>
    <p>For S1 HR Solution<br/>${esc(model.client.companyName)}</p>
    <p class="note">${esc(model.note || '')}</p>`;
  return shell({ title: `Relieving · ${employee.fullName}`, watermark: model.watermark, body });
}

function appointment(model) {
  const employee = model.employee;
  const body = `
    ${letterhead(model, 'Appointment letter')}
    <h1>Appointment letter</h1>
    <p>${esc(model.today)}</p>
    <p>Dear ${esc(employee.fullName)},</p>
    <p>With reference to application ${esc(employee.applicationNumber)}, ${esc(model.client.companyName)} appoints you as <strong>${esc(employee.roleTitle)}</strong> in ${esc(employee.department)}, ${esc(employee.levelName)}, based at ${esc(employee.branchName)}.</p>
    <p>Your employee id is <strong>${esc(employee.employeeCode)}</strong>. Date of joining on record: ${esc(employee.joinedOn)}. You will report to ${esc(employee.reportingManager || 'the manager named on your record')} and follow the ${esc(employee.shiftName)} shift.</p>
    <p>The payroll card on this record is the basis for PF, ESIC, TDS, allowances, and other components. Confirmation, transfer, and separation are recorded separately on the lifecycle of this employee.</p>
    <p>Yours sincerely,<br/>S1 HR Solution<br/>For ${esc(model.client.companyName)}</p>
    <p class="note">${esc(model.note || '')}</p>`;
  return shell({ title: `Appointment · ${employee.fullName}`, watermark: model.watermark, body });
}

function experience(model) {
  const employee = model.employee;
  const body = `
    ${letterhead(model, 'Experience letter')}
    <h1>Experience letter</h1>
    <p>${esc(model.today)}</p>
    <p>This is to certify that ${esc(employee.fullName)} (${esc(employee.employeeCode)}) has been associated with ${esc(model.client.companyName)} as ${esc(employee.roleTitle)} in ${esc(employee.department)} from ${esc(employee.joinedOn)}.</p>
    <p>The current record status is ${esc(employee.status)}. Reporting manager: ${esc(employee.reportingManager || '—')}. Branch: ${esc(employee.branchName)}, ${esc(employee.branchCity)}.</p>
    <p>This letter is issued from the workforce record ${esc(employee.applicationNumber)} for the purpose requested by the access holder.</p>
    <p>For S1 HR Solution<br/>${esc(model.client.companyName)}</p>
    <p class="note">${esc(model.note || '')}</p>`;
  return shell({ title: `Experience · ${employee.fullName}`, watermark: model.watermark, body });
}

function salaryCertificate(model) {
  const employee = model.employee;
  const pay = model.pay;
  const body = `
    ${letterhead(model, 'Salary certificate')}
    <h1>Salary certificate</h1>
    <p>${esc(model.today)}</p>
    <p>This is to certify that ${esc(employee.fullName)}, ${esc(employee.employeeCode)}, is engaged with ${esc(model.client.companyName)} as ${esc(employee.roleTitle)}. The monthly figures below are taken from the payroll card for ${esc(model.period)}.</p>
    <div class="cols">
      <div><h2>Earnings</h2>${linesTable(pay.earnings)}</div>
      <div><h2>Deductions</h2>${linesTable(pay.deductions)}</div>
    </div>
    <div class="net"><span>Net pay</span><span>${inr(pay.net)}</span></div>
    <h2>Employer contributions</h2>
    ${linesTable(pay.employer)}
    <p class="note">${esc(model.note || 'Issued for the employee record on file. Statutory portals remain the source for PF, ESIC, and TDS filings.')}</p>`;
  return shell({ title: `Salary certificate · ${employee.fullName}`, watermark: model.watermark, body });
}

function commercial(model) {
  const client = model.client;
  const lines = (client.positionBudgets || []).map((row) => ({
    label: row.position,
    amount: Number(row.budget) || 0
  }));
  if (!lines.length) lines.push({ label: 'Workforce services retainer', amount: Number(client.totalBudget) || 0 });
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const gst = Math.round(subtotal * 0.18);
  const title = model.kind === 'invoice' ? 'Tax invoice' : 'Quotation';
  const body = `
    ${letterhead(model, title)}
    <h1>${esc(title)}</h1>
    <p>Prepared for ${esc(client.companyName)} · ${esc(client.applicationNumber)} · ${esc(model.today)}</p>
    <p>${esc(client.businessType)} · ${esc(client.address)}</p>
    ${linesTable(lines)}
    <div class="totals">
      <div><span>Subtotal</span><strong>${inr(subtotal)}</strong></div>
      <div><span>GST 18% (illustrative)</span><strong>${inr(gst)}</strong></div>
    </div>
    <div class="net"><span>Total</span><span>${inr(subtotal + gst)}</span></div>
    <p class="note">${esc(model.note || 'Position-wise budget on the client record. Final billing follows access-holder approval.')}</p>`;
  return shell({ title: `${title} · ${client.companyName}`, watermark: model.watermark, body });
}

function render(model) {
  if (model.customBody) return customLetter(model);
  if (model.kind === 'payslip') return payslip(model);
  if (model.kind === 'offer') return offer(model);
  if (model.kind === 'idcard') return idcard(model);
  if (model.kind === 'relieving') return relieving(model);
  if (model.kind === 'appointment') return appointment(model);
  if (model.kind === 'experience') return experience(model);
  if (model.kind === 'salarycert') return salaryCertificate(model);
  if (model.kind === 'invoice' || model.kind === 'quotation') return commercial(model);
  return shell({
    title: 'Document',
    watermark: 'S1 HR SOLUTION',
    body: '<h1>Document unavailable</h1><p>This letter type is not on the desk.</p>'
  });
}

module.exports = { render };
