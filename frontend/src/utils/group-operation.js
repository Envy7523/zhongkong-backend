// Both group-buy platforms use the same chart/table renderer, with their own fields.
export const groupOperationMetrics = {
  '美团团购': [
    {key:'gross_amount',label:'营业额',unit:'money',section:'revenue',color:'#8dbcf7'},
    {key:'income_amount',label:'收入',unit:'money',section:'revenue',color:'#315fc5'},
    {key:'order_count',label:'订单量',unit:'count',section:'revenue',color:'#f59e0b'},
    {key:'actual_amount',label:'实际到账金额',unit:'money',section:'revenue',color:'#28a879'},
    {key:'impression_users',label:'曝光人数',unit:'count',section:'traffic',color:'#bed8fb'},
    {key:'visit_users',label:'访问人数',unit:'count',section:'traffic',color:'#5c93e8'},
    {key:'visit_rate',label:'曝光-访问转化率',unit:'percent',section:'traffic',color:'#0f9d7b'},
    {key:'ordering_users',label:'购买人数',unit:'count',section:'traffic',color:'#2857ba'},
    {key:'order_rate',label:'访问-购买转化率',unit:'percent',section:'traffic',color:'#f59e0b'},
    {key:'meituan_rating',label:'美团星级',unit:'rating',section:'rating',color:'#6d4ac4'},
    {key:'dianping_rating',label:'点评星级',unit:'rating',section:'rating',color:'#c47c12'},
    {key:'review_count',label:'全部评价数',unit:'count',section:'rating',color:'#9abce8'},
  ],
  '抖音团购': [
    {key:'gross_amount',label:'营业额',unit:'money',section:'revenue',color:'#8dbcf7'},
    {key:'actual_amount',label:'实收',unit:'money',section:'revenue',color:'#315fc5'},
    {key:'order_count',label:'订单量',unit:'count',section:'revenue',color:'#f59e0b'},
    {key:'visit_users',label:'访问人数',unit:'count',section:'traffic',color:'#5c93e8'},
    {key:'ordering_users',label:'购买人数',unit:'count',section:'traffic',color:'#2857ba'},
    {key:'order_rate',label:'下单转化率',unit:'percent',section:'traffic',color:'#f59e0b'},
    {key:'store_rating',label:'门店评分',unit:'rating',section:'rating',color:'#6d4ac4'},
    {key:'review_count',label:'累计评价数',unit:'count',section:'rating',color:'#9abce8'},
  ],
};
