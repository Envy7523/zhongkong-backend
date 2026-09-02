<template>
  <div class="business-analytics-page" :class="{ 'compare-mode': compareThemeActive }">
    <section class="analytics-hero">
      <div class="hero-copy"><span class="eyebrow">DATA ANALYTICS</span><h2>{{ viewConfig.title }}</h2><p>{{ viewConfig.description }}</p></div><div class="hero-actions"><el-button type="primary" :disabled="!canDiagnose" :loading="diagnosisLoading" @click="runDiagnosis">{{ hasCurrentDiagnosis ? '重新诊断' : 'AI 诊断' }}</el-button><el-button v-if="hasCurrentDiagnosis" plain @click="diagnosisVisible = true">诊断结果</el-button></div>
    </section>

    <section class="filter-bar">
      <div class="period-switch" aria-label="时间视角"><button v-for="item in timeModes" :key="item.value" :class="{ active: filters.timeMode === item.value }" @click="changeTimeMode(item.value)">{{ item.label }}</button></div>
      <el-date-picker v-if="filters.timeMode === 'day'" v-model="filters.day" :clearable="false" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
      <el-date-picker v-else-if="filters.timeMode === 'week'" v-model="filters.week" :clearable="false" type="week" value-format="YYYY-MM-DD" format="YYYY 第 ww 周" placeholder="选择周次" />
      <el-date-picker v-else-if="filters.timeMode === 'month'" v-model="filters.month" :clearable="false" type="month" value-format="YYYY-MM" placeholder="选择月份" />
      <el-date-picker v-else v-model="filters.customRange" :clearable="false" class="compact-range-picker" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" />
      <template v-if="analysisScope === 'delivery'">
        <div class="delivery-store-picker" aria-label="外卖门店范围">
          <StoreRegionSelect v-model="filters.deliveryStoreIds" :stores="storeOptions" multiple :filterable="false" :show-hint="false" show-selection-actions placeholder="选择门店或区域（不选即全部）" style="width:300px" />
        </div>
      </template>
      <StoreRegionSelect v-else-if="analysisMode === 'store'" v-model="filters.storeId" :stores="storeOptions" placeholder="选择门店或区域" input-width="220px" />
      <StoreRegionSelect v-else-if="analysisMode === 'custom'" v-model="filters.storeIds" :stores="storeOptions" multiple placeholder="勾选门店或区域" style="width:300px" />
      <el-select v-if="showPlatformSelect" v-model="filters.platform" style="width:180px"><el-option label="平台汇总" value="" /><el-option v-for="platform in scopedPlatforms" :key="platform" :label="platform" :value="platform" /></el-select>
      <el-button type="primary" class="query-button" :loading="loading" :disabled="!canQuery" @click="queryData"><el-icon><Search /></el-icon>查询</el-button>
      <el-button v-if="!compareMode" class="compare-button" @click="openCompareDialog">环比</el-button><template v-else><el-button class="compare-button" @click="openCompareDialog">调整环比</el-button><el-button class="compare-button exit" @click="exitCompareMode">退出环比</el-button></template>
      <div class="filter-summary"><span class="live-dot"></span>{{ rangeLabel }}</div>
    </section>

    <section class="metric-grid" :class="{ compact: analysisScope === 'total' }" v-loading="loading">
      <article class="metric-card primary"><div><span>营业额</span><small>营业收入 + 优惠金额</small></div><strong>{{ money(data.totals.gross_amount) }}</strong><div class="metric-foot">{{ scopeChip }} · {{ rangeLabel }}</div><aside v-if="compareMode" class="card-compare"><span>环比</span><b :class="compareValueClass(compareRates.gross_amount)">{{ comparePercent(compareRates.gross_amount) }}</b></aside></article>
      <article class="metric-card"><div><span>{{ incomeLabel }}</span><small>{{ incomeHint }}</small></div><strong>{{ money(scopeIncome) }}</strong><div class="metric-foot">实收占比 {{ percent(scopeIncomeRatio) }}</div><aside v-if="compareMode" class="card-compare"><span>环比</span><b :class="compareValueClass(compareRates.actual_amount)">{{ comparePercent(compareRates.actual_amount) }}</b></aside></article>
      <article class="metric-card"><div><span>订单量</span><small>渠道订单量汇总</small></div><strong>{{ numberText(data.totals.order_count) }}</strong><div class="metric-foot">当前筛选范围</div><aside v-if="compareMode" class="card-compare"><span>环比</span><b :class="compareValueClass(compareRates.order_count)">{{ comparePercent(compareRates.order_count) }}</b></aside></article>
      <article class="metric-card"><div><span>优惠金额</span><small>渠道优惠金额汇总</small></div><strong>{{ money(data.totals.discount_amount) }}</strong><div class="metric-foot">优惠金额占比 {{ percent(discountRatio) }}</div><aside v-if="compareMode" class="card-compare"><span>环比</span><b :class="compareValueClass(compareRates.discount_amount)">{{ comparePercent(compareRates.discount_amount) }}</b></aside></article>
      <template v-if="analysisScope !== 'total' && !compareMode"><article class="metric-card"><div><span>线上核对差额</span><small>收银记录 - 平台实收</small></div><strong>{{ signedMoney(data.totals.online_difference) }}</strong><div class="metric-foot">待平台账单核验</div></article><article class="metric-card warning"><div><span>平台费用合计</span><small>服务费、推广费、保险及退款</small></div><strong>{{ money(data.totals.fees) }}</strong><div class="metric-foot">按实际平台账单归集</div></article></template>
    </section>

    <section class="content-tabs"><button v-for="tab in tabs" :key="tab.value" :class="{ active: activeTab === tab.value }" @click="activeTab = tab.value">{{ tab.label }}<em v-if="tab.value === 'reconciliation'">{{ reconciliationCount }}</em></button></section>
    <template v-if="activeTab === 'overview'">
      <template v-if="analysisScope === 'total'">
        <section class="panel composition-panel"><header><div><h3>渠道营业构成</h3><p>{{ rangeLabel }} · 店内销售、自提销售及三方外卖渠道</p></div><span class="panel-badge">{{ channelTableRows.length }} 个渠道</span></header><div v-if="channelTableRows.length" class="composition-layout"><el-table :data="channelTableRows" class="composition-table" stripe><el-table-column prop="name" label="渠道字段" min-width="150" /><el-table-column label="营业额" min-width="135" align="right"><template #default="{ row }">{{ money(row.gross) }}</template></el-table-column><el-table-column v-if="compareMode" label="营业额环比" min-width="130" align="right"><template #default="{ row }"><span :class="compareValueClass(row.grossCompareRate)">{{ comparePercent(row.grossCompareRate) }}</span></template></el-table-column><el-table-column label="营业额占比" min-width="108" align="right"><template #default="{ row }">{{ percent(row.grossRatio) }}</template></el-table-column><el-table-column label="实收" min-width="135" align="right"><template #default="{ row }">{{ money(row.actual) }}</template></el-table-column><el-table-column v-if="compareMode" label="实收环比" min-width="130" align="right"><template #default="{ row }"><span :class="compareValueClass(row.actualCompareRate)">{{ comparePercent(row.actualCompareRate) }}</span></template></el-table-column><el-table-column label="实收占比" min-width="108" align="right"><template #default="{ row }">{{ percent(row.actualRatio) }}</template></el-table-column></el-table><aside class="ring-column"><div ref="channelCompositionChartRef" class="ring-chart"></div><span>按实收占比</span></aside></div><el-empty v-else :description="emptyDescription" /></section>
        <section class="panel composition-panel income-panel"><header><div><h3>营业收入构成</h3><p>{{ rangeLabel }} · 按经营日报“营业收入构成”上级字段汇总</p></div><span class="panel-badge">{{ incomeTableRows.length }} 项构成</span></header><div v-if="incomeTableRows.length" class="composition-layout"><el-table :data="incomeTableRows" class="composition-table" stripe><el-table-column prop="name" label="收入字段" min-width="200" /><el-table-column label="实收" min-width="155" align="right"><template #default="{ row }">{{ money(row.actual) }}</template></el-table-column><el-table-column v-if="compareMode" label="实收环比" min-width="135" align="right"><template #default="{ row }"><span :class="compareValueClass(row.actualCompareRate)">{{ comparePercent(row.actualCompareRate) }}</span></template></el-table-column><el-table-column label="实收占比" min-width="130" align="right"><template #default="{ row }">{{ percent(row.actualRatio) }}</template></el-table-column></el-table><aside class="ring-column"><div ref="compositionChartRef" class="ring-chart"></div><span>按实收占比</span></aside></div><el-empty v-else description="暂无营业收入构成数据" /></section>
        <section class="panel hourly-order-panel"><header><div><h3>时段订单走势图</h3><p>{{ rangeLabel }} · 从 00:00 至次日 00:00，每小时统计一次实际订单量</p></div><span class="panel-badge">24 个时段</span></header><div v-if="dishAnalytics.hourly_trend?.length" ref="hourlyOrderChartRef" class="hourly-order-chart"></div><el-empty v-else description="暂无带下单时间的菜品销售数据" /></section>
        <section class="panel dish-panel">
          <header><div><h3>菜品销售分析</h3><p>{{ rangeLabel }} · 按菜品汇总销量、销售额、收入、预估成本与净收入</p></div>
            <div class="panel-actions"><el-radio-group v-model="dishSort" size="small" @change="changeDishSort"><el-radio-button value="income">按收入</el-radio-button><el-radio-button value="quantity">按销量</el-radio-button><el-radio-button value="amount">按金额</el-radio-button></el-radio-group></div>
          </header>
          <div class="dish-metrics">
            <div><span>菜品数</span><strong>{{ dishAnalytics.summary.product_count ?? 0 }}</strong></div>
            <div><span>总销量</span><strong>{{ numberText(dishAnalytics.summary.quantity) }}</strong></div>
            <div><span>销售额</span><strong>{{ money(dishAnalytics.summary.amount_total) }}</strong></div>
            <div><span>菜品收入</span><strong>{{ money(dishAnalytics.summary.income_amount) }}</strong></div>
            <div><span>优惠金额</span><strong>{{ money(dishAnalytics.summary.discount_amount) }}</strong></div>
            <div><span>退款金额</span><strong class="dish-refund-text">{{ money(dishAnalytics.summary.refund_amount) }}</strong></div>
            <div><span>预估成本</span><strong class="dish-cost-text">{{ money(dishAnalytics.summary.estimated_cost) }}</strong><small>已绑定 {{ dishAnalytics.summary.cost_covered_product_count ?? 0 }}/{{ dishAnalytics.summary.product_count ?? 0 }} 款</small></div>
            <div><span>净收入</span><strong class="dish-income">{{ money(dishAnalytics.summary.net_income) }}</strong><small>收入 − 预估成本</small></div>
          </div>
          <el-table v-loading="dishLoading" :data="dishAnalytics.top" class="dish-table" stripe>
            <el-table-column type="index" label="排名" width="62" />
            <el-table-column prop="product_name" label="菜品" min-width="200" show-overflow-tooltip />
            <el-table-column label="规格" min-width="90"><template #default="{ row }">{{ row.spec && row.spec !== '--' ? row.spec : '—' }}</template></el-table-column>
            <el-table-column label="销量" width="84" align="right"><template #default="{ row }">{{ numberText(row.quantity) }}</template></el-table-column>
            <el-table-column label="销售额" width="108" align="right"><template #default="{ row }">{{ money(row.amount_total) }}</template></el-table-column>
            <el-table-column label="优惠" width="96" align="right"><template #default="{ row }">{{ money(row.discount_amount) }}</template></el-table-column>
            <el-table-column label="收入" width="106" align="right"><template #default="{ row }"><b class="dish-income">{{ money(row.income_amount) }}</b></template></el-table-column>
            <el-table-column label="预估成本" width="108" align="right"><template #default="{ row }"><span v-if="row.cost_available" class="dish-cost-text">{{ money(row.estimated_cost) }}</span><span v-else class="dish-cost-pending">未绑定</span></template></el-table-column>
            <el-table-column label="净收入" width="108" align="right"><template #default="{ row }"><b v-if="row.cost_available" class="dish-income">{{ money(row.net_income) }}</b><span v-else class="dish-cost-pending">—</span></template></el-table-column>
            <el-table-column label="退款金额" width="100" align="right"><template #default="{ row }"><span :class="Number(row.refund_amount) > 0 ? 'dish-refund-text' : ''">{{ money(row.refund_amount) }}</span></template></el-table-column>
            <el-table-column label="订单数" width="84" align="right"><template #default="{ row }">{{ numberText(row.order_count) }}</template></el-table-column>
            <el-table-column label="退款笔数" width="84" align="right"><template #default="{ row }">{{ row.refunded_count || 0 }}</template></el-table-column>
          </el-table>
          <el-empty v-if="!dishLoading && !dishAnalytics.top?.length" description="暂无菜品销售数据，请确认时间范围或先导入菜品销售明细" />
          <footer v-if="dishTotal > 0" class="dish-footer">
            <span>共 {{ dishTotal }} 个菜品 · 按{{ { income: '收入', quantity: '销量', amount: '金额' }[dishSort] }}排序</span>
            <el-pagination
              v-model:current-page="dishPage"
              v-model:page-size="dishPageSize"
              :page-sizes="[10, 20, 50]"
              :total="dishTotal"
              layout="total, sizes, prev, pager, next"
              background
              @current-change="loadDishAnalytics"
              @size-change="dishPage = 1; loadDishAnalytics()"
            />
          </footer>
        </section>
      </template>
      <template v-else>
        <section class="chart-grid"><article class="panel"><header><div><h3>{{ analysisScope === 'delivery' ? '营业额与实收趋势' : analysisMode === 'store' ? '门店实收走势图' : '实收趋势' }}</h3><p>{{ analysisScope === 'delivery' ? '莓红为营业额，明黄实收叠放于前，可直接查看实收占比' : `按${trendTimeModeLabel}口径聚合` }}</p></div><span class="panel-badge">{{ data.trend.length }} 个周期</span></header><div v-if="data.trend.length" ref="trendChartRef" class="chart"></div><el-empty v-else :description="emptyDescription" /></article><article class="panel"><header><div><h3>渠道营业构成</h3><p>{{ scopeChip }}渠道构成</p></div></header><div v-if="channelCompositionItems.length" ref="compositionChartRef" class="chart"></div><el-empty v-else description="暂无构成数据" /></article></section>
      </template>
      <section v-if="analysisMode === 'store' && analysisScope === 'total'" class="panel store-trend-panel"><header><div><h3>门店实收走势图</h3><p>按{{ trendTimeModeLabel }}口径聚合</p></div><span class="panel-badge">{{ data.trend.length }} 个周期</span></header><div v-if="data.trend.length" ref="trendChartRef" class="chart"></div><el-empty v-else :description="emptyDescription" /></section>
      <section v-else-if="analysisMode === 'custom'" class="panel custom-store-panel"><header><div><h3>自选门店经营结果</h3><p>已按实收从高到低展示全部选中门店</p></div><span class="panel-badge">{{ customStoreRows.length }} 家门店</span></header><el-table v-if="customStoreRows.length" :data="customStoreRows" stripe><el-table-column type="index" label="排名" width="76" /><el-table-column prop="store_name" label="门店" min-width="180" show-overflow-tooltip /><el-table-column label="营业额" min-width="150" align="right"><template #default="{ row }">{{ money(row.gross_amount) }}</template></el-table-column><el-table-column label="实收" min-width="150" align="right"><template #default="{ row }">{{ money(row.actual) }}</template></el-table-column><el-table-column label="订单量" min-width="120" align="right"><template #default="{ row }">{{ numberText(row.order_count) }}</template></el-table-column><el-table-column label="客单价" min-width="135" align="right"><template #default="{ row }">{{ money(row.average_order) }}</template></el-table-column></el-table><el-empty v-else description="暂无自选门店数据" /></section>
      <section v-else-if="analysisMode !== 'store'" class="panel store-ranking"><header><div><h3>{{ compareMode ? '门店实收排名（含环比）' : rankingTitle }}</h3><p>{{ compareMode ? '按当前实收排序，右侧新增实收环比值' : '按确认实收分为前三、中三、后三；点击门店查看明细' }}</p></div></header><div v-if="rankingBands.length" class="ranking-bands"><section v-for="band in rankingBands" :key="band.key" class="ranking-band" :class="band.key"><h4>{{ band.label }}</h4><button v-for="store in band.rows" :key="store.store_id" type="button" class="ranking-row" @click="openStoreDetail(store)"><span class="rank" :class="band.key">{{ store.rank }}</span><div><b>{{ store.store_name }}</b><small>{{ compareMode ? '当前实收 · 右侧为环比' : `${store.verified_channels} 个线上渠道已验证` }}</small></div><strong>{{ money(store.actual) }}</strong><em v-if="compareMode" :class="compareValueClass(store.actualCompareRate)">{{ comparePercent(store.actualCompareRate) }}</em></button></section></div><el-empty v-else description="暂无门店数据" /></section>
    </template>
    <section v-else-if="activeTab === 'products'" class="panel delivery-product-panel"><header><div><h3>美团外卖菜品销量</h3><p>{{ rangeLabel }} · 仅统计已按美团外卖门店 ID 精确关联的商品销量</p></div><span class="panel-badge">{{ productAnalytics.totals.total_products || 0 }} 款菜品</span></header><div v-loading="productLoading"><div class="product-summary-grid"><article><span>菜品款数</span><strong>{{ productAnalytics.totals.total_products || 0 }}</strong><small>去重后的平台商品</small></article><article><span>商品销量</span><strong>{{ numberText(productAnalytics.totals.quantity) }}</strong><small>已关联门店的销量</small></article><article><span>商品销售额</span><strong>{{ money(productAnalytics.totals.sales_amount) }}</strong><small>按美团商品报表口径</small></article><article><span>已绑定本地 SKU</span><strong>{{ productAnalytics.totals.mapped || 0 }}</strong><small>可继续核算成本与毛利</small></article></div><el-table v-if="productPageRows.length" :data="productPageRows" class="delivery-product-table" stripe><el-table-column type="index" :index="productIndex" label="排名" width="72" /><el-table-column prop="product_name" label="美团商品" min-width="220" show-overflow-tooltip /><el-table-column label="销量" width="110" align="right"><template #default="{ row }">{{ numberText(row.quantity) }}</template></el-table-column><el-table-column label="销售额" width="140" align="right"><template #default="{ row }">{{ money(row.sales_amount) }}</template></el-table-column><el-table-column label="本地菜品 SKU" min-width="250"><template #default="{ row }"><span v-if="row.mapped" class="mapped-sku">{{ row.menu_sku_label || row.menu_name }}</span><span v-else class="unmapped-sku">未绑定</span></template></el-table-column><el-table-column label="预估成本" width="140" align="right"><template #default="{ row }"><span v-if="row.mapped">{{ money(row.total_cost) }}</span><span v-else>—</span></template></el-table-column><el-table-column label="预估毛利" width="140" align="right"><template #default="{ row }"><span v-if="row.mapped" :class="Number(row.gross_profit) >= 0 ? 'profit-positive' : 'profit-negative'">{{ signedMoney(row.gross_profit) }}</span><span v-else>—</span></template></el-table-column></el-table><el-empty v-else-if="!productLoading" description="暂无美团外卖菜品销量，请先在数据导入中上传“全部门店商品销量”报表" /><footer v-if="productAnalytics.products.length" class="product-pagination"><span>按商品销售额从高到低排序</span><el-pagination v-model:current-page="productPage" v-model:page-size="productPageSize" :page-sizes="[20, 50, 100]" :total="productAnalytics.products.length" layout="total, sizes, prev, pager, next" background @size-change="productPage = 1" /></footer></div></section>
    <section v-else class="panel reconciliation-panel"><header><div><h3>收银系统与平台双向验证</h3><p>差额 = 收银系统记录 - 平台实际结算；尚未导入平台账单的渠道显示为“待验证”</p></div><div class="recon-channel-switch"><el-segmented v-model="reconciliationChannel" :options="reconChannelOptions" @change="switchReconChannel" /></div><el-tag type="warning" effect="light">共 {{ data.reconciliation_total || 0 }} 条核对记录</el-tag></header><el-table :data="data.reconciliation" stripe><el-table-column prop="biz_date" label="日期" width="110" /><el-table-column prop="store_name" label="门店" min-width="170" show-overflow-tooltip /><el-table-column prop="channel_label" label="线上渠道" width="120" /><el-table-column label="收银记录" width="130" align="right"><template #default="{ row }">{{ money(row.recorded) }}</template></el-table-column><el-table-column label="平台实收" width="130" align="right"><template #default="{ row }"><span v-if="row.has_platform">{{ money(row.actual) }}</span><el-tag v-else size="small" type="info">待验证</el-tag></template></el-table-column><el-table-column label="平台费用" width="120" align="right"><template #default="{ row }">{{ money(row.fees) }}</template></el-table-column><el-table-column label="差额" width="120" align="right"><template #default="{ row }"><span v-if="row.difference != null" :class="differenceClass(row.difference)">{{ signedMoney(row.difference) }}</span><span v-else>—</span></template></el-table-column></el-table><div v-if="data.reconciliation_total" class="reconciliation-pagination"><span>共 {{ data.reconciliation_total }} 条核对记录 · 每页 {{ reconciliationPageSize }} 条 · 第 {{ reconciliationPage }} 页</span><el-pagination v-model:current-page="reconciliationPage" :page-size="reconciliationPageSize" :total="data.reconciliation_total" layout="prev, pager, next" @current-change="handleReconciliationPage" /></div></section>

    <el-dialog v-model="storeDetailVisible" :title="selectedStore ? `${selectedStore.store_name} · 门店经营数据` : '门店经营数据'" width="900px" class="store-detail-dialog" destroy-on-close>
      <p class="detail-period">统计范围：{{ detailRangeLabel }}</p>
      <div v-loading="storeDetailLoading" class="store-detail-content">
        <section class="detail-metric-grid"><article><span>营业额</span><strong>{{ money(storeDetail.totals.gross_amount) }}</strong></article><article><span>营业收入（实收）</span><strong>{{ money(storeDetail.totals.confirmed) }}</strong><small>实收占比 {{ percent(detailActualRatio) }}</small></article><article><span>订单量</span><strong>{{ numberText(storeDetail.totals.order_count) }}</strong></article><article><span>优惠金额</span><strong>{{ money(storeDetail.totals.discount_amount) }}</strong><small>优惠金额占比 {{ percent(detailDiscountRatio) }}</small></article></section>
        <section class="detail-table-grid"><article><h4>渠道营业构成</h4><el-table :data="detailChannelRows" size="small" stripe><el-table-column prop="name" label="渠道" min-width="100" /><el-table-column label="营业额" min-width="100" align="right"><template #default="{ row }">{{ money(row.gross) }}</template></el-table-column><el-table-column label="实收" min-width="100" align="right"><template #default="{ row }">{{ money(row.actual) }}</template></el-table-column><el-table-column label="实收占比" min-width="88" align="right"><template #default="{ row }">{{ percent(row.actualRatio) }}</template></el-table-column></el-table></article><article><h4>营业收入构成</h4><el-table :data="detailIncomeRows" size="small" stripe><el-table-column prop="name" label="收入字段" min-width="135" /><el-table-column label="实收" min-width="120" align="right"><template #default="{ row }">{{ money(row.actual) }}</template></el-table-column><el-table-column label="实收占比" min-width="98" align="right"><template #default="{ row }">{{ percent(row.actualRatio) }}</template></el-table-column></el-table></article></section>
      </div>
    </el-dialog>

    <el-dialog v-model="compareDialogVisible" title="设置环比时间" width="620px" class="compare-dialog" destroy-on-close @closed="handleCompareDialogClosed">
      <div class="compare-form"><div><h4>当前时间</h4><p>{{ compareCurrentLocked ? '当前页面已有查询结果，当前时间已锁定。' : '当前页面尚未查询，可在此编辑当前时间。' }}</p><el-date-picker v-if="filters.timeMode === 'day'" v-model="compareCurrentSelection" :clearable="false" type="date" value-format="YYYY-MM-DD" :disabled="compareCurrentLocked" @change="updateCompareCurrent" /><el-date-picker v-else-if="filters.timeMode === 'week'" v-model="compareCurrentSelection" :clearable="false" type="week" value-format="YYYY-MM-DD" format="YYYY 第 ww 周" :disabled="compareCurrentLocked" @change="updateCompareCurrent" /><el-date-picker v-else-if="filters.timeMode === 'month'" v-model="compareCurrentSelection" :clearable="false" type="month" value-format="YYYY-MM" :disabled="compareCurrentLocked" @change="updateCompareCurrent" /><el-date-picker v-else v-model="compareCurrentSelection" :clearable="false" class="compact-range-picker" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" :disabled="compareCurrentLocked" @change="updateCompareCurrent" /></div><div><h4>环比时间</h4><p>{{ compareTimeHint }}</p><el-date-picker v-if="filters.timeMode === 'day'" v-model="comparePreviousSelection" :clearable="false" type="date" value-format="YYYY-MM-DD" @change="updateComparePrevious" /><el-date-picker v-else-if="filters.timeMode === 'week'" v-model="comparePreviousSelection" :clearable="false" type="week" value-format="YYYY-MM-DD" format="YYYY 第 ww 周" @change="updateComparePrevious" /><el-date-picker v-else-if="filters.timeMode === 'month'" v-model="comparePreviousSelection" :clearable="false" type="month" value-format="YYYY-MM" @change="updateComparePrevious" /><el-date-picker v-else v-model="comparePreviousSelection" :clearable="false" class="compact-range-picker" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" @change="updateComparePrevious" /></div></div><template #footer><el-button @click="compareDialogVisible = false">取消</el-button><el-button type="primary" :disabled="!compareRangesReady" @click="applyCompareMode">查询环比</el-button></template>
    </el-dialog>

    <el-dialog v-model="diagnosisVisible" :title="diagnosis?.headline || 'AI 经营诊断'" width="760px" class="diagnosis-dialog" destroy-on-close>
      <div v-if="diagnosis" class="diagnosis-content"><div class="diagnosis-meta"><el-tag type="info" effect="light">模拟 AI · 测试阶段</el-tag><span>诊断范围：{{ rangeLabel }}</span><span>更新于：{{ diagnosis.updated_at || diagnosis.generated_at }}</span></div><p class="diagnosis-summary">{{ diagnosis.summary }}</p><section class="diagnosis-metrics"><div><span>营业额</span><b>{{ money(diagnosis.metrics?.gross_amount) }}</b></div><div><span>实收</span><b>{{ money(diagnosis.metrics?.actual_amount) }}</b></div><div><span>订单量</span><b>{{ numberText(diagnosis.metrics?.order_count) }}</b></div><div><span>优惠占比</span><b>{{ percent(diagnosis.metrics?.discount_rate) }}</b></div></section><section class="diagnosis-section"><h4>经营发现</h4><article v-for="item in diagnosis.findings" :key="item.title" :class="item.level"><b>{{ item.title }}</b><p>{{ item.detail }}</p></article></section><section class="diagnosis-section"><h4>改进建议</h4><ol><li v-for="item in diagnosis.recommendations" :key="item">{{ item }}</li></ol></section></div><el-empty v-else description="暂无已保存的诊断结果" />
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import * as echarts from 'echarts'
import { Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { generateBusinessDiagnosis, getBusinessAnalytics, getBusinessDiagnosis, getBusinessProductAnalytics, getDishSalesAnalytics, getStores } from '@/api'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'

const route = useRoute()
const pageMeta = Object.freeze({ ...route.meta, routePath: route.path })
const timeModes = [{ label: '日数据', value: 'day' }, { label: '周数据', value: 'week' }, { label: '月数据', value: 'month' }, { label: '自定义时间', value: 'custom' }]
const baseTabs = [{ label: '经营总览', value: 'overview' }, { label: '双向核对', value: 'reconciliation' }]
const groupPlatforms = ['美团团购', '抖音团购', '免费试']
const deliveryPlatforms = ['美团外卖', '淘宝闪购', '京东外卖']
const activeTab = ref('overview'), loading = ref(false), storeOptions = ref([]), trendChartRef = ref(), compositionChartRef = ref(), channelCompositionChartRef = ref(), hourlyOrderChartRef = ref()
const storeDetailVisible = ref(false), storeDetailLoading = ref(false), selectedStore = ref(null), detailRangeLabel = ref('')
const compareMode = ref(false), compareDialogVisible = ref(false), compareCurrentLocked = ref(false), compareCurrentRange = ref([]), comparePreviousRange = ref([]), compareCurrentSelection = ref(null), comparePreviousSelection = ref(null), hasQueried = ref(false)
const reconciliationPage = ref(1), reconciliationPageSize = ref(20)
// 双向验证面板的平台筛选：全部 + 五个线上平台（免费试并入美团团购）
const reconChannelOptions = [
  { label: '全部', value: '' },
  { label: '美团外卖', value: 'meituan_delivery' },
  { label: '淘宝闪购', value: 'taobao_flash' },
  { label: '京东外卖', value: 'jd_delivery' },
  { label: '美团团购', value: 'meituan_group,free_trial' },
  { label: '抖音团购', value: 'douyin_group' },
]
const reconciliationChannel = ref('')
function switchReconChannel() { reconciliationPage.value = 1; loadData() }
const diagnosisVisible = ref(false), diagnosisLoading = ref(false), diagnosisAvailable = ref(false), diagnosis = ref(null), diagnosisSignatureAtQuery = ref('')
let trendChart, compositionChart, channelCompositionChart, hourlyOrderChart, chartFrame
function toDateText(value) { return value.toISOString().slice(0, 10) }
function yesterday() { const date = new Date(); date.setDate(date.getDate() - 1); return toDateText(date) }
function thisWeek() { const date = new Date(); const weekday = date.getDay() || 7; const start = new Date(date); start.setDate(date.getDate() - weekday + 1); const end = new Date(start); end.setDate(start.getDate() + 6); return [toDateText(start), toDateText(end)] }
function fullWeekRange(value) { if (!value) return []; const date = value instanceof Date ? new Date(value) : new Date(`${String(value).slice(0, 10)}T12:00:00`); if (Number.isNaN(date.getTime())) return []; const weekday = date.getDay() || 7; date.setDate(date.getDate() - weekday + 1); const start = toDateText(date); const end = new Date(date); end.setDate(end.getDate() + 6); return [start, toDateText(end)] }
function thisMonth() { return toDateText(new Date()).slice(0, 7) }
function monthRange(month) { const [year, value] = String(month || '').split('-').map(Number); if (!year || !value) return []; const text = `${year}-${String(value).padStart(2, '0')}`; return [`${text}-01`, `${text}-${new Date(year, value, 0).getDate()}`] }
const filters = reactive({ timeMode: 'day', day: yesterday(), week: thisWeek()[0], month: thisMonth(), customRange: [], storeId: null, storeIds: [], deliveryStoreIds: [], platform: '' })
const data = reactive({ totals: {}, trend: [], reconciliation: [], reconciliation_total: 0, reconciliation_page: 1, reconciliation_page_size: 20, stores: [], revenue_composition: [], channel_breakdown: [] })
const dishAnalytics = reactive({ summary: {}, top: [], hourly_trend: [] })
const dishLoading = ref(false)
const dishSort = ref('income')
const dishPage = ref(1)
const dishPageSize = ref(20)
const dishTotal = ref(0)
const productAnalytics = reactive({ products: [], totals: {} })
const productLoading = ref(false)
const productPage = ref(1)
const productPageSize = ref(20)
const compareData = reactive({ totals: {}, stores: [], revenue_composition: [], channel_breakdown: [] })
const storeDetail = reactive({ totals: {}, revenue_composition: [], channel_breakdown: [] })
const analysisScope = computed(() => pageMeta.analysisScope || 'total')
const analysisMode = computed(() => pageMeta.analysisMode || 'brand')
const routePlatform = computed(() => pageMeta.analysisPlatform || '')
const scopeChannelGroup = computed(() => ({ 'group-buy': 'group_buy', delivery: 'delivery' }[analysisScope.value] || ''))
const scopedPlatforms = computed(() => analysisScope.value === 'group-buy' ? groupPlatforms : analysisScope.value === 'delivery' ? deliveryPlatforms : [])
const effectivePlatform = computed(() => routePlatform.value || filters.platform)
const requiresPlatformRecord = computed(() => analysisScope.value === 'delivery' && routePlatform.value === '美团外卖')
const hasMeituanProductBoard = computed(() => requiresPlatformRecord.value)
const tabs = computed(() => hasMeituanProductBoard.value ? [baseTabs[0], { label: '菜品销量', value: 'products' }, baseTabs[1]] : baseTabs)
const showPlatformSelect = computed(() => analysisMode.value === 'store' && scopedPlatforms.value.length > 0)
const viewConfig = computed(() => ({ title: pageMeta.analysisTitle || '总数据视角', description: requiresPlatformRecord.value ? '只统计已通过“第三方平台 → 美团外卖门店 ID”精确关联的美团结算数据；未登记 ID 的原始记录会保留但不计入分析。' : analysisScope.value === 'total' ? '从日、周、月和自定义时间四种口径，查看品牌、单店或自选门店的经营汇总。' : `${analysisScope.value === 'group-buy' ? '团购' : '外卖'}数据支持平台、品牌与门店统计；门店可切换平台分别查看或平台汇总。` }))
const scopeChip = computed(() => routePlatform.value || (analysisScope.value === 'total' ? '总数据汇总' : analysisScope.value === 'group-buy' ? (filters.platform || '团购平台汇总') : (filters.platform || '外卖平台汇总')))
const timeModeLabel = computed(() => timeModes.find(item => item.value === filters.timeMode)?.label || '日数据')
const trendTimeModeLabel = computed(() => analysisMode.value === 'store' ? '日' : timeModeLabel.value)
const activeRange = computed(() => filters.timeMode === 'day' ? [filters.day, filters.day] : filters.timeMode === 'week' ? fullWeekRange(filters.week) : filters.timeMode === 'month' ? monthRange(filters.month) : filters.customRange)
const reportRange = computed(() => compareMode.value ? compareCurrentRange.value : activeRange.value)
const rangeLabel = computed(() => reportRange.value?.length === 2 && reportRange.value[0] ? `${reportRange.value[0]} 至 ${reportRange.value[1]}` : '请选择时间范围')
const compareThemeActive = computed(() => compareMode.value || compareDialogVisible.value)
const compareTimeHint = computed(() => ({ day: '按单天与单天进行环比。', week: '按完整周一至周日与另一完整周进行环比。', month: '按整月与另一整月进行环比。', custom: '环比时间段始终可编辑。' }[filters.timeMode] || '环比时间始终可编辑。'))
const aggregationPeriod = computed(() => filters.timeMode === 'week' ? 'week' : filters.timeMode === 'month' ? 'month' : 'day')
const scopeIncome = computed(() => analysisScope.value === 'group-buy' ? data.totals.group_buy || 0 : analysisScope.value === 'delivery' ? data.totals.delivery || 0 : data.totals.confirmed || 0)
const previousScopeIncome = computed(() => analysisScope.value === 'group-buy' ? compareData.totals.group_buy || 0 : analysisScope.value === 'delivery' ? compareData.totals.delivery || 0 : compareData.totals.confirmed || 0)
const compareRates = computed(() => ({ gross_amount: compareRate(data.totals.gross_amount, compareData.totals.gross_amount), actual_amount: compareRate(scopeIncome.value, previousScopeIncome.value), order_count: compareRate(data.totals.order_count, compareData.totals.order_count), discount_amount: compareRate(data.totals.discount_amount, compareData.totals.discount_amount) }))
const compareRangeHint = computed(() => `当前 ${rangeLabel.value} 对比 ${comparePreviousRange.value?.[0] || '—'} 至 ${comparePreviousRange.value?.[1] || '—'}`)
const scopeIncomeRatio = computed(() => data.totals.gross_amount ? Number(scopeIncome.value) / Number(data.totals.gross_amount) : 0)
const discountRatio = computed(() => data.totals.gross_amount ? Number(data.totals.discount_amount || 0) / Number(data.totals.gross_amount) : 0)
const incomeLabel = computed(() => analysisScope.value === 'total' ? '营业收入（实收）' : `${scopeChip.value}实收`)
const incomeHint = computed(() => effectivePlatform.value ? '已固定至所选平台' : analysisScope.value === 'total' ? '全部门店与渠道' : '当前渠道汇总')
const rankingTitle = computed(() => '门店实收排名')
const emptyDescription = computed(() => filters.timeMode === 'custom' && activeRange.value?.length !== 2 ? '请先选择自定义时间范围' : '暂无统计数据，请先在左侧“数据导入”录入数据')
const reconciliationCount = computed(() => data.reconciliation.filter(row => row.difference != null && Math.abs(row.difference) > 0.01).length)
const chartSeries = computed(() => analysisScope.value === 'total' ? [{ key: 'offline', name: '线下堂食', color: '#3b82f6' }, { key: 'group_buy', name: '团购', color: '#8b5cf6' }, { key: 'delivery', name: '外卖', color: '#14b8a6' }] : [{ key: analysisScope.value === 'group-buy' ? 'group_buy' : 'delivery', name: scopeChip.value, color: analysisScope.value === 'group-buy' ? '#8b5cf6' : '#14b8a6' }])
const incomeCompositionItems = computed(() => data.revenue_composition.map(item => ({ name: item.category, value: Number(item.amount || 0) })).filter(item => item.value))
const channelCompositionItems = computed(() => data.channel_breakdown.map(item => ({ name: item.label, value: Number(item.amount || 0) })).filter(item => item.value))
const channelTableRows = computed(() => { const previous = new Map((compareData.channel_breakdown || []).map(item => [item.channel, item])); return data.channel_breakdown.map(item => ({ name: item.label, gross: Number(item.gross_amount || 0), actual: Number(item.amount || 0), grossCompareRate: compareRate(item.gross_amount, previous.get(item.channel)?.gross_amount), actualCompareRate: compareRate(item.amount, previous.get(item.channel)?.amount), grossRatio: data.totals.gross_amount ? Number(item.gross_amount || 0) / Number(data.totals.gross_amount) : 0, actualRatio: scopeIncome.value ? Number(item.amount || 0) / Number(scopeIncome.value) : 0 })).filter(item => item.gross || item.actual) })
const incomeTableRows = computed(() => { const previous = new Map((compareData.revenue_composition || []).map(item => [item.category, item])); return data.revenue_composition.map(item => ({ name: item.category, actual: Number(item.amount || 0), actualCompareRate: compareRate(item.amount, previous.get(item.category)?.amount), actualRatio: scopeIncome.value ? Number(item.amount || 0) / Number(scopeIncome.value) : 0 })).filter(item => item.actual) })
const detailActualRatio = computed(() => storeDetail.totals.gross_amount ? Number(storeDetail.totals.confirmed || 0) / Number(storeDetail.totals.gross_amount) : 0)
const detailDiscountRatio = computed(() => storeDetail.totals.gross_amount ? Number(storeDetail.totals.discount_amount || 0) / Number(storeDetail.totals.gross_amount) : 0)
const detailChannelRows = computed(() => storeDetail.channel_breakdown.map(item => ({ name: item.label, gross: Number(item.gross_amount || 0), actual: Number(item.amount || 0), actualRatio: storeDetail.totals.confirmed ? Number(item.amount || 0) / Number(storeDetail.totals.confirmed) : 0 })).filter(item => item.gross || item.actual))
const detailIncomeRows = computed(() => storeDetail.revenue_composition.map(item => ({ name: item.category, actual: Number(item.amount || 0), actualRatio: storeDetail.totals.confirmed ? Number(item.amount || 0) / Number(storeDetail.totals.confirmed) : 0 })).filter(item => item.actual))
const rankingStores = computed(() => {
  if (!compareMode.value) return data.stores || []
  const previous = new Map((compareData.stores || []).map(store => [store.store_id, store]))
  return (data.stores || []).map(store => ({ ...store, actual: Number(store.actual || 0), actualCompareRate: compareRate(store.actual, previous.get(store.store_id)?.actual) })).sort((a, b) => b.actual - a.actual)
})
const customStoreRows = computed(() => (data.stores || []).map(store => {
  const actual = Number(store.actual || 0)
  const orderCount = Number(store.order_count || 0)
  return { ...store, gross_amount: Number(store.gross_amount || 0), actual, order_count: orderCount, average_order: orderCount ? actual / orderCount : 0 }
}).sort((a, b) => b.actual - a.actual))
const productPageRows = computed(() => productAnalytics.products.slice((productPage.value - 1) * productPageSize.value, productPage.value * productPageSize.value))
const rankingBands = computed(() => {
  const stores = rankingStores.value
  if (!stores.length) return []
  const rows = stores.map((store, index) => ({ ...store, rank: index + 1 }))
  if (rows.length <= 3) return [{ key: 'top', label: '前三', rows }]
  const top = rows.slice(0, 3)
  const bottom = rows.slice(-3)
  const middleStart = Math.max(3, Math.floor((rows.length - 3) / 2))
  const middle = rows.slice(middleStart, Math.min(middleStart + 3, rows.length - 3))
  return [{ key: 'top', label: '前三', rows: top }, ...(middle.length ? [{ key: 'middle', label: '中三', rows: middle }] : []), { key: 'bottom', label: '后三', rows: bottom }]
})
const canQuery = computed(() => !(filters.timeMode === 'custom' && activeRange.value?.length !== 2) && !(analysisMode.value === 'custom' && !filters.storeIds.length))
const compareRangesReady = computed(() => compareCurrentRange.value?.length === 2 && compareCurrentRange.value[0] && compareCurrentRange.value[1] && comparePreviousRange.value?.length === 2 && comparePreviousRange.value[0] && comparePreviousRange.value[1])
const diagnosisParams = computed(() => {
  const range = reportRange.value
  return { period: aggregationPeriod.value, ...currentStoreScope(), channel_group: scopeChannelGroup.value || undefined, platform: effectivePlatform.value || undefined, require_platform_record: requiresPlatformRecord.value ? '1' : undefined, date_from: range?.[0] || '', date_to: range?.[1] || '' }
})
const diagnosisSignature = computed(() => JSON.stringify({ perspective_key: pageMeta.analysisKey || pageMeta.routePath, ...diagnosisParams.value }))
const canDiagnose = computed(() => hasQueried.value && diagnosisSignatureAtQuery.value === diagnosisSignature.value)
const hasCurrentDiagnosis = computed(() => diagnosisAvailable.value && canDiagnose.value)
function money(value) { return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function numberText(value) { return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }
function signedMoney(value) { const number = Number(value || 0); return `${number > 0 ? '+' : number < 0 ? '-' : ''}${money(Math.abs(number))}` }
function signedNumber(value) { const number = Number(value || 0); return `${number > 0 ? '+' : number < 0 ? '-' : ''}${Math.abs(number).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}` }
function percent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%` }
function compareRate(current, previous) { const now = Number(current || 0); const before = Number(previous || 0); if (!before) return now ? null : 0; return (now - before) / before }
function comparePercent(value) { if (value == null || !Number.isFinite(value)) return '—'; return `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%` }
function ratio(value, total) { return total ? `${(Number(value || 0) / total * 100).toFixed(1)}%` : '0.0%' }
function differenceClass(value) { return Math.abs(value) <= 0.01 ? 'difference-ok' : 'difference-warn' }
function compareValueClass(value) { if (!compareMode.value || value == null) return 'compare-flat'; return value > 0 ? 'compare-up' : value < 0 ? 'compare-down' : 'compare-flat' }
function changeTimeMode(mode) { filters.timeMode = mode }
function currentStoreScope() {
  if (analysisScope.value === 'delivery') {
    return { store_id: undefined, store_ids: filters.deliveryStoreIds.join(',') || undefined }
  }
  return { store_id: analysisMode.value === 'store' ? filters.storeId || undefined : undefined, store_ids: analysisMode.value === 'custom' ? filters.storeIds.join(',') || undefined : undefined }
}
function clearData() { Object.assign(data, { totals: {}, trend: [], reconciliation: [], reconciliation_total: 0, reconciliation_page: 1, reconciliation_page_size: reconciliationPageSize.value, stores: [], revenue_composition: [], channel_breakdown: [] }); Object.assign(dishAnalytics, { summary: {}, top: [], hourly_trend: [] }); Object.assign(productAnalytics, { products: [], totals: {} }); dishTotal.value = 0; dishPage.value = 1; productPage.value = 1; diagnosisVisible.value = false; diagnosisAvailable.value = false; diagnosis.value = null; diagnosisSignatureAtQuery.value = '' }
function resetScopeFilters() { filters.storeId = analysisMode.value === 'store' ? storeOptions.value[0]?.id || null : null; filters.storeIds = []; filters.deliveryStoreIds = []; filters.platform = '' }
function selectionToRange(value) { if (!value) return []; if (filters.timeMode === 'day') return [value, value]; if (filters.timeMode === 'week') return fullWeekRange(value); if (filters.timeMode === 'month') return monthRange(value); return Array.isArray(value) ? value : [] }
function rangeToSelection(range) { if (!range?.length) return null; if (filters.timeMode === 'day' || filters.timeMode === 'week') return range[0]; if (filters.timeMode === 'month') return String(range[0]).slice(0, 7); return [...range] }
function previousRange(range) { const start = new Date(`${range[0]}T12:00:00`); const end = new Date(`${range[1]}T12:00:00`); const days = Math.round((end - start) / 86400000) + 1; const previousEnd = new Date(start); previousEnd.setDate(previousEnd.getDate() - 1); const previousStart = new Date(previousEnd); previousStart.setDate(previousStart.getDate() - days + 1); return [toDateText(previousStart), toDateText(previousEnd)] }
function analyticsParams(range, storeId) { return { period: aggregationPeriod.value, trend_period: analysisScope.value === 'delivery' || analysisMode.value === 'store' ? 'day' : undefined, ...(storeId ? { store_id: storeId, store_ids: undefined } : currentStoreScope()), channel_group: scopeChannelGroup.value || undefined, platform: effectivePlatform.value || undefined, require_platform_record: requiresPlatformRecord.value ? '1' : undefined, reconciliation_channel: reconciliationChannel.value || undefined, reconciliation_page: reconciliationPage.value, reconciliation_page_size: reconciliationPageSize.value, date_from: range?.[0], date_to: range?.[1] } }
function updateCompareCurrent(value) { compareCurrentRange.value = selectionToRange(value) }
function updateComparePrevious(value) { comparePreviousRange.value = selectionToRange(value) }
function syncCurrentRangeToFilters(range) { if (filters.timeMode === 'day') filters.day = range[0]; else if (filters.timeMode === 'week') filters.week = range[0]; else if (filters.timeMode === 'month') filters.month = String(range[0]).slice(0, 7); else filters.customRange = [...range] }
function openCompareDialog() { const current = (compareMode.value ? reportRange.value : activeRange.value)?.length === 2 ? [...(compareMode.value ? reportRange.value : activeRange.value)] : []; compareCurrentLocked.value = hasQueried.value; compareCurrentRange.value = current; if (!compareMode.value || !comparePreviousRange.value?.length) comparePreviousRange.value = current.length ? previousRange(current) : []; compareCurrentSelection.value = rangeToSelection(compareCurrentRange.value); comparePreviousSelection.value = rangeToSelection(comparePreviousRange.value); compareDialogVisible.value = true }
async function applyCompareMode() { if (!compareRangesReady.value) return; if (!compareCurrentLocked.value) syncCurrentRangeToFilters(compareCurrentRange.value); reconciliationPage.value = 1; compareMode.value = true; compareDialogVisible.value = false; await loadData() }
function exitCompareMode() { compareMode.value = false; Object.assign(compareData, { totals: {}, stores: [], revenue_composition: [], channel_breakdown: [] }) }
function handleCompareDialogClosed() { if (!compareMode.value) compareDialogVisible.value = false }
function queryData() { reconciliationPage.value = 1; return loadData() }
async function handleReconciliationPage(page) { reconciliationPage.value = page; await loadData() }
async function refreshDiagnosis() {
  if (!hasQueried.value) return
  const signature = diagnosisSignature.value
  try {
    const result = await getBusinessDiagnosis({ perspective_key: pageMeta.analysisKey || pageMeta.routePath, filter_signature: signature })
    diagnosis.value = result.diagnosis || null
    diagnosisAvailable.value = Boolean(result.diagnosis)
  } catch (error) {
    diagnosis.value = null
    diagnosisAvailable.value = false
  }
}
async function runDiagnosis() {
  if (!canDiagnose.value) return ElMessage.warning('请先按当前条件点击查询，再使用 AI 诊断')
  const isUpdating = hasCurrentDiagnosis.value
  diagnosisLoading.value = true
  try {
    const result = await generateBusinessDiagnosis({ perspective_key: pageMeta.analysisKey || pageMeta.routePath, filter_signature: diagnosisSignature.value, perspective_title: viewConfig.value.title, analysis_params: diagnosisParams.value })
    diagnosis.value = result.diagnosis || null
    diagnosisAvailable.value = Boolean(diagnosis.value)
    diagnosisVisible.value = Boolean(diagnosis.value)
    ElMessage.success(isUpdating ? '诊断结果已更新' : '诊断结果已生成')
  } catch (error) { ElMessage.error(error.message || '诊断生成失败') } finally { diagnosisLoading.value = false }
}
async function loadData() { const range = reportRange.value; if ((!compareMode.value && filters.timeMode === 'custom' && range?.length !== 2) || (analysisMode.value === 'custom' && !filters.storeIds.length) || (compareMode.value && !compareRangesReady.value)) { clearData(); return } loading.value = true; try { if (compareMode.value) { const [result, previous] = await Promise.all([getBusinessAnalytics('overview', analyticsParams(range)), getBusinessAnalytics('overview', analyticsParams(comparePreviousRange.value))]); Object.assign(data, result); Object.assign(compareData, previous) } else { const result = await getBusinessAnalytics('overview', analyticsParams(range)); Object.assign(data, result); Object.assign(compareData, { totals: {}, stores: [], revenue_composition: [], channel_breakdown: [] }) } reconciliationPage.value = Number(data.reconciliation_page) || reconciliationPage.value; hasQueried.value = true; diagnosisSignatureAtQuery.value = diagnosisSignature.value; if (analysisScope.value === 'total') await loadDishAnalytics(); if (hasMeituanProductBoard.value) await loadDeliveryProductAnalytics(); await refreshDiagnosis(); await nextTick(); queueChartRender() } catch (error) { ElMessage.error(error.message) } finally { loading.value = false } }
async function loadDeliveryProductAnalytics() {
  const range = reportRange.value
  if (!hasMeituanProductBoard.value || range?.length !== 2 || !range[0] || !range[1]) {
    Object.assign(productAnalytics, { products: [], totals: {} })
    return
  }
  productLoading.value = true
  try {
    const result = await getBusinessProductAnalytics('delivery', { ...currentStoreScope(), channel_group: 'delivery', platform: '美团外卖', date_from: range[0], date_to: range[1] })
    Object.assign(productAnalytics, { products: result.products || [], totals: result.totals || {} })
    if ((productPage.value - 1) * productPageSize.value >= productAnalytics.products.length) productPage.value = 1
  } catch (error) {
    Object.assign(productAnalytics, { products: [], totals: {} })
    ElMessage.error(error.message || '加载美团菜品销量失败')
  } finally { productLoading.value = false }
}
function productIndex(index) { return (productPage.value - 1) * productPageSize.value + index + 1 }
async function loadDishAnalytics() {
  const range = reportRange.value
  if (analysisScope.value !== 'total' || range?.length !== 2 || !range[0] || !range[1]) {
    Object.assign(dishAnalytics, { summary: {}, top: [], hourly_trend: [] })
    dishTotal.value = 0
    return
  }
  dishLoading.value = true
  try {
    const params = {
      date_from: range[0],
      date_to: range[1],
      sort: dishSort.value,
      page: dishPage.value,
      page_size: dishPageSize.value,
    }
    // 跟随视角与门店筛选：全门店汇总不带门店；单店数据带 store_id；自选门店汇总带 store_ids
    if (analysisMode.value === 'store' && filters.storeId) params.store_id = filters.storeId
    if (analysisMode.value === 'custom' && filters.storeIds.length) params.store_ids = filters.storeIds.join(',')
    const result = await getDishSalesAnalytics(params)
    Object.assign(dishAnalytics, { summary: result.summary || {}, top: result.top || [], hourly_trend: result.hourly_trend || [] })
    dishTotal.value = Number(result.total) || 0
  } catch (error) {
    Object.assign(dishAnalytics, { summary: {}, top: [], hourly_trend: [] })
    dishTotal.value = 0
  } finally {
    dishLoading.value = false
  }
}
function changeDishSort() {
  dishPage.value = 1
  loadDishAnalytics()
}
async function openStoreDetail(store) {
  const range = reportRange.value
  if (!range?.[0] || !range?.[1]) return ElMessage.warning('请先选择完整的时间范围')
  selectedStore.value = store
  detailRangeLabel.value = `${range[0]} 至 ${range[1]}`
  storeDetailVisible.value = true
  storeDetailLoading.value = true
  Object.assign(storeDetail, { totals: {}, revenue_composition: [], channel_breakdown: [] })
  try {
    const result = await getBusinessAnalytics('overview', { period: aggregationPeriod.value, store_id: store.store_id, channel_group: scopeChannelGroup.value || undefined, platform: effectivePlatform.value || undefined, require_platform_record: requiresPlatformRecord.value ? '1' : undefined, date_from: range[0], date_to: range[1] })
    Object.assign(storeDetail, result)
  } catch (error) { ElMessage.error(error.message) } finally { storeDetailLoading.value = false }
}
function reuseChart(chart, target) {
  if (!target) return null
  if (chart && chart.getDom() !== target) { chart.dispose(); chart = null }
  return chart || echarts.getInstanceByDom(target) || echarts.init(target)
}
function renderPie(chartRef, chart, items, centerText, centerLabel) {
  const instance = reuseChart(chart, chartRef.value)
  if (!instance) return chart
  if (!items.length) { instance.clear(); return instance }
  const compactLegend = analysisScope.value === 'total'
  const dark = compareThemeActive.value
  instance.resize()
  instance.setOption({
    tooltip: { trigger: 'item', backgroundColor: dark ? '#172b48' : '#fff', textStyle: { color: dark ? '#e7f0ff' : '#182230' }, formatter: item => `${item.name}<br/>${money(item.value)} · ${item.percent}%` },
    legend: { show: !compactLegend, bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { color: dark ? '#b9cce9' : '#667085' } },
    series: [{ type: 'pie', radius: ['54%', '76%'], center: ['50%', '45%'], label: { show: false }, itemStyle: { borderColor: '#fff', borderWidth: 4, borderRadius: 8 }, data: items }],
    graphic: [{ type: 'text', left: 'center', top: '38%', style: { text: money(centerText), fill: dark ? '#f4f8ff' : '#182230', fontSize: 18, fontWeight: 700, textAlign: 'center' } }, { type: 'text', left: 'center', top: '48%', style: { text: centerLabel, fill: dark ? '#c1d1ea' : '#98a2b3', fontSize: 11, textAlign: 'center' } }],
  }, true)
  return instance
}
function renderHourlyOrderChart() {
  if (!hourlyOrderChartRef.value || analysisScope.value !== 'total') return
  hourlyOrderChart = reuseChart(hourlyOrderChart, hourlyOrderChartRef.value)
  const rows = dishAnalytics.hourly_trend || []
  if (!rows.length) { hourlyOrderChart.clear(); return }
  const dark = compareThemeActive.value
  hourlyOrderChart.resize()
  hourlyOrderChart.setOption({
    color: ['#4b83ed'],
    tooltip: {
      trigger: 'axis',
      backgroundColor: dark ? '#172b48' : '#fff',
      textStyle: { color: dark ? '#e7f0ff' : '#182230' },
      formatter: params => `${params?.[0]?.axisValue || ''}<br/>订单量：<b>${numberText(params?.[0]?.value || 0)}</b> 单`,
    },
    grid: { left: 14, right: 22, top: 24, bottom: 16, containLabel: true },
    xAxis: {
      type: 'category', data: rows.map(row => row.period), boundaryGap: false,
      axisLine: { lineStyle: { color: dark ? '#2d527e' : '#e4e9f1' } }, axisTick: { show: false },
      axisLabel: { color: dark ? '#aec4e4' : '#8a94a6', interval: 1, fontSize: 10 },
    },
    yAxis: {
      type: 'value', minInterval: 1,
      axisLabel: { color: dark ? '#aec4e4' : '#8a94a6', formatter: value => numberText(value) },
      splitLine: { lineStyle: { color: dark ? 'rgba(148,180,224,.14)' : '#edf1f6', type: 'dashed' } },
    },
    series: [{
      name: '订单量', type: 'line', smooth: true, data: rows.map(row => Number(row.order_count) || 0),
      symbol: 'circle', symbolSize: 5, lineStyle: { width: 3 }, itemStyle: { color: '#4b83ed' },
      areaStyle: { color: dark ? 'rgba(75,131,237,.24)' : 'rgba(75,131,237,.14)' },
    }],
  }, true)
}
function renderCharts() {
  if (activeTab.value !== 'overview') return
  const series = chartSeries.value
  const isStoreTrend = analysisMode.value === 'store'
  const isDeliveryTrend = analysisScope.value === 'delivery'
  if (trendChartRef.value) {
    trendChart = reuseChart(trendChart, trendChartRef.value)
    if (!data.trend.length) { trendChart.clear(); return }
    trendChart.resize()
    const deliveryGross = data.trend.map(row => Math.max(Number(row.delivery_gross || 0), Number(row.delivery || 0)))
    const deliveryActual = data.trend.map(row => Number(row.delivery || 0))
    const deliveryTooltip = params => {
      const index = params?.[0]?.dataIndex || 0
      const gross = deliveryGross[index] || 0
      const actual = deliveryActual[index] || 0
      const ratio = gross ? actual / gross : 0
      return `${data.trend[index]?.period || ''}<br/>营业额：<b>${money(gross)}</b><br/>实收：<b>${money(actual)}</b><br/>实收率：<b>${percent(ratio)}</b>`
    }
    trendChart.setOption({
      color: isDeliveryTrend ? ['#e94b68', '#ffd166'] : isStoreTrend ? ['#3b82f6'] : series.map(item => item.color),
      tooltip: { trigger: 'axis', axisPointer: { type: isDeliveryTrend ? 'shadow' : 'line' }, valueFormatter: value => money(value), formatter: isDeliveryTrend ? deliveryTooltip : undefined },
      legend: { show: isDeliveryTrend || isStoreTrend, top: 5, right: 8, itemWidth: 10, itemHeight: 7, itemGap: 16, textStyle: { color: '#667085' } },
      grid: { left: 12, right: 12, top: isDeliveryTrend ? 48 : 42, bottom: 5, containLabel: true },
      xAxis: { type: 'category', data: data.trend.map(item => item.period), axisLine: { lineStyle: { color: '#e4e9f1' } }, axisTick: { show: false }, axisLabel: { color: '#8a94a6' } },
      yAxis: { type: 'value', axisLabel: { color: '#8a94a6', formatter: value => value >= 10000 ? `${(value / 10000).toFixed(1)}万` : value }, splitLine: { lineStyle: { color: '#edf1f6', type: 'dashed' } } },
      series: isDeliveryTrend
        ? [
          { name: '营业额', type: 'bar', data: deliveryGross, barWidth: 28, barCategoryGap: '42%', itemStyle: { color: '#e94b68', borderRadius: [6, 6, 0, 0] }, z: 1 },
          { name: '实收', type: 'bar', data: deliveryActual, barWidth: 16, barGap: '-100%', itemStyle: { color: '#ffd166', borderRadius: [5, 5, 0, 0] }, z: 2 },
        ]
        : isStoreTrend
          ? [{ name: '实收', type: 'line', smooth: true, data: data.trend.map(row => row.total || 0), symbol: 'circle', symbolSize: 7, lineStyle: { width: 3 }, itemStyle: { color: '#3b82f6' }, areaStyle: { color: 'rgba(59,130,246,.16)' } }]
          : series.map((item, index) => ({ name: item.name, type: 'bar', stack: series.length > 1 ? 'revenue' : undefined, data: data.trend.map(row => row[item.key] || 0), barMaxWidth: 26, itemStyle: { borderRadius: index === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })),
    }, true)
  }
  compositionChart = renderPie(compositionChartRef, compositionChart, analysisScope.value === 'total' ? incomeCompositionItems.value : channelCompositionItems.value, analysisScope.value === 'total' ? scopeIncome.value : channelCompositionItems.value.reduce((sum, item) => sum + item.value, 0), analysisScope.value === 'total' ? '营业收入构成' : '渠道营业构成')
  channelCompositionChart = renderPie(channelCompositionChartRef, channelCompositionChart, channelCompositionItems.value, scopeIncome.value, '渠道营业构成')
  renderHourlyOrderChart()
}
function queueChartRender() {
  if (chartFrame) cancelAnimationFrame(chartFrame)
  chartFrame = requestAnimationFrame(() => { chartFrame = null; renderCharts() })
}
function resizeCharts() { trendChart?.resize(); compositionChart?.resize(); channelCompositionChart?.resize(); hourlyOrderChart?.resize() }
watch(activeTab, async value => { if (value === 'overview') { await nextTick(); queueChartRender() } else if (value === 'products' && hasQueried.value) await loadDeliveryProductAnalytics() })
watch(compareThemeActive, async () => { await nextTick(); queueChartRender() })
onMounted(async () => { const result = await getStores({ page: 1, pageSize: 200 }).catch(() => ({ stores: [] })); storeOptions.value = result.stores || []; resetScopeFilters(); hasQueried.value = false; clearData(); window.addEventListener('resize', resizeCharts) })
onBeforeUnmount(() => { if (chartFrame) cancelAnimationFrame(chartFrame); trendChart?.dispose(); compositionChart?.dispose(); channelCompositionChart?.dispose(); hourlyOrderChart?.dispose(); window.removeEventListener('resize', resizeCharts) })
</script>

<style scoped>
.business-analytics-page{--ink:#162033;--line:#e6eaf0;--blue:#3b82f6;min-width:0;color:var(--ink)}.analytics-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:16px;padding:28px 30px;border-radius:18px;color:#fff;background:radial-gradient(circle at 88% 0,rgba(107,172,255,.35),transparent 34%),linear-gradient(125deg,#14295b 0%,#2255a4 56%,#3b82f6 100%);box-shadow:0 16px 36px rgba(34,75,151,.18)}.eyebrow{color:#b8d4ff;font-size:10px;font-weight:800;letter-spacing:.2em}.hero-copy h2{margin:7px 0 6px;font-size:27px}.hero-copy p{margin:0;color:rgba(255,255,255,.72);font-size:13px}.analytics-hero :deep(.el-button){height:38px;border-color:rgba(255,255,255,.32);background:rgba(255,255,255,.12);color:#fff}.filter-bar{display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:#fff;box-shadow:0 6px 18px rgba(33,48,78,.05)}.period-switch{display:flex;padding:3px;border-radius:9px;background:#f1f4f8}.period-switch button{min-width:72px;height:32px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:#69758a;cursor:pointer;font-size:12px}.period-switch button.active{background:#fff;color:var(--blue);font-weight:700;box-shadow:0 2px 7px rgba(32,48,78,.12)}.delivery-store-picker{display:flex;align-items:center;gap:7px}.delivery-store-picker :deep(.el-button){margin:0}.scope-chip{padding:8px 11px;border:1px solid #cfe0fa;border-radius:8px;background:#f4f8ff;color:#3772bc;font-size:12px;font-weight:700;white-space:nowrap}.filter-summary{display:flex;align-items:center;gap:7px;margin-left:auto;color:#7c8799;font-size:11px;white-space:nowrap}.live-dot{width:7px;height:7px;border-radius:50%;background:#22b980;box-shadow:0 0 0 4px rgba(34,185,128,.1)}.metric-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:17px}.metric-card{min-height:130px;padding:17px;border:1px solid var(--line);border-radius:14px;background:#fff;box-shadow:0 6px 18px rgba(33,48,78,.05)}.metric-card>div:first-child span,.metric-card>div:first-child small{display:block}.metric-card span{font-size:12px;font-weight:700}.metric-card small{margin-top:5px;color:#98a2b3;font-size:9px;line-height:1.5}.metric-card strong{display:block;margin:17px 0 12px;font-size:21px;letter-spacing:-.02em}.metric-foot{color:#8a94a6;font-size:10px}.metric-card.primary{border-color:#8ebcff;background:linear-gradient(145deg,#f7fbff,#edf5ff)}.metric-card.primary strong{color:#246bd4}.metric-card.warning strong{color:#d37b12}.metric-card.success strong{color:#159467}.metric-card.success :deep(.el-progress-bar__inner){background:#22b980}.content-tabs{display:flex;gap:4px;margin-bottom:12px;padding:4px;border:1px solid var(--line);border-radius:11px;background:#f7f8fa;width:max-content}.content-tabs button{height:33px;padding:0 16px;border:0;border-radius:8px;background:transparent;color:#667085;cursor:pointer;font-size:12px}.content-tabs button.active{background:#fff;color:#246bd4;font-weight:700;box-shadow:0 3px 9px rgba(36,57,91,.09)}.content-tabs em{display:inline-grid;min-width:18px;height:18px;margin-left:6px;place-items:center;border-radius:9px;background:#fff1db;color:#c87008;font-size:9px;font-style:normal}.chart-grid{display:grid;grid-template-columns:minmax(0,1.85fr) minmax(300px,.75fr);gap:14px;margin-bottom:14px}.panel{overflow:hidden;border:1px solid var(--line);border-radius:15px;background:#fff;box-shadow:0 7px 22px rgba(33,48,78,.055)}.panel>header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 19px;border-bottom:1px solid #edf0f4}.panel h3{margin:0;font-size:14px}.panel header p{margin:4px 0 0;color:#929cad;font-size:10px}.panel-badge{padding:5px 9px;border-radius:20px;background:#eef4ff;color:#3d6fc5;font-size:10px}.chart{height:330px}.store-ranking,.reconciliation-panel{min-height:330px}.ranking-list{padding:6px 18px 12px}.ranking-list>div{display:flex;align-items:center;gap:11px;padding:12px 2px;border-bottom:1px solid #eef1f5}.ranking-list>div:last-child{border-bottom:0}.rank{display:grid;width:24px;height:24px;place-items:center;border-radius:7px;background:#f0f2f6;color:#7e899b;font-size:10px;font-weight:700}.rank.top{background:#e8f1ff;color:#3275de}.ranking-list>div>div{min-width:0;flex:1}.ranking-list b,.ranking-list small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ranking-list b{font-size:11px}.ranking-list small{margin-top:3px;color:#9aa3b2;font-size:9px}.ranking-list strong{font-size:12px}.difference-ok{color:#189768}.difference-warn{color:#d97706;font-weight:700}@media(max-width:1280px){.metric-grid{grid-template-columns:repeat(3,1fr)}}@media(max-width:900px){.analytics-hero{align-items:flex-start;flex-direction:column}.filter-bar{align-items:stretch;flex-wrap:wrap}.filter-summary{width:100%;margin-left:0}.metric-grid{grid-template-columns:repeat(2,1fr)}.chart-grid{grid-template-columns:1fr}.chart{height:300px}}@media(max-width:560px){.analytics-hero{padding:22px 20px}.metric-grid{grid-template-columns:1fr}.period-switch{width:100%}.period-switch button{flex:1;padding:0 4px}.delivery-store-picker{flex-wrap:wrap;width:100%}.content-tabs{width:100%}.content-tabs button{flex:1;padding:0 8px}}
.metric-grid{grid-template-columns:repeat(6,minmax(0,1fr))}
.metric-grid.compact{grid-template-columns:repeat(4,minmax(0,1fr))}.query-button{min-width:88px;font-weight:700}.composition-panel{margin-bottom:14px}.composition-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;align-items:stretch;min-height:280px}.composition-table{border:0}.composition-table :deep(.el-table__inner-wrapper:before){display:none}.ring-column{display:flex;min-height:280px;align-items:center;justify-content:center;flex-direction:column;border-left:1px solid #edf0f4;background:linear-gradient(180deg,#fbfdff,#f5f9ff);color:#8793a6;font-size:11px}.ring-chart{width:270px;height:245px}.income-panel{margin-bottom:18px}@media(max-width:1280px){.metric-grid.compact{grid-template-columns:repeat(2,1fr)}}@media(max-width:900px){.composition-layout{grid-template-columns:1fr}.ring-column{border-top:1px solid #edf0f4;border-left:0}.composition-table{max-width:100%;overflow-x:auto}}@media(max-width:560px){.metric-grid.compact{grid-template-columns:1fr}.query-button{width:100%}.ring-chart{width:100%;height:260px}}
.ranking-bands{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;padding:16px 18px 18px}.ranking-band{min-width:0;padding:0 15px;border-right:1px solid #edf0f4}.ranking-band:first-child{padding-left:0}.ranking-band:last-child{padding-right:0;border-right:0}.ranking-band h4{margin:0 0 8px;font-size:12px;color:#637189}.ranking-row{display:flex;width:100%;align-items:center;gap:9px;padding:10px 0;border:0;border-bottom:1px solid #f0f2f6;background:transparent;color:inherit;text-align:left;cursor:pointer}.ranking-row:hover{background:#f7faff}.ranking-row:focus-visible{outline:2px solid #78aefc;outline-offset:2px;border-radius:6px}.ranking-row:last-child{border-bottom:0}.ranking-row>div{min-width:0;flex:1}.ranking-row b,.ranking-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ranking-row b{font-size:11px}.ranking-row small{margin-top:3px;color:#9aa3b2;font-size:9px}.ranking-row strong{font-size:11px;white-space:nowrap}.rank.middle{background:#f2f5fa;color:#68778f}.rank.bottom{background:#f8f0f2;color:#a86c76}.detail-period{margin:0 0 14px;color:#7d899a;font-size:12px}.store-detail-content{min-height:240px}.detail-metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px}.detail-metric-grid article{padding:13px;border:1px solid #e6ebf2;border-radius:10px;background:#f8fbff}.detail-metric-grid span,.detail-metric-grid strong{display:block}.detail-metric-grid span{color:#718096;font-size:11px}.detail-metric-grid strong{margin-top:7px;color:#1f5fb9;font-size:17px}.detail-metric-grid small{display:block;margin-top:5px;color:#8b98aa;font-size:10px}.detail-table-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.detail-table-grid article{overflow:hidden;border:1px solid #e9edf2;border-radius:10px}.detail-table-grid h4{margin:0;padding:12px 14px;border-bottom:1px solid #e9edf2;font-size:13px}.store-detail-dialog :deep(.el-dialog__body){padding-top:12px}@media(max-width:900px){.ranking-bands{grid-template-columns:1fr;gap:14px}.ranking-band,.ranking-band:first-child,.ranking-band:last-child{padding:0;border:0}.ranking-band{padding-bottom:12px;border-bottom:1px solid #edf0f4}.ranking-band:last-child{padding-bottom:0;border-bottom:0}.detail-table-grid{grid-template-columns:1fr}.detail-metric-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.detail-metric-grid{grid-template-columns:1fr}}
.compare-button{border-color:#c8b8fb;background:#faf8ff;color:#6547ba;font-weight:700}.compare-button.exit{border-color:#f0bfc8;background:#fff5f6;color:#bb4d61}.compare-up{color:#16865a!important}.compare-down{color:#d65262!important}.compare-flat{color:#7d899a!important}.compare-mode{padding:16px;border-radius:20px;background:radial-gradient(circle at 8% 0,rgba(194,174,255,.27),transparent 35%),radial-gradient(circle at 100% 88%,rgba(131,206,255,.23),transparent 36%),linear-gradient(135deg,#f5f1ff,#eef7ff);box-shadow:inset 0 0 0 1px rgba(141,116,219,.13)}.compare-mode .analytics-hero{background:radial-gradient(circle at 88% 0,rgba(230,207,255,.44),transparent 34%),linear-gradient(125deg,#312060,#5a3c9e 54%,#8064c5)}.compare-mode .filter-bar,.compare-mode .panel,.compare-mode .metric-card{border-color:rgba(126,99,196,.16);box-shadow:0 9px 25px rgba(74,55,129,.08)}.compare-mode .metric-card.primary{background:linear-gradient(145deg,#fbf9ff,#f0ebff);border-color:#bfa9ed}.compare-form{display:grid;gap:18px}.compare-form>div{padding:15px;border:1px solid #e8e0fb;border-radius:12px;background:#fbfaff}.compare-form h4{margin:0;color:#43306f;font-size:14px}.compare-form p{margin:6px 0 12px;color:#8992a4;font-size:12px}.compare-form :deep(.el-date-editor){width:100%}@media(max-width:560px){.compare-mode{padding:10px}}
.metric-card{position:relative}.card-compare{position:absolute;right:17px;top:48px;display:flex;min-width:104px;flex-direction:column;gap:6px;padding-left:15px;border-left:1px solid #dce3ec}.card-compare span{color:#8c97a8;font-size:10px;font-weight:600}.card-compare b{font-size:15px;line-height:1.2;white-space:nowrap}.ranking-row em{min-width:72px;font-size:11px;font-style:normal;font-weight:700;text-align:right;white-space:nowrap}.compare-mode{--ink:#e8efff;padding:18px;border:1px solid #31496f;background:radial-gradient(circle at 3% 0,rgba(98,132,238,.28),transparent 33%),radial-gradient(circle at 100% 95%,rgba(37,186,190,.2),transparent 35%),linear-gradient(135deg,#071321 0%,#102744 48%,#121b35 100%);box-shadow:0 22px 55px rgba(2,9,24,.42),inset 0 1px 0 rgba(160,190,255,.1)}.compare-mode .analytics-hero{border:1px solid rgba(125,168,255,.26);background:radial-gradient(circle at 92% 0,rgba(74,150,255,.4),transparent 35%),linear-gradient(125deg,#091a32,#163964 60%,#1d4f89)}.compare-mode .filter-bar,.compare-mode .panel,.compare-mode .metric-card{border-color:rgba(118,157,213,.22);background:rgba(13,30,53,.92);box-shadow:0 12px 28px rgba(0,5,16,.28)}.compare-mode .metric-card.primary{background:linear-gradient(145deg,rgba(19,51,91,.97),rgba(16,39,72,.97));border-color:#4678bd}.compare-mode .metric-card span,.compare-mode .panel h3,.compare-mode .ranking-band h4,.compare-mode .ranking-row b{color:#e6efff}.compare-mode .metric-card small,.compare-mode .metric-foot,.compare-mode .panel header p,.compare-mode .ranking-row small{color:#a9bbd6}.compare-mode .card-compare{border-left-color:rgba(157,186,231,.28)}.compare-mode .ring-column{border-left-color:rgba(128,163,216,.22);background:linear-gradient(180deg,rgba(18,42,74,.88),rgba(10,27,50,.88));color:#9db4d5}.compare-mode :deep(.el-table){--el-table-header-bg-color:#132d50;--el-table-tr-bg-color:rgba(11,28,50,.92);--el-table-row-hover-bg-color:#193d68;--el-table-border-color:rgba(128,163,216,.18);--el-table-text-color:#dbe8fb;--el-table-header-text-color:#aec5e8;background:transparent}.compare-mode :deep(.el-table__inner-wrapper:before){background-color:rgba(128,163,216,.18)}.compare-mode .ranking-band{border-right-color:rgba(128,163,216,.18)}.compare-mode .ranking-row{border-bottom-color:rgba(128,163,216,.14)}.compare-mode .ranking-row:hover{background:rgba(70,123,188,.17)}.compare-mode .content-tabs{border-color:rgba(126,166,223,.25);background:rgba(7,20,38,.7)}.compare-mode .content-tabs button{color:#afc1dd}.compare-mode .content-tabs button.active{background:#1c4779;color:#fff}.compare-mode .filter-summary{color:#bdcde5}.compare-mode .scope-chip{border-color:#4876ae;background:#14395f;color:#d7e7ff}@media(max-width:760px){.card-compare{position:static;display:inline-flex;margin-top:6px;padding:6px 0 0;border-top:1px solid #dce3ec;border-left:0}.compare-mode .card-compare{border-top-color:rgba(157,186,231,.28)}}
.compare-mode .metric-card strong{color:#f3f7ff}.compare-mode .metric-card.primary strong{color:#8fc2ff}.compare-mode .compare-up{color:#37d39a!important}.compare-mode .compare-down{color:#ff7583!important}.compare-mode .compare-flat{color:#bdcbe0!important}.compare-mode :deep(.el-table th.el-table__cell){background:#16365d!important;color:#c9dcf7!important}.compare-mode :deep(.el-table tr),.compare-mode :deep(.el-table td.el-table__cell){background:#0d2039!important;color:#e1ecff!important}.compare-mode :deep(.el-table--striped .el-table__body tr.el-table__row--striped td.el-table__cell){background:#122b4b!important}.compare-mode :deep(.el-table--enable-row-hover .el-table__body tr:hover>td.el-table__cell){background:#1a416d!important}.compare-mode :deep(.el-table .cell){color:inherit}.compare-mode :deep(.el-table .el-table__empty-block){background:#0d2039}.compare-mode .panel-badge{background:#1c4779;color:#d9ebff}.compare-mode .rank{background:#214a78;color:#d9ebff}.compare-mode .rank.middle{background:#364966;color:#e2edff}.compare-mode .rank.bottom{background:#6b3d54;color:#ffe0e5}
.reconciliation-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-top:1px solid #edf0f4;color:#8793a6;font-size:12px}.compare-mode .reconciliation-pagination{border-top-color:rgba(128,163,216,.18);color:#b8c9e1}.compare-mode :deep(.el-pagination button),.compare-mode :deep(.el-pagination .number){background:transparent;color:#c7d8f2}.compare-mode :deep(.el-pagination .number.is-active){color:#75b2ff}.recon-channel-switch{flex:none}.recon-channel-switch :deep(.el-segmented__item){font-size:12px;padding:0 11px}.recon-channel-switch :deep(.el-segmented__item:not(.is-selected)){color:#5c6b82}
.hero-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px}.analytics-hero :deep(.el-button--primary){border-color:rgba(255,255,255,.52);background:rgba(255,255,255,.22);font-weight:700}.analytics-hero :deep(.el-button.is-disabled){opacity:.5}.diagnosis-content{color:#253247}.diagnosis-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;color:#7e8b9c;font-size:12px}.diagnosis-summary{margin:18px 0;padding:15px 17px;border-left:4px solid #4d87e8;border-radius:0 10px 10px 0;background:#f4f8ff;color:#45607f;line-height:1.7}.diagnosis-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:22px}.diagnosis-metrics>div{padding:13px;border:1px solid #e3eaf5;border-radius:11px;background:linear-gradient(145deg,#fbfdff,#f3f7fd)}.diagnosis-metrics span,.diagnosis-metrics b{display:block}.diagnosis-metrics span{color:#7e8da1;font-size:11px}.diagnosis-metrics b{margin-top:8px;color:#245fae;font-size:17px}.diagnosis-section{margin-top:18px}.diagnosis-section h4{margin:0 0 10px;font-size:14px}.diagnosis-section article{margin:8px 0;padding:12px 14px;border:1px solid #e8edf5;border-radius:10px;background:#fff}.diagnosis-section article b{font-size:13px}.diagnosis-section article p{margin:6px 0 0;color:#718095;font-size:12px;line-height:1.65}.diagnosis-section article.warning{border-left:3px solid #e6a23c}.diagnosis-section article.success{border-left:3px solid #35ad7c}.diagnosis-section article.info{border-left:3px solid #4d87e8}.diagnosis-section ol{margin:0;padding:2px 0 2px 20px;color:#4d5f75}.diagnosis-section li{padding:5px 0;line-height:1.6}@media(max-width:900px){.hero-actions{justify-content:flex-start}.diagnosis-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.hero-actions{width:100%}.hero-actions :deep(.el-button){flex:1}.diagnosis-metrics{grid-template-columns:1fr}.diagnosis-meta{align-items:flex-start;flex-direction:column;gap:6px}}
.store-trend-panel,.custom-store-panel{margin-top:14px}.custom-store-panel :deep(.el-table__inner-wrapper:before){display:none}.compare-mode .custom-store-panel :deep(.el-table__inner-wrapper:before){background-color:rgba(128,163,216,.18)}
.dish-panel{margin-top:14px}.dish-panel header{display:flex;align-items:center;justify-content:space-between;gap:14px}.dish-panel .panel-actions{flex:none}.dish-panel .panel-actions :deep(.el-radio-button__inner){font-size:12px;padding:6px 11px}.dish-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:14px 18px}.dish-metrics>div{min-height:66px;padding:12px 14px;border:1px solid #e6ebf2;border-radius:10px;background:#f8fbff}.dish-metrics span,.dish-metrics strong,.dish-metrics small{display:block}.dish-metrics span{color:#718096;font-size:11px}.dish-metrics strong{margin-top:6px;color:#1f5fb9;font-size:18px;font-variant-numeric:tabular-nums}.dish-metrics small{margin-top:4px;color:#98a3b4;font-size:9px;white-space:nowrap}.dish-refund-text{color:#d65262!important}.dish-cost-text{color:#c47c12!important}.dish-cost-pending{color:#98a3b4;font-size:11px}.dish-income{color:#16865a}.dish-table{border:0}.dish-panel :deep(.el-table__inner-wrapper:before){display:none}.compare-mode .dish-metrics>div{background:rgba(13,30,53,.9);border-color:rgba(118,157,213,.22)}.compare-mode .dish-metrics strong{color:#f3f7ff}.compare-mode .dish-metrics span,.compare-mode .dish-metrics small{color:#a9bbd6}.compare-mode .dish-refund-text{color:#ff7583!important}.compare-mode .dish-cost-text{color:#f4bd63!important}.compare-mode .dish-cost-pending{color:#91a7c5}.dish-footer{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 18px;border-top:1px solid #edf0f4;background:#fafbfc;color:#7f8999;font-size:12px}.dish-footer :deep(.el-pagination){--el-pagination-font-size:12px}.dish-footer :deep(.el-pagination.is-background .btn-prev),.dish-footer :deep(.el-pagination.is-background .btn-next),.dish-footer :deep(.el-pagination.is-background .el-pager li){border-radius:7px}.compare-mode .dish-footer{border-top-color:rgba(128,163,216,.18);background:rgba(13,30,53,.85);color:#b8c9e1}@media(max-width:900px){.dish-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:560px){.dish-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.dish-panel header{align-items:flex-start;flex-direction:column}.dish-footer{align-items:flex-start;flex-direction:column}}
.hourly-order-panel{margin:0 0 14px}.hourly-order-chart{height:286px;padding:8px 14px 0}.compare-mode .hourly-order-panel{border-color:rgba(118,157,213,.22);background:rgba(13,30,53,.92)}@media(max-width:560px){.hourly-order-chart{height:260px;padding:8px 4px 0}}
.period-switch{flex:0 0 auto;white-space:nowrap}.period-switch button{white-space:nowrap}
.compact-range-picker{width:360px!important;flex:0 0 360px}@media(max-width:560px){.compact-range-picker{width:100%!important;flex-basis:100%}}
.delivery-product-panel{min-height:420px}.product-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:16px 18px;border-bottom:1px solid #edf1f5;background:linear-gradient(180deg,#fbfdff,#f7faff)}.product-summary-grid article{padding:13px 14px;border:1px solid #e3eaf4;border-radius:10px;background:#fff}.product-summary-grid span,.product-summary-grid strong,.product-summary-grid small{display:block}.product-summary-grid span{color:#718096;font-size:11px}.product-summary-grid strong{margin:7px 0 4px;color:#147c70;font-size:20px;font-variant-numeric:tabular-nums}.product-summary-grid small{color:#97a4b5;font-size:10px}.delivery-product-table{border:0}.delivery-product-table :deep(.el-table__inner-wrapper:before){display:none}.mapped-sku{color:#207258;font-weight:700}.unmapped-sku{color:#9aa5b5}.profit-positive{color:#16865a;font-weight:700}.profit-negative{color:#d65262;font-weight:700}.product-pagination{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 18px;border-top:1px solid #edf1f5;background:#fafbfd;color:#8491a2;font-size:12px}@media(max-width:900px){.product-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.product-summary-grid{grid-template-columns:1fr}.product-pagination{align-items:flex-start;flex-direction:column}}

/* 1366px 笔记本在展开数据看板时避免六张卡片被压成窄列。 */
@media (max-width:1440px) {
  .metric-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .metric-grid.compact { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .filter-bar { flex-wrap:wrap; }
  .filter-summary { width:100%; margin-left:0; }
  .chart-grid { grid-template-columns:minmax(0,1.35fr) minmax(260px,.85fr); }
}
</style>
