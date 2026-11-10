const catalog = [
  {
    id: 'earnings',
    title: 'Employee earnings',
    fields: [
      ['basicSalary', 'Basic salary'],
      ['hra', 'HRA'],
      ['performanceIncentive', 'Performance incentive'],
      ['productionIncentive', 'Production incentive'],
      ['salesIncentive', 'Sales incentive'],
      ['bonus', 'Bonus'],
      ['exGratia', 'Ex-gratia'],
      ['overtime', 'Overtime'],
      ['arrears', 'Arrears'],
      ['leaveEncashment', 'Leave encashment'],
      ['joiningBonus', 'Joining bonus'],
      ['retentionBonus', 'Retention bonus'],
      ['referralBonus', 'Referral bonus'],
      ['festivalBonus', 'Festival bonus'],
      ['gratuity', 'Gratuity'],
      ['napsStipend', 'NAPS stipend']
    ]
  },
  {
    id: 'deductions',
    title: 'Employee deductions',
    fields: [
      ['employeePf', 'Employee PF'],
      ['employeeEsic', 'Employee ESIC'],
      ['professionalTax', 'Professional tax'],
      ['tds', 'TDS'],
      ['labourWelfareFund', 'Labour welfare fund'],
      ['salaryAdvanceRecovery', 'Salary advance recovery'],
      ['employeeLoanRecovery', 'Employee loan recovery'],
      ['noticePayRecovery', 'Notice pay recovery'],
      ['lopDeduction', 'LOP / unpaid leave deduction'],
      ['lateComingDeduction', 'Late coming deduction'],
      ['absenceDeduction', 'Absence deduction'],
      ['canteenDeduction', 'Canteen deduction'],
      ['foodDeduction', 'Food deduction'],
      ['transportDeduction', 'Transport deduction'],
      ['accommodationDeduction', 'Accommodation deduction'],
      ['uniformDeduction', 'Uniform deduction'],
      ['insurancePremium', 'Insurance premium'],
      ['voluntaryPf', 'Voluntary PF (VPF)'],
      ['salaryOverpaymentRecovery', 'Salary overpayment recovery'],
      ['assetDamageRecovery', 'Asset / damage recovery'],
      ['mobileRecovery', 'Mobile / telephone recovery'],
      ['otherStatutoryRecovery', 'Other statutory recovery']
    ]
  },
  {
    id: 'employer',
    title: 'Employer contributions',
    fields: [
      ['employerPf', 'Employer PF'],
      ['employerEps', 'Employer EPS'],
      ['employerEdli', 'Employer EDLI'],
      ['pfAdminCharges', 'PF administrative charges'],
      ['employerEsic', 'Employer ESIC'],
      ['employerLwf', 'Employer LWF'],
      ['gratuityProvision', 'Gratuity provision'],
      ['napsGovtContribution', 'NAPS government contribution']
    ]
  },
  {
    id: 'allowances',
    title: 'Employee allowance',
    fields: [
      ['dearnessAllowance', 'Dearness allowance (DA)'],
      ['conveyanceAllowance', 'Conveyance allowance'],
      ['transportAllowance', 'Transport allowance'],
      ['medicalAllowance', 'Medical allowance'],
      ['specialAllowance', 'Special allowance'],
      ['cityCompensatoryAllowance', 'City compensatory allowance (CCA)'],
      ['foodMealAllowance', 'Food / meal allowance'],
      ['telephoneAllowance', 'Telephone / mobile allowance'],
      ['internetAllowance', 'Internet allowance'],
      ['educationAllowance', 'Education allowance'],
      ['hostelAllowance', 'Hostel allowance'],
      ['travelAllowance', 'Travel allowance'],
      ['shiftAllowance', 'Shift allowance'],
      ['nightShiftAllowance', 'Night shift allowance'],
      ['riskHardshipAllowance', 'Risk / hardship allowance'],
      ['siteAllowance', 'Site allowance'],
      ['fieldAllowance', 'Field allowance'],
      ['locationAllowance', 'Location allowance'],
      ['attendanceAllowance', 'Attendance allowance']
    ]
  },
  {
    id: 'attendanceInputs',
    title: 'Attendance payroll inputs',
    fields: [
      ['paidDays', 'Paid days'],
      ['presentDays', 'Present days'],
      ['trainingDays', 'Training days'],
      ['probationDays', 'Probation days'],
      ['absentDays', 'Absent days'],
      ['lopDays', 'LOP days'],
      ['paidLeave', 'Paid leave'],
      ['weeklyOff', 'Weekly off'],
      ['holidays', 'Holidays'],
      ['otHours', 'OT hours'],
      ['otRate', 'OT rate'],
      ['payableDays', 'Payable days']
    ]
  },
  {
    id: 'fullAndFinal',
    title: 'Full and final settlement',
    fields: [
      ['pendingSalary', 'Pending salary'],
      ['lastWorkingDaysSalary', 'Salary for last working days'],
      ['lopAdjustment', 'Unpaid / LOP adjustment'],
      ['leaveEncashmentFnf', 'Leave encashment'],
      ['overtimePending', 'Overtime pending'],
      ['incentivePending', 'Incentive pending'],
      ['bonusPending', 'Bonus / ex-gratia pending'],
      ['arrearsFnf', 'Arrears'],
      ['gratuityFnf', 'Gratuity, if applicable'],
      ['noticePay', 'Notice pay'],
      ['noticePayRecoveryFnf', 'Notice pay recovery'],
      ['salaryAdvanceRecoveryFnf', 'Salary advance recovery'],
      ['loanRecovery', 'Loan recovery'],
      ['assetDamageRecoveryFnf', 'Asset / damage recovery'],
      ['pfSettlement', 'PF-related settlement information'],
      ['tdsAdjustment', 'TDS adjustment'],
      ['otherRecoveries', 'Other recoveries'],
      ['netFfAmount', 'Net F&F amount payable']
    ]
  }
];

function sum(lines) {
  return lines.reduce((total, line) => total + line.amount, 0);
}

function summarize(raw) {
  const data = raw || {};
  const earnings = [];
  const deductions = [];
  const employer = [];
  const attendance = {};
  const settlement = [];

  const push = (list, group) => {
    for (const [key, label] of group.fields) {
      const amount = Number(data[key]) || 0;
      if (amount) list.push({ key, label, amount });
    }
  };

  for (const group of catalog) {
    if (group.id === 'earnings' || group.id === 'allowances') push(earnings, group);
    else if (group.id === 'deductions') push(deductions, group);
    else if (group.id === 'employer') push(employer, group);
    else if (group.id === 'fullAndFinal') push(settlement, group);
    else if (group.id === 'attendanceInputs') {
      for (const [key] of group.fields) attendance[key] = Number(data[key]) || 0;
    }
  }

  const computedOt = (Number(data.otHours) || 0) * (Number(data.otRate) || 0);
  if (computedOt && !Number(data.overtime)) {
    earnings.push({ key: 'otComputed', label: 'Overtime (hours × rate)', amount: computedOt });
  }

  const earnTotal = sum(earnings);
  const dedTotal = sum(deductions);
  return {
    earnings,
    deductions,
    employer,
    settlement,
    attendance,
    earnTotal,
    dedTotal,
    net: earnTotal - dedTotal
  };
}

module.exports = { catalog, summarize };
