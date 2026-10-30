'use strict';
const plannedHours=require('./part-time-planned-hours');
function dispatchDates(row){
 if(row.dispatch_mode==='selected'){try{return JSON.parse(row.dispatch_dates_json||'[]')}catch{return []}}
 const out=[];for(let date=row.start_date;date&&date<=row.end_date;date=new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10))out.push(date);return out;
}
const DEFAULT_LABOR_EFFICIENCY_CITIES = ['深圳市'];
// 全职：月工资构成合计 ÷ 当月应出勤天数 × 出勤天数；兼职：当天工作时长 × 时薪。
// 当月应出勤天数与工资表模块同一默认值 26，可在 config.json 的 laborEfficiency.scheduledDaysPerMonth 覆盖。
const LABOR_EFFICIENCY_SCHEDULED_DAYS = 26;
const LABOR_EFFICIENCY_PART_TIME_TITLE = '兼职';
const LABOR_EFFICIENCY_ROWS_LIMIT = 500;
const round2 = value => Math.round(Number(value || 0) * 100) / 100;
function laborEfficiencyRegion(config) {
  const section = (config || {}).laborEfficiency || {};
  const fromEnv = String(process.env.LABOR_EFFICIENCY_CITIES || '').split(/[,，\s]+/);
  const configured = Array.isArray(section.includedCities) ? section.includedCities : [];
  const source = configured.length ? 'config.laborEfficiency.includedCities' : (fromEnv.some(city => String(city).trim()) ? 'LABOR_EFFICIENCY_CITIES' : 'default');
  const raw = configured.length ? configured : (source === 'default' ? DEFAULT_LABOR_EFFICIENCY_CITIES : fromEnv);
  const cities = [...new Set(raw.map(city => String(city || '').trim()).filter(Boolean))];
  const scheduledDays = Math.max(1, Math.min(31, Number(section.scheduledDaysPerMonth) || LABOR_EFFICIENCY_SCHEDULED_DAYS));
  return { enabled: section.enabled !== false && cities.length > 0, source, cities, scheduled_days: scheduledDays };
}
function buildLaborEfficiency({ db, period, store, storeId, region, revenueDailyRows, revenueView }) {
  const useTotalReceipts=Array.isArray(revenueDailyRows);
  const days = Number(period.days_in_month) || 30;
  const scheduledDays = Number(region.scheduled_days) || LABOR_EFFICIENCY_SCHEDULED_DAYS;
  const wageParts = parts => ({
    base_salary: round2(parts.base_salary), position_allowance: round2(parts.position_allowance),
    performance_salary: round2(parts.performance_salary), attendance_bonus: round2(parts.attendance_bonus),
    housing_allowance: round2(parts.housing_allowance), monthly_total: round2(parts.monthly_total),
  });
  const common = {
    enabled: region.enabled,
    region,
    included: false,
    period: { month: period.month, start: period.start, end: period.cutoff, days_in_month: days },
    scheduled_days_per_month: scheduledDays,
    formula: {
      full_time: `月工资构成合计（基本工资+岗位津贴+绩效工资+全勤奖+住房补贴）÷ 当月应出勤 ${scheduledDays} 天 × 出勤天数`,
      part_time: '兼职：有实际打卡按当日完整计划时长 × 时薪，不扣迟到早退或部分小时请假，不额外计提前/延后时间',
      denominator: useTotalReceipts?'当日/本期所选门店全渠道总实收，按月看板当前收入视角取值，团购不重复累计':'当日/本期收银机渠道「店内销售」记录金额合计',
      attendance_rule: '有实际打卡计出勤；全职计当天日工资，兼职按计划时长计薪，不执行考勤扣减',
    },
  };
  if (!region.enabled) return { ...common, reason: 'not_configured' };
  if (!store) return { ...common, reason: 'no_store' };
  const storeCity = String(store.city || '').trim();
  if (!region.cities.includes(storeCity)) return { ...common, reason: 'out_of_region', store_city: storeCity || null };

  const dateFrom = period.start;
  const dateTo = period.cutoff;
  const scheduleByDay=plannedHours.plans(db,dateFrom,dateTo);
  // 人员归属以当天实际工作门店为准：有效支援安排优先于员工的常驻门店。
  // 这样员工在 A 打卡但被安排支援 B 时，只会进入 B 的经营看板与人效名单。
  const dispatchedStoreByEmployeeDate = new Map();
  db.queryAll("SELECT * FROM employee_store_dispatches WHERE status='有效'").forEach(dispatch => {
    dispatchDates(dispatch).filter(day => day >= dateFrom && day <= dateTo).forEach(day => {
      const key = `${Number(dispatch.employee_id)}:${day}`;
      if (!dispatchedStoreByEmployeeDate.has(key)) dispatchedStoreByEmployeeDate.set(key, Number(dispatch.support_store_id));
    });
  });
  const attendanceRows = db.queryAll(
    `SELECT a.employee_id, a.work_date, a.check_time, a.check_type, a.time_result, a.source_data, e.store_id AS home_store_id
       FROM dingtalk_attendance_records a JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date >= ? AND a.work_date <= ? AND COALESCE(a.time_result,'')!='NotSigned'
      ORDER BY a.employee_id, a.work_date, a.check_time`,
    [dateFrom, dateTo]
  ).filter(record => Number(dispatchedStoreByEmployeeDate.get(`${Number(record.employee_id)}:${record.work_date}`) || record.home_store_id) === Number(storeId));
  const dailyRows = useTotalReceipts ? revenueDailyRows.filter(row=>row.biz_date>=dateFrom&&row.biz_date<=dateTo) : db.queryAll(
    `SELECT biz_date, COALESCE(SUM(recorded_amount), 0) AS amount FROM business_revenue_records
      WHERE store_id=? AND channel='store_sales' AND biz_date>=? AND biz_date<=? GROUP BY biz_date ORDER BY biz_date`,
    [storeId, dateFrom, dateTo]
  );
  const revenueByDate = new Map(dailyRows.map(row => [row.biz_date, Number(row.amount || 0)]));
  const storeSalesDaily = round2(revenueByDate.get(dateTo) || 0);
  const storeSalesPeriod = round2(dailyRows.reduce((sum, row) => sum + Number(row.amount || 0), 0));

  const byEmployee = new Map();
  attendanceRows.forEach(record => {
    const id = Number(record.employee_id);
    if (!id) return;
    const item = byEmployee.get(id) || { employee_id: id, dates: new Set(), dateRecords: new Map(), punches: 0 };
    item.dates.add(record.work_date);
    const list = item.dateRecords.get(record.work_date) || [];
    list.push({ check_time: record.check_time, check_type: record.check_type, time_result: record.time_result });
    item.dateRecords.set(record.work_date, list);
    item.punches += 1;
    byEmployee.set(id, item);
  });

  const ids = [...byEmployee.keys()];
  const employeeById = new Map();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.queryAll(
      `SELECT e.id, e.name, e.store_name, e.position, e.hire_type, e.salary,
              COALESCE(p.base_salary,0) AS base_salary, COALESCE(p.position_allowance,0) AS position_allowance,
              COALESCE(p.performance_salary,0) AS performance_salary, COALESCE(p.attendance_bonus,0) AS attendance_bonus,
              COALESCE(p.housing_allowance,0) AS housing_allowance, COALESCE(p.part_time_hourly_rate,0) AS part_time_hourly_rate,
              CASE WHEN p.employee_id IS NULL THEN 0 ELSE 1 END AS has_profile
         FROM employees e LEFT JOIN employee_salary_profiles p ON p.employee_id = e.id
        WHERE e.id IN (${placeholders})`,
      ids
    );
    rows.forEach(row => employeeById.set(Number(row.id), row));
  }

  const periodGaps = new Set();
  const dayGaps = new Set();
  const periodRows = [];
  const dayRows = [];
  const buildRow = (id, item, scope) => {
    const employee = employeeById.get(id) || {};
    const isPartTime = String(employee.hire_type || '').trim() === LABOR_EFFICIENCY_PART_TIME_TITLE;
    const profile = {
      base_salary: Number(employee.base_salary || 0), position_allowance: Number(employee.position_allowance || 0),
      performance_salary: Number(employee.performance_salary || 0), attendance_bonus: Number(employee.attendance_bonus || 0),
      housing_allowance: Number(employee.housing_allowance || 0),
    };
    profile.monthly_total = profile.base_salary + profile.position_allowance + profile.performance_salary + profile.attendance_bonus + profile.housing_allowance;
    if(!isPartTime&&profile.monthly_total<=0&&Number(employee.salary)>0){profile.base_salary=Number(employee.salary);profile.monthly_total=profile.base_salary;}
    const hourlyRate = Number(employee.part_time_hourly_rate || 0) || (isPartTime ? Number(employee.salary || 0) : 0);
    const isDayScope = scope === 'day';
    const attendanceDays = isDayScope ? 1 : item.dates.size;
    const dayRecords = item.dateRecords.get(dateTo) || [];
    const workDetails=(isDayScope?[dateTo]:[...item.dateRecords.keys()]).map(date=>({date,...plannedHours.statistics(item.dateRecords.get(date)||[],scheduleByDay.get(`${id}:${date}`),date)}));
    const hours=isPartTime?round2(workDetails.reduce((sum,r)=>sum+(r.hours||0),0)):round2((isDayScope?[dayRecords]:[...item.dateRecords.values()]).reduce((sum,list)=>sum+(require('./attendance-calendar').workTime(list).hours||0),0));
    const scheduleMissing=isPartTime&&workDetails.some(r=>!r.complete);
    const dailyFullTimeWage = round2(profile.monthly_total / scheduledDays);
    // 日工资先精确到分，再乘出勤天数，避免月末合计出现分位漂移。
    const fullTimeWage = round2(dailyFullTimeWage * attendanceDays);
    const partTimeWage = round2(hours * hourlyRate);
    const rateMissing = isPartTime ? hourlyRate <= 0 || scheduleMissing : profile.monthly_total <= 0;
    if (rateMissing) (isDayScope ? dayGaps : periodGaps).add(employee.name || `员工 ${id}`);
    return {
      employee_id: id,
      name: employee.name || '',
      store_name: employee.store_name || '',
      position: employee.position || '',
      hire_type: isPartTime ? LABOR_EFFICIENCY_PART_TIME_TITLE : '全职',
      attendance_days: attendanceDays,
      total_attendance_days: item.dates.size,
      work_hours: hours,
      work_details:isPartTime?workDetails:[],
      hourly_rate: round2(hourlyRate),
      daily_full_time_wage: dailyFullTimeWage,
      monthly_wage_total: round2(profile.monthly_total),
      wage_parts: isPartTime ? null : wageParts(profile),
      wage: isPartTime ? partTimeWage : fullTimeWage,
      wage_note: isPartTime
        ? `${hours} 计划小时 × ${round2(hourlyRate)} 元/时${scheduleMissing?'；已出勤，计薪时长待核':''}`
        : `${round2(profile.monthly_total)} ÷ ${scheduledDays} 天 × ${attendanceDays} 天`,
      has_wage_basis: !rateMissing,
      punches: isDayScope ? dayRecords.length : item.punches,
    };
  };

  byEmployee.forEach((item, id) => {
    periodRows.push(buildRow(id, item, 'period'));
    if (item.dateRecords.has(dateTo)) dayRows.push(buildRow(id, item, 'day'));
  });
  periodRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  dayRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const summarize = rows => ({
    people: rows.length,
    full_time_people: rows.filter(row => row.hire_type === '全职').length,
    part_time_people: rows.filter(row => row.hire_type === '兼职').length,
    attendance_days: rows.filter(row => row.hire_type === '全职').reduce((sum, row) => sum + row.attendance_days, 0),
    work_hours: round2(rows.filter(row => row.hire_type === '兼职').reduce((sum, row) => sum + row.work_hours, 0)),
    wage_total: round2(rows.reduce((sum, row) => sum + row.wage, 0)),
    missing_basis_count: rows.filter(row => !row.has_wage_basis).length,
  });
  const daySummary = summarize(dayRows);
  const periodSummary = summarize(periodRows);
  const dayRatio = (wage, revenue) => revenue > 0 ? Math.round(wage / revenue * 10000) / 10000 : null;

  return {
    ...common,
    included: true,
    store_name: store.store_name,
    store_city: storeCity,
    range: { date_from: dateFrom, date_to: dateTo },
    days_in_month: days,
    // 当日口径：截止日当天出勤的人，每人算当天工资
    day: {
      ...daySummary,
      date: dateTo,
      rows: dayRows,
      store_sales: storeSalesDaily,
      total_receipts: useTotalReceipts ? storeSalesDaily : null,
      revenue_view: revenueView || null,
      ratio: daySummary.missing_basis_count || !dayRows.length ? null : dayRatio(daySummary.wage_total, storeSalesDaily),
    },
    // 期间口径：月初至截止日期间出勤过的所有人，每人按各自出勤推算工资
    range_totals: {
      ...periodSummary,
      rows: periodRows.slice(0, LABOR_EFFICIENCY_ROWS_LIMIT),
      rows_total: periodRows.length,
      rows_truncated: periodRows.length > LABOR_EFFICIENCY_ROWS_LIMIT,
      store_sales: storeSalesPeriod,
      total_receipts: useTotalReceipts ? storeSalesPeriod : null,
      revenue_view: revenueView || null,
      ratio: periodSummary.missing_basis_count || !periodRows.length ? null : dayRatio(periodSummary.wage_total, storeSalesPeriod),
    },
    daily_rows: dailyRows.map(row => ({ date: row.biz_date, revenue: round2(row.amount) })),
    data_gap: { names: [...periodGaps], day_names: [...dayGaps] },
  };
}

module.exports={buildLaborEfficiency,laborEfficiencyRegion};
