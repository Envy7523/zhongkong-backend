const XLSX = require('xlsx');

const headers = [
  '门店名称', '日期', '营业额', '有效订单数',
  '店内销售', '自提销售', '美团外卖', '淘宝闪购', '京东外卖',
  '美团一键买单', '美团团购', '抖音团购', '储值消费', '优惠券',
  '优惠金额', '优惠占比'
];

const rows = [
  ['鹅太公烧鹅（龙岗万科店）', '2026年7月9日', 14525.57, 281,
   443.40, 183.30, 0, 1950.40, 7092.04,
   950, 700, 600, 400, 300,
   891.50, '48.82%'],
  ['鹅太公烧鹅（南山店）', '2026年7月9日', 8950.30, 172,
   320.00, 150.50, 350.20, 1200.00, 5200.00,
   680, 450, 380, 250, 170,
   620.00, '42.15%'],
  ['鹅太公烧鹅（福田店）', '2026年7月9日', 11280.00, 205,
   550.00, 210.00, 120.00, 800.00, 6200.00,
   1100, 550, 480, 320, 200,
   750.00, '38.60%'],
];

const data = [headers, ...rows];
const ws = XLSX.utils.aoa_to_sheet(data);

ws['!cols'] = headers.map((h, i) => {
  if (i === 0) return { wch: 30 };
  if (i === 1) return { wch: 16 };
  return { wch: 14 };
});

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '门店日报');
XLSX.writeFile(wb, 'F:/NewDeom/日报.xlsx');
console.log('Excel template created with ' + rows.length + ' stores');
