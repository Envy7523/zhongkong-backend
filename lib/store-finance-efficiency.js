'use strict';
const fs=require('fs'),path=require('path');
const labor=require('./labor-efficiency');
function calculate(db,storeId,from,to){
 const required=['employees','dingtalk_attendance_records','employee_salary_profiles','employee_store_dispatches'];
 if(required.some(name=>!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[name])))return {value:null,items:[],notes:['尚无可用的人员、打卡或工资来源，人效待核。']};
 let config={};try{config=JSON.parse(fs.readFileSync(path.join(__dirname,'../config.json'),'utf8').replace(/^\uFEFF/,''));}catch{}
 const board=labor.buildLaborEfficiency({db,store:db.queryOne('SELECT * FROM stores WHERE id=?',[storeId]),storeId,region:labor.laborEfficiencyRegion(config),period:{month:to.slice(0,7),start:from,cutoff:to,days_in_month:new Date(Date.UTC(Number(to.slice(0,4)),Number(to.slice(5,7)),0)).getUTCDate()}});
 const scope=board.range_totals;
 const notes=!scope?['人效沿用月经营看板统计范围，当前门店未纳入。']:scope.missing_basis_count?['已有打卡计入出勤，但工资标准或兼职计薪时长未登记：'+board.data_gap.names.join('、')]:!scope.people?['没有出勤记录，人效待核。']:scope.store_sales<=0?['收银店内销售为0，人效暂留空。']:[];
 return {value:scope?.ratio??null,notes,board,items:scope?[...scope.rows.map(r=>({label:r.name+' · '+r.wage_note,amount:r.wage,source:'月经营看板人员工资口径',date:from===to?from:from+' 至 '+to,work_details:r.work_details})),{label:'收银店内销售（分母）',amount:scope.store_sales,source:'收银综合营业统计',date:from===to?from:from+' 至 '+to}]:[]};
}
module.exports={calculate};
