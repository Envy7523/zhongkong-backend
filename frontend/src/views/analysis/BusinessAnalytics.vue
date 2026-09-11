<template>
  <div class="business-analytics-page">
    <section class="analytics-hero">
      <div class="hero-copy">
        <span class="eyebrow">DATA ANALYTICS</span>
        <h2>{{ viewConfig.title }}</h2>
        <p>{{ viewConfig.description }}</p>
      </div>
      <div class="hero-actions">
        <el-button
          type="primary"
          :disabled="!canDiagnose"
          :loading="diagnosisLoading"
          @click="runDiagnosis"
          >{{ hasCurrentDiagnosis ? "重新诊断" : "AI 诊断" }}</el-button
        ><el-button
          v-if="hasCurrentDiagnosis"
          plain
          @click="diagnosisVisible = true"
          >诊断结果</el-button
        >
      </div>
    </section>

    <Transition name="group-query">
      <div
        v-if="groupQueryVisible"
        class="group-query-overlay"
        role="status"
        aria-live="polite"
      >
        <div class="group-query-orbit"><i></i><i></i><i></i></div>
        <div>
          <b>{{ queryFeedbackTitle }}</b
          ><span>{{ groupQueryStepText }}</span>
        </div>
        <div class="group-query-track">
          <i :style="{ width: `${(groupQueryStep + 1) * 32}%` }"></i>
        </div>
      </div>
    </Transition>
    <section class="filter-bar">
      <div class="period-switch" aria-label="时间视角">
        <button
          v-for="item in timeModes"
          :key="item.value"
          :class="{ active: filters.timeMode === item.value }"
          @click="changeTimeMode(item.value)"
        >
          {{ item.label }}
        </button>
      </div>
      <el-date-picker
        v-if="filters.timeMode === 'day'"
        v-model="filters.day"
        :clearable="false"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="选择日期"
      />
      <el-date-picker
        v-else-if="filters.timeMode === 'week'"
        v-model="filters.week"
        :clearable="false"
        type="week"
        value-format="YYYY-MM-DD"
        format="YYYY 第 ww 周"
        placeholder="选择周次"
      />
      <el-date-picker
        v-else-if="filters.timeMode === 'month'"
        v-model="filters.month"
        :clearable="false"
        type="month"
        value-format="YYYY-MM"
        placeholder="选择月份"
      />
      <el-date-picker
        v-else
        v-model="filters.customRange"
        :clearable="false"
        class="compact-range-picker"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
      />
      <template v-if="showRevenueSourceControls">
        <div class="analysis-source-switch">
          <span>数据视角</span
          ><el-radio-group v-model="filters.dataView"
            ><el-radio-button label="cashier">收银机</el-radio-button
            ><el-radio-button label="real"
              >真实第三方</el-radio-button
            ></el-radio-group
          >
        </div>
        <span v-if="filters.dataView === 'cashier'" class="source-mode-hint"
          >线上渠道按收银机入账，平台配置不参与本次取数</span
        >
        <el-button
          v-else
          class="source-config-button"
          @click="sourceDialogVisible = true"
          >平台来源 · {{ platformSourceSummary }}</el-button
        >
      </template>
      <template
        v-if="analysisScope === 'delivery' || analysisScope === 'group-buy'"
      >
        <div
          class="delivery-platform-switch"
          :aria-label="`${analysisScope === 'group-buy' ? '团购' : '外卖'}平台选择`"
        >
          <span>平台</span>
          <el-radio-group
            v-model="filters.platform"
            size="small"
            @change="switchDeliveryPlatform"
          >
            <el-radio-button v-if="analysisMode !== 'platform'" label=""
              >汇总</el-radio-button
            >
            <el-radio-button
              v-for="platform in scopedPlatforms"
              :key="platform"
              :label="platform"
              >{{ platform }}</el-radio-button
            >
          </el-radio-group>
        </div>
        <div
          v-if="analysisMode === 'store' || analysisMode === 'platform'"
          class="delivery-store-picker"
          :aria-label="`${analysisScope === 'group-buy' ? '团购' : '外卖'}门店范围`"
        >
          <StoreRegionSelect
            v-model="filters.deliveryStoreIds"
            :stores="storeOptions"
            multiple
            :filterable="false"
            :show-hint="false"
            show-selection-actions
            input-width="220px"
            :placeholder="requiresInitialStoreSelection ? '请先选择至少一个门店' : '选择门店范围（不选即全部）'"
          />
        </div>
      </template>
      <template v-else>
        <StoreRegionSelect
          v-if="analysisMode === 'platform'"
          v-model="filters.platformStoreIds"
          :stores="storeOptions"
          multiple
          :filterable="false"
          :show-hint="false"
          show-selection-actions
          input-width="220px"
          placeholder="选择门店范围（不选即全部）"
        />
        <StoreRegionSelect
          v-else-if="analysisMode === 'store'"
          v-model="filters.storeIds"
          :stores="storeOptions"
          multiple
          :filterable="false"
          :show-hint="false"
          show-selection-actions
          input-width="260px"
          placeholder="选择门店范围（不选即全部）"
        />
        <el-select
          v-if="showPlatformSelect"
          v-model="filters.platform"
          style="width: 180px"
          ><el-option label="平台汇总" value="" /><el-option
            v-for="platform in scopedPlatforms"
            :key="platform"
            :label="platform"
            :value="platform"
        /></el-select>
      </template>
      <el-button
        type="primary"
        class="query-button"
        :loading="loading"
        :disabled="!canQuery"
        @click="queryData"
        ><el-icon><Search /></el-icon>查询</el-button
      >
      <el-button
        v-if="!compareMode"
        class="compare-button"
        @click="openCompareDialog"
        >环比</el-button
      ><template v-else
        ><el-button class="compare-button" @click="openCompareDialog"
          >调整环比</el-button
        ><el-button class="compare-button exit" @click="exitCompareMode"
          >退出环比</el-button
        ></template
      >
      <div class="filter-summary">
        <span class="live-dot"></span>{{ rangeLabel }}
      </div>
    </section>

    <section
      class="metric-grid"
      :class="{ compact: analysisScope === 'total' }"
      v-loading="loading"
    >
      <article class="metric-card primary">
        <div>
          <span>营业额</span
          ><small>{{
            mtOpView
              ? "平台运营日报 · 营业额"
              : isMeituanGroupBuyView
                ? "收益明细 · 售价"
                : data.totals.gross_pending
                  ? "美团外卖待导入营业日报，暂不汇总营业额"
                  : "营业收入 + 优惠金额"
          }}</small>
        </div>
        <strong>{{ grossValueText }}</strong>
        <div class="metric-foot">{{ scopeChip }} · {{ rangeLabel }}</div>
        <aside v-if="compareMode" class="card-compare">
          <span>环比</span
          ><b :class="compareValueClass(compareRates.gross_amount)">{{
            comparePercent(compareRates.gross_amount)
          }}</b>
        </aside>
      </article>
      <article class="metric-card">
        <div>
          <span>{{
            isMeituanOperationView
              ? isTaobaoOperation
                ? "实际收入"
                : "实收（营业收入）"
              : incomeLabel
          }}</span
          ><small>{{
            isMeituanOperationView
              ? isTaobaoOperation
                ? "平台营业日报 · 未扣第三方费用"
                : isJdOperation
                  ? "平台结算口径 · 已扣第三方费用"
                  : `${operationPlatformName}营业日报口径`
              : incomeHint
          }}</small>
        </div>
        <strong>{{ money(cardIncome) }}</strong>
        <div class="metric-foot">实收占比 {{ percent(cardIncomeRatio) }}</div>
        <aside v-if="compareMode" class="card-compare">
          <span>环比</span
          ><b :class="compareValueClass(compareRates.actual_amount)">{{
            comparePercent(compareRates.actual_amount)
          }}</b>
        </aside>
      </article>
      <article class="metric-card">
        <div><span>订单量</span><small>渠道订单量汇总</small></div>
        <strong>{{ numberText(cardOrders) }}</strong>
        <div class="metric-foot">当前筛选范围</div>
        <aside v-if="compareMode" class="card-compare">
          <span>环比</span
          ><b :class="compareValueClass(compareRates.order_count)">{{
            comparePercent(compareRates.order_count)
          }}</b>
        </aside>
      </article>
      <article class="metric-card">
        <div><span>优惠金额</span><small>客户优惠汇总</small></div>
        <strong>{{ money(cardDiscount) }}</strong>
        <div class="metric-foot">
          优惠金额占比 {{ percent(cardDiscountRatio) }}
        </div>
        <aside v-if="compareMode" class="card-compare">
          <span>环比</span
          ><b :class="compareValueClass(compareRates.discount_amount)">{{
            comparePercent(compareRates.discount_amount)
          }}</b>
        </aside>
      </article>
      <template v-if="analysisScope !== 'total' && !compareMode"
        ><article class="metric-card">
          <div><span>线上核对差额</span><small>平台到账 − 收银记录</small></div>
          <strong>{{ signedMoney(data.totals.online_difference) }}</strong>
          <div class="metric-foot">负数表示平台到账较低</div>
        </article>
        <el-tooltip
          v-if="analysisScope === 'delivery' || analysisScope === 'group-buy'"
          effect="light"
          placement="bottom-start"
          :fallback-placements="['top-start', 'right-start', 'left-start']"
          :show-after="160"
          popper-class="fee-breakdown-tooltip"
          ><template #content
            ><div class="fee-breakdown">
              <header>
                <div>
                  <strong
                    >平台费用合计 ·
                    {{
                      hasRawFeeBreakdown ? "上传原始字段" : "计算构成"
                    }}</strong
                  ><span>{{ feeBreakdownItems.length }} 项明细</span>
                </div>
                <p>
                  {{
                    hasRawFeeBreakdown
                      ? "按上传报表的原始费用字段展示；负数为平台扣款，正数为冲销或赔付。"
                      : "第三方平台费用为支出，各分类如下。"
                  }}
                </p>
              </header>
              <div class="fee-breakdown-scroll">
                <div
                  v-for="item in feeBreakdownItems"
                  :key="item.key"
                  class="fee-breakdown-line"
                >
                  <span>{{ item.label }}</span
                  ><b>{{ signedMoney(-item.amount) }}</b>
                </div>
                <div
                  v-if="!feeBreakdownItems.length"
                  class="fee-breakdown-empty"
                >
                  当前时间范围内暂无平台费用记录
                </div>
              </div>
              <footer>
                合计 <b>{{ signedMoney(-(data.totals.fees || 0)) }}</b>
              </footer>
            </div></template
          >
          <article class="metric-card warning">
            <div>
              <span>平台费用合计</span><small>第三方平台费用 · 支出</small>
            </div>
            <strong>{{ signedMoney(-(data.totals.fees || 0)) }}</strong>
            <div class="metric-foot">
              {{
                feeBreakdownItems.length
                  ? `悬停查看 ${feeBreakdownItems.length} 项原始字段`
                  : "按实际平台账单归集"
              }}
            </div>
          </article></el-tooltip
        >
        <article v-else class="metric-card warning">
          <div>
            <span>平台费用合计</span><small>服务费、推广费、保险及退款</small>
          </div>
          <strong>{{ money(data.totals.fees) }}</strong>
          <div class="metric-foot">按实际平台账单归集</div>
        </article></template
      >
    </section>

    <section
      v-if="isDeliverySettlementView"
      class="delivery-settlement-chain"
      :aria-label="`${scopeChip}数据口径拆解`"
    >
      <template v-if="!isDirectSettlementOperation">
        <div>
          <span>营业额</span><strong>{{ money(chainGross) }}</strong
          ><small>{{ settlementSource.daily }}</small>
        </div>
        <b>−</b>
        <div>
          <span>客户优惠</span><strong>{{ money(chainDiscount) }}</strong
          ><small>{{ settlementSource.daily }}</small>
        </div>
        <b>=</b>
        <div>
          <span>优惠后收入</span><strong>{{ money(chainIncome) }}</strong
          ><small>{{ settlementSource.income }}</small>
        </div>
        <b>−</b>
        <div>
          <span>平台费用</span><strong>{{ money(chainFees) }}</strong
          ><small>{{ settlementSource.fee }}</small>
        </div>
        <b>=</b>
        <div class="settlement-result">
          <span>实际到账</span><strong>{{ money(chainActual) }}</strong
          ><small>{{ settlementSource.settled }}</small>
        </div>
      </template>
      <template v-else>
        <template v-if="isJdOperation">
          <div>
            <span>订单实收</span><strong>{{ money(chainIncome) }}</strong
            ><small>H 列“正向订单”</small>
          </div>
          <b>→</b>
          <div>
            <span>第三方费用</span><strong>{{ money(chainFees) }}</strong
            ><small>I 列费用明细，仅展示不重复扣减</small>
          </div>
          <b>→</b>
          <div class="settlement-result">
            <span>实际到账</span><strong>{{ money(chainActual) }}</strong
            ><small>X 列应结金额，账单最终结算结果</small>
          </div>
        </template>
        <template v-else>
          <div>
            <span>营业额</span><strong>{{ money(chainGross) }}</strong
            ><small>优惠前总额（平台日报）</small>
          </div>
          <b>−</b>
          <div>
            <span>客户优惠</span><strong>{{ money(chainDiscount) }}</strong
            ><small>优惠及让利</small>
          </div>
          <b>=</b>
          <div class="settlement-result">
            <span>实际到账</span><strong>{{ money(chainActual) }}</strong
            ><small>美团营业收入已含第三方费用扣减</small>
          </div>
        </template>
      </template>
    </section>

    <section
      v-if="isMeituanGroupBuyView"
      class="delivery-settlement-chain meituan-group-settlement"
      aria-label="美团团购收益明细结算构成"
    >
      <div>
        <span>营业额</span><strong>{{ money(data.totals.gross_amount) }}</strong
        ><small>收益明细 · 售价</small>
      </div>
      <template v-for="item in meituanGroupFeeCategories" :key="item.key">
        <b>−</b>
        <el-tooltip
          effect="light"
          placement="bottom"
          :show-after="140"
          popper-class="group-fee-category-tooltip"
        >
          <template #content
            ><div class="group-fee-category-detail">
              <header>
                <strong>{{ item.label }}</strong
                ><span>{{ item.details.length }} 个原始字段</span>
              </header>
              <div
                v-for="detail in item.details"
                :key="detail.label"
                class="group-fee-category-line"
              >
                <span>{{ detail.label }}</span
                ><b>{{ money(detail.amount) }}</b>
              </div>
              <p v-if="!item.details.length">当前筛选范围内暂无该类费用。</p>
              <footer>
                小计 <b>{{ money(item.amount) }}</b>
              </footer>
            </div></template
          >
          <div class="settlement-fee-step" tabindex="0">
            <span>{{ item.label }}</span
            ><strong>{{ money(item.amount) }}</strong
            ><small>{{
              item.details.length
                ? `悬停查看 ${item.details.length} 个字段`
                : "暂无明细"
            }}</small>
          </div>
        </el-tooltip>
      </template>
      <b>=</b>
      <div class="settlement-result">
        <span>商家应得</span><strong>{{ money(scopeIncome) }}</strong
        ><small>收益明细 · 商家应得</small>
      </div>
    </section>

    <section
      v-if="isDirectGroupSettlementView"
      class="delivery-settlement-chain douyin-group-settlement"
      aria-label="抖音团购结算构成"
    >
      <div>
        <span>商家收入</span
        ><strong>{{ money(douyinSettlementIncome) }}</strong>
      </div>
      <b>−</b>
      <el-tooltip
        effect="light"
        placement="bottom"
        :show-after="120"
        popper-class="douyin-settlement-tooltip"
      >
        <template #content
          ><div class="douyin-settlement-detail">
            <header>
              <strong>商家支出明细</strong
              ><span>{{ douyinExpenseItems.length }} 项</span>
            </header>
            <div
              v-for="item in douyinExpenseItems"
              :key="item.key"
              class="douyin-settlement-line"
            >
              <span>{{ item.label }}</span
              ><b>{{ money(item.amount) }}</b>
            </div>
            <p v-if="!douyinExpenseItems.length">
              当前范围没有可展示的第三方费用明细。
            </p>
            <footer>
              合计 <b>{{ money(douyinSettlementExpense) }}</b>
            </footer>
          </div></template
        >
        <div class="settlement-expense settlement-hover" tabindex="0">
          <span>商家支出</span
          ><strong>{{ money(douyinSettlementExpense) }}</strong
          ><small>悬停查看明细</small>
        </div> </el-tooltip
      ><b>−</b>
      <el-tooltip
        effect="light"
        placement="bottom"
        :show-after="120"
        popper-class="douyin-settlement-tooltip"
      >
        <template #content
          ><div class="douyin-settlement-detail">
            <header>
              <strong>退款金额构成</strong><span>分账流水抵销</span>
            </header>
            <div class="douyin-settlement-line">
              <span>商家收入</span><b>{{ money(douyinSettlementIncome) }}</b>
            </div>
            <div class="douyin-settlement-line">
              <span>减：商家支出</span
              ><b>-{{ money(douyinSettlementExpense) }}</b>
            </div>
            <div class="douyin-settlement-line">
              <span>减：商家应得</span
              ><b>-{{ money(douyinSettlementActual) }}</b>
            </div>
            <footer>
              退款金额 <b>{{ money(douyinSettlementRefund) }}</b>
            </footer>
            <p>由正向与退款分账流水自动抵销，不会重复扣减。</p>
          </div></template
        >
        <div class="settlement-refund settlement-hover" tabindex="0">
          <span>退款金额</span
          ><strong>{{ money(douyinSettlementRefund) }}</strong
          ><small>悬停查看构成</small>
        </div> </el-tooltip
      ><b>+</b>
      <div class="settlement-other">
        <span>其他金额</span><strong>{{ money(douyinSettlementOther) }}</strong>
      </div>
      <b>=</b>
      <div class="settlement-result">
        <span>商家应得</span
        ><strong>{{ money(douyinSettlementActual) }}</strong>
      </div>
    </section>

    <section
      v-if="isMeituanOperationView && meituanOpLoaded"
      class="panel mt-trend-panel"
    >
      <header class="mt-trend-header">
        <div class="mt-trend-title">
          <h3>{{ operationPlatformName }}经营趋势</h3>
          <p>
            {{
              isGroupOperationView
                ? `${rangeLabel} · 经营收入、流量转化、评分评价三组互斥展示；转化率按人数重新计算。`
                : `${rangeLabel} · 可叠加查看经营指标；流量指标切换为单独趋势，数据口径更清晰。`
            }}
          </p>
        </div>
        <div
          class="mt-trend-toolbar"
          role="tablist"
          aria-label="切换走势图字段"
        >
          <template v-if="isGroupOperationView">
            <div class="mt-metric-group">
              <span class="mt-metric-label">趋势组</span>
              <button
                type="button"
                :class="{ active: mtGroupTrendSection === 'revenue' }"
                @click="switchGroupMtSection('revenue')"
              >
                经营收入
              </button>
              <button
                type="button"
                :class="{ active: mtGroupTrendSection === 'traffic' }"
                @click="switchGroupMtSection('traffic')"
              >
                流量转化
              </button>
              <button
                type="button"
                :class="{ active: mtGroupTrendSection === 'rating' }"
                @click="switchGroupMtSection('rating')"
              >
                评分评价
              </button>
            </div>
            <div class="mt-metric-group mt-metric-funnel mt-group-field-picker">
              <span class="mt-metric-label">显示字段</span>
              <button
                v-for="item in groupMtMetricOptions.filter(
                  (item) => item.section === mtGroupTrendSection,
                )"
                :key="item.key"
                type="button"
                :class="{ active: mtGroupMetricActive(item.key) }"
                @click="switchGroupMtMetric(item.key)"
              >
                {{ item.label }}
              </button>
            </div>
          </template>
          <template v-else>
            <div class="mt-metric-group">
              <span class="mt-metric-label">经营</span>
              <button
                v-for="item in mtMetricOptions.filter((item) => item.group)"
                :key="item.key"
                type="button"
                :class="{ active: mtIsActive(item.key) }"
                @click="switchMtMetric(item.key)"
              >
                {{ item.label }}
              </button>
            </div>
            <div class="mt-metric-group mt-metric-funnel">
              <span class="mt-metric-label">漏斗</span>
              <button
                v-for="item in mtMetricOptions.filter((item) => !item.group)"
                :key="item.key"
                type="button"
                :class="{ active: mtIsActive(item.key) }"
                @click="switchMtMetric(item.key)"
              >
                {{ item.label }}
              </button>
            </div>
          </template>
          <span class="panel-badge">{{ meituanOpTotals.days || 0 }} 天</span>
        </div>
      </header>
      <div class="mt-trend-body">
        <div
          v-if="meituanOpTrend.length"
          ref="mtTrendChartRef"
          class="mt-chart"
        ></div>
        <el-empty v-else description="当前筛选范围暂无趋势数据" />
      </div>
    </section>

    <section
      v-if="isMeituanOperationView && meituanOpLoaded"
      class="panel meituan-op-panel"
    >
      <header class="meituan-op-header">
        <div>
          <h3>门店经营指标（{{ operationPlatformName }}）</h3>
          <p>
            {{
              isGroupOperationView
                ? `${rangeLabel} · 金额、人数为求和；转化率按汇总人数重算。`
                : `${rangeLabel} · 金额/人数/次数为求和；转化率为加权口径。`
            }}
          </p>
        </div>
        <span class="panel-badge"
          >{{ meituanOpTotals.stores_count || 0 }} 家门店 ·
          {{ meituanOpTotals.days || 0 }} 天</span
        >
      </header>
      <div
        v-if="isGroupOperationView"
        class="meituan-op-tiles group-operation-tiles"
      >
        <article
          v-for="item in groupMtMetricOptions"
          :key="item.key"
          :class="[
            'operation-metric-card',
            `metric-${item.section}`,
            { 'op-rate': item.unit === 'percent' },
          ]"
        >
          <div class="operation-card-kicker">
            <i :style="{ backgroundColor: item.color }"></i
            ><em>{{ groupMetricSectionLabel(item) }}</em>
          </div>
          <span>{{ item.label }}</span
          ><strong>{{
            formatGroupMetric(meituanOpTotals.totals[item.key], item)
          }}</strong
          ><small>{{ groupMetricHint(item) }}</small>
        </article>
      </div>
      <div
        v-else-if="meituanOpTotals.totals"
        :class="[
          'meituan-op-tiles',
          { 'group-operation-tiles': isGroupOperationView },
        ]"
      >
        <article>
          <span>{{ isGroupOperationView ? "营业额" : "营业收入" }}</span
          ><strong>{{
            money(
              isGroupOperationView
                ? meituanOpTotals.totals.gross_amount
                : meituanOpTotals.totals.income_amount,
            )
          }}</strong>
        </article>
        <article>
          <span>{{ isGroupOperationView ? "收入" : "优惠前总额" }}</span
          ><strong>{{
            money(
              isGroupOperationView
                ? meituanOpTotals.totals.income_amount
                : meituanOpTotals.totals.gross_amount,
            )
          }}</strong>
        </article>
        <article>
          <span>{{ isGroupOperationView ? "订单量" : "有效订单" }}</span
          ><strong>{{ numberText(meituanOpTotals.totals.order_count) }}</strong>
        </article>
        <article v-if="isGroupOperationView">
          <span>实际到账金额</span
          ><strong>{{ money(meituanOpTotals.totals.actual_amount) }}</strong>
        </article>
        <article>
          <span>曝光人数</span
          ><strong>{{
            numberText(meituanOpTotals.totals.impression_users)
          }}</strong>
        </article>
        <article>
          <span>{{ isGroupOperationView ? "访问人数" : "入店人数" }}</span
          ><strong>{{ numberText(meituanOpTotals.totals.visit_users) }}</strong>
        </article>
        <article>
          <span>{{ isGroupOperationView ? "购买人数" : "下单人数" }}</span
          ><strong>{{
            numberText(meituanOpTotals.totals.ordering_users)
          }}</strong>
        </article>
        <article v-if="!isGroupOperationView">
          <span>曝光次数</span
          ><strong>{{
            numberText(meituanOpTotals.totals.impression_count)
          }}</strong>
        </article>
        <article v-else>
          <span>美团星级</span
          ><strong>{{
            Number(meituanOpTotals.totals.meituan_rating || 0).toFixed(2)
          }}</strong>
        </article>
        <article v-if="isGroupOperationView">
          <span>点评星级</span
          ><strong>{{
            Number(meituanOpTotals.totals.dianping_rating || 0).toFixed(2)
          }}</strong>
        </article>
        <article v-if="isGroupOperationView">
          <span>全部评价数</span
          ><strong>{{
            numberText(meituanOpTotals.totals.review_count)
          }}</strong>
        </article>
        <article class="op-rate">
          <span>{{
            isGroupOperationView ? "曝光-访问转化率" : "入店转化率"
          }}</span
          ><strong>{{
            meituanOpTotals.totals.visit_rate != null
              ? percent(meituanOpTotals.totals.visit_rate)
              : "—"
          }}</strong
          ><small>{{
            isGroupOperationView ? "Σ访问 ÷ Σ曝光" : "Σ入店 ÷ Σ曝光"
          }}</small>
        </article>
        <article class="op-rate">
          <span>{{
            isGroupOperationView ? "访问-购买转化率" : "下单转化率"
          }}</span
          ><strong>{{
            meituanOpTotals.totals.order_rate != null
              ? percent(meituanOpTotals.totals.order_rate)
              : "—"
          }}</strong
          ><small>{{
            isGroupOperationView ? "Σ购买 ÷ Σ访问" : "Σ下单 ÷ Σ入店"
          }}</small>
        </article>
      </div>
      <el-table
        v-if="isGroupOperationView && meituanOpStores.length"
        :data="meituanOpStores"
        class="meituan-op-table"
        size="small"
        stripe
      >
        <el-table-column
          prop="store_name"
          label="门店"
          min-width="180"
          fixed
          show-overflow-tooltip
        />
        <el-table-column
          v-for="item in groupMtMetricOptions"
          :key="item.key"
          :prop="item.key"
          :label="item.label"
          min-width="122"
          align="right"
          sortable
          ><template #default="{ row }">{{
            formatGroupMetric(row[item.key], item)
          }}</template></el-table-column
        >
        <el-table-column
          v-if="isMeituanGroupBuyView"
          prop="gross_profit"
          label="预估毛利"
          min-width="112"
          align="right"
          sortable
          ><template #default="{ row }">{{
            money(row.gross_profit)
          }}</template></el-table-column
        >
        <el-table-column
          v-if="isMeituanGroupBuyView"
          prop="gross_profit_rate"
          label="毛利占比"
          min-width="92"
          align="right"
          sortable
          ><template #default="{ row }">{{
            row.gross_profit_rate != null ? percent(row.gross_profit_rate) : "—"
          }}</template></el-table-column
        >
      </el-table>
      <el-table
        v-else-if="meituanOpStores.length"
        :data="meituanOpStores"
        class="meituan-op-table"
        size="small"
        stripe
        :default-sort="{ prop: 'income_amount', order: 'descending' }"
      >
        <el-table-column
          prop="store_name"
          label="门店"
          min-width="160"
          show-overflow-tooltip
        />
        <el-table-column
          prop="income_amount"
          :label="isTaobaoOperation ? '优惠后收入' : '营业收入（实收）'"
          min-width="122"
          align="right"
          sortable
          ><template #default="{ row }">{{
            isJdOperation && row.actual_amount != null
              ? money(row.actual_amount)
              : money(row.income_amount)
          }}</template></el-table-column
        >
        <el-table-column
          v-if="isTaobaoOperation"
          prop="actual_amount"
          label="实际到账"
          min-width="112"
          align="right"
          sortable
          ><template #default="{ row }">{{
            row.actual_amount == null ? "待导入账单" : money(row.actual_amount)
          }}</template></el-table-column
        >
        <el-table-column
          prop="gross_profit"
          label="预估毛利"
          min-width="112"
          align="right"
          sortable
          ><template #default="{ row }"
            ><span
              :class="
                Number(row.gross_profit) >= 0
                  ? 'profit-positive'
                  : 'profit-negative'
              "
              >{{ money(row.gross_profit) }}</span
            ></template
          ></el-table-column
        >
        <el-table-column
          prop="gross_profit_rate"
          label="毛利占比"
          min-width="92"
          align="right"
          sortable
          ><template #default="{ row }">{{
            row.gross_profit_rate != null ? percent(row.gross_profit_rate) : "—"
          }}</template></el-table-column
        >
        <el-table-column
          prop="gross_amount"
          label="优惠前总额（营业额）"
          min-width="128"
          align="right"
          sortable
          ><template #default="{ row }">{{
            money(row.gross_amount)
          }}</template></el-table-column
        >
        <el-table-column
          prop="order_count"
          label="有效订单"
          width="88"
          align="right"
          sortable
          ><template #default="{ row }">{{
            numberText(row.order_count)
          }}</template></el-table-column
        >
        <el-table-column
          label="客单价"
          min-width="92"
          align="right"
          sortable
          :sort-method="(a, b) => avgOrderValue(a) - avgOrderValue(b)"
          ><template #default="{ row }">{{
            money(avgOrderValue(row))
          }}</template></el-table-column
        >
        <el-table-column
          prop="impression_users"
          label="曝光人数"
          width="96"
          align="right"
          sortable
          ><template #default="{ row }">{{
            numberText(row.impression_users)
          }}</template></el-table-column
        >
        <el-table-column
          prop="visit_users"
          label="入店人数"
          width="90"
          align="right"
          sortable
          ><template #default="{ row }">{{
            numberText(row.visit_users)
          }}</template></el-table-column
        >
        <el-table-column
          prop="ordering_users"
          label="下单人数"
          width="90"
          align="right"
          sortable
          ><template #default="{ row }">{{
            numberText(row.ordering_users)
          }}</template></el-table-column
        >
        <el-table-column
          prop="visit_rate"
          label="入店转化率"
          width="100"
          align="right"
          sortable
          ><template #default="{ row }">{{
            row.visit_rate != null ? percent(row.visit_rate) : "—"
          }}</template></el-table-column
        >
        <el-table-column
          prop="order_rate"
          label="下单转化率"
          width="100"
          align="right"
          sortable
          ><template #default="{ row }">{{
            row.order_rate != null ? percent(row.order_rate) : "—"
          }}</template></el-table-column
        >
      </el-table>
      <div
        v-if="meituanOpStores.length && !isDirectGroupSettlementView"
        class="mt-op-note"
      >
        {{
          isGroupOperationView
            ? "预估毛利 = 实际到账金额 − 已绑定团购菜品成本之和；未绑定菜品按 0 计，请在“菜品销售分析”完成绑定后重新查询。毛利占比 = 预估毛利 ÷ 实际到账金额。"
            : "预估毛利 = 营业收入 − 菜品成本（成本来自已绑定菜品，未绑定的按 0 计，请在“菜品销量”完成绑定后重新查询）；毛利占比 = 预估毛利 ÷ 营业收入；客单价 = 实收 ÷ 有效订单（京东无下单人数，按下单转化率反推，结果四舍五入保留整数）。"
        }}
        点击列头可升/降序排序。
      </div>
      <div
        v-if="isDirectGroupSettlementView && meituanOpStores.length"
        class="mt-op-note"
      >
        营业额、实收和订单量来自抖音分账数据；评分、累计评价取各门店期末记录；—
        表示缺少对应数据。
      </div>
      <el-empty
        v-if="!meituanOpStores.length"
        description="当前筛选范围暂无经营数据，请先在数据导入中上传对应平台报表"
      />
    </section>

    <section class="content-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        :class="{ active: activeTab === tab.value }"
        @click="activeTab = tab.value"
      >
        {{ tab.label
        }}<em v-if="tab.value === 'reconciliation'">{{
          reconciliationCount
        }}</em>
      </button>
    </section>
    <template v-if="activeTab === 'overview'">
      <template v-if="analysisScope === 'total'">
        <section class="panel composition-panel">
          <header>
            <div>
              <h3>{{ channelCompositionTitle }}</h3>
              <p>{{ channelCompositionDescription }}</p>
            </div>
            <span class="panel-badge"
              >{{ displayedChannelRows.length }} 项字段</span
            >
          </header>
          <div v-if="displayedChannelRows.length" class="composition-layout">
            <el-table :data="channelTableRows" class="composition-table" stripe
              ><el-table-column
                prop="name"
                label="渠道字段"
                min-width="150"
              /><el-table-column label="取数来源" min-width="138"
                ><template #default="{ row }"
                  ><el-tag size="small" :type="row.sourceTone">{{
                    row.source
                  }}</el-tag></template
                ></el-table-column
              ><el-table-column label="营业额" min-width="150" align="right"
                ><template #default="{ row }">{{
                  row.grossPending ? "待导入营业日报" : money(row.gross)
                }}</template></el-table-column
              ><el-table-column
                v-if="compareMode"
                label="营业额环比"
                min-width="130"
                align="right"
                ><template #default="{ row }"
                  ><span :class="compareValueClass(row.grossCompareRate)">{{
                    comparePercent(row.grossCompareRate)
                  }}</span></template
                ></el-table-column
              ><el-table-column label="实收" min-width="135" align="right"
                ><template #default="{ row }">{{
                  money(row.actual)
                }}</template></el-table-column
              ><el-table-column
                v-if="compareMode"
                label="实收环比"
                min-width="130"
                align="right"
                ><template #default="{ row }"
                  ><span :class="compareValueClass(row.actualCompareRate)">{{
                    comparePercent(row.actualCompareRate)
                  }}</span></template
                ></el-table-column
              ><el-table-column label="实收占比" min-width="108" align="right"
                ><template #default="{ row }">{{
                  percent(row.actualRatio)
                }}</template></el-table-column
              ></el-table
            >
            <aside class="ring-column">
              <div ref="channelCompositionChartRef" class="ring-chart"></div>
              <span>按实收占比</span>
            </aside>
          </div>
          <el-empty v-else :description="emptyDescription" />
        </section>
        <section class="panel composition-panel income-panel">
          <header>
            <div>
              <h3>{{ incomeCompositionTitle }}</h3>
              <p>{{ incomeCompositionDescription }}</p>
            </div>
            <span class="panel-badge"
              >{{ incomeTableRows.length }} 项构成 ·
              {{ incomeReconciliationLabel }}</span
            >
          </header>
          <div v-if="incomeTableRows.length" class="composition-layout">
            <el-table :data="incomeTableRows" class="composition-table" stripe
              ><el-table-column
                :label="incomeCompositionFieldLabel"
                prop="name"
                min-width="200"
              /><el-table-column label="字段来源" min-width="150"
                ><template #default="{ row }"
                  ><el-tag size="small" type="info">{{
                    row.source
                  }}</el-tag></template
                ></el-table-column
              ><el-table-column label="实收" min-width="155" align="right"
                ><template #default="{ row }">{{
                  money(row.actual)
                }}</template></el-table-column
              ><el-table-column
                v-if="compareMode"
                label="实收环比"
                min-width="135"
                align="right"
                ><template #default="{ row }"
                  ><span :class="compareValueClass(row.actualCompareRate)">{{
                    comparePercent(row.actualCompareRate)
                  }}</span></template
                ></el-table-column
              ><el-table-column label="实收占比" min-width="130" align="right"
                ><template #default="{ row }">{{
                  percent(row.actualRatio)
                }}</template></el-table-column
              ></el-table
            >
            <aside class="ring-column">
              <div ref="compositionChartRef" class="ring-chart"></div>
              <span>按实收占比</span>
            </aside>
          </div>
          <el-empty v-else :description="`暂无${incomeCompositionTitle}数据`" />
        </section>
        <section class="panel hourly-order-panel">
          <header>
            <div>
              <h3>时段订单走势图</h3>
              <p>
                {{ rangeLabel }} · 从 00:00 至次日
                00:00，每小时统计一次实际订单量
              </p>
            </div>
            <span class="panel-badge">24 个时段</span>
          </header>
          <div
            v-if="dishAnalytics.hourly_trend?.length"
            ref="hourlyOrderChartRef"
            class="hourly-order-chart"
          ></div>
          <el-empty v-else description="暂无带下单时间的菜品销售数据" />
        </section>
      </template>
      <template v-else>
        <section
          v-if="!isMeituanOperationView"
          class="chart-grid"
          :class="{ single: analysisScope === 'delivery' }"
        >
          <article v-if="!isMeituanOperationView" class="panel">
            <header>
              <div>
                <h3>
                  {{
                    isSettlementTrend
                      ? "营业额与实收趋势"
                      : analysisMode === "store"
                        ? "门店实收走势图"
                        : "实收趋势"
                  }}
                </h3>
                <p>
                  {{
                    isSettlementTrend
                      ? "浅色为营业额，深色实收叠放于前，可直接查看实收占比"
                      : `按${trendTimeModeLabel}口径聚合`
                  }}
                </p>
              </div>
              <span class="panel-badge">{{ data.trend.length }} 个周期</span>
            </header>
            <div
              v-if="data.trend.length"
              ref="trendChartRef"
              class="chart"
            ></div>
            <el-empty v-else :description="emptyDescription" />
          </article>
          <article v-if="analysisScope !== 'delivery'" class="panel">
            <header>
              <div>
                <h3>渠道营业构成</h3>
                <p>{{ scopeChip }}渠道构成</p>
              </div>
            </header>
            <div
              v-if="channelCompositionItems.length"
              ref="compositionChartRef"
              class="chart"
            ></div>
            <el-empty v-else description="暂无构成数据" />
          </article>
        </section>
      </template>
      <section
        v-if="analysisMode === 'store' && analysisScope === 'total'"
        class="panel store-trend-panel"
      >
        <header>
          <div>
            <h3>门店实收走势图</h3>
            <p>按{{ trendTimeModeLabel }}口径聚合</p>
          </div>
          <span class="panel-badge">{{ data.trend.length }} 个周期</span>
        </header>
        <div v-if="data.trend.length" ref="trendChartRef" class="chart"></div>
        <el-empty v-else :description="emptyDescription" />
      </section>
      <section v-if="analysisMode === 'store'" class="panel custom-store-panel">
        <header>
          <div>
            <h3>门店经营结果</h3>
            <p>
              {{
                scopedStoreIds.length
                  ? "已按实收从高到低展示所选门店"
                  : "未选择门店，展示全部门店并支持直接对比"
              }}
            </p>
          </div>
          <span class="panel-badge">{{ customStoreRows.length }} 家门店</span>
        </header>
        <el-table v-if="customStoreRows.length" :data="customStoreRows" stripe
          ><el-table-column
            type="index"
            label="排名"
            width="76"
          /><el-table-column
            prop="store_name"
            label="门店"
            min-width="180"
            show-overflow-tooltip
          /><el-table-column label="营业额" min-width="150" align="right"
            ><template #default="{ row }">{{
              money(row.gross_amount)
            }}</template></el-table-column
          ><el-table-column label="实收" min-width="150" align="right"
            ><template #default="{ row }">{{
              money(row.actual)
            }}</template></el-table-column
          ><el-table-column label="订单量" min-width="120" align="right"
            ><template #default="{ row }">{{
              numberText(row.order_count)
            }}</template></el-table-column
          ><el-table-column label="客单价" min-width="135" align="right"
            ><template #default="{ row }">{{
              money(row.average_order)
            }}</template></el-table-column
          ></el-table
        ><el-empty v-else description="暂无门店数据" />
      </section>
      <section v-else-if="analysisMode !== 'store'" class="panel store-ranking">
        <header>
          <div>
            <h3>{{ compareMode ? "门店实收排名（含环比）" : rankingTitle }}</h3>
            <p>
              {{
                compareMode
                  ? "按当前实收排序，右侧新增实收环比值"
                  : "按确认实收分为前三、中三、后三；点击门店查看明细"
              }}
            </p>
          </div>
        </header>
        <div v-if="rankingBands.length" class="ranking-bands">
          <section
            v-for="band in rankingBands"
            :key="band.key"
            class="ranking-band"
            :class="band.key"
          >
            <h4>{{ band.label }}</h4>
            <button
              v-for="store in band.rows"
              :key="store.store_id"
              type="button"
              class="ranking-row"
              @click="openStoreDetail(store)"
            >
              <span class="rank" :class="band.key">{{ store.rank }}</span>
              <div>
                <b>{{ store.store_name }}</b
                ><small>{{
                  compareMode
                    ? "当前实收 · 右侧为环比"
                    : `${store.verified_channels} 个线上渠道已验证`
                }}</small>
              </div>
              <strong>{{ money(store.actual) }}</strong
              ><em
                v-if="compareMode"
                :class="compareValueClass(store.actualCompareRate)"
                >{{ comparePercent(store.actualCompareRate) }}</em
              >
            </button>
          </section>
        </div>
        <el-empty v-else description="暂无门店数据" />
      </section>
    </template>
    <section
      v-else-if="activeTab === 'products'"
      class="panel"
      :class="isTotalProductBoard ? 'dish-panel' : 'delivery-product-panel'"
    >
      <template v-if="isTotalProductBoard">
        <header>
          <div>
            <h3>菜品销售分析</h3>
            <p>
              {{ rangeLabel }} ·
              按下单时间汇总各渠道菜品的销量、销售额、收入、优惠、退款与预估成本；赠品已含在销量与销售额内并单独标注；本地菜品按菜品编码/名称自动识别，未关联的自动排到列表末尾；展开可查看收银机与平台订单来源明细。
            </p>
          </div>
          <div class="panel-actions">
            <el-radio-group
              v-model="dishSort"
              size="small"
              @change="changeDishSort"
              ><el-radio-button value="income">按收入</el-radio-button
              ><el-radio-button value="quantity">按销量</el-radio-button
              ><el-radio-button value="amount">按金额</el-radio-button
            ></el-radio-group>
            <span class="panel-badge">{{ dishTotal }} 款菜品</span>
          </div>
        </header>
        <div class="dish-metrics">
          <div>
            <span>菜品数</span
            ><strong>{{ dishAnalytics.summary.product_count ?? 0 }}</strong>
          </div>
          <div>
            <span>总销量</span
            ><strong>{{ numberText(dishAnalytics.summary.quantity) }}</strong>
          </div>
          <div>
            <span>赠品数量</span
            ><strong
              >{{ numberText(productAnalytics.totals.gift_quantity || 0) }} 份</strong
            ><small>已含在总销量内</small>
          </div>
          <div>
            <span>销售额</span
            ><strong>{{ money(dishAnalytics.summary.amount_total) }}</strong>
          </div>
          <div>
            <span>赠品金额</span
            ><strong>{{
              money(productAnalytics.totals.gift_amount || 0)
            }}</strong
            ><small>已含在销售额内，不重复计入收入</small>
          </div>
          <div>
            <span>菜品收入</span
            ><strong>{{ money(dishAnalytics.summary.income_amount) }}</strong>
          </div>
          <div>
            <span>优惠金额</span
            ><strong>{{ money(dishAnalytics.summary.discount_amount) }}</strong>
          </div>
          <div>
            <span>退款金额</span
            ><strong class="dish-refund-text">{{
              money(dishAnalytics.summary.refund_amount)
            }}</strong>
          </div>
          <div>
            <span>预估成本</span
            ><strong class="dish-cost-text">{{
              money(dishAnalytics.summary.estimated_cost)
            }}</strong
            ><small
              >已关联
              {{ dishAnalytics.summary.cost_covered_product_count ?? 0 }}/{{
                dishAnalytics.summary.product_count ?? 0
              }}
              款 · 含自动识别</small
            >
          </div>
          <div>
            <span>净收入</span
            ><strong class="dish-income">{{
              money(dishAnalytics.summary.net_income)
            }}</strong
            ><small>收入 − 预估成本</small>
          </div>
        </div>
        <el-table
          v-loading="dishLoading"
          :data="dishAnalytics.top"
          :row-key="dishRowKey"
          class="dish-table"
          stripe
        >
          <el-table-column type="expand" width="48"><template #default="{ row }"
            ><div class="total-product-breakdown">
              <div
                v-if="dishSourceDetails(row).length"
                class="total-product-breakdown-title"
              >
                来源订单明细
              </div>
              <div
                v-for="detail in dishSourceDetails(row)"
                :key="`${detail.source_name}-${detail.product_code}-${detail.product_name}`"
                class="total-product-breakdown-row"
              >
                <span class="total-product-source">{{ detail.source_name }}</span>
                <span class="total-product-origin">{{ detail.product_name }}</span>
                <b>销量 {{ numberText(detail.quantity) }}</b>
                <span>销售额 {{ money(detail.sales_amount) }}</span>
                <span>收入 {{ money(detail.income_amount) }}</span>
                <span>订单 {{ numberText(detail.order_count) }}</span>
              </div>
              <div v-if="!dishSourceDetails(row).length" class="total-product-breakdown-row">
                <span class="total-product-origin"
                  >暂无对应来源明细，请确认该区间已导入收银机“品项销售明细”</span
                >
              </div>
            </div></template
          ></el-table-column>
          <el-table-column
            type="index"
            :index="dishIndex"
            label="排名"
            width="62"
          />
          <el-table-column
            prop="product_name"
            label="菜品"
            min-width="200"
            show-overflow-tooltip
          />
          <el-table-column label="规格" min-width="90"
            ><template #default="{ row }">{{
              row.spec && row.spec !== "--" ? row.spec : "—"
            }}</template></el-table-column
          >
          <el-table-column label="销量" width="84" align="right"
            ><template #default="{ row }">{{
              numberText(row.quantity)
            }}</template></el-table-column
          >
          <el-table-column label="赠品数量" width="104" align="right"
            ><template #default="{ row }"
              ><span v-if="Number(dishGift(row).quantity)">{{
                numberText(dishGift(row).quantity)
              }}</span
              ><span v-else class="total-product-unmapped">—</span></template
            ></el-table-column
          >
          <el-table-column label="销售额" width="108" align="right"
            ><template #default="{ row }">{{
              money(row.amount_total)
            }}</template></el-table-column
          >
          <el-table-column label="赠品金额" width="112" align="right"
            ><template #default="{ row }"
              ><span v-if="Number(dishGift(row).amount)">{{
                money(dishGift(row).amount)
              }}</span
              ><span v-else class="total-product-unmapped">—</span></template
            ></el-table-column
          >
          <el-table-column label="优惠" width="96" align="right"
            ><template #default="{ row }">{{
              money(row.discount_amount)
            }}</template></el-table-column
          >
          <el-table-column label="收入" width="106" align="right"
            ><template #default="{ row }"
              ><b class="dish-income">{{
                money(row.income_amount)
              }}</b></template
            ></el-table-column
          >
          <el-table-column label="预估成本" width="108" align="right"
            ><template #default="{ row }"
              ><span v-if="row.cost_available" class="dish-cost-text">{{
                money(row.estimated_cost)
              }}</span
              ><span v-else class="dish-cost-pending">未绑定</span></template
            ></el-table-column
          >
          <el-table-column label="净收入" width="108" align="right"
            ><template #default="{ row }"
              ><b v-if="row.cost_available" class="dish-income">{{
                money(row.net_income)
              }}</b
              ><span v-else class="dish-cost-pending">—</span></template
            ></el-table-column
          >
          <el-table-column label="退款金额" width="100" align="right"
            ><template #default="{ row }"
              ><span
                :class="
                  Number(row.refund_amount) > 0 ? 'dish-refund-text' : ''
                "
                >{{ money(row.refund_amount) }}</span
              ></template
            ></el-table-column
          >
          <el-table-column label="订单数" width="84" align="right"
            ><template #default="{ row }">{{
              numberText(row.order_count)
            }}</template></el-table-column
          >
          <el-table-column label="退款笔数" width="84" align="right"
            ><template #default="{ row }">{{
              row.refunded_count || 0
            }}</template></el-table-column
          >
          <el-table-column label="本地菜品 SKU" min-width="270"
            ><template #default="{ row }"
              ><el-popover
                trigger="click"
                placement="bottom-start"
                :width="390"
                popper-class="analytics-sku-picker"
                @show="refreshLocalMenuItems"
                ><template #reference
                  ><button
                    type="button"
                    class="inline-sku-picker"
                    :class="{ 'is-bound': row.mapped && row.menu_item_id }"
                    :title="
                      row.mapped
                        ? row.auto_matched
                          ? '已按菜品编码/名称自动识别，点击可改绑'
                          : '点击替换本地菜品 SKU'
                        : '选择本地菜品 SKU'
                    "
                  >
                    <span>{{
                      row.mapped
                        ? row.menu_sku_label || row.menu_name
                        : "选择本地菜品 SKU"
                    }}</span
                    ><i>⌄</i>
                  </button></template
                >
                <div class="analytics-sku-picker-body">
                  <el-input
                    v-model="inlineSkuSearch[productRowKey(row)]"
                    clearable
                    :loading="menuItemsLoading"
                    placeholder="搜索菜品名、规格或做法"
                  />
                  <div
                    v-if="
                      recommendedMenusFor(row).length &&
                      !inlineSkuSearch[productRowKey(row)]
                    "
                    class="analytics-picker-caption"
                  >
                    智能推荐 · 请确认后绑定
                  </div>
                  <div class="analytics-sku-options">
                    <button
                      v-for="menu in inlineMenuOptionsFor(row)"
                      :key="menu.id"
                      type="button"
                      :class="{
                        recommended: recommendedMenuIds(row).includes(menu.id),
                      }"
                      @click="bindDishRowFromAnalytics(row, menu.id)"
                    >
                      <b>{{ menu.label }}</b
                      ><small>{{ menu.category }}</small></button
                    ><span
                      v-if="!inlineMenuOptionsFor(row).length"
                      class="analytics-picker-empty"
                      >没有匹配的本地 SKU，请输入名称搜索</span
                    >
                  </div>
                </div></el-popover
              ></template
            ></el-table-column
          >
        </el-table>
        <el-empty
          v-if="!dishLoading && !dishAnalytics.top?.length"
          description="暂无菜品销售数据，请确认时间范围，或先在数据导入中上传收银机“品项销售明细”报表"
        />
        <footer v-if="dishTotal > 0" class="dish-footer">
          <span
            >共 {{ dishTotal }} 个菜品 · 按{{
              { income: "收入", quantity: "销量", amount: "金额" }[dishSort]
            }}排序</span
          >
          <el-pagination
            v-model:current-page="dishPage"
            v-model:page-size="dishPageSize"
            :page-sizes="[10, 20, 50]"
            :total="dishTotal"
            layout="total, sizes, prev, pager, next"
            background
            @current-change="loadDishAnalytics"
            @size-change="
              dishPage = 1;
              loadDishAnalytics();
            "
          />
        </footer>
      </template>
      <template v-else>
        <header>
          <div>
            <h3>
              {{
                isMeituanGroupProductBoard
                  ? "美团团购菜品销售分析"
                  : `${platformProductName}菜品销量`
              }}
            </h3>
            <p>
              {{
                isMeituanGroupProductBoard
                  ? `${rangeLabel} · 项目名称为菜品；消费计订单，撤销计退单。`
                  : `${rangeLabel} · 仅统计已按${platformProductName}门店 ID 精确关联的商品销量`
              }}
            </p>
          </div>
          <span class="panel-badge"
            >{{ productAnalytics.totals.total_products || 0 }} 款菜品</span
          >
        </header>
      <div v-loading="productLoading">
        <div class="product-summary-grid">
          <article>
            <span>菜品款数</span
            ><strong>{{ productAnalytics.totals.total_products || 0 }}</strong
            ><small>去重后的项目名称</small>
          </article>
          <article>
            <span>{{
              isTotalProductBoard
                ? "销量（含赠品）"
                : isMeituanGroupProductBoard
                  ? "消费订单"
                  : "商品销量"
            }}</span
            ><strong>{{
              numberText(
                isMeituanGroupProductBoard
                  ? productAnalytics.totals.orders
                  : productAnalytics.totals.quantity,
              )
            }}</strong
            ><small>{{
              isMeituanGroupProductBoard ? "流水类型：消费" : "已关联门店的销量"
            }}</small>
          </article>
          <article>
            <span>{{
              isTotalProductBoard
                ? "营业额（含赠品）"
                : isMeituanGroupProductBoard
                  ? "撤销退单"
                  : "商品销售额"
            }}</span
            ><strong>{{
              isMeituanGroupProductBoard
                ? numberText(productAnalytics.totals.refunds)
                : money(productAnalytics.totals.sales_amount)
            }}</strong
            ><small>{{
              isMeituanGroupProductBoard
                ? "流水类型：撤销"
                : isTotalProductBoard
                  ? "收银机品项明细口径"
                  : `按${platformProductName}商品报表口径`
            }}</small>
          </article>
          <article v-if="isTotalProductBoard">
            <span>其中赠品</span
            ><strong
              >{{ numberText(productAnalytics.totals.gift_quantity || 0) }} 份</strong
            ><small
              >{{ money(productAnalytics.totals.gift_amount || 0) }} ·
              已含在上方销量与营业额内</small
            >
          </article>
          <article>
            <span>{{
              isMeituanGroupProductBoard ? "商家应得" : "已绑定本地 SKU"
            }}</span
            ><strong>{{
              isMeituanGroupProductBoard
                ? money(productAnalytics.totals.merchant_income)
                : productAnalytics.totals.mapped || 0
            }}</strong
            ><small>{{
              isMeituanGroupProductBoard
                ? "消费与撤销净额"
                : "可继续核算成本与毛利"
            }}</small>
          </article>
        </div>
          <el-table
          v-if="productPageRows.length"
          :data="productPageRows"
          class="delivery-product-table"
          stripe
          ><el-table-column
            v-if="isTotalProductBoard"
            type="expand"
            width="48"
          ><template #default="{ row }"
            ><div class="total-product-breakdown">
              <div v-if="row.breakdown?.length" class="total-product-breakdown-title">
                来源订单明细
              </div>
              <div
                v-for="detail in row.breakdown || []"
                :key="`${detail.source_name}-${detail.product_code}-${detail.product_name}`"
                class="total-product-breakdown-row"
              >
                <span class="total-product-source">{{ detail.source_name }}</span>
                <span class="total-product-origin">{{ detail.product_name }}</span>
                <b>销量 {{ numberText(detail.quantity) }}</b>
                <span>销售额 {{ money(detail.sales_amount) }}</span>
                <span>收入 {{ money(detail.income_amount) }}</span>
                <span>订单 {{ numberText(detail.order_count) }}</span>
              </div>
            </div></template
          ></el-table-column
          ><el-table-column
            type="index"
            :index="productIndex"
            label="排名"
            width="72"
          /><el-table-column
            prop="product_name"
            :label="
              isTotalProductBoard
                ? '本地菜品 / 未关联菜品'
                : isMeituanGroupProductBoard
                ? '菜品（项目名称）'
                : `${platformProductName}商品`
            "
            min-width="220"
            show-overflow-tooltip
          /><el-table-column
            v-if="isMeituanGroupProductBoard"
            label="消费订单"
            width="110"
            align="right"
            ><template #default="{ row }">{{
              numberText(row.orders)
            }}</template></el-table-column
          ><el-table-column
            v-if="isMeituanGroupProductBoard"
            label="撤销退单"
            width="110"
            align="right"
            ><template #default="{ row }">{{
              numberText(row.refunds)
            }}</template></el-table-column
          ><el-table-column
            :label="isTotalProductBoard ? '销量（含赠品）' : '净销量'"
            width="124"
            align="right"
            ><template #default="{ row }">{{
              numberText(row.quantity)
            }}</template></el-table-column
          ><el-table-column
            v-if="isTotalProductBoard"
            label="其中赠品"
            width="104"
            align="right"
            ><template #default="{ row }"
              ><span v-if="Number(row.gift_quantity)">{{ numberText(row.gift_quantity) }}</span
              ><span v-else class="total-product-unmapped">—</span></template
            ></el-table-column
          ><el-table-column
            :label="isTotalProductBoard ? '营业额（含赠品）' : '销售额'"
            width="152"
            align="right"
            ><template #default="{ row }">{{
              money(row.sales_amount)
            }}</template></el-table-column
          ><el-table-column
            v-if="isTotalProductBoard"
            label="赠品金额"
            width="120"
            align="right"
            ><template #default="{ row }"
              ><span v-if="Number(row.gift_amount)">{{ money(row.gift_amount) }}</span
              ><span v-else class="total-product-unmapped">—</span></template
            ></el-table-column
          ><el-table-column
            v-if="isMeituanGroupProductBoard"
            label="商家应得"
            width="140"
            align="right"
            ><template #default="{ row }">{{
              money(row.merchant_income)
            }}</template></el-table-column
          ><el-table-column label="本地菜品 SKU" min-width="270"
            ><template #default="{ row }"
              ><el-popover
                trigger="click"
                placement="bottom-start"
                :width="390"
                popper-class="analytics-sku-picker"
                @show="refreshLocalMenuItems"
                ><template #reference
                  ><button
                    type="button"
                    class="inline-sku-picker"
                    :class="{ 'is-bound': row.mapped && row.menu_item_id }"
                    :title="
                      row.mapped ? '点击替换本地菜品 SKU' : '选择本地菜品 SKU'
                    "
                  >
                    <span>{{
                      row.mapped
                        ? row.menu_sku_label || row.menu_name
                        : "选择本地菜品 SKU"
                    }}</span
                    ><i>⌄</i>
                  </button></template
                >
                <div class="analytics-sku-picker-body">
                  <el-input
                    v-model="inlineSkuSearch[productRowKey(row)]"
                    clearable
                    :loading="menuItemsLoading"
                    placeholder="搜索菜品名、规格或做法"
                  />
                  <div
                    v-if="
                      recommendedMenusFor(row).length &&
                      !inlineSkuSearch[productRowKey(row)]
                    "
                    class="analytics-picker-caption"
                  >
                    智能推荐 · 请确认后绑定
                  </div>
                  <div class="analytics-sku-options">
                    <button
                      v-for="menu in inlineMenuOptionsFor(row)"
                      :key="menu.id"
                      type="button"
                      :class="{
                        recommended: recommendedMenuIds(row).includes(menu.id),
                      }"
                      @click="bindProductFromAnalytics(row, menu.id)"
                    >
                      <b>{{ menu.label }}</b
                      ><small>{{ menu.category }}</small></button
                    ><span
                      v-if="!inlineMenuOptionsFor(row).length"
                      class="analytics-picker-empty"
                      >没有匹配的本地 SKU，请输入名称搜索</span
                    >
                  </div>
                </div></el-popover
              ></template
            ></el-table-column
          ><el-table-column label="预估成本" width="140" align="right"
            ><template #default="{ row }"
              ><span v-if="row.mapped">{{ money(row.total_cost) }}</span
              ><span v-else>—</span></template
            ></el-table-column
          ><el-table-column label="预估毛利" width="140" align="right"
            ><template #default="{ row }"
              ><span
                v-if="row.mapped"
                :class="
                  Number(row.gross_profit) >= 0
                    ? 'profit-positive'
                    : 'profit-negative'
                "
                >{{ signedMoney(row.gross_profit) }}</span
              ><span v-else>—</span></template
            ></el-table-column
          ></el-table
        ><el-empty
          v-else-if="!productLoading"
          :description="
            isMeituanGroupProductBoard
              ? '暂无美团团购收益明细，请先导入收益明细表。'
              : `暂无${platformProductName}菜品销量，请先在数据导入中上传“全部门店商品销量”报表`
          "
        />
        <footer
          v-if="productAnalytics.products.length"
          class="product-pagination"
        >
          <span>{{
            isMeituanGroupProductBoard
              ? "按菜品销售额从高到低排序"
              : "按商品销售额从高到低排序"
          }}</span
          ><el-pagination
            v-model:current-page="productPage"
            v-model:page-size="productPageSize"
            :page-sizes="[20, 50, 100]"
            :total="productAnalytics.products.length"
            layout="total, sizes, prev, pager, next"
            background
            @size-change="productPage = 1"
          />
        </footer>
        </div>
      </template>
    </section>
    <section v-else class="panel reconciliation-panel">
      <header>
        <div>
          <h3>收银系统与平台双向验证</h3>
          <p>
            按同一平台的收银机记录与平台到账逐日对比；实差金额 = 平台金额 −
            收银机金额，负数表示平台金额较低。外卖视角不会混入团购数据。
          </p>
        </div>
        <div
          v-if="!reconciliationLockedToCurrentPlatform"
          class="recon-channel-switch"
        >
          <el-segmented
            v-model="reconciliationChannel"
            :options="reconChannelOptions"
            @change="switchReconChannel"
          />
        </div>
      </header>
      <div class="reconciliation-summary">
        <article>
          <span>收银机金额</span
          ><strong>{{ money(reconciliationCashierAmount) }}</strong
          ><small>{{ reconciliationScopeLabel }}</small>
        </article>
        <article class="success">
          <span>平台金额</span
          ><strong>{{ money(reconciliationPlatformAmount) }}</strong
          ><small>当前筛选范围的平台到账汇总</small>
        </article>
        <article class="warning">
          <span>实差金额</span
          ><strong>{{ signedMoney(reconciliationDifferenceAmount) }}</strong
          ><small>平台金额 − 收银机金额</small>
        </article>
      </div>
      <el-table
        :data="reconciliationPageRows"
        class="reconciliation-table"
        stripe
        ><el-table-column
          prop="biz_date"
          label="日期"
          width="110"
        /><el-table-column
          prop="store_name"
          label="门店"
          min-width="170"
          show-overflow-tooltip
        /><el-table-column
          prop="channel_label"
          label="第三方平台"
          width="120"
        /><el-table-column label="收银机金额" width="132" align="right"
          ><template #default="{ row }">{{
            money(row.recorded)
          }}</template></el-table-column
        ><el-table-column label="平台金额" width="132" align="right"
          ><template #default="{ row }">{{
            money(row.actual)
          }}</template></el-table-column
        ><el-table-column label="平台费用" width="120" align="right"
          ><template #default="{ row }">{{
            money(row.fees)
          }}</template></el-table-column
        ><el-table-column label="实差金额" width="120" align="right"
          ><template #default="{ row }"
            ><span :class="differenceClass(row.difference)">{{
              signedMoney(row.difference)
            }}</span></template
          ></el-table-column
        ><el-table-column label="偏差率" width="100" align="right"
          ><template #default="{ row }">{{
            percent(row.difference_rate)
          }}</template></el-table-column
        ></el-table
      >
      <div v-if="reconciliationRows.length" class="reconciliation-pagination">
        <span
          >{{ reconciliationRows.length }} 条记录 · 每页
          {{ reconciliationPageSize }} 条 · 第 {{ reconciliationPage }} 页</span
        ><el-pagination
          v-model:current-page="reconciliationPage"
          :page-size="reconciliationPageSize"
          :total="reconciliationRows.length"
          layout="prev, pager, next"
          @current-change="handleReconciliationPage"
        />
      </div>
    </section>

    <el-dialog
      v-model="storeDetailVisible"
      :title="
        selectedStore
          ? `${selectedStore.store_name} · 门店经营数据`
          : '门店经营数据'
      "
      width="900px"
      class="store-detail-dialog"
      destroy-on-close
    >
      <p class="detail-period">统计范围：{{ detailRangeLabel }}</p>
      <div v-loading="storeDetailLoading" class="store-detail-content">
        <section class="detail-metric-grid">
          <article>
            <span>营业额</span
            ><strong>{{ money(storeDetail.totals.gross_amount) }}</strong>
          </article>
          <article>
            <span>营业收入（实收）</span
            ><strong>{{ money(storeDetail.totals.confirmed) }}</strong
            ><small>实收占比 {{ percent(detailActualRatio) }}</small>
          </article>
          <article>
            <span>订单量</span
            ><strong>{{ numberText(storeDetail.totals.order_count) }}</strong>
          </article>
          <article>
            <span>优惠金额</span
            ><strong>{{ money(storeDetail.totals.discount_amount) }}</strong
            ><small>优惠金额占比 {{ percent(detailDiscountRatio) }}</small>
          </article>
        </section>
        <section class="detail-table-grid">
          <article>
            <h4>渠道营业构成</h4>
            <el-table :data="detailChannelRows" size="small" stripe
              ><el-table-column
                prop="name"
                label="渠道"
                min-width="100"
              /><el-table-column label="营业额" min-width="100" align="right"
                ><template #default="{ row }">{{
                  money(row.gross)
                }}</template></el-table-column
              ><el-table-column label="实收" min-width="100" align="right"
                ><template #default="{ row }">{{
                  money(row.actual)
                }}</template></el-table-column
              ><el-table-column label="实收占比" min-width="88" align="right"
                ><template #default="{ row }">{{
                  percent(row.actualRatio)
                }}</template></el-table-column
              ></el-table
            >
          </article>
          <article>
            <h4>营业收入构成</h4>
            <el-table :data="detailIncomeRows" size="small" stripe
              ><el-table-column
                prop="name"
                label="收入字段"
                min-width="135"
              /><el-table-column label="实收" min-width="120" align="right"
                ><template #default="{ row }">{{
                  money(row.actual)
                }}</template></el-table-column
              ><el-table-column label="实收占比" min-width="98" align="right"
                ><template #default="{ row }">{{
                  percent(row.actualRatio)
                }}</template></el-table-column
              ></el-table
            >
          </article>
        </section>
      </div>
    </el-dialog>

    <el-dialog
      v-model="compareDialogVisible"
      title="设置环比时间"
      width="620px"
      class="compare-dialog"
      destroy-on-close
      @closed="handleCompareDialogClosed"
    >
      <div class="compare-form">
        <div>
          <h4>当前时间</h4>
          <p>
            {{
              compareCurrentLocked
                ? "当前页面已有查询结果，当前时间已锁定。"
                : "当前页面尚未查询，可在此编辑当前时间。"
            }}
          </p>
          <el-date-picker
            v-if="filters.timeMode === 'day'"
            v-model="compareCurrentSelection"
            :clearable="false"
            type="date"
            value-format="YYYY-MM-DD"
            :disabled="compareCurrentLocked"
            @change="updateCompareCurrent"
          /><el-date-picker
            v-else-if="filters.timeMode === 'week'"
            v-model="compareCurrentSelection"
            :clearable="false"
            type="week"
            value-format="YYYY-MM-DD"
            format="YYYY 第 ww 周"
            :disabled="compareCurrentLocked"
            @change="updateCompareCurrent"
          /><el-date-picker
            v-else-if="filters.timeMode === 'month'"
            v-model="compareCurrentSelection"
            :clearable="false"
            type="month"
            value-format="YYYY-MM"
            :disabled="compareCurrentLocked"
            @change="updateCompareCurrent"
          /><el-date-picker
            v-else
            v-model="compareCurrentSelection"
            :clearable="false"
            class="compact-range-picker"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            :disabled="compareCurrentLocked"
            @change="updateCompareCurrent"
          />
        </div>
        <div>
          <h4>环比时间</h4>
          <p>{{ compareTimeHint }}</p>
          <el-date-picker
            v-if="filters.timeMode === 'day'"
            v-model="comparePreviousSelection"
            :clearable="false"
            type="date"
            value-format="YYYY-MM-DD"
            @change="updateComparePrevious"
          /><el-date-picker
            v-else-if="filters.timeMode === 'week'"
            v-model="comparePreviousSelection"
            :clearable="false"
            type="week"
            value-format="YYYY-MM-DD"
            format="YYYY 第 ww 周"
            @change="updateComparePrevious"
          /><el-date-picker
            v-else-if="filters.timeMode === 'month'"
            v-model="comparePreviousSelection"
            :clearable="false"
            type="month"
            value-format="YYYY-MM"
            @change="updateComparePrevious"
          /><el-date-picker
            v-else
            v-model="comparePreviousSelection"
            :clearable="false"
            class="compact-range-picker"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            @change="updateComparePrevious"
          />
        </div>
      </div>
      <template #footer
        ><el-button @click="compareDialogVisible = false">取消</el-button
        ><el-button
          type="primary"
          :disabled="!compareRangesReady"
          @click="applyCompareMode"
          >查询环比</el-button
        ></template
      >
    </el-dialog>

    <el-dialog
      v-model="diagnosisVisible"
      :title="diagnosis?.headline || 'AI 经营诊断'"
      width="760px"
      class="diagnosis-dialog"
      destroy-on-close
    >
      <div v-if="diagnosis" class="diagnosis-content">
        <div class="diagnosis-meta">
          <el-tag type="info" effect="light">模拟 AI · 测试阶段</el-tag
          ><span>诊断范围：{{ rangeLabel }}</span
          ><span
            >更新于：{{ diagnosis.updated_at || diagnosis.generated_at }}</span
          >
        </div>
        <p class="diagnosis-summary">{{ diagnosis.summary }}</p>
        <section class="diagnosis-metrics">
          <div>
            <span>营业额</span
            ><b>{{ money(diagnosis.metrics?.gross_amount) }}</b>
          </div>
          <div>
            <span>实收</span
            ><b>{{ money(diagnosis.metrics?.actual_amount) }}</b>
          </div>
          <div>
            <span>订单量</span
            ><b>{{ numberText(diagnosis.metrics?.order_count) }}</b>
          </div>
          <div>
            <span>优惠占比</span
            ><b>{{ percent(diagnosis.metrics?.discount_rate) }}</b>
          </div>
        </section>
        <section class="diagnosis-section">
          <h4>经营发现</h4>
          <article
            v-for="item in diagnosis.findings"
            :key="item.title"
            :class="item.level"
          >
            <b>{{ item.title }}</b>
            <p>{{ item.detail }}</p>
          </article>
        </section>
        <section class="diagnosis-section">
          <h4>改进建议</h4>
          <ol>
            <li v-for="item in diagnosis.recommendations" :key="item">
              {{ item }}
            </li>
          </ol>
        </section>
      </div>
      <el-empty v-else description="暂无已保存的诊断结果" />
    </el-dialog>

    <el-dialog
      v-model="sourceDialogVisible"
      title="真实数据视角 · 平台来源"
      width="720px"
      class="source-config-dialog"
      destroy-on-close
    >
      <p class="source-dialog-hint">
        该配置仅在“真实第三方”视角生效：店内销售与自提固定取收银机，其余平台可逐项指定收银机或第三方报表。切回“收银机”时，所有线上渠道会统一使用收银机入账记录。
      </p>
      <div class="platform-source-grid">
        <article v-for="item in platformSourceOptions" :key="item.key">
          <div>
            <b>{{ item.label }}</b
            ><small>{{ item.note }}</small>
          </div>
          <el-radio-group
            v-model="filters.sourceOverrides[item.key]"
            size="small"
            ><el-radio-button label="platform">第三方</el-radio-button
            ><el-radio-button label="pos"
              >收银机</el-radio-button
            ></el-radio-group
          >
        </article>
      </div>
      <template #footer
        ><el-button @click="sourceDialogVisible = false">取消</el-button
        ><el-button
          type="primary"
          @click="
            sourceDialogVisible = false;
            ElMessage.info('平台来源已调整，请点击查询应用新口径');
          "
          >确认选择</el-button
        ></template
      >
    </el-dialog>
  </div>
</template>

<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { useRoute } from "vue-router";
import * as echarts from "echarts";
import { Search } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import {
  generateBusinessDiagnosis,
  getBusinessAnalytics,
  getBusinessDiagnosis,
  getBusinessProductAnalytics,
  getDishSalesAnalytics,
  getMeituanOperation,
  getMenuItems,
  getStores,
  saveBusinessProductMapping,
  saveDishSalesMapping,
} from "@/api";
import StoreRegionSelect from "@/components/StoreRegionSelect.vue";
import { groupOperationMetrics } from "@/utils/group-operation";

const route = useRoute();
const pageMeta = Object.freeze({ ...route.meta, routePath: route.path });
const timeModes = [
  { label: "日数据", value: "day" },
  { label: "周数据", value: "week" },
  { label: "月数据", value: "month" },
  { label: "自定义时间", value: "custom" },
];
const baseTabs = [
  { label: "经营总览", value: "overview" },
  { label: "双向核对", value: "reconciliation" },
];
const groupPlatforms = ["美团团购", "抖音团购"];
const deliveryPlatforms = ["美团外卖", "淘宝闪购", "京东外卖"];
const activeTab = ref("overview"),
  loading = ref(false),
  storeOptions = ref([]),
  trendChartRef = ref(),
  compositionChartRef = ref(),
  channelCompositionChartRef = ref(),
  hourlyOrderChartRef = ref();
const groupQueryVisible = ref(false),
  groupQueryStep = ref(0);
const groupQuerySteps = computed(() => {
  if (analysisScope.value === "total")
    return ["正在校验全域门店数据", "正在汇总经营账单", "正在生成总览趋势"];
  if (analysisScope.value === "delivery")
    return ["正在校验外卖筛选范围", "正在汇总外卖平台账单", "正在生成外卖趋势"];
  return ["正在校验筛选范围", "正在汇总平台账单", "正在生成经营趋势"];
});
const queryFeedbackTitle = computed(() => {
  if (analysisScope.value === "total") return "正在校验总视角数据";
  if (analysisScope.value === "delivery") return "正在校验外卖数据";
  return `正在校准${operationPlatformName.value}数据`;
});
const groupQueryStepText = computed(
  () => groupQuerySteps.value[groupQueryStep.value] || groupQuerySteps.value[0],
);
let groupQueryToken = 0,
  groupQueryInterval = null;
function beginGroupQueryFeedback() {
  const token = ++groupQueryToken;
  clearInterval(groupQueryInterval);
  groupQueryVisible.value = true;
  groupQueryStep.value = 0;
  const startedAt = Date.now();
  groupQueryInterval = setInterval(() => {
    if (token === groupQueryToken)
      groupQueryStep.value =
        (groupQueryStep.value + 1) % groupQuerySteps.value.length;
  }, 460);
  return { token, startedAt };
}
async function finishGroupQueryFeedback(feedback) {
  if (!feedback || feedback.token !== groupQueryToken) return;
  const wait = Math.max(0, 980 - (Date.now() - feedback.startedAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  if (feedback.token === groupQueryToken) {
    clearInterval(groupQueryInterval);
    groupQueryInterval = null;
    groupQueryVisible.value = false;
  }
}
const storeDetailVisible = ref(false),
  storeDetailLoading = ref(false),
  selectedStore = ref(null),
  detailRangeLabel = ref("");
const compareMode = ref(false),
  compareDialogVisible = ref(false),
  compareCurrentLocked = ref(false),
  compareCurrentRange = ref([]),
  comparePreviousRange = ref([]),
  compareCurrentSelection = ref(null),
  comparePreviousSelection = ref(null),
  hasQueried = ref(false);
const reconciliationPage = ref(1),
  reconciliationPageSize = ref(20);
const deliveryReconChannelOptions = [
  { label: "全部", value: "" },
  { label: "美团外卖", value: "meituan_delivery" },
  { label: "淘宝闪购", value: "taobao_flash" },
  { label: "京东外卖", value: "jd_delivery" },
];
const groupBuyReconChannelOptions = [
  { label: "全部", value: "" },
  { label: "美团团购", value: "meituan_group" },
  { label: "抖音团购", value: "douyin_group" },
];
const totalReconChannelOptions = [
  { label: "全部", value: "" },
  ...deliveryReconChannelOptions.slice(1),
  ...groupBuyReconChannelOptions.slice(1),
];
const reconChannelOptions = computed(() =>
  analysisScope.value === "delivery"
    ? deliveryReconChannelOptions
    : analysisScope.value === "group-buy"
      ? groupBuyReconChannelOptions
      : totalReconChannelOptions,
);
const reconciliationChannel = ref("");
function switchReconChannel() {
  reconciliationPage.value = 1;
}
const diagnosisVisible = ref(false),
  diagnosisLoading = ref(false),
  diagnosisAvailable = ref(false),
  diagnosis = ref(null),
  diagnosisSignatureAtQuery = ref("");
let trendChart,
  compositionChart,
  channelCompositionChart,
  hourlyOrderChart,
  chartFrame;
let mtTrendPlaybackTimer = null,
  mtTrendPlaybackToken = 0;
function toDateText(value) {
  return value.toISOString().slice(0, 10);
}
function yesterday() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return toDateText(date);
}
// 一周按 周一~周日：本周起点 = 今天 - (星期几+6)%7
function thisWeek() {
  const date = new Date();
  const start = new Date(date);
  start.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return [toDateText(start), toDateText(end)];
}
// 周选择器返回日先规整到所在周的周一（兼容周日起始的返回值），区间 = 周一 ~ 周日
function mondayOf(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
function fullWeekRange(value) {
  if (!value) return [];
  const date =
    value instanceof Date
      ? new Date(value)
      : new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return [];
  const start = mondayOf(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return [toDateText(start), toDateText(end)];
}
function thisMonth() {
  return toDateText(new Date()).slice(0, 7);
}
function monthRange(month) {
  const [year, value] = String(month || "")
    .split("-")
    .map(Number);
  if (!year || !value) return [];
  const text = `${year}-${String(value).padStart(2, "0")}`;
  return [`${text}-01`, `${text}-${new Date(year, value, 0).getDate()}`];
}
const filters = reactive({
  timeMode: "day",
  day: yesterday(),
  week: thisWeek()[0],
  month: thisMonth(),
  customRange: [],
  storeId: null,
  storeIds: [],
  deliveryStoreIds: [],
  platformStoreIds: [],
  platform: "",
  dataView: "real",
  sourceOverrides: {
    meituan_delivery: "platform",
    taobao_flash: "platform",
    jd_delivery: "platform",
    douyin_group: "platform",
    meituan_group: "platform",
  },
});
const data = reactive({
  totals: {},
  trend: [],
  reconciliation: [],
  reconciliation_total: 0,
  reconciliation_page: 1,
  reconciliation_page_size: 20,
  stores: [],
  revenue_composition: [],
  channel_breakdown: [],
  fee_detail_breakdown: [],
  meituan_group_fee_categories: [],
});
const dishAnalytics = reactive({ summary: {}, top: [], hourly_trend: [] });
const dishLoading = ref(false);
const dishSort = ref("income");
const dishPage = ref(1);
const dishPageSize = ref(20);
const dishTotal = ref(0);
const productAnalytics = reactive({ products: [], totals: {} });
const productLoading = ref(false);
const productPage = ref(1);
const productPageSize = ref(20);
const localMenuItems = ref([]);
const menuItemsLoading = ref(false);
const inlineSkuSearch = ref({});
// 平台视角在一次查询后预取三个平台与汇总结果；来回切换只替换内存数据，不重新请求接口。
const deliveryDatasetCache = new Map();
const deliveryDatasetPending = new Map();
const compareData = reactive({
  totals: {},
  stores: [],
  revenue_composition: [],
  channel_breakdown: [],
});
const storeDetail = reactive({
  totals: {},
  revenue_composition: [],
  channel_breakdown: [],
});
const analysisScope = computed(() => pageMeta.analysisScope || "total");
const analysisMode = computed(() => pageMeta.analysisMode || "brand");
const routePlatform = computed(() => pageMeta.analysisPlatform || "");
const scopeChannelGroup = computed(
  () =>
    ({ "group-buy": "group_buy", delivery: "delivery" })[analysisScope.value] ||
    "",
);
const scopedPlatforms = computed(() =>
  analysisScope.value === "group-buy"
    ? groupPlatforms
    : analysisScope.value === "delivery"
      ? deliveryPlatforms
      : [],
);
const effectivePlatform = computed(
  () => routePlatform.value || filters.platform,
);
// 门店视角可能还未选择具体平台；产品看板仍应有可读的兜底名称，不能把 undefined 渲染到界面。
const platformProductName = computed(
  () =>
    effectivePlatform.value ||
    (analysisScope.value === "group-buy" ? "团购平台" : "外卖平台"),
);
const localMenuSkuOptions = computed(() =>
  localMenuItems.value
    .filter(
      (item) =>
        (item.status || "在售") === "在售" &&
        !String(item.name || "").includes("员工餐") &&
        !String(item.category || "").includes("员工餐"),
    )
    .map((item) => ({
      id: Number(item.id),
      name: String(item.name || ""),
      spec: String(item.spec || ""),
      method: String(item.method || ""),
      category: item.category || "未分类",
      label: [
        item.name,
        item.spec && !["标准", "常规", "份"].includes(item.spec)
          ? item.spec
          : "",
        item.method && item.method !== "/" ? item.method : "",
      ]
        .filter(Boolean)
        .join(" · "),
    }))
    .sort(
      (a, b) =>
        a.category.localeCompare(b.category, "zh-CN") ||
        a.label.localeCompare(b.label, "zh-CN"),
    ),
);
const requiresPlatformRecord = computed(
  () => analysisScope.value === "delivery" && Boolean(effectivePlatform.value),
);
const isMeituanGroupProductBoard = computed(
  () =>
    analysisScope.value === "group-buy" &&
    effectivePlatform.value === "美团团购",
);
const isTotalProductBoard = computed(() => analysisScope.value === "total");
const hasProductBoard = computed(
  () =>
    isTotalProductBoard.value ||
    requiresPlatformRecord.value ||
    isMeituanGroupProductBoard.value,
);
const tabs = computed(() =>
  hasProductBoard.value
    ? [
        baseTabs[0],
        // 总数据视角的菜品销量已由「菜品销售分析」取代（字段口径更完整），
        // 外卖/团购平台看板仍叫「菜品销量」。
        {
          label: isTotalProductBoard.value ? "菜品销售分析" : "菜品销量",
          value: "products",
        },
        baseTabs[1],
      ]
    : baseTabs,
);
const showPlatformSelect = computed(
  () => analysisMode.value === "store" && scopedPlatforms.value.length > 0,
);
const viewConfig = computed(() => ({
  title: pageMeta.analysisTitle || "总数据视角",
  description:
    analysisScope.value === "total"
      ? "从日、周、月和自定义时间四种口径，查看品牌整体或所选门店的经营汇总。"
      : analysisMode.value === "brand"
        ? `${analysisScope.value === "group-buy" ? "团购" : "外卖"}品牌汇总：锁定全门店范围，可按平台切换查看或查看全部平台汇总。`
        : analysisMode.value === "store"
          ? `${analysisScope.value === "group-buy" ? "团购" : "外卖"}门店汇总：可选择门店范围，并按平台查看经营、趋势、核对与菜品数据。`
          : `${analysisScope.value === "group-buy" ? "团购" : "外卖"}平台视角：按平台查看经营、趋势、核对与菜品数据，并可限定门店范围。`,
}));
const scopeChip = computed(
  () =>
    routePlatform.value ||
    (analysisScope.value === "total"
      ? "总数据汇总"
      : analysisScope.value === "group-buy"
        ? filters.platform ||
          (analysisMode.value === "brand" ? "团购品牌汇总" : "团购平台汇总")
        : filters.platform ||
          (analysisMode.value === "brand" ? "外卖品牌汇总" : "外卖平台汇总")),
);
const timeModeLabel = computed(
  () =>
    timeModes.find((item) => item.value === filters.timeMode)?.label ||
    "日数据",
);
const trendTimeModeLabel = computed(() =>
  analysisMode.value === "store" ? "日" : timeModeLabel.value,
);
const scopedStoreIds = computed(() =>
  analysisScope.value === "delivery" || analysisScope.value === "group-buy"
    ? filters.deliveryStoreIds
    : filters.storeIds,
);
const activeRange = computed(() =>
  filters.timeMode === "day"
    ? [filters.day, filters.day]
    : filters.timeMode === "week"
      ? fullWeekRange(filters.week)
      : filters.timeMode === "month"
        ? monthRange(filters.month)
        : filters.customRange,
);
const reportRange = computed(() =>
  compareMode.value ? compareCurrentRange.value : activeRange.value,
);
const deliverySettlementSources = {
  美团外卖: {
    daily: "营业日报",
    income: "营业日报 / 账单核对",
    fee: "结算账单",
    settled: "结算账单",
  },
  淘宝闪购: {
    daily: "营业日报",
    income: "营业日报 / 账单核对",
    fee: "账单汇总",
    settled: "账单汇总",
  },
  // 京东目前导入的是营业日报。未导入结算账单前，收入与到账相同，不能误标为已结算。
  京东外卖: {
    daily: "营业日报",
    income: "营业日报",
    fee: "待导入结算账单",
    settled: "营业日报（当前）",
  },
};
const isDeliverySettlementView = computed(
  () =>
    analysisScope.value === "delivery" &&
    Boolean(deliverySettlementSources[effectivePlatform.value]),
);
const isSettlementTrend = computed(
  () =>
    analysisScope.value === "delivery" || analysisScope.value === "group-buy",
);
const settlementSource = computed(
  () =>
    deliverySettlementSources[effectivePlatform.value] || {
      daily: "日报",
      income: "日报",
      fee: "账单",
      settled: "账单",
    },
);
const sourceDialogVisible = ref(false);

const platformSourceOptions = [
  {
    key: "meituan_delivery",
    label: "美团外卖",
    note: "美团外卖平台日报 / 结算数据",
  },
  { key: "taobao_flash", label: "淘宝闪购", note: "闪购日报 / 账单汇总" },
  {
    key: "jd_delivery",
    label: "京东外卖（京东秒送）",
    note: "京东平台营业数据",
  },
  { key: "douyin_group", label: "抖音团购", note: "抖音团购平台数据" },
  { key: "meituan_group", label: "美团团购", note: "美团/大众点评团购及支付" },
];
const isMeituanGroupBuyView = computed(
  () =>
    analysisScope.value === "group-buy" &&
    effectivePlatform.value === "美团团购",
);
const isGroupOperationView = computed(
  () =>
    analysisScope.value === "group-buy" &&
    ["美团团购", "抖音团购"].includes(effectivePlatform.value),
);
const isMeituanOperationView = computed(
  () =>
    (analysisScope.value === "delivery" &&
      deliveryPlatforms.includes(effectivePlatform.value)) ||
    isGroupOperationView.value,
);
const operationPlatformName = computed(
  () => effectivePlatform.value || "外卖平台",
);
const isTaobaoOperation = computed(
  () => effectivePlatform.value === "淘宝闪购",
);
const isJdOperation = computed(() => effectivePlatform.value === "京东外卖");
// 是否为美团外卖页面（不依赖数据加载），公式条按页面切换展示
const isMeituanPage = computed(
  () =>
    analysisScope.value === "delivery" &&
    effectivePlatform.value === "美团外卖",
);
const isDirectSettlementOperation = computed(
  () => isMeituanPage.value || isJdOperation.value,
);
const meituanOpLoaded = ref(false);
const meituanOpTotals = ref({ days: 0, stores_count: 0, totals: {} });
const meituanOpStores = ref([]);
const meituanOpTrend = ref([]);
const mtTrendChartRef = ref();
let mtTrendChart = null;
const mtGroupTrendSection = ref("revenue");
const groupMtMetricOptions = computed(
  () => groupOperationMetrics[effectivePlatform.value] || [],
);
const currentMtMetricOptions = computed(() =>
  isGroupOperationView.value ? groupMtMetricOptions.value : mtMetricOptions,
);
const mtGroupMetricOn = reactive({});
function mtGroupMetricActive(key) {
  return mtGroupMetricOn[`${effectivePlatform.value}:${key}`] !== false;
}
function switchGroupMtMetric(key) {
  const metric = groupMtMetricOptions.value.find((item) => item.key === key);
  if (!metric) return;
  const selected = groupMtMetricOptions.value.filter(
    (item) => item.section === metric.section && mtGroupMetricActive(item.key),
  );
  if (mtGroupMetricActive(key) && selected.length === 1) return;
  mtGroupMetricOn[`${effectivePlatform.value}:${key}`] =
    !mtGroupMetricActive(key);
  renderMeituanTrends();
}
function formatGroupMetric(value, item) {
  if (value == null) return "—";
  return item.unit === "money"
    ? money(value)
    : item.unit === "percent"
      ? percent(value)
      : item.unit === "rating"
        ? Number(value).toFixed(1)
        : numberText(value);
}
function switchGroupMtSection(section) {
  mtGroupTrendSection.value = section;
  renderMeituanTrends();
}
const mtMetricOptions = [
  { key: "income_amount", label: "营业收入", unit: "money", group: true },
  { key: "gross_amount", label: "优惠前总额", unit: "money", group: true },
  { key: "order_count", label: "有效订单", unit: "count", group: true },
  { key: "impression_users", label: "曝光人数", unit: "count" },
  { key: "visit_users", label: "入店人数", unit: "count" },
  { key: "ordering_users", label: "下单人数", unit: "count" },
  { key: "visit_rate", label: "入店转化率", unit: "percent" },
  { key: "order_rate", label: "下单转化率", unit: "percent" },
];
// 交互：营业收入/优惠前总额/有效订单 可叠加共存（点击切换显隐）；
// 其它字段（曝光/入店/下单/转化率）点击后清掉组合，只单独渲染该字段走势图
const mtGroupOn = reactive({
  income_amount: true,
  gross_amount: true,
  order_count: true,
});
const mtSingleKey = ref("");
function switchMtMetric(key) {
  const metric = currentMtMetricOptions.value.find((item) => item.key === key);
  if (!metric) return;
  if (metric.group) {
    mtSingleKey.value = "";
    mtGroupOn[key] = !mtGroupOn[key];
    if (!Object.values(mtGroupOn).some(Boolean)) mtGroupOn[key] = true;
  } else {
    mtSingleKey.value = mtSingleKey.value === key ? "" : key;
  }
  renderMeituanTrends();
}
function mtIsActive(key) {
  const metric = currentMtMetricOptions.value.find((item) => item.key === key);
  if (!metric) return false;
  return metric.group ? mtGroupOn[key] : mtSingleKey.value === key;
}
let operationRequest = 0;
async function loadMeituanOperation() {
  const request = ++operationRequest;
  const range = reportRange.value;
  const platform = effectivePlatform.value;
  if (
    !isMeituanOperationView.value ||
    range?.length !== 2 ||
    !range[0] ||
    !range[1]
  ) {
    meituanOpLoaded.value = false;
    return;
  }
  try {
    const result = await getMeituanOperation({
      ...currentStoreScope(),
      platform,
      date_from: range[0],
      date_to: range[1],
    });
    if (request !== operationRequest || platform !== effectivePlatform.value)
      return;
    meituanOpTotals.value = {
      days: result.days || 0,
      stores_count: result.stores_count || 0,
      totals: result.totals || {},
    };
    meituanOpStores.value = result.stores || [];
    meituanOpTrend.value = result.trend || [];
    meituanOpLoaded.value = true;
    await nextTick();
    renderMeituanTrends();
    mtTrendChart?.resize();
  } catch (error) {
    if (request !== operationRequest) return;
    meituanOpLoaded.value = false;
    ElMessage.error(error.message || "经营数据加载失败");
  }
}
watch(effectivePlatform, () => {
  operationRequest++;
  meituanOpLoaded.value = false;
});
watch(mtTrendChartRef, async (target) => {
  if (mtTrendChart && mtTrendChart.getDom() !== target) {
    mtTrendChart.dispose();
    mtTrendChart = null;
  }
  if (target) {
    await nextTick();
    renderMeituanTrends();
    mtTrendChart?.resize();
  }
});
function groupMetricSectionLabel(item) {
  return (
    { revenue: "经营收入", traffic: "流量转化", rating: "评分评价" }[
      item?.section
    ] || "经营指标"
  );
}
function groupMetricHint(item) {
  if (item?.unit === "percent") return "按汇总人数重新计算";
  if (item?.unit === "rating") return "门店评分均值";
  if (item?.unit === "money") return "当前筛选范围合计";
  return item?.key === "review_count" ? "当前累计评价" : "当前筛选范围汇总";
}
function mtNumSeries(rows, key) {
  return rows.map((row) => (row[key] == null ? null : Number(row[key])));
}
// ECharts 的 animationDelay 在部分浏览器的图表重建场景不会逐点执行。
// 因此先绘制空数据，再把每个周期依次补进来，确保每次查询都有从左到右的走势动画。
function renderMeituanTrendPlayback(chart, option) {
  if (!chart) return;
  clearTimeout(mtTrendPlaybackTimer);
  const token = ++mtTrendPlaybackToken;
  const targetSeries = option.series || [];
  const length = Math.max(
    0,
    ...targetSeries.map((series) =>
      Array.isArray(series.data) ? series.data.length : 0,
    ),
  );
  const stagedSeries = targetSeries.map((series) => ({
    ...series,
    data: Array.isArray(series.data) ? series.data.map(() => null) : [],
    animationDelay: 0,
  }));
  chart.clear();
  chart.setOption(
    {
      ...option,
      animation: false,
      series: stagedSeries,
    },
    true,
  );
  if (!length) return;

  const revealed = targetSeries.map((series) =>
    Array.isArray(series.data) ? series.data.map(() => null) : [],
  );
  let index = 0;
  const revealNext = () => {
    if (token !== mtTrendPlaybackToken || index >= length) return;
    targetSeries.forEach((series, seriesIndex) => {
      if (Array.isArray(series.data) && index < series.data.length)
        revealed[seriesIndex][index] = series.data[index];
    });
    chart.setOption({
      animation: true,
      animationDurationUpdate: 260,
      animationEasingUpdate: "cubicOut",
      series: targetSeries.map((series, seriesIndex) => ({
        id: series.id,
        name: series.name,
        type: series.type,
        data: revealed[seriesIndex],
      })),
    });
    index += 1;
    if (index < length) mtTrendPlaybackTimer = setTimeout(revealNext, 58);
  };
  requestAnimationFrame(revealNext);
}
// 交互式单图：
// - 组合模式（点营业收入/优惠前总额/有效订单 任意组合叠加，常驻三项默认全开）
// - 单独模式（点曝光人数/入店人数/下单人数/转化率等：清掉组合只渲染该字段）
function renderMeituanTrends() {
  if (!isMeituanOperationView.value || !meituanOpLoaded.value) return;
  const rows = meituanOpTrend.value;
  if (!rows.length) {
    clearTimeout(mtTrendPlaybackTimer);
    mtTrendPlaybackToken += 1;
    mtTrendChart?.clear();
    return;
  }
  if (!mtTrendChartRef.value) return;
  mtTrendChart = reuseChart(mtTrendChart, mtTrendChartRef.value);
  const dates = rows.map((row) => row.date);
  const single =
    currentMtMetricOptions.value.find(
      (item) => item.key === mtSingleKey.value && !item.group,
    ) || null;
  const moneyAxis = (value) =>
    value >= 10000 ? `${(value / 10000).toFixed(1)}万` : value;
  const baseOption = {
    // 顶层只开动画开关；"从左到右生长"由各 series 逐点 animationDelay 驱动（见 line/bar 构造）。
    // setOption 使用 notMerge，每次查询/切换指标都重建，入场动画随之重新播放。
    animation: true,
    animationDuration: 700,
    animationDurationUpdate: 500,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicInOut",
    tooltip: {
      trigger: "axis",
      backgroundColor: "#fff",
      borderColor: "#e2e8f0",
      padding: [10, 14],
      textStyle: { color: "#334155", fontSize: 12 },
      extraCssText:
        "box-shadow:0 14px 34px rgba(15,23,42,.1);border-radius:10px",
      axisPointer: {
        type: "shadow",
        shadowStyle: { color: "rgba(30,64,175,.05)" },
      },
    },
    // 指标已在卡片标题右侧统一控制，图内不再重复放图例，以免压住右侧坐标轴。
    legend: { show: false },
    grid: { left: 12, right: 54, top: 22, bottom: 12, containLabel: true },
    xAxis: {
      type: "category",
      data: dates,
      axisLine: { lineStyle: { color: "#eef1f6" } },
      axisTick: { show: false },
      axisLabel: { color: "#94a3b8", fontSize: 10 },
    },
  };
  if (isGroupOperationView.value) {
    const section = mtGroupTrendSection.value;
    const axis = (name, color, formatter = (value) => numberText(value)) => ({
      type: "value",
      name,
      nameLocation: "end",
      nameGap: 10,
      nameTextStyle: { color, fontSize: 10, align: "right" },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color, fontSize: 10, formatter },
      splitLine: {
        lineStyle: { color: "rgba(148,163,184,.16)", type: "dashed" },
      },
    });
    const bar = (name, key, color, yAxisIndex = 0) => ({
      id: key,
      name,
      type: "bar",
      yAxisIndex,
      data: mtNumSeries(rows, key),
      barMaxWidth: 18,
      animationDuration: 380,
      animationEasing: "cubicOut",
      animationDelay: (idx) => idx * 110,
      itemStyle: { color, borderRadius: [4, 4, 0, 0] },
      tooltip: {
        valueFormatter: (value) =>
          key.includes("amount") ? money(value) : numberText(value),
      },
    });
    const line = (name, key, color, yAxisIndex = 0, percentValue = false) => ({
      id: key,
      name,
      type: "line",
      yAxisIndex,
      data: percentValue
        ? rows.map((row) =>
            row[key] == null
              ? null
              : Math.round(Number(row[key]) * 10000) / 100,
          )
        : key.includes("rating")
          ? rows.map((row) =>
              row[key] == null ? null : Number(Number(row[key]).toFixed(1)),
            )
          : mtNumSeries(rows, key),
      smooth: 0.35,
      symbol: "circle",
      symbolSize: 7,
      animationDuration: 380,
      animationEasing: "cubicOut",
      animationDelay: (idx) => idx * 110,
      lineStyle: { width: 2.4, color },
      itemStyle: { color, borderColor: "#fff", borderWidth: 2 },
      tooltip: {
        valueFormatter: (value) =>
          percentValue
            ? `${value}%`
            : key.includes("amount")
              ? money(value)
              : key.includes("rating")
                ? Number(value).toFixed(1)
                : numberText(value),
      },
    });
    const axes =
      section === "revenue"
        ? [
            axis("金额（元）", "#94a3b8", moneyAxis),
            axis("订单（单）", "#b4891f"),
          ]
        : section === "traffic"
          ? [
              axis("人数", "#94a3b8"),
              axis("转化率", "#0f9d7b", (value) => `${value}%`),
            ]
          : [
              axis("星级", "#7859a7", (value) => Number(value).toFixed(1)),
              axis("评价数", "#8a97a7"),
            ];
    axes[1].splitLine = { show: false };
    if (section === "rating") {
      axes[0].scale = true;
      axes[0].minInterval = 0.1;
    }
    const series = groupMtMetricOptions.value
      .filter(
        (item) => item.section === section && mtGroupMetricActive(item.key),
      )
      .map((item) => {
        const right =
          item.unit === "percent" ||
          item.key === "order_count" ||
          (section === "rating" && item.unit === "count");
        return item.unit === "percent" ||
          item.unit === "rating" ||
          item.key === "order_count"
          ? line(
              item.label,
              item.key,
              item.color,
              right ? 1 : 0,
              item.unit === "percent",
            )
          : bar(item.label, item.key, item.color, right ? 1 : 0);
      });
    const options = { yAxis: axes, series };
    renderMeituanTrendPlayback(mtTrendChart, {
      ...baseOption,
      legend: {
        show: true,
        top: 0,
        right: 4,
        itemWidth: 9,
        itemHeight: 9,
        textStyle: { color: "#64748b", fontSize: 11 },
      },
      grid: { ...baseOption.grid, top: 42 },
      yAxis: options.yAxis,
      series: options.series,
    });
    return;
  }
  if (single) {
    // 单独模式：只渲染该字段
    const isPercent = single.unit === "percent";
    const data = isPercent
      ? rows.map(
          (row) => Math.round(Number(row[single.key] || 0) * 10000) / 100,
        )
      : mtNumSeries(rows, single.key);
    const color =
      single.unit === "count"
        ? "#2563eb"
        : single.unit === "money"
          ? "#1e40af"
          : "#0f9d7b";
    renderMeituanTrendPlayback(mtTrendChart, {
      ...baseOption,
      tooltip: {
        ...baseOption.tooltip,
        valueFormatter: (value) =>
          isPercent ? `${value}%` : numberText(value),
      },
      yAxis: [
        {
          type: "value",
          name: isPercent ? "转化率" : single.label,
          nameLocation: "end",
          nameGap: 10,
          nameTextStyle: { color: "#94a3b8", fontSize: 10, align: "right" },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: "#94a3b8",
            fontSize: 10,
            formatter: (value) =>
              isPercent
                ? `${value}%`
                : single.unit === "money"
                  ? moneyAxis(value)
                  : numberText(value),
          },
          splitLine: {
            lineStyle: { color: "rgba(148,163,184,.16)", type: "dashed" },
          },
        },
      ],
      series: [
        {
          name: single.label,
          type: "line",
          data,
          smooth: 0.35,
          symbol: "circle",
          symbolSize: 9,
          animationDuration: 380,
          animationEasing: "cubicOut",
          animationDelay: (idx) => idx * 110,
          lineStyle: { width: 2.5, color },
          itemStyle: { color, borderColor: "#fff", borderWidth: 2 },
          areaStyle: { color: `${color}1f` },
        },
      ],
    });
    return;
  }
  // 组合模式：营业收入/优惠前总额/有效订单 按需共存
  const series = [];
  const pointAnim = {
    animationDuration: 380,
    animationEasing: "cubicOut",
    animationDelay: (idx) => idx * 110,
  };
  if (mtGroupOn.income_amount)
    series.push({
      name: "营业收入",
      type: "bar",
      data: mtNumSeries(rows, "income_amount"),
      barWidth: 14,
      ...pointAnim,
      itemStyle: { color: "#1e40af", borderRadius: [4, 4, 0, 0] },
      tooltip: { valueFormatter: (value) => money(value) },
    });
  if (mtGroupOn.gross_amount)
    series.push({
      name: "优惠前总额",
      type: "bar",
      data: mtNumSeries(rows, "gross_amount"),
      barWidth: 14,
      ...pointAnim,
      itemStyle: { color: "#93c5fd", borderRadius: [4, 4, 0, 0] },
      tooltip: { valueFormatter: (value) => money(value) },
    });
  if (mtGroupOn.order_count)
    series.push({
      name: "有效订单",
      type: "line",
      yAxisIndex: 1,
      data: mtNumSeries(rows, "order_count"),
      smooth: 0.35,
      symbol: "circle",
      symbolSize: 9,
      ...pointAnim,
      lineStyle: { width: 2.5, color: "#f59e0b" },
      itemStyle: { color: "#f59e0b", borderColor: "#fff", borderWidth: 2 },
      tooltip: { valueFormatter: (value) => numberText(value) },
    });
  const showOrders = mtGroupOn.order_count;
  renderMeituanTrendPlayback(mtTrendChart, {
    ...baseOption,
    yAxis: [
      {
        type: "value",
        name: "金额（元）",
        nameLocation: "end",
        nameGap: 10,
        nameTextStyle: { color: "#94a3b8", fontSize: 10, align: "left" },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#94a3b8", fontSize: 10, formatter: moneyAxis },
        splitLine: {
          lineStyle: { color: "rgba(148,163,184,.16)", type: "dashed" },
        },
      },
      {
        type: "value",
        name: showOrders ? "订单（单）" : "",
        nameLocation: "end",
        nameGap: 10,
        nameTextStyle: { color: "#b4891f", fontSize: 10, align: "right" },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { color: "#b4891f", fontSize: 10 },
      },
    ],
    series,
  });
}
const isDirectGroupSettlementView = computed(
  () =>
    analysisScope.value === "group-buy" &&
    effectivePlatform.value === "抖音团购",
);
const showRevenueSourceControls = computed(
  () => analysisScope.value === "total",
);
const isTrueThirdPartyView = computed(
  () => analysisScope.value === "total" && filters.dataView === "real",
);
const platformSourceSummary = computed(
  () =>
    `${platformSourceOptions.filter((item) => filters.sourceOverrides[item.key] === "platform").length}/5 第三方`,
);
const channelCompositionDescription = computed(
  () =>
    `${rangeLabel.value} · 渠道字段和顺序固定；仅按当前数据视角切换每个渠道的取值来源。平台字段缺失时明确标记回退收银机。`,
);
const incomeCompositionTitle = computed(() => "营业收入构成");
const incomeCompositionDescription = computed(
  () =>
    `${rangeLabel.value} · 按收银经营日报“营业收入构成”付款字段汇总；不随数据视角切换为渠道表。`,
);
const incomeCompositionFieldLabel = computed(() => "收入字段");
const rangeLabel = computed(() =>
  reportRange.value?.length === 2 && reportRange.value[0]
    ? `${reportRange.value[0]} 至 ${reportRange.value[1]}`
    : "请选择时间范围",
);
const compareThemeActive = computed(
  () => compareMode.value || compareDialogVisible.value,
);
const compareTimeHint = computed(
  () =>
    ({
      day: "按单天与单天进行环比。",
      week: "按完整周一至周日与另一完整周进行环比。",
      month: "按整月与另一整月进行环比。",
      custom: "环比时间段始终可编辑。",
    })[filters.timeMode] || "环比时间始终可编辑。",
);
const aggregationPeriod = computed(() =>
  filters.timeMode === "week"
    ? "week"
    : filters.timeMode === "month"
      ? "month"
      : "day",
);
const scopeIncome = computed(() =>
  analysisScope.value === "group-buy"
    ? data.totals.group_buy || 0
    : analysisScope.value === "delivery"
      ? data.totals.delivery || 0
      : data.totals.confirmed || 0,
);
const previousScopeIncome = computed(() =>
  analysisScope.value === "group-buy"
    ? compareData.totals.group_buy || 0
    : analysisScope.value === "delivery"
      ? compareData.totals.delivery || 0
      : compareData.totals.confirmed || 0,
);
const compareRates = computed(() => ({
  gross_amount: compareRate(
    data.totals.gross_amount,
    compareData.totals.gross_amount,
  ),
  actual_amount: compareRate(scopeIncome.value, previousScopeIncome.value),
  order_count: compareRate(
    data.totals.order_count,
    compareData.totals.order_count,
  ),
  discount_amount: compareRate(
    data.totals.discount_amount,
    compareData.totals.discount_amount,
  ),
}));
const compareRangeHint = computed(
  () =>
    `当前 ${rangeLabel.value} 对比 ${comparePreviousRange.value?.[0] || "—"} 至 ${comparePreviousRange.value?.[1] || "—"}`,
);
const scopeIncomeRatio = computed(() =>
  data.totals.gross_amount
    ? Number(scopeIncome.value) / Number(data.totals.gross_amount)
    : 0,
);
const discountRatio = computed(() =>
  data.totals.gross_amount
    ? Number(data.totals.discount_amount || 0) /
      Number(data.totals.gross_amount)
    : 0,
);
// 美团外卖视角：顶部卡片改取“门店经营日报”口径（经营日报覆盖 7/1 起，含引擎未覆盖的日期）。
// 美团团购除外：卡片与“结算构成”链统一使用收益明细口径（售价/商家应得），运营日报只保留在经营指标面板。
const mtOpView = computed(
  () =>
    isMeituanOperationView.value &&
    meituanOpLoaded.value &&
    effectivePlatform.value !== "美团团购",
);
const mtOpTot = computed(() => meituanOpTotals.value?.totals || {});
const cardGross = computed(() =>
  mtOpView.value
    ? Number(mtOpTot.value.gross_amount || 0)
    : Number(data.totals.gross_amount || 0),
);
const grossValueText = computed(() =>
  isTrueThirdPartyView.value && data.totals.gross_pending
    ? "待补营业日报"
    : money(cardGross.value),
);
const mtOpIncomeRaw = computed(() =>
  isJdOperation.value
    ? Number(mtOpTot.value.platform_income_amount || 0)
    : Number(mtOpTot.value.income_amount || 0),
);
const mtOpActualRaw = computed(() => Number(mtOpTot.value.actual_amount || 0));
const mtOpFees = computed(() =>
  isTaobaoOperation.value
    ? Math.max(0, mtOpIncomeRaw.value - mtOpActualRaw.value)
    : Number(mtOpTot.value.fee_total || 0),
);
// 淘宝顶部卡展示运营日报“实际收入”（优惠后、未扣第三方费用）；最终到账只在结算链中展示。
const cardIncome = computed(() =>
  mtOpView.value
    ? isTaobaoOperation.value
      ? mtOpIncomeRaw.value
      : mtOpActualRaw.value || mtOpIncomeRaw.value
    : Number(scopeIncome.value || 0),
);
const cardOrders = computed(() =>
  mtOpView.value
    ? Number(mtOpTot.value.order_count || 0)
    : Number(data.totals.order_count || 0),
);
const cardDiscount = computed(() =>
  mtOpView.value
    ? Math.max(0, cardGross.value - mtOpIncomeRaw.value)
    : Number(data.totals.discount_amount || 0),
);
const cardIncomeRatio = computed(() =>
  cardGross.value ? cardIncome.value / cardGross.value : 0,
);
const cardDiscountRatio = computed(() =>
  cardGross.value ? cardDiscount.value / cardGross.value : 0,
);
// 结算拆解链：美团外卖视角与卡片/经营日报同一口径；实际到账 = 营业收入 − 平台费用
const chainGross = computed(() =>
  mtOpView.value ? cardGross.value : Number(data.totals.gross_amount || 0),
);
const chainDiscount = computed(() =>
  mtOpView.value
    ? cardDiscount.value
    : Number(data.totals.discount_amount || 0),
);
const chainIncome = computed(() =>
  mtOpView.value
    ? mtOpIncomeRaw.value
    : Number(data.totals.platform_income_amount || 0),
);
const chainFees = computed(() =>
  mtOpView.value ? mtOpFees.value : Number(data.totals.fees || 0),
);
const chainActual = computed(() =>
  mtOpView.value
    ? isTaobaoOperation.value
      ? mtOpActualRaw.value
      : mtOpActualRaw.value || mtOpIncomeRaw.value
    : Number(scopeIncome.value || 0),
);
const douyinSettlementIncome = computed(() =>
  Number(data.totals.gross_amount || 0),
);
const douyinSettlementExpense = computed(() => Number(data.totals.fees || 0));
const douyinSettlementActual = computed(() => Number(scopeIncome.value || 0));
const douyinSettlementOther = computed(() => 0);
const douyinSettlementRefund = computed(() =>
  Math.max(
    0,
    douyinSettlementIncome.value -
      douyinSettlementExpense.value +
      douyinSettlementOther.value -
      douyinSettlementActual.value,
  ),
);
const douyinExpenseItems = computed(() =>
  feeBreakdownItems.value.filter(
    (item) => Math.abs(Number(item.amount || 0)) > 0.005,
  ),
);
const hasRawFeeBreakdown = computed(
  () => (data.fee_detail_breakdown || []).length > 0,
);
const feeBreakdownItems = computed(() => {
  if (hasRawFeeBreakdown.value) return data.fee_detail_breakdown;
  const breakdown = data.totals.fee_breakdown || {};
  const list = [
    {
      key: "promotion_fee",
      label: "推广费",
      amount: Number(breakdown.promotion_fee || 0),
    },
    {
      key: "service_fee",
      label: "服务费",
      amount: Number(breakdown.service_fee || 0),
    },
    {
      key: "insurance_fee",
      label: "保障 / 保险",
      amount: Number(breakdown.insurance_fee || 0),
    },
    {
      key: "refund_amount",
      label: "退款及赔付",
      amount: Number(breakdown.refund_amount || 0),
    },
  ];
  return list.filter((item) => Math.abs(item.amount) > 0.005);
});
const MEITUAN_GROUP_FEE_CATEGORY_DEFAULTS = [
  { key: "promotion", label: "促销费" },
  { key: "service", label: "服务费" },
  { key: "merchant_refund", label: "商家承担退款" },
  { key: "other", label: "其他费用" },
  { key: "marketing", label: "推广费" },
];
const meituanGroupFeeCategories = computed(() => {
  const fromApi = new Map(
    (data.meituan_group_fee_categories || []).map((item) => [item.key, item]),
  );
  return MEITUAN_GROUP_FEE_CATEGORY_DEFAULTS.map((item) => {
    const value = fromApi.get(item.key);
    return {
      ...item,
      amount: Number(value?.amount || 0),
      details: value?.details || [],
    };
  });
});
const incomeLabel = computed(() =>
  isMeituanGroupBuyView.value
    ? "商家应得"
    : analysisScope.value === "total"
      ? "营业收入（实收）"
      : `${scopeChip.value}实收`,
);
const incomeHint = computed(() =>
  isMeituanGroupBuyView.value
    ? "收益明细 · 商家应得"
    : effectivePlatform.value
      ? "已固定至所选平台"
      : analysisScope.value === "total"
        ? "全部门店与渠道"
        : "当前渠道汇总",
);
const rankingTitle = computed(() => "门店实收排名");
const emptyDescription = computed(() =>
  filters.timeMode === "custom" && activeRange.value?.length !== 2
    ? "请先选择自定义时间范围"
    : "暂无统计数据，请先在左侧“数据导入”录入数据",
);
const channelKeyByPlatform = Object.freeze({
  美团外卖: "meituan_delivery",
  淘宝闪购: "taobao_flash",
  京东外卖: "jd_delivery",
  美团团购: "meituan_group",
  抖音团购: "douyin_group",
});
// 平台页锁定当前平台；外卖范围始终只允许三个外卖渠道，绝不把团购带入核对。
const reconOwnChannel = computed(() => {
  if (analysisScope.value === "delivery" && effectivePlatform.value)
    return channelKeyByPlatform[effectivePlatform.value] || "";
  return channelKeyByPlatform[routePlatform.value] || "";
});
const reconciliationLockedToCurrentPlatform = computed(() =>
  Boolean(reconOwnChannel.value),
);
const reconciliationScopeLabel = computed(() => {
  if (reconOwnChannel.value)
    return `仅核对${effectivePlatform.value || routePlatform.value}的收银记录`;
  if (analysisScope.value === "delivery")
    return "仅包含美团外卖、淘宝闪购、京东外卖";
  if (analysisScope.value === "group-buy") return "仅包含美团团购、抖音团购";
  return "包含美团外卖、淘宝闪购、京东外卖、美团团购、抖音团购";
});
const reconciliationRows = computed(() => {
  const own = reconOwnChannel.value;
  const wanted = own
    ? own.split(",")
    : reconciliationChannel.value
      ? reconciliationChannel.value.split(",")
      : [];
  return (data.reconciliation || []).filter((row) => {
    if (analysisScope.value === "delivery" && row.channel_group !== "delivery")
      return false;
    if (
      analysisScope.value === "group-buy" &&
      row.channel_group !== "group_buy"
    )
      return false;
    return !wanted.length || wanted.includes(row.channel);
  });
});
const reconciliationCount = computed(
  () =>
    reconciliationRows.value.filter(
      (row) => Math.abs(Number(row.difference || 0)) > 0.01,
    ).length,
);
const reconciliationMatchedCount = computed(
  () =>
    reconciliationRows.value.filter(
      (row) => Math.abs(Number(row.difference || 0)) <= 0.01,
    ).length,
);
const reconciliationExceptionCount = computed(
  () => reconciliationRows.value.length - reconciliationMatchedCount.value,
);
const reconciliationPageRows = computed(() =>
  reconciliationRows.value.slice(
    (reconciliationPage.value - 1) * reconciliationPageSize.value,
    reconciliationPage.value * reconciliationPageSize.value,
  ),
);
const reconciliationCashierAmount = computed(() =>
  reconciliationRows.value.reduce(
    (sum, row) => sum + Number(row.recorded || 0),
    0,
  ),
);
const reconciliationPlatformAmount = computed(() =>
  reconciliationRows.value.reduce(
    (sum, row) => sum + Number(row.actual || 0),
    0,
  ),
);
const reconciliationDifferenceAmount = computed(
  () => reconciliationPlatformAmount.value - reconciliationCashierAmount.value,
);
const chartSeries = computed(() =>
  analysisScope.value === "total"
    ? [
        { key: "offline", name: "线下堂食", color: "#3b82f6" },
        { key: "group_buy", name: "团购", color: "#8b5cf6" },
        { key: "delivery", name: "外卖", color: "#14b8a6" },
      ]
    : [
        {
          key: analysisScope.value === "group-buy" ? "group_buy" : "delivery",
          name: scopeChip.value,
          color: analysisScope.value === "group-buy" ? "#8b5cf6" : "#14b8a6",
        },
      ],
);
const channelCompositionItems = computed(() =>
  data.channel_breakdown
    .map((item) => ({ name: item.label, value: Number(item.amount || 0) }))
    .filter((item) => item.value),
);
const cashierCompositionTotal = computed(() =>
  data.revenue_composition.reduce(
    (total, item) => total + Number(item.amount || 0),
    0,
  ),
);
const cashierChannelRows = computed(() => {
  const normalize = (category) =>
    /美团\/大众点评(?:团购|支付)/.test(String(category || ""))
      ? "美团团购"
      : category;
  const current = new Map();
  const previous = new Map();
  (data.revenue_composition || []).forEach((item) => {
    const name = normalize(item.category);
    const existing = current.get(name) || {
      actual: 0,
      source: item.source || "收银经营日报",
    };
    current.set(name, {
      actual: existing.actual + Number(item.amount || 0),
      source: item.source || existing.source,
    });
  });
  (compareData.revenue_composition || []).forEach((item) => {
    const name = normalize(item.category);
    previous.set(
      name,
      Number(previous.get(name) || 0) + Number(item.amount || 0),
    );
  });
  return [...current.entries()]
    .map(([name, item]) => ({
      name,
      actual: item.actual,
      source: item.source,
      actualCompareRate: compareRate(item.actual, previous.get(name)),
      actualRatio: cashierCompositionTotal.value
        ? item.actual / cashierCompositionTotal.value
        : 0,
    }))
    .filter((item) => item.actual);
});
const incomeReconciliationLabel = computed(() =>
  Math.abs(cashierCompositionTotal.value - Number(scopeIncome.value || 0)) <
  0.01
    ? `实收已对齐 ${money(scopeIncome.value)}`
    : `待核对 · 差额 ${signedMoney(cashierCompositionTotal.value - Number(scopeIncome.value || 0))}`,
);
const channelCompositionTitle = computed(() => "渠道营业构成");
const displayedChannelRows = computed(() => channelTableRows.value);
const displayedChannelCompositionItems = computed(() =>
  displayedChannelRows.value
    .map((item) => ({ name: item.name, value: Number(item.actual || 0) }))
    .filter((item) => item.value),
);
const displayedChannelCompositionTotal = computed(() => scopeIncome.value);
const TOTAL_CHANNEL_ORDER = Object.freeze([
  "store_sales",
  "meituan_delivery",
  "taobao_flash",
  "jd_delivery",
  "pickup",
]);
const channelTableRows = computed(() => {
  const current = new Map(
    (data.channel_breakdown || []).map((item) => [item.channel, item]),
  );
  const previous = new Map(
    (compareData.channel_breakdown || []).map((item) => [item.channel, item]),
  );
  const sourceInfo = (source, status, missing) => {
    if (missing) return { label: "收银字段未上传", tone: "warning" };
    if (status === "platform_missing_fallback_pos")
      return { label: "平台缺失·收银机", tone: "warning" };
    if (source === "platform") return { label: "第三方", tone: "success" };
    if (source === "mixed") return { label: "混合口径", tone: "warning" };
    return { label: "收银机", tone: "info" };
  };
  return TOTAL_CHANNEL_ORDER.map((channel) => {
    const item = current.get(channel);
    const gross = Number(item?.gross_amount || 0);
    const actual = Number(item?.amount || 0);
    const missing =
      !item || (!isTrueThirdPartyView.value && gross === 0 && actual === 0);
    const source = sourceInfo(item?.source_used, item?.source_status, missing);
    return {
      name:
        item?.label ||
        {
          store_sales: "店内销售",
          meituan_delivery: "美团外卖",
          taobao_flash: "淘宝闪购",
          meituan_group: "美团团购",
          jd_delivery: "京东外卖",
          pickup: "自提销售",
        }[channel] ||
        channel,
      source: source.label,
      sourceTone: source.tone,
      gross,
      grossPending: Boolean(item?.gross_pending),
      actual,
      grossCompareRate: compareRate(gross, previous.get(channel)?.gross_amount),
      actualCompareRate: compareRate(actual, previous.get(channel)?.amount),
      actualRatio: scopeIncome.value ? actual / Number(scopeIncome.value) : 0,
    };
  });
});
const incomeTableRows = computed(() => cashierChannelRows.value);
const incomeCompositionItems = computed(() =>
  incomeTableRows.value
    .map((item) => ({ name: item.name, value: Number(item.actual || 0) }))
    .filter((item) => item.value),
);
const detailActualRatio = computed(() =>
  storeDetail.totals.gross_amount
    ? Number(storeDetail.totals.confirmed || 0) /
      Number(storeDetail.totals.gross_amount)
    : 0,
);
const detailDiscountRatio = computed(() =>
  storeDetail.totals.gross_amount
    ? Number(storeDetail.totals.discount_amount || 0) /
      Number(storeDetail.totals.gross_amount)
    : 0,
);
const detailChannelRows = computed(() =>
  storeDetail.channel_breakdown
    .map((item) => ({
      name: item.label,
      gross: Number(item.gross_amount || 0),
      actual: Number(item.amount || 0),
      actualRatio: storeDetail.totals.confirmed
        ? Number(item.amount || 0) / Number(storeDetail.totals.confirmed)
        : 0,
    }))
    .filter((item) => item.gross || item.actual),
);
const detailIncomeRows = computed(() =>
  storeDetail.revenue_composition
    .map((item) => ({
      name: item.category,
      actual: Number(item.amount || 0),
      actualRatio: storeDetail.totals.confirmed
        ? Number(item.amount || 0) / Number(storeDetail.totals.confirmed)
        : 0,
    }))
    .filter((item) => item.actual),
);
const rankingStores = computed(() => {
  if (!compareMode.value) return data.stores || [];
  const previous = new Map(
    (compareData.stores || []).map((store) => [store.store_id, store]),
  );
  return (data.stores || [])
    .map((store) => ({
      ...store,
      actual: Number(store.actual || 0),
      actualCompareRate: compareRate(
        store.actual,
        previous.get(store.store_id)?.actual,
      ),
    }))
    .sort((a, b) => b.actual - a.actual);
});
const customStoreRows = computed(() =>
  (data.stores || [])
    .map((store) => {
      const actual = Number(store.actual || 0);
      const orderCount = Number(store.order_count || 0);
      return {
        ...store,
        gross_amount: Number(store.gross_amount || 0),
        actual,
        order_count: orderCount,
        average_order: orderCount ? actual / orderCount : 0,
      };
    })
    .sort((a, b) => b.actual - a.actual),
);
const productPageRows = computed(() =>
  productAnalytics.products.slice(
    (productPage.value - 1) * productPageSize.value,
    productPage.value * productPageSize.value,
  ),
);
const rankingBands = computed(() => {
  const stores = rankingStores.value;
  if (!stores.length) return [];
  const rows = stores.map((store, index) => ({ ...store, rank: index + 1 }));
  if (rows.length <= 3) return [{ key: "top", label: "前三", rows }];
  const top = rows.slice(0, 3);
  const bottom = rows.slice(-3);
  const middleStart = Math.max(3, Math.floor((rows.length - 3) / 2));
  const middle = rows.slice(
    middleStart,
    Math.min(middleStart + 3, rows.length - 3),
  );
  return [
    { key: "top", label: "前三", rows: top },
    ...(middle.length ? [{ key: "middle", label: "中三", rows: middle }] : []),
    { key: "bottom", label: "后三", rows: bottom },
  ];
});
const requiresInitialStoreSelection = computed(
  () =>
    !hasQueried.value &&
    analysisMode.value === "store" &&
    ["delivery", "group-buy"].includes(analysisScope.value),
);
const hasRequiredInitialStore = computed(
  () => filters.deliveryStoreIds.length > 0,
);
const canQuery = computed(
  () =>
    !(filters.timeMode === "custom" && activeRange.value?.length !== 2) &&
    (!requiresInitialStoreSelection.value || hasRequiredInitialStore.value),
);
const compareRangesReady = computed(
  () =>
    compareCurrentRange.value?.length === 2 &&
    compareCurrentRange.value[0] &&
    compareCurrentRange.value[1] &&
    comparePreviousRange.value?.length === 2 &&
    comparePreviousRange.value[0] &&
    comparePreviousRange.value[1],
);
const diagnosisParams = computed(() => {
  const range = reportRange.value;
  return {
    period: aggregationPeriod.value,
    ...currentStoreScope(),
    channel_group: scopeChannelGroup.value || undefined,
    platform: effectivePlatform.value || undefined,
    require_platform_record: requiresPlatformRecord.value ? "1" : undefined,
    date_from: range?.[0] || "",
    date_to: range?.[1] || "",
  };
});
const diagnosisSignature = computed(() =>
  JSON.stringify({
    perspective_key: pageMeta.analysisKey || pageMeta.routePath,
    ...diagnosisParams.value,
  }),
);
const canDiagnose = computed(
  () =>
    hasQueried.value &&
    diagnosisSignatureAtQuery.value === diagnosisSignature.value,
);
const hasCurrentDiagnosis = computed(
  () => diagnosisAvailable.value && canDiagnose.value,
);
function money(value) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// 客单价 = 实收 ÷ 有效订单；实收口径与该行首列一致（京东有结算到账用实际到账，其余用优惠后收入）
function avgOrderValue(row) {
  const actual =
    isJdOperation.value && row.actual_amount != null
      ? Number(row.actual_amount)
      : Number(row.income_amount);
  const orders = Number(row.order_count) || 0;
  return orders > 0 ? actual / orders : 0;
}
function numberText(value) {
  return Number(value || 0).toLocaleString("zh-CN", {
    maximumFractionDigits: 0,
  });
}
function signedMoney(value) {
  const number = Number(value || 0);
  return `${number > 0 ? "+" : number < 0 ? "-" : ""}${money(Math.abs(number))}`;
}
function signedNumber(value) {
  const number = Number(value || 0);
  return `${number > 0 ? "+" : number < 0 ? "-" : ""}${Math.abs(number).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}
function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}
function compareRate(current, previous) {
  const now = Number(current || 0);
  const before = Number(previous || 0);
  if (!before) return now ? null : 0;
  return (now - before) / before;
}
function comparePercent(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}
function ratio(value, total) {
  return total ? `${((Number(value || 0) / total) * 100).toFixed(1)}%` : "0.0%";
}
function differenceClass(value) {
  return Math.abs(value) <= 0.01 ? "difference-ok" : "difference-warn";
}
function compareValueClass(value) {
  if (!compareMode.value || value == null) return "compare-flat";
  return value > 0 ? "compare-up" : value < 0 ? "compare-down" : "compare-flat";
}
function changeTimeMode(mode) {
  filters.timeMode = mode;
}
function currentStoreScope() {
  // 团购、外卖三种子视角共用平台框架：品牌汇总不传门店，
  // 平台/门店视角均从同一个门店范围控件取值。
  if (
    analysisScope.value === "delivery" ||
    analysisScope.value === "group-buy"
  ) {
    return {
      store_id: undefined,
      store_ids: ["store", "platform"].includes(analysisMode.value)
        ? filters.deliveryStoreIds.join(",") || undefined
        : undefined,
    };
  }
  return {
    store_id: undefined,
    store_ids:
      analysisMode.value === "store"
        ? filters.storeIds.join(",") || undefined
        : analysisMode.value === "platform"
          ? filters.platformStoreIds.join(",") || undefined
          : undefined,
  };
}
function clearData() {
  Object.assign(data, {
    totals: {},
    trend: [],
    reconciliation: [],
    reconciliation_total: 0,
    reconciliation_page: 1,
    reconciliation_page_size: reconciliationPageSize.value,
    stores: [],
    revenue_composition: [],
    channel_breakdown: [],
    fee_detail_breakdown: [],
    meituan_group_fee_categories: [],
  });
  Object.assign(dishAnalytics, { summary: {}, top: [], hourly_trend: [] });
  Object.assign(productAnalytics, { products: [], totals: {} });
  dishTotal.value = 0;
  dishPage.value = 1;
  productPage.value = 1;
  meituanOpLoaded.value = false;
  meituanOpTotals.value = { days: 0, stores_count: 0, totals: {} };
  meituanOpStores.value = [];
  meituanOpTrend.value = [];
  diagnosisVisible.value = false;
  diagnosisAvailable.value = false;
  diagnosis.value = null;
  diagnosisSignatureAtQuery.value = "";
}
function resetScopeFilters() {
  filters.storeId = null;
  filters.storeIds = [];
  filters.deliveryStoreIds = [];
  filters.platformStoreIds = [];
  filters.platform =
    analysisMode.value === "platform" ? scopedPlatforms.value[0] || "" : "";
}
function selectionToRange(value) {
  if (!value) return [];
  if (filters.timeMode === "day") return [value, value];
  if (filters.timeMode === "week") return fullWeekRange(value);
  if (filters.timeMode === "month") return monthRange(value);
  return Array.isArray(value) ? value : [];
}
function rangeToSelection(range) {
  if (!range?.length) return null;
  if (filters.timeMode === "day" || filters.timeMode === "week")
    return range[0];
  if (filters.timeMode === "month") return String(range[0]).slice(0, 7);
  return [...range];
}
function previousRange(range) {
  const start = new Date(`${range[0]}T12:00:00`);
  const end = new Date(`${range[1]}T12:00:00`);
  const days = Math.round((end - start) / 86400000) + 1;
  const previousEnd = new Date(start);
  previousEnd.setDate(previousEnd.getDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setDate(previousStart.getDate() - days + 1);
  return [toDateText(previousStart), toDateText(previousEnd)];
}
function analyticsParams(range, storeId, platformOverride) {
  const platform =
    platformOverride === undefined ? effectivePlatform.value : platformOverride;
  const dataView =
    isMeituanGroupBuyView.value || isDirectGroupSettlementView.value
      ? "real"
      : filters.dataView;
  return {
    period: aggregationPeriod.value,
    trend_period:
      isSettlementTrend.value || analysisMode.value === "store"
        ? "day"
        : undefined,
    ...(storeId
      ? { store_id: storeId, store_ids: undefined }
      : currentStoreScope()),
    channel_group: scopeChannelGroup.value || undefined,
    platform: platform || undefined,
    require_platform_record:
      analysisScope.value === "delivery" && deliveryPlatforms.includes(platform)
        ? "1"
        : undefined,
    data_view: dataView,
    source_overrides:
      dataView === "real" ? JSON.stringify(filters.sourceOverrides) : undefined,
    reconciliation_all: "1",
    date_from: range?.[0],
    date_to: range?.[1],
  };
}
function deliveryDatasetKey(range, platform) {
  return JSON.stringify({
    range,
    platform: platform || "",
    period: aggregationPeriod.value,
    storeIds: ["store", "platform"].includes(analysisMode.value)
      ? [...filters.deliveryStoreIds].map(Number).sort((a, b) => a - b)
      : [],
    dataView: filters.dataView,
    overrides: filters.sourceOverrides,
  });
}
async function fetchDeliveryDataset(range, platform) {
  const key = deliveryDatasetKey(range, platform);
  if (deliveryDatasetCache.has(key)) return deliveryDatasetCache.get(key);
  if (deliveryDatasetPending.has(key)) return deliveryDatasetPending.get(key);
  const pending = getBusinessAnalytics(
    "overview",
    analyticsParams(range, undefined, platform),
  )
    .then((result) => {
      deliveryDatasetCache.set(key, result);
      return result;
    })
    .finally(() => deliveryDatasetPending.delete(key));
  deliveryDatasetPending.set(key, pending);
  return pending;
}
async function warmDeliveryDatasets(range) {
  if (analysisScope.value !== "delivery" || !range?.[0] || !range?.[1]) return;
  const platforms =
    analysisMode.value === "platform"
      ? deliveryPlatforms
      : ["", ...deliveryPlatforms];
  await Promise.all(
    platforms.map((platform) => fetchDeliveryDataset(range, platform)),
  );
}
function updateCompareCurrent(value) {
  compareCurrentRange.value = selectionToRange(value);
}
function updateComparePrevious(value) {
  comparePreviousRange.value = selectionToRange(value);
}
function syncCurrentRangeToFilters(range) {
  if (filters.timeMode === "day") filters.day = range[0];
  else if (filters.timeMode === "week") filters.week = range[0];
  else if (filters.timeMode === "month")
    filters.month = String(range[0]).slice(0, 7);
  else filters.customRange = [...range];
}
function openCompareDialog() {
  const current =
    (compareMode.value ? reportRange.value : activeRange.value)?.length === 2
      ? [...(compareMode.value ? reportRange.value : activeRange.value)]
      : [];
  compareCurrentLocked.value = hasQueried.value;
  compareCurrentRange.value = current;
  if (!compareMode.value || !comparePreviousRange.value?.length)
    comparePreviousRange.value = current.length ? previousRange(current) : [];
  compareCurrentSelection.value = rangeToSelection(compareCurrentRange.value);
  comparePreviousSelection.value = rangeToSelection(comparePreviousRange.value);
  compareDialogVisible.value = true;
}
async function applyCompareMode() {
  if (!compareRangesReady.value) return;
  if (!compareCurrentLocked.value)
    syncCurrentRangeToFilters(compareCurrentRange.value);
  reconciliationPage.value = 1;
  compareMode.value = true;
  compareDialogVisible.value = false;
  await loadData();
}
function exitCompareMode() {
  compareMode.value = false;
  Object.assign(compareData, {
    totals: {},
    stores: [],
    revenue_composition: [],
    channel_breakdown: [],
  });
}
function handleCompareDialogClosed() {
  if (!compareMode.value) compareDialogVisible.value = false;
}
function queryData() {
  if (requiresInitialStoreSelection.value && !hasRequiredInitialStore.value) {
    ElMessage.warning("门店视角首次查询请先选择至少一个门店");
    return;
  }
  reconciliationPage.value = 1;
  // 只有用户主动“查询”才丢弃缓存；平台切换始终复用这一轮查询的结果。
  if (analysisScope.value === "delivery") {
    deliveryDatasetCache.clear();
    deliveryDatasetPending.clear();
  }
  return loadData();
}
async function switchDeliveryPlatform() {
  if (!["delivery", "group-buy"].includes(analysisScope.value)) return;
  // 门店视角的首轮数据必须先由用户明确门店范围，平台切换不能绕过该条件。
  // 首次成功查询后，门店范围会保留，后续切换平台直接复用当前范围查询即可。
  if (requiresInitialStoreSelection.value && !hasRequiredInitialStore.value) {
    ElMessage.warning("请先选择门店并点击查询，再切换平台");
    return;
  }
  // 切换即按当前日期、门店和数据视角查询；已有同轮数据直接复用缓存。
  // 这样首次切换平台也不需要再额外点击“查询”。
  reconciliationPage.value = 1;
  return loadData();
}
function handleReconciliationPage(page) {
  reconciliationPage.value = page;
}
async function refreshDiagnosis() {
  if (!hasQueried.value) return;
  const signature = diagnosisSignature.value;
  try {
    const result = await getBusinessDiagnosis({
      perspective_key: pageMeta.analysisKey || pageMeta.routePath,
      filter_signature: signature,
    });
    diagnosis.value = result.diagnosis || null;
    diagnosisAvailable.value = Boolean(result.diagnosis);
  } catch (error) {
    diagnosis.value = null;
    diagnosisAvailable.value = false;
  }
}
async function runDiagnosis() {
  if (!canDiagnose.value)
    return ElMessage.warning("请先按当前条件点击查询，再使用 AI 诊断");
  const isUpdating = hasCurrentDiagnosis.value;
  diagnosisLoading.value = true;
  try {
    const result = await generateBusinessDiagnosis({
      perspective_key: pageMeta.analysisKey || pageMeta.routePath,
      filter_signature: diagnosisSignature.value,
      perspective_title: viewConfig.value.title,
      analysis_params: diagnosisParams.value,
    });
    diagnosis.value = result.diagnosis || null;
    diagnosisAvailable.value = Boolean(diagnosis.value);
    diagnosisVisible.value = Boolean(diagnosis.value);
    ElMessage.success(isUpdating ? "诊断结果已更新" : "诊断结果已生成");
  } catch (error) {
    ElMessage.error(error.message || "诊断生成失败");
  } finally {
    diagnosisLoading.value = false;
  }
}
let analyticsRequestId = 0;
async function loadData() {
  const request = ++analyticsRequestId;
  const range = reportRange.value;
  if (
    (!compareMode.value &&
      filters.timeMode === "custom" &&
      range?.length !== 2) ||
    (compareMode.value && !compareRangesReady.value)
  ) {
    clearData();
    return;
  }
  const groupFeedback =
    analysisScope.value === "total" ||
    analysisScope.value === "delivery" ||
    isGroupOperationView.value
      ? beginGroupQueryFeedback()
      : null;
  loading.value = true;
  try {
    if (analysisScope.value === "delivery") {
      if (compareMode.value) {
        const [result, previous] = await Promise.all([
          fetchDeliveryDataset(range, effectivePlatform.value),
          fetchDeliveryDataset(
            comparePreviousRange.value,
            effectivePlatform.value,
          ),
        ]);
        Object.assign(data, result);
        Object.assign(compareData, previous);
        await Promise.all([
          warmDeliveryDatasets(range),
          warmDeliveryDatasets(comparePreviousRange.value),
        ]);
      } else {
        Object.assign(
          data,
          await fetchDeliveryDataset(range, effectivePlatform.value),
        );
        Object.assign(compareData, {
          totals: {},
          stores: [],
          revenue_composition: [],
          channel_breakdown: [],
        });
        await warmDeliveryDatasets(range);
      }
    } else if (compareMode.value) {
      const [result, previous] = await Promise.all([
        getBusinessAnalytics("overview", analyticsParams(range)),
        getBusinessAnalytics(
          "overview",
          analyticsParams(comparePreviousRange.value),
        ),
      ]);
      Object.assign(data, result);
      Object.assign(compareData, previous);
    } else {
      const result = await getBusinessAnalytics(
        "overview",
        analyticsParams(range),
      );
      if (request !== analyticsRequestId) return;
      Object.assign(data, result);
      Object.assign(compareData, {
        totals: {},
        stores: [],
        revenue_composition: [],
        channel_breakdown: [],
      });
    }
    reconciliationPage.value =
      Number(data.reconciliation_page) || reconciliationPage.value;
    hasQueried.value = true;

    diagnosisSignatureAtQuery.value = diagnosisSignature.value;
    if (isMeituanOperationView.value) await loadMeituanOperation();
    if (analysisScope.value === "total") await loadDishAnalytics();
    if (hasProductBoard.value) await loadProductAnalytics();
    await refreshDiagnosis();
    await nextTick();
  } catch (error) {
    if (request === analyticsRequestId) ElMessage.error(error.message);
  } finally {
    if (request === analyticsRequestId) {
      await finishGroupQueryFeedback(groupFeedback);
      loading.value = false;
      await nextTick();
      queueChartRender();
    }
  }
}
async function loadProductAnalytics() {
  const range = reportRange.value;
  if (!hasProductBoard.value || range?.length !== 2 || !range[0] || !range[1]) {
    Object.assign(productAnalytics, { products: [], totals: {} });
    return;
  }
  productLoading.value = true;
  try {
    const [result] = await Promise.all([
      getBusinessProductAnalytics(
        isTotalProductBoard.value
          ? "overview"
          : isMeituanGroupProductBoard.value
            ? "group-buy"
            : "delivery",
        {
          ...currentStoreScope(),
          channel_group: isTotalProductBoard.value
            ? undefined
            : isMeituanGroupProductBoard.value
              ? "group_buy"
              : "delivery",
          platform: isTotalProductBoard.value
            ? undefined
            : effectivePlatform.value,
          date_from: range[0],
          date_to: range[1],
        },
      ),
      ensureLocalMenuItems(),
    ]);
    Object.assign(productAnalytics, {
      products: result.products || [],
      totals: result.totals || {},
    });
    if (
      (productPage.value - 1) * productPageSize.value >=
      productAnalytics.products.length
    )
      productPage.value = 1;
  } catch (error) {
    Object.assign(productAnalytics, { products: [], totals: {} });
    ElMessage.error(
      error.message || `加载${platformProductName.value}菜品销售数据失败`,
    );
  } finally {
    productLoading.value = false;
  }
}
function productIndex(index) {
  return (productPage.value - 1) * productPageSize.value + index + 1;
}
// 菜品销售分析由服务端按排序分页，排名要带上前面的页数。
function dishIndex(index) {
  return (dishPage.value - 1) * dishPageSize.value + index + 1;
}
async function ensureLocalMenuItems({ force = false } = {}) {
  if ((!force && localMenuItems.value.length) || menuItemsLoading.value) return;
  menuItemsLoading.value = true;
  try {
    const result = await getMenuItems({ page: 1, page_size: 1000 });
    localMenuItems.value = result.items || [];
  } catch (error) {
    ElMessage.error(error.message || "本地菜品库加载失败");
  } finally {
    menuItemsLoading.value = false;
  }
}
async function refreshLocalMenuItems() {
  // 菜品管理可在另一页面新建 SKU；展开关联选择器时同步最新菜品库，
  // 避免当前分析页的旧缓存漏掉刚创建的菜品。
  await ensureLocalMenuItems({ force: true });
}
function dishRowKey(row) {
  return `${row?.product_code || ""}|${row?.product_name || ""}|${row?.spec || ""}`;
}
function productRowKey(row) {
  // 总数据「菜品销售分析」按 (菜品编码, 菜品名称, 规格) 聚合，绑定选择器的行键必须带规格，
  // 否则上庄/下庄这类同名不同规格的菜会共用同一个搜索框状态。
  if (isTotalProductBoard.value) return `dish::${dishRowKey(row)}`;
  return `${row?.platform || ""}::${row?.product_name || ""}`;
}
function bindingSuggestionKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(
      /[【\[](?:新客专享|外卖专享|限时特惠|热销推荐|招牌|人气|爆款|新品)[】\]]/g,
      "",
    )
    .replace(/[【】\[\]]/g, "")
    .replace(
      /[（(][^）)]*(?:例汤|靓汤|海咸鸭蛋|时蔬|柠檬茶|不含米饭)[^）)]*[）)]/g,
      "",
    )
    .replace(/[+＋]\s*(?:例汤|靓汤)(?=\s*$)/g, "")
    .replace(
      /(?:新客专享|外卖专享|限时特惠|热销推荐|招牌|人气|爆款|新品|经典港味|现烤现卖|太公推荐必点)/g,
      "",
    )
    .replace(/(?:含时蔬|含海咸鸭蛋|含例汤|含靓汤|不含米饭|不含白饭)/g, "")
    .replace(/[\s·•_—\-－，,。.!！:：/\\]/g, "")
    .trim();
}
function bindingFamilyKey(value) {
  return bindingSuggestionKey(value)
    .replace(/(?:太公|招牌|金牌|现烤|烧鹅|经典|超值|烧味)/g, "")
    .replace(/(?:约)?\d+(?:g|克|斤|两|ml|毫升)/g, "")
    .trim();
}
function menuSuggestionScore(row, menu) {
  const source = bindingSuggestionKey(row?.product_name);
  const target = bindingSuggestionKey(menu?.name);
  if (!source || !target) return 0;
  if (source === target) return 100;
  if (
    Math.min(source.length, target.length) >= 3 &&
    (source.includes(target) || target.includes(source))
  )
    return 82;
  const sourceFamily = bindingFamilyKey(row?.product_name);
  const targetFamily = bindingFamilyKey(menu?.name);
  if (sourceFamily.length >= 3 && sourceFamily === targetFamily) return 76;
  if (
    Math.min(sourceFamily.length, targetFamily.length) >= 3 &&
    (sourceFamily.includes(targetFamily) || targetFamily.includes(sourceFamily))
  )
    return 62;
  return 0;
}
function recommendedMenusFor(row) {
  return localMenuSkuOptions.value
    .map((menu) => ({ ...menu, score: menuSuggestionScore(row, menu) }))
    .filter((menu) => menu.score >= 62)
    .sort(
      (a, b) => b.score - a.score || a.label.localeCompare(b.label, "zh-CN"),
    )
    .slice(0, 8);
}
function recommendedMenuIds(row) {
  return recommendedMenusFor(row).map((menu) => menu.id);
}
function inlineMenuOptionsFor(row) {
  const keyword = String(inlineSkuSearch.value[productRowKey(row)] || "")
    .trim()
    .toLowerCase();
  const suggested = recommendedMenusFor(row);
  if (!keyword) return suggested;
  // 关键词只检索本地菜品名称；分类、规格和做法仅用于展示，不能作为命中条件。
  const matchesDishName = (menu) => menu.name.toLowerCase().includes(keyword);
  const matched = localMenuSkuOptions.value.filter(matchesDishName);
  const matchingSuggestions = suggested.filter(matchesDishName);
  const suggestedIds = new Set(matchingSuggestions.map((menu) => menu.id));
  return [
    ...matchingSuggestions,
    ...matched.filter((menu) => !suggestedIds.has(menu.id)),
  ].slice(0, 20);
}
async function bindProductFromAnalytics(row, menuId) {
  const menuItemId = Number(menuId);
  if (!menuItemId || !row?.product_name) return;
  const wasMapped = Boolean(row.mapped);
  try {
    // 只有外卖/团购平台商品走这张表；总数据视角的菜品绑定见 bindDishRowFromAnalytics。
    if (!row.platform) return;
    await saveBusinessProductMapping({
      scope: isMeituanGroupProductBoard.value ? "group-buy" : "delivery",
      platform: row.platform,
      external_product_name: row.product_name,
      menu_item_id: menuItemId,
    });
    ElMessage.success(
      `${wasMapped ? "已替换" : "已绑定"}「${row.product_name}」`,
    );
    await loadProductAnalytics();
  } catch (error) {
    ElMessage.error(error.message || "菜品绑定失败");
  }
}
// 总数据「菜品销售分析」的行内绑定：写 dish_sales_mappings（与「堂食菜品绑定」同一张表、同一唯一键）。
async function bindDishRowFromAnalytics(row, menuId) {
  const menuItemId = Number(menuId);
  if (!menuItemId || !row?.product_code || !row?.product_name) return;
  const wasMapped = Boolean(row.mapped);
  try {
    await saveDishSalesMapping({
      product_code: row.product_code,
      product_name: row.product_name,
      spec: row.spec,
      menu_item_id: menuItemId,
    });
    ElMessage.success(
      `${wasMapped ? "已替换" : "已绑定"}「${row.product_name}」`,
    );
    await loadDishAnalytics();
  } catch (error) {
    ElMessage.error(error.message || "菜品绑定失败");
  }
}
// 来源订单明细：菜品销售分析按 (编码,名称,规格) 聚合，来源明细按 (编码,名称) 从收银机
// 品项明细聚合结果里取，规格不参与匹配（源报表的明细行本身不带规格维度）。
const dishSourceDetailMap = computed(() => {
  const map = new Map();
  (productAnalytics.products || []).forEach((product) => {
    (product.breakdown || []).forEach((detail) => {
      const key = `${detail.product_code || ""}|${detail.product_name || ""}`;
      const list = map.get(key) || [];
      list.push(detail);
      map.set(key, list);
    });
  });
  return map;
});
function dishSourceDetails(row) {
  return (
    dishSourceDetailMap.value.get(
      `${row?.product_code || ""}|${row?.product_name || ""}`,
    ) || []
  );
}
// 赠品：源报表里「赠送数量/赠送金额」是已含在销量与销售额内的部分，只做标注不重复相加。
// dish_sales 表本身没有赠品列，所以按同一批来源明细（收银机品项明细）汇总到菜品行上。
const dishGiftMap = computed(() => {
  const map = new Map();
  dishSourceDetailMap.value.forEach((details, key) => {
    map.set(
      key,
      details.reduce(
        (acc, detail) => ({
          quantity: acc.quantity + Number(detail.gift_quantity || 0),
          amount: acc.amount + Number(detail.gift_amount || 0),
        }),
        { quantity: 0, amount: 0 },
      ),
    );
  });
  return map;
});
function dishGift(row) {
  return (
    dishGiftMap.value.get(
      `${row?.product_code || ""}|${row?.product_name || ""}`,
    ) || { quantity: 0, amount: 0 }
  );
}
async function loadDishAnalytics() {
  const range = reportRange.value;
  if (
    analysisScope.value !== "total" ||
    range?.length !== 2 ||
    !range[0] ||
    !range[1]
  ) {
    Object.assign(dishAnalytics, { summary: {}, top: [], hourly_trend: [] });
    dishTotal.value = 0;
    return;
  }
  dishLoading.value = true;
  try {
    const params = {
      date_from: range[0],
      date_to: range[1],
      sort: dishSort.value,
      page: dishPage.value,
      page_size: dishPageSize.value,
    };
    // 品牌视角不带门店筛选；门店视角支持单店或多店，统一通过 store_ids 汇总。
    if (analysisMode.value === "store" && filters.storeIds.length)
      params.store_ids = filters.storeIds.join(",");
    const result = await getDishSalesAnalytics(params);
    Object.assign(dishAnalytics, {
      summary: result.summary || {},
      top: result.top || [],
      hourly_trend: result.hourly_trend || [],
    });
    dishTotal.value = Number(result.total) || 0;
  } catch (error) {
    Object.assign(dishAnalytics, { summary: {}, top: [], hourly_trend: [] });
    dishTotal.value = 0;
  } finally {
    dishLoading.value = false;
  }
}
function changeDishSort() {
  dishPage.value = 1;
  loadDishAnalytics();
}
async function openStoreDetail(store) {
  const range = reportRange.value;
  if (!range?.[0] || !range?.[1])
    return ElMessage.warning("请先选择完整的时间范围");
  selectedStore.value = store;
  detailRangeLabel.value = `${range[0]} 至 ${range[1]}`;
  storeDetailVisible.value = true;
  storeDetailLoading.value = true;
  Object.assign(storeDetail, {
    totals: {},
    revenue_composition: [],
    channel_breakdown: [],
  });
  try {
    const result = await getBusinessAnalytics("overview", {
      period: aggregationPeriod.value,
      store_id: store.store_id,
      channel_group: scopeChannelGroup.value || undefined,
      platform: effectivePlatform.value || undefined,
      require_platform_record: requiresPlatformRecord.value ? "1" : undefined,
      date_from: range[0],
      date_to: range[1],
    });
    Object.assign(storeDetail, result);
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    storeDetailLoading.value = false;
  }
}
function reuseChart(chart, target) {
  if (!target) return null;
  if (chart && chart.getDom() !== target) {
    chart.dispose();
    chart = null;
  }
  return chart || echarts.getInstanceByDom(target) || echarts.init(target);
}
function renderPie(chartRef, chart, items, centerText, centerLabel) {
  const instance = reuseChart(chart, chartRef.value);
  if (!instance) return chart;
  if (!items.length) {
    instance.clear();
    return instance;
  }
  const compactLegend = analysisScope.value === "total";
  const dark = false; // 环比沿用浅色工作台，仅比较数据，不切换主题。
  instance.resize();
  instance.setOption(
    {
      tooltip: {
        trigger: "item",
        backgroundColor: dark ? "#172b48" : "#fff",
        textStyle: { color: dark ? "#e7f0ff" : "#182230" },
        formatter: (item) =>
          `${item.name}<br/>${money(item.value)} · ${item.percent}%`,
      },
      legend: {
        show: !compactLegend,
        bottom: 0,
        icon: "circle",
        itemWidth: 8,
        textStyle: { color: dark ? "#b9cce9" : "#667085" },
      },
      series: [
        {
          type: "pie",
          radius: ["54%", "76%"],
          center: ["50%", "45%"],
          label: { show: false },
          itemStyle: { borderColor: "#fff", borderWidth: 4, borderRadius: 8 },
          data: items,
        },
      ],
      graphic: [
        {
          type: "text",
          left: "center",
          top: "38%",
          style: {
            text: money(centerText),
            fill: dark ? "#f4f8ff" : "#182230",
            fontSize: 18,
            fontWeight: 700,
            textAlign: "center",
          },
        },
        {
          type: "text",
          left: "center",
          top: "48%",
          style: {
            text: centerLabel,
            fill: dark ? "#c1d1ea" : "#98a2b3",
            fontSize: 11,
            textAlign: "center",
          },
        },
      ],
    },
    true,
  );
  return instance;
}
function renderHourlyOrderChart() {
  if (!hourlyOrderChartRef.value || analysisScope.value !== "total") return;
  hourlyOrderChart = reuseChart(hourlyOrderChart, hourlyOrderChartRef.value);
  const rows = dishAnalytics.hourly_trend || [];
  if (!rows.length) {
    hourlyOrderChart.clear();
    return;
  }
  const dark = false;
  hourlyOrderChart.resize();
  hourlyOrderChart.setOption(
    {
      color: ["#4b83ed"],
      tooltip: {
        trigger: "axis",
        backgroundColor: dark ? "#172b48" : "#fff",
        textStyle: { color: dark ? "#e7f0ff" : "#182230" },
        formatter: (params) =>
          `${params?.[0]?.axisValue || ""}<br/>订单量：<b>${numberText(params?.[0]?.value || 0)}</b> 单`,
      },
      grid: { left: 14, right: 22, top: 24, bottom: 16, containLabel: true },
      xAxis: {
        type: "category",
        data: rows.map((row) => row.period),
        boundaryGap: false,
        axisLine: { lineStyle: { color: dark ? "#2d527e" : "#e4e9f1" } },
        axisTick: { show: false },
        axisLabel: {
          color: dark ? "#aec4e4" : "#8a94a6",
          interval: 1,
          fontSize: 10,
        },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        axisLabel: {
          color: dark ? "#aec4e4" : "#8a94a6",
          formatter: (value) => numberText(value),
        },
        splitLine: {
          lineStyle: {
            color: dark ? "rgba(148,180,224,.14)" : "#edf1f6",
            type: "dashed",
          },
        },
      },
      series: [
        {
          name: "订单量",
          type: "line",
          smooth: true,
          data: rows.map((row) => Number(row.order_count) || 0),
          symbol: "circle",
          symbolSize: 5,
          lineStyle: { width: 3 },
          itemStyle: { color: "#4b83ed" },
          areaStyle: {
            color: dark ? "rgba(75,131,237,.24)" : "rgba(75,131,237,.14)",
          },
        },
      ],
    },
    true,
  );
}
function renderCharts() {
  if (activeTab.value !== "overview") return;
  const series = chartSeries.value;
  const isStoreTrend = analysisMode.value === "store";
  const isSettlementTrend =
    analysisScope.value === "delivery" || analysisScope.value === "group-buy";
  if (trendChartRef.value) {
    trendChart = reuseChart(trendChart, trendChartRef.value);
    if (!data.trend.length) {
      trendChart.clear();
      return;
    }
    trendChart.resize();
    // 外卖、团购均按日展示“营业额 + 实收”。团购的营业额取第三方售价（gross_amount），
    // 实收取商家应得（group_buy），避免月筛选时被聚合成单根实收柱。
    const settlementKey =
      analysisScope.value === "delivery" ? "delivery" : "group_buy";
    const settlementGross = data.trend.map((row) =>
      Math.max(
        Number(
          analysisScope.value === "delivery"
            ? row.delivery_gross || 0
            : row.gross_amount || 0,
        ),
        Number(row[settlementKey] || 0),
      ),
    );
    const settlementActual = data.trend.map((row) =>
      Number(row[settlementKey] || 0),
    );
    const settlementTooltip = (params) => {
      const index = params?.[0]?.dataIndex || 0;
      const gross = settlementGross[index] || 0;
      const actual = settlementActual[index] || 0;
      const ratio = gross ? actual / gross : 0;
      return `${data.trend[index]?.period || ""}<br/><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#93c5fd;margin-right:6px;vertical-align:1px"></span>营业额：<b style="color:#1e3a8a">${money(gross)}</b><br/><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#1e40af;margin-right:6px;vertical-align:1px"></span>实收：<b style="color:#1e3a8a">${money(actual)}</b><br/><span style="display:inline-block;color:#94a3b8;margin-top:2px">实收率 ${percent(ratio)}</span>`;
    };
    // 极简扁平 · 高对比度 · 干净留白的科技感走势图
    // 【入场动画】真正效果来自 series 级逐点延迟（animationDelay 按数据点 index 递增，柱/线从左到右逐根生长，
    // 每点 380ms、相邻点间隔 110ms，约 15~20 点 → 2~2.6 秒走完全图）。
    // 每次数据更新/查询前先 clear() 再 setOption，确保入场动画每次都重新播放。
    trendChart.clear();
    trendChart.setOption(
      {
        animation: true,
        animationDuration: 700,
        animationDurationUpdate: 500,
        animationEasing: "cubicOut",
        animationEasingUpdate: "cubicInOut",
        color: isSettlementTrend
          ? ["#93c5fd", "#1e40af"]
          : isStoreTrend
            ? ["#3b82f6"]
            : series.map((item) => item.color),
        tooltip: {
          trigger: "axis",
          confine: true,
          backgroundColor: "#ffffff",
          borderColor: "#e2e8f0",
          borderWidth: 1,
          padding: [10, 14],
          borderRadius: 10,
          extraCssText: "box-shadow:0 14px 34px rgba(15,23,42,.10);",
          textStyle: { color: "#334155", fontSize: 12 },
          axisPointer: {
            type: isSettlementTrend ? "shadow" : "line",
            shadowStyle: { color: "rgba(30,64,175,.05)" },
            lineStyle: { color: "#94a3b8", type: "dashed" },
          },
          valueFormatter: (value) => money(value),
          formatter: isSettlementTrend ? settlementTooltip : undefined,
        },
        legend: {
          show: isSettlementTrend || isStoreTrend,
          top: 0,
          right: 6,
          itemWidth: 10,
          itemHeight: 10,
          itemGap: 18,
          icon: "roundRect",
          textStyle: { color: "#475569", fontSize: 11 },
        },
        grid: {
          left: 10,
          right: 16,
          top: isSettlementTrend ? 46 : 40,
          bottom: 6,
          containLabel: true,
        },
        xAxis: {
          type: "category",
          data: data.trend.map((item) => item.period),
          axisLine: { lineStyle: { color: "#eef1f6", width: 1 } },
          axisTick: { show: false },
          axisLabel: { color: "#94a3b8", fontSize: 10, margin: 12 },
        },
        yAxis: {
          type: "value",
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: "#94a3b8",
            fontSize: 10,
            formatter: (value) =>
              value >= 10000 ? `${(value / 10000).toFixed(1)}万` : value,
          },
          splitLine: {
            lineStyle: { color: "rgba(148,163,184,.16)", type: "dashed" },
          },
        },
        series: isSettlementTrend
          ? [
              {
                name: "营业额",
                type: "bar",
                data: settlementGross,
                barWidth: 30,
                barCategoryGap: "38%",
                animationDuration: 380,
                animationEasing: "cubicOut",
                animationDelay: (idx) => idx * 110,
                itemStyle: { color: "#93c5fd", borderRadius: [4, 4, 0, 0] },
                emphasis: { itemStyle: { color: "#a9ccff" } },
                z: 1,
              },
              {
                name: "实收",
                type: "bar",
                data: settlementActual,
                barWidth: 15,
                barGap: "-100%",
                animationDuration: 380,
                animationEasing: "cubicOut",
                animationDelay: (idx) => idx * 110,
                itemStyle: { color: "#1e40af", borderRadius: [4, 4, 0, 0] },
                emphasis: { itemStyle: { color: "#1d4ed8" } },
                z: 2,
              },
            ]
          : isStoreTrend
            ? [
                {
                  name: "实收",
                  type: "line",
                  smooth: true,
                  data: data.trend.map((row) => row.total || 0),
                  symbol: "circle",
                  symbolSize: 7,
                  animationDuration: 380,
                  animationEasing: "cubicOut",
                  animationDelay: (idx) => idx * 110,
                  lineStyle: { width: 3 },
                  itemStyle: { color: "#3b82f6" },
                  areaStyle: { color: "rgba(59,130,246,.16)" },
                },
              ]
            : series.map((item, index) => ({
                name: item.name,
                type: "bar",
                stack: series.length > 1 ? "revenue" : undefined,
                data: data.trend.map((row) => row[item.key] || 0),
                barMaxWidth: 26,
                animationDuration: 380,
                animationEasing: "cubicOut",
                animationDelay: (idx) => idx * 110,
                itemStyle: {
                  color: item.color,
                  borderRadius:
                    index === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 4, 4],
                },
              })),
      },
      true,
    );
  }
  if (compositionChartRef.value)
    compositionChart = renderPie(
      compositionChartRef,
      compositionChart,
      analysisScope.value === "total"
        ? incomeCompositionItems.value
        : channelCompositionItems.value,
      analysisScope.value === "total"
        ? scopeIncome.value
        : channelCompositionItems.value.reduce(
            (sum, item) => sum + item.value,
            0,
          ),
      analysisScope.value === "total" ? "营业收入构成" : "渠道营业构成",
    );
  if (channelCompositionChartRef.value)
    channelCompositionChart = renderPie(
      channelCompositionChartRef,
      channelCompositionChart,
      displayedChannelCompositionItems.value,
      displayedChannelCompositionTotal.value,
      channelCompositionTitle.value,
    );
  renderHourlyOrderChart();
  if (isMeituanOperationView.value) renderMeituanTrends();
}
function queueChartRender() {
  if (chartFrame) cancelAnimationFrame(chartFrame);
  chartFrame = requestAnimationFrame(() => {
    chartFrame = null;
    renderCharts();
  });
}
function resizeCharts() {
  trendChart?.resize();
  compositionChart?.resize();
  channelCompositionChart?.resize();
  hourlyOrderChart?.resize();
  mtTrendChart?.resize();
}
watch(activeTab, async (value) => {
  if (value === "overview") {
    await nextTick();
    queueChartRender();
  } else if (value === "products" && hasQueried.value) {
    // 总数据视角的菜品销售分析是服务端排序分页，切回来要重新取当前页；
    // productAnalytics 同时提供展开行的来源订单明细。
    if (isTotalProductBoard.value) await loadDishAnalytics();
    await loadProductAnalytics();
  }
});
watch(compareThemeActive, async () => {
  await nextTick();
  queueChartRender();
});
onMounted(async () => {
  const result = await getStores({ page: 1, pageSize: 200 }).catch(() => ({
    stores: [],
  }));
  storeOptions.value = result.stores || [];
  resetScopeFilters();
  hasQueried.value = false;
  clearData();
  window.addEventListener("resize", resizeCharts);
});
onBeforeUnmount(() => {
  if (chartFrame) cancelAnimationFrame(chartFrame);
  clearTimeout(mtTrendPlaybackTimer);
  mtTrendPlaybackToken += 1;
  trendChart?.dispose();
  compositionChart?.dispose();
  channelCompositionChart?.dispose();
  hourlyOrderChart?.dispose();
  mtTrendChart?.dispose();
  window.removeEventListener("resize", resizeCharts);
});
</script>

<style scoped>
.business-analytics-page {
  --ink: #162033;
  --line: #e6eaf0;
  --blue: #3b82f6;
  min-width: 0;
  color: var(--ink);
}
.analytics-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 16px;
  padding: 28px 30px;
  border-radius: 18px;
  color: #fff;
  background:
    radial-gradient(
      circle at 88% 0,
      rgba(107, 172, 255, 0.35),
      transparent 34%
    ),
    linear-gradient(125deg, #14295b 0%, #2255a4 56%, #3b82f6 100%);
  box-shadow: 0 16px 36px rgba(34, 75, 151, 0.18);
}
.eyebrow {
  color: #b8d4ff;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.2em;
}
.hero-copy h2 {
  margin: 7px 0 6px;
  font-size: 27px;
}
.hero-copy p {
  margin: 0;
  color: rgba(255, 255, 255, 0.72);
  font-size: 13px;
}
.analytics-hero :deep(.el-button) {
  height: 38px;
  border-color: rgba(255, 255, 255, 0.32);
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 6px 18px rgba(33, 48, 78, 0.05);
}
.period-switch {
  display: flex;
  padding: 3px;
  border-radius: 9px;
  background: #f1f4f8;
}
.period-switch button {
  min-width: 72px;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #69758a;
  cursor: pointer;
  font-size: 12px;
}
.period-switch button.active {
  background: #fff;
  color: var(--blue);
  font-weight: 700;
  box-shadow: 0 2px 7px rgba(32, 48, 78, 0.12);
}
.delivery-store-picker {
  display: flex;
  align-items: center;
  gap: 7px;
}
.delivery-store-picker :deep(.el-button) {
  margin: 0;
}
.scope-chip {
  padding: 8px 11px;
  border: 1px solid #cfe0fa;
  border-radius: 8px;
  background: #f4f8ff;
  color: #3772bc;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
.filter-summary {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  color: #7c8799;
  font-size: 11px;
  white-space: nowrap;
}
.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22b980;
  box-shadow: 0 0 0 4px rgba(34, 185, 128, 0.1);
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 17px;
}
.metric-card {
  min-height: 130px;
  padding: 17px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 6px 18px rgba(33, 48, 78, 0.05);
}
.metric-card > div:first-child span,
.metric-card > div:first-child small {
  display: block;
}
.metric-card span {
  font-size: 12px;
  font-weight: 700;
}
.metric-card small {
  margin-top: 5px;
  color: #98a2b3;
  font-size: 9px;
  line-height: 1.5;
}
.metric-card strong {
  display: block;
  margin: 17px 0 12px;
  font-size: 21px;
  letter-spacing: -0.02em;
}
.metric-foot {
  color: #8a94a6;
  font-size: 10px;
}
.metric-card.primary {
  border-color: #8ebcff;
  background: linear-gradient(145deg, #f7fbff, #edf5ff);
}
.metric-card.primary strong {
  color: #246bd4;
}
.metric-card.warning strong {
  color: #d37b12;
}
.metric-card.success strong {
  color: #159467;
}
.metric-card.success :deep(.el-progress-bar__inner) {
  background: #22b980;
}
.content-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: #f7f8fa;
  width: max-content;
}
.content-tabs button {
  height: 33px;
  padding: 0 16px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #667085;
  cursor: pointer;
  font-size: 12px;
}
.content-tabs button.active {
  background: #fff;
  color: #246bd4;
  font-weight: 700;
  box-shadow: 0 3px 9px rgba(36, 57, 91, 0.09);
}
.content-tabs em {
  display: inline-grid;
  min-width: 18px;
  height: 18px;
  margin-left: 6px;
  place-items: center;
  border-radius: 9px;
  background: #fff1db;
  color: #c87008;
  font-size: 9px;
  font-style: normal;
}
.chart-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.85fr) minmax(300px, 0.75fr);
  gap: 14px;
  margin-bottom: 14px;
}
.panel {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: #fff;
  box-shadow: 0 7px 22px rgba(33, 48, 78, 0.055);
}
.panel > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 17px 19px;
  border-bottom: 1px solid #edf0f4;
}
.panel h3 {
  margin: 0;
  font-size: 14px;
}
.panel header p {
  margin: 4px 0 0;
  color: #929cad;
  font-size: 10px;
}
.panel-badge {
  padding: 5px 9px;
  border-radius: 20px;
  background: #eef4ff;
  color: #3d6fc5;
  font-size: 10px;
}
.chart {
  height: 330px;
}
.store-ranking,
.reconciliation-panel {
  min-height: 330px;
}
.ranking-list {
  padding: 6px 18px 12px;
}
.ranking-list > div {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 2px;
  border-bottom: 1px solid #eef1f5;
}
.ranking-list > div:last-child {
  border-bottom: 0;
}
.rank {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 7px;
  background: #f0f2f6;
  color: #7e899b;
  font-size: 10px;
  font-weight: 700;
}
.rank.top {
  background: #e8f1ff;
  color: #3275de;
}
.ranking-list > div > div {
  min-width: 0;
  flex: 1;
}
.ranking-list b,
.ranking-list small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ranking-list b {
  font-size: 11px;
}
.ranking-list small {
  margin-top: 3px;
  color: #9aa3b2;
  font-size: 9px;
}
.ranking-list strong {
  font-size: 12px;
}
.difference-ok {
  color: #189768;
}
.difference-warn {
  color: #d97706;
  font-weight: 700;
}
@media (max-width: 1280px) {
  .metric-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
@media (max-width: 900px) {
  .analytics-hero {
    align-items: flex-start;
    flex-direction: column;
  }
  .filter-bar {
    align-items: stretch;
    flex-wrap: wrap;
  }
  .filter-summary {
    width: 100%;
    margin-left: 0;
  }
  .metric-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .chart-grid {
    grid-template-columns: 1fr;
  }
  .chart {
    height: 300px;
  }
}
@media (max-width: 560px) {
  .analytics-hero {
    padding: 22px 20px;
  }
  .metric-grid {
    grid-template-columns: 1fr;
  }
  .period-switch {
    width: 100%;
  }
  .period-switch button {
    flex: 1;
    padding: 0 4px;
  }
  .delivery-store-picker {
    flex-wrap: wrap;
    width: 100%;
  }
  .content-tabs {
    width: 100%;
  }
  .content-tabs button {
    flex: 1;
    padding: 0 8px;
  }
}
.metric-grid {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}
.metric-grid.compact {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.query-button {
  min-width: 88px;
  font-weight: 700;
}
.composition-panel {
  margin-bottom: 14px;
}
.composition-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  align-items: stretch;
  min-height: 280px;
}
.composition-table {
  border: 0;
}
.composition-table :deep(.el-table__inner-wrapper:before) {
  display: none;
}
.ring-column {
  display: flex;
  min-height: 280px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  border-left: 1px solid #edf0f4;
  background: linear-gradient(180deg, #fbfdff, #f5f9ff);
  color: #8793a6;
  font-size: 11px;
}
.ring-chart {
  width: 270px;
  height: 245px;
}
.income-panel {
  margin-bottom: 18px;
}
@media (max-width: 1280px) {
  .metric-grid.compact {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 900px) {
  .composition-layout {
    grid-template-columns: 1fr;
  }
  .ring-column {
    border-top: 1px solid #edf0f4;
    border-left: 0;
  }
  .composition-table {
    max-width: 100%;
    overflow-x: auto;
  }
}
@media (max-width: 560px) {
  .metric-grid.compact {
    grid-template-columns: 1fr;
  }
  .query-button {
    width: 100%;
  }
  .ring-chart {
    width: 100%;
    height: 260px;
  }
}
.ranking-bands {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  padding: 16px 18px 18px;
}
.ranking-band {
  min-width: 0;
  padding: 0 15px;
  border-right: 1px solid #edf0f4;
}
.ranking-band:first-child {
  padding-left: 0;
}
.ranking-band:last-child {
  padding-right: 0;
  border-right: 0;
}
.ranking-band h4 {
  margin: 0 0 8px;
  font-size: 12px;
  color: #637189;
}
.ranking-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 9px;
  padding: 10px 0;
  border: 0;
  border-bottom: 1px solid #f0f2f6;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.ranking-row:hover {
  background: #f7faff;
}
.ranking-row:focus-visible {
  outline: 2px solid #78aefc;
  outline-offset: 2px;
  border-radius: 6px;
}
.ranking-row:last-child {
  border-bottom: 0;
}
.ranking-row > div {
  min-width: 0;
  flex: 1;
}
.ranking-row b,
.ranking-row small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ranking-row b {
  font-size: 11px;
}
.ranking-row small {
  margin-top: 3px;
  color: #9aa3b2;
  font-size: 9px;
}
.ranking-row strong {
  font-size: 11px;
  white-space: nowrap;
}
.rank.middle {
  background: #f2f5fa;
  color: #68778f;
}
.rank.bottom {
  background: #f8f0f2;
  color: #a86c76;
}
.detail-period {
  margin: 0 0 14px;
  color: #7d899a;
  font-size: 12px;
}
.store-detail-content {
  min-height: 240px;
}
.detail-metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.detail-metric-grid article {
  padding: 13px;
  border: 1px solid #e6ebf2;
  border-radius: 10px;
  background: #f8fbff;
}
.detail-metric-grid span,
.detail-metric-grid strong {
  display: block;
}
.detail-metric-grid span {
  color: #718096;
  font-size: 11px;
}
.detail-metric-grid strong {
  margin-top: 7px;
  color: #1f5fb9;
  font-size: 17px;
}
.detail-metric-grid small {
  display: block;
  margin-top: 5px;
  color: #8b98aa;
  font-size: 10px;
}
.detail-table-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.detail-table-grid article {
  overflow: hidden;
  border: 1px solid #e9edf2;
  border-radius: 10px;
}
.detail-table-grid h4 {
  margin: 0;
  padding: 12px 14px;
  border-bottom: 1px solid #e9edf2;
  font-size: 13px;
}
.store-detail-dialog :deep(.el-dialog__body) {
  padding-top: 12px;
}
@media (max-width: 900px) {
  .ranking-bands {
    grid-template-columns: 1fr;
    gap: 14px;
  }
  .ranking-band,
  .ranking-band:first-child,
  .ranking-band:last-child {
    padding: 0;
    border: 0;
  }
  .ranking-band {
    padding-bottom: 12px;
    border-bottom: 1px solid #edf0f4;
  }
  .ranking-band:last-child {
    padding-bottom: 0;
    border-bottom: 0;
  }
  .detail-table-grid {
    grid-template-columns: 1fr;
  }
  .detail-metric-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 560px) {
  .detail-metric-grid {
    grid-template-columns: 1fr;
  }
}
.compare-button {
  border-color: #c8b8fb;
  background: #faf8ff;
  color: #6547ba;
  font-weight: 700;
}
.compare-button.exit {
  border-color: #f0bfc8;
  background: #fff5f6;
  color: #bb4d61;
}
.compare-up {
  color: #16865a !important;
}
.compare-down {
  color: #d65262 !important;
}
.compare-flat {
  color: #7d899a !important;
}
.compare-mode {
  padding: 16px;
  border-radius: 20px;
  background:
    radial-gradient(circle at 8% 0, rgba(194, 174, 255, 0.27), transparent 35%),
    radial-gradient(
      circle at 100% 88%,
      rgba(131, 206, 255, 0.23),
      transparent 36%
    ),
    linear-gradient(135deg, #f5f1ff, #eef7ff);
  box-shadow: inset 0 0 0 1px rgba(141, 116, 219, 0.13);
}
.compare-mode .analytics-hero {
  background:
    radial-gradient(
      circle at 88% 0,
      rgba(230, 207, 255, 0.44),
      transparent 34%
    ),
    linear-gradient(125deg, #312060, #5a3c9e 54%, #8064c5);
}
.compare-mode .filter-bar,
.compare-mode .panel,
.compare-mode .metric-card {
  border-color: rgba(126, 99, 196, 0.16);
  box-shadow: 0 9px 25px rgba(74, 55, 129, 0.08);
}
.compare-mode .metric-card.primary {
  background: linear-gradient(145deg, #fbf9ff, #f0ebff);
  border-color: #bfa9ed;
}
.compare-form {
  display: grid;
  gap: 18px;
}
.compare-form > div {
  padding: 15px;
  border: 1px solid #e8e0fb;
  border-radius: 12px;
  background: #fbfaff;
}
.compare-form h4 {
  margin: 0;
  color: #43306f;
  font-size: 14px;
}
.compare-form p {
  margin: 6px 0 12px;
  color: #8992a4;
  font-size: 12px;
}
.compare-form :deep(.el-date-editor) {
  width: 100%;
}
@media (max-width: 560px) {
  .compare-mode {
    padding: 10px;
  }
}
.metric-card {
  position: relative;
}
.card-compare {
  position: absolute;
  right: 17px;
  top: 48px;
  display: flex;
  min-width: 104px;
  flex-direction: column;
  gap: 6px;
  padding-left: 15px;
  border-left: 1px solid #dce3ec;
}
.card-compare span {
  color: #8c97a8;
  font-size: 10px;
  font-weight: 600;
}
.card-compare b {
  font-size: 15px;
  line-height: 1.2;
  white-space: nowrap;
}
.ranking-row em {
  min-width: 72px;
  font-size: 11px;
  font-style: normal;
  font-weight: 700;
  text-align: right;
  white-space: nowrap;
}
.compare-mode {
  --ink: #e8efff;
  padding: 18px;
  border: 1px solid #31496f;
  background:
    radial-gradient(circle at 3% 0, rgba(98, 132, 238, 0.28), transparent 33%),
    radial-gradient(
      circle at 100% 95%,
      rgba(37, 186, 190, 0.2),
      transparent 35%
    ),
    linear-gradient(135deg, #071321 0%, #102744 48%, #121b35 100%);
  box-shadow:
    0 22px 55px rgba(2, 9, 24, 0.42),
    inset 0 1px 0 rgba(160, 190, 255, 0.1);
}
.compare-mode .analytics-hero {
  border: 1px solid rgba(125, 168, 255, 0.26);
  background:
    radial-gradient(circle at 92% 0, rgba(74, 150, 255, 0.4), transparent 35%),
    linear-gradient(125deg, #091a32, #163964 60%, #1d4f89);
}
.compare-mode .filter-bar,
.compare-mode .panel,
.compare-mode .metric-card {
  border-color: rgba(118, 157, 213, 0.22);
  background: rgba(13, 30, 53, 0.92);
  box-shadow: 0 12px 28px rgba(0, 5, 16, 0.28);
}
.compare-mode .metric-card.primary {
  background: linear-gradient(
    145deg,
    rgba(19, 51, 91, 0.97),
    rgba(16, 39, 72, 0.97)
  );
  border-color: #4678bd;
}
.compare-mode .metric-card span,
.compare-mode .panel h3,
.compare-mode .ranking-band h4,
.compare-mode .ranking-row b {
  color: #e6efff;
}
.compare-mode .metric-card small,
.compare-mode .metric-foot,
.compare-mode .panel header p,
.compare-mode .ranking-row small {
  color: #a9bbd6;
}
.compare-mode .card-compare {
  border-left-color: rgba(157, 186, 231, 0.28);
}
.compare-mode .ring-column {
  border-left-color: rgba(128, 163, 216, 0.22);
  background: linear-gradient(
    180deg,
    rgba(18, 42, 74, 0.88),
    rgba(10, 27, 50, 0.88)
  );
  color: #9db4d5;
}
.compare-mode :deep(.el-table) {
  --el-table-header-bg-color: #132d50;
  --el-table-tr-bg-color: rgba(11, 28, 50, 0.92);
  --el-table-row-hover-bg-color: #193d68;
  --el-table-border-color: rgba(128, 163, 216, 0.18);
  --el-table-text-color: #dbe8fb;
  --el-table-header-text-color: #aec5e8;
  background: transparent;
}
.compare-mode :deep(.el-table__inner-wrapper:before) {
  background-color: rgba(128, 163, 216, 0.18);
}
.compare-mode .ranking-band {
  border-right-color: rgba(128, 163, 216, 0.18);
}
.compare-mode .ranking-row {
  border-bottom-color: rgba(128, 163, 216, 0.14);
}
.compare-mode .ranking-row:hover {
  background: rgba(70, 123, 188, 0.17);
}
.compare-mode .content-tabs {
  border-color: rgba(126, 166, 223, 0.25);
  background: rgba(7, 20, 38, 0.7);
}
.compare-mode .content-tabs button {
  color: #afc1dd;
}
.compare-mode .content-tabs button.active {
  background: #1c4779;
  color: #fff;
}
.compare-mode .filter-summary {
  color: #bdcde5;
}
.compare-mode .scope-chip {
  border-color: #4876ae;
  background: #14395f;
  color: #d7e7ff;
}
@media (max-width: 760px) {
  .card-compare {
    position: static;
    display: inline-flex;
    margin-top: 6px;
    padding: 6px 0 0;
    border-top: 1px solid #dce3ec;
    border-left: 0;
  }
  .compare-mode .card-compare {
    border-top-color: rgba(157, 186, 231, 0.28);
  }
}
.compare-mode .metric-card strong {
  color: #f3f7ff;
}
.compare-mode .metric-card.primary strong {
  color: #8fc2ff;
}
.compare-mode .compare-up {
  color: #37d39a !important;
}
.compare-mode .compare-down {
  color: #ff7583 !important;
}
.compare-mode .compare-flat {
  color: #bdcbe0 !important;
}
.compare-mode :deep(.el-table th.el-table__cell) {
  background: #16365d !important;
  color: #c9dcf7 !important;
}
.compare-mode :deep(.el-table tr),
.compare-mode :deep(.el-table td.el-table__cell) {
  background: #0d2039 !important;
  color: #e1ecff !important;
}
.compare-mode
  :deep(
    .el-table--striped
      .el-table__body
      tr.el-table__row--striped
      td.el-table__cell
  ) {
  background: #122b4b !important;
}
.compare-mode
  :deep(
    .el-table--enable-row-hover .el-table__body tr:hover > td.el-table__cell
  ) {
  background: #1a416d !important;
}
.compare-mode :deep(.el-table .cell) {
  color: inherit;
}
.compare-mode :deep(.el-table .el-table__empty-block) {
  background: #0d2039;
}
.compare-mode .panel-badge {
  background: #1c4779;
  color: #d9ebff;
}
.compare-mode .rank {
  background: #214a78;
  color: #d9ebff;
}
.compare-mode .rank.middle {
  background: #364966;
  color: #e2edff;
}
.compare-mode .rank.bottom {
  background: #6b3d54;
  color: #ffe0e5;
}
.reconciliation-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid #edf0f4;
  background: linear-gradient(180deg, #fbfdff, #f7faff);
}
.reconciliation-summary article {
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid #e4eaf3;
  border-radius: 11px;
  background: #fff;
}
.reconciliation-summary span,
.reconciliation-summary strong,
.reconciliation-summary small {
  display: block;
}
.reconciliation-summary span {
  color: #718096;
  font-size: 11px;
}
.reconciliation-summary strong {
  margin: 5px 0 3px;
  color: #245fae;
  font-size: 21px;
  font-variant-numeric: tabular-nums;
}
.reconciliation-summary small {
  overflow: hidden;
  color: #9aa6b6;
  font-size: 10px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.reconciliation-summary article.success {
  border-color: #ccebdd;
  background: #f6fdf9;
}
.reconciliation-summary article.success strong {
  color: #16865a;
}
.reconciliation-summary article.warning {
  border-color: #f2dfbb;
  background: #fffaf0;
}
.reconciliation-summary article.warning strong {
  color: #c47c12;
}
.reconciliation-table :deep(.el-table__inner-wrapper:before) {
  display: none;
}
.reconciliation-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-top: 1px solid #edf0f4;
  color: #8793a6;
  font-size: 12px;
}
.compare-mode .reconciliation-summary {
  border-bottom-color: rgba(128, 163, 216, 0.18);
  background: rgba(13, 30, 53, 0.88);
}
.compare-mode .reconciliation-summary article {
  border-color: rgba(118, 157, 213, 0.22);
  background: rgba(18, 42, 74, 0.9);
}
.compare-mode .reconciliation-summary span,
.compare-mode .reconciliation-summary small {
  color: #a9bbd6;
}
.compare-mode .reconciliation-summary strong {
  color: #e7f1ff;
}
.compare-mode .reconciliation-summary article.success {
  background: rgba(17, 103, 75, 0.24);
  border-color: rgba(58, 190, 139, 0.3);
}
.compare-mode .reconciliation-summary article.success strong {
  color: #55d8a6;
}
.compare-mode .reconciliation-summary article.warning {
  background: rgba(121, 78, 18, 0.24);
  border-color: rgba(239, 185, 76, 0.28);
}
.compare-mode .reconciliation-summary article.warning strong {
  color: #ffd16a;
}
.compare-mode .reconciliation-pagination {
  border-top-color: rgba(128, 163, 216, 0.18);
  color: #b8c9e1;
}
.compare-mode :deep(.el-pagination button),
.compare-mode :deep(.el-pagination .number) {
  background: transparent;
  color: #c7d8f2;
}
.compare-mode :deep(.el-pagination .number.is-active) {
  color: #75b2ff;
}
.recon-channel-switch {
  flex: none;
}
.recon-channel-switch :deep(.el-segmented__item) {
  font-size: 12px;
  padding: 0 11px;
}
.recon-channel-switch :deep(.el-segmented__item:not(.is-selected)) {
  color: #5c6b82;
}
@media (max-width: 760px) {
  .reconciliation-summary {
    grid-template-columns: 1fr;
  }
  .reconciliation-pagination {
    align-items: flex-start;
    flex-direction: column;
  }
  .recon-channel-switch {
    width: 100%;
    overflow-x: auto;
  }
  .recon-channel-switch :deep(.el-segmented) {
    min-width: max-content;
  }
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}
.analytics-hero :deep(.el-button--primary) {
  border-color: rgba(255, 255, 255, 0.52);
  background: rgba(255, 255, 255, 0.22);
  font-weight: 700;
}
.analytics-hero :deep(.el-button.is-disabled) {
  opacity: 0.5;
}
.diagnosis-content {
  color: #253247;
}
.diagnosis-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  color: #7e8b9c;
  font-size: 12px;
}
.diagnosis-summary {
  margin: 18px 0;
  padding: 15px 17px;
  border-left: 4px solid #4d87e8;
  border-radius: 0 10px 10px 0;
  background: #f4f8ff;
  color: #45607f;
  line-height: 1.7;
}
.diagnosis-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 22px;
}
.diagnosis-metrics > div {
  padding: 13px;
  border: 1px solid #e3eaf5;
  border-radius: 11px;
  background: linear-gradient(145deg, #fbfdff, #f3f7fd);
}
.diagnosis-metrics span,
.diagnosis-metrics b {
  display: block;
}
.diagnosis-metrics span {
  color: #7e8da1;
  font-size: 11px;
}
.diagnosis-metrics b {
  margin-top: 8px;
  color: #245fae;
  font-size: 17px;
}
.diagnosis-section {
  margin-top: 18px;
}
.diagnosis-section h4 {
  margin: 0 0 10px;
  font-size: 14px;
}
.diagnosis-section article {
  margin: 8px 0;
  padding: 12px 14px;
  border: 1px solid #e8edf5;
  border-radius: 10px;
  background: #fff;
}
.diagnosis-section article b {
  font-size: 13px;
}
.diagnosis-section article p {
  margin: 6px 0 0;
  color: #718095;
  font-size: 12px;
  line-height: 1.65;
}
.diagnosis-section article.warning {
  border-left: 3px solid #e6a23c;
}
.diagnosis-section article.success {
  border-left: 3px solid #35ad7c;
}
.diagnosis-section article.info {
  border-left: 3px solid #4d87e8;
}
.diagnosis-section ol {
  margin: 0;
  padding: 2px 0 2px 20px;
  color: #4d5f75;
}
.diagnosis-section li {
  padding: 5px 0;
  line-height: 1.6;
}
@media (max-width: 900px) {
  .hero-actions {
    justify-content: flex-start;
  }
  .diagnosis-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .hero-actions {
    width: 100%;
  }
  .hero-actions :deep(.el-button) {
    flex: 1;
  }
  .diagnosis-metrics {
    grid-template-columns: 1fr;
  }
  .diagnosis-meta {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }
}
.store-trend-panel,
.custom-store-panel {
  margin-top: 14px;
}
.custom-store-panel :deep(.el-table__inner-wrapper:before) {
  display: none;
}
.compare-mode .custom-store-panel :deep(.el-table__inner-wrapper:before) {
  background-color: rgba(128, 163, 216, 0.18);
}
.dish-panel {
  margin-top: 14px;
}
.dish-panel header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.dish-panel .panel-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
}
.dish-panel .panel-actions :deep(.el-radio-button__inner) {
  font-size: 12px;
  padding: 6px 11px;
}
.dish-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  padding: 14px 18px;
}
.dish-metrics > div {
  min-height: 66px;
  padding: 12px 14px;
  border: 1px solid #e6ebf2;
  border-radius: 10px;
  background: #f8fbff;
}
.dish-metrics span,
.dish-metrics strong,
.dish-metrics small {
  display: block;
}
.dish-metrics span {
  color: #718096;
  font-size: 11px;
}
.dish-metrics strong {
  margin-top: 6px;
  color: #1f5fb9;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.dish-metrics small {
  margin-top: 4px;
  color: #98a3b4;
  font-size: 9px;
  white-space: nowrap;
}
.dish-refund-text {
  color: #d65262 !important;
}
.dish-cost-text {
  color: #c47c12 !important;
}
.dish-cost-pending {
  color: #98a3b4;
  font-size: 11px;
}
.dish-income {
  color: #16865a;
}
.dish-table {
  border: 0;
}
.dish-panel :deep(.el-table__inner-wrapper:before) {
  display: none;
}
.compare-mode .dish-metrics > div {
  background: rgba(13, 30, 53, 0.9);
  border-color: rgba(118, 157, 213, 0.22);
}
.compare-mode .dish-metrics strong {
  color: #f3f7ff;
}
.compare-mode .dish-metrics span,
.compare-mode .dish-metrics small {
  color: #a9bbd6;
}
.compare-mode .dish-refund-text {
  color: #ff7583 !important;
}
.compare-mode .dish-cost-text {
  color: #f4bd63 !important;
}
.compare-mode .dish-cost-pending {
  color: #91a7c5;
}
.dish-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 18px;
  border-top: 1px solid #edf0f4;
  background: #fafbfc;
  color: #7f8999;
  font-size: 12px;
}
.dish-footer :deep(.el-pagination) {
  --el-pagination-font-size: 12px;
}
.dish-footer :deep(.el-pagination.is-background .btn-prev),
.dish-footer :deep(.el-pagination.is-background .btn-next),
.dish-footer :deep(.el-pagination.is-background .el-pager li) {
  border-radius: 7px;
}
.compare-mode .dish-footer {
  border-top-color: rgba(128, 163, 216, 0.18);
  background: rgba(13, 30, 53, 0.85);
  color: #b8c9e1;
}
@media (max-width: 900px) {
  .dish-metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .dish-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .dish-panel header {
    align-items: flex-start;
    flex-direction: column;
  }
  .dish-footer {
    align-items: flex-start;
    flex-direction: column;
  }
}
.hourly-order-panel {
  margin: 0 0 14px;
}
.hourly-order-chart {
  height: 286px;
  padding: 8px 14px 0;
}
.compare-mode .hourly-order-panel {
  border-color: rgba(118, 157, 213, 0.22);
  background: rgba(13, 30, 53, 0.92);
}
@media (max-width: 560px) {
  .hourly-order-chart {
    height: 260px;
    padding: 8px 4px 0;
  }
}
.period-switch {
  flex: 0 0 auto;
  white-space: nowrap;
}
.period-switch button {
  white-space: nowrap;
}
.analysis-source-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 2px;
  color: #69778c;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
.analysis-source-switch :deep(.el-radio-button__inner) {
  padding: 8px 10px;
  font-size: 12px;
}
.source-mode-hint {
  max-width: 235px;
  padding: 6px 9px;
  border: 1px solid #d9e7fb;
  border-radius: 8px;
  background: #f7fbff;
  color: #6c7f98;
  font-size: 10px;
  line-height: 1.35;
}
.source-config-button {
  border-color: #b9d5fc;
  background: #f5f9ff;
  color: #2868b9;
  font-weight: 700;
}
.analysis-source-note {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: -7px 0 16px;
  padding: 9px 13px;
  border: 1px solid #d9e7fb;
  border-radius: 10px;
  background: #f8fbff;
  color: #71829a;
  font-size: 11px;
}
.analysis-source-note b {
  color: #2f68ac;
  font-size: 12px;
}
.source-dialog-hint {
  margin: 0 0 16px;
  padding: 11px 13px;
  border-left: 3px solid #5e91e8;
  border-radius: 0 8px 8px 0;
  background: #f3f7ff;
  color: #60728d;
  font-size: 12px;
  line-height: 1.65;
}
.platform-source-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.platform-source-grid article {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 76px;
  padding: 12px 13px;
  border: 1px solid #e1e9f3;
  border-radius: 11px;
  background: #fbfdff;
}
.platform-source-grid b,
.platform-source-grid small {
  display: block;
}
.platform-source-grid b {
  color: #294466;
  font-size: 13px;
}
.platform-source-grid small {
  margin-top: 5px;
  color: #93a0b1;
  font-size: 10px;
}
.platform-source-grid :deep(.el-radio-button__inner) {
  padding: 6px 8px;
  font-size: 11px;
}
@media (max-width: 900px) {
  .platform-source-grid {
    grid-template-columns: 1fr;
  }
  .analysis-source-note {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
}
@media (max-width: 560px) {
  .analysis-source-switch {
    width: 100%;
    justify-content: space-between;
  }
  .source-config-button {
    width: 100%;
  }
}
.delivery-settlement-chain {
  display: flex;
  align-items: stretch;
  gap: 10px;
  margin: -3px 0 17px;
  padding: 12px 16px;
  border: 1px solid #dce8fb;
  border-radius: 14px;
  background: linear-gradient(100deg, #f8fbff, #fffaf2);
  box-shadow: 0 5px 15px rgba(31, 69, 122, 0.04);
}
.delivery-settlement-chain > div {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  padding: 2px 10px;
}
.delivery-settlement-chain span {
  color: #63748d;
  font-size: 11px;
  font-weight: 700;
}
.delivery-settlement-chain strong {
  color: #1d4f91;
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}
.delivery-settlement-chain small {
  color: #98a5b5;
  font-size: 10px;
}
.delivery-settlement-chain > b {
  align-self: center;
  color: #9aa9bd;
  font-size: 18px;
}
.delivery-settlement-chain .settlement-result {
  border-radius: 9px;
  background: #eaf8f1;
}
.delivery-settlement-chain .settlement-result strong {
  color: #13845b;
}
.compare-mode .delivery-settlement-chain {
  border-color: rgba(118, 157, 213, 0.26);
  background: rgba(13, 30, 53, 0.92);
}
.compare-mode .delivery-settlement-chain span {
  color: #b9cae4;
}
.compare-mode .delivery-settlement-chain strong {
  color: #e7f1ff;
}
.compare-mode .delivery-settlement-chain small {
  color: #91a7c5;
}
.compare-mode .delivery-settlement-chain > b {
  color: #7e9bc1;
}
.compare-mode .delivery-settlement-chain .settlement-result {
  background: rgba(20, 117, 86, 0.22);
}
.compare-mode .delivery-settlement-chain .settlement-result strong {
  color: #55d8a6;
}
@media (max-width: 900px) {
  .delivery-settlement-chain {
    display: grid;
    grid-template-columns: 1fr 20px 1fr;
    gap: 6px;
  }
  .delivery-settlement-chain > b {
    display: grid;
    place-items: center;
  }
  .delivery-settlement-chain > div {
    padding: 5px 8px;
  }
}
@media (max-width: 560px) {
  .delivery-settlement-chain {
    grid-template-columns: 1fr;
  }
  .delivery-settlement-chain > b {
    display: none;
  }
  .delivery-settlement-chain > div {
    border-bottom: 1px dashed #dbe4ef;
  }
  .delivery-settlement-chain > div:last-child {
    border-bottom: 0;
  }
}
.meituan-group-settlement {
  gap: 8px;
  border-color: #eadcfb;
  background: linear-gradient(100deg, #fbf8ff, #fffaf4);
}
.settlement-fee-step {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  padding: 2px 10px;
  border-radius: 9px;
  cursor: help;
  outline: 0;
}
.settlement-fee-step:hover,
.settlement-fee-step:focus-visible {
  background: #f3edff;
  box-shadow: inset 0 0 0 1px #dbc8fb;
}
.meituan-group-settlement .settlement-fee-step strong {
  color: #6d3fbb;
}
.compare-mode .meituan-group-settlement {
  border-color: rgba(172, 133, 238, 0.3);
  background: rgba(33, 20, 60, 0.58);
}
.compare-mode .settlement-fee-step:hover,
.compare-mode .settlement-fee-step:focus-visible {
  background: rgba(111, 71, 188, 0.22);
  box-shadow: inset 0 0 0 1px rgba(190, 157, 247, 0.42);
}
.compare-mode .meituan-group-settlement .settlement-fee-step strong {
  color: #d9c5ff;
}
.douyin-group-settlement {
  border-color: #cfe8e4;
  background: linear-gradient(100deg, #f7fcfb, #f7faff);
}
.douyin-group-settlement .settlement-expense strong,
.douyin-group-settlement .settlement-refund strong {
  color: #bf701e;
}
.douyin-group-settlement .settlement-other strong {
  color: #60728d;
}
.compare-mode .douyin-group-settlement {
  border-color: rgba(89, 197, 174, 0.3);
  background: rgba(13, 49, 51, 0.65);
}
.compare-mode .douyin-group-settlement .settlement-expense strong,
.compare-mode .douyin-group-settlement .settlement-refund strong {
  color: #f3bf74;
}
.compare-mode .douyin-group-settlement .settlement-other strong {
  color: #b9cae4;
}
:global(.group-fee-category-tooltip) {
  max-width: min(330px, calc(100vw - 32px));
  padding: 10px 12px !important;
  border-color: #e1d5f5 !important;
  box-shadow: 0 14px 34px rgba(54, 31, 88, 0.16) !important;
}
.group-fee-category-detail {
  min-width: 248px;
  color: #40506a;
}
.group-fee-category-detail header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 7px;
}
.group-fee-category-detail header strong {
  color: #493173;
  font-size: 13px;
}
.group-fee-category-detail header span {
  padding: 3px 7px;
  border-radius: 9px;
  background: #f2ecff;
  color: #7652b8;
  font-size: 10px;
  font-weight: 700;
}
.group-fee-category-line {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 5px 0;
  border-top: 1px dashed #ebe3f6;
  font-size: 12px;
}
.group-fee-category-line span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-fee-category-line b {
  flex: none;
  color: #5d3b97;
  font-variant-numeric: tabular-nums;
}
.group-fee-category-detail p {
  margin: 5px 0;
  color: #8a98aa;
  font-size: 12px;
}
.group-fee-category-detail footer {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid #ded3ee;
  font-size: 12px;
}
.group-fee-category-detail footer b {
  color: #6941ad;
  font-size: 14px;
}
.compact-range-picker {
  width: 360px !important;
  flex: 0 0 360px;
}
@media (max-width: 560px) {
  .compact-range-picker {
    width: 100% !important;
    flex-basis: 100%;
  }
}
.delivery-product-panel {
  min-height: 420px;
}
.product-summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  padding: 16px 18px;
  border-bottom: 1px solid #edf1f5;
  background: linear-gradient(180deg, #fbfdff, #f7faff);
}
.product-summary-grid article {
  padding: 13px 14px;
  border: 1px solid #e3eaf4;
  border-radius: 10px;
  background: #fff;
}
.product-summary-grid span,
.product-summary-grid strong,
.product-summary-grid small {
  display: block;
}
.product-summary-grid span {
  color: #718096;
  font-size: 11px;
}
.product-summary-grid strong {
  margin: 7px 0 4px;
  color: #147c70;
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.product-summary-grid small {
  color: #97a4b5;
  font-size: 10px;
}
.delivery-product-table {
  border: 0;
}
.delivery-product-table :deep(.el-table__inner-wrapper:before) {
  display: none;
}
.mapped-sku {
  padding: 0;
  border: 0;
  background: transparent;
  color: #207258;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  text-align: left;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 3px;
  transition:
    color 0.18s ease,
    text-decoration-color 0.18s ease;
}
.mapped-sku:hover,
.mapped-sku:focus-visible {
  color: #176647;
  text-decoration-color: currentColor;
  outline: 0;
}
.inline-sku-picker {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  max-width: 260px;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid #d7e3f2;
  border-radius: 8px;
  background: #fbfdff;
  color: #8896a9;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.16s,
    box-shadow 0.16s;
}
.inline-sku-picker.is-bound {
  color: #207258;
  font-weight: 700;
  background: #f5fbf8;
  border-color: #cde9db;
}
.inline-sku-picker:hover,
.inline-sku-picker:focus-visible {
  border-color: #75a0eb;
  box-shadow: 0 0 0 3px rgba(66, 124, 221, 0.1);
  outline: 0;
}
.inline-sku-picker i {
  color: #88a1c7;
  font-size: 14px;
  font-style: normal;
}
.analytics-sku-picker-body {
  display: grid;
  gap: 9px;
}
.analytics-picker-caption {
  color: #438066;
  font-size: 11px;
  font-weight: 700;
}
.analytics-sku-options {
  display: grid;
  max-height: 312px;
  overflow: auto;
}
.analytics-sku-options button {
  display: grid;
  gap: 3px;
  padding: 9px 10px;
  border: 0;
  border-top: 1px solid #edf1f6;
  background: #fff;
  color: #30445f;
  text-align: left;
  cursor: pointer;
}
.analytics-sku-options button:first-child {
  border-top: 0;
}
.analytics-sku-options button:hover {
  background: #f4f8ff;
}
.analytics-sku-options button.recommended {
  background: #f4fbf7;
}
.analytics-sku-options button.recommended:hover {
  background: #eaf8f0;
}
.analytics-sku-options b {
  font-size: 12px;
  font-weight: 650;
  line-height: 1.4;
}
.analytics-sku-options small {
  color: #8594a7;
  font-size: 11px;
}
.analytics-picker-empty {
  padding: 17px 8px;
  color: #98a5b6;
  font-size: 12px;
  text-align: center;
}
.unmapped-sku {
  color: #9aa5b5;
}
.profit-positive {
  color: #16865a;
  font-weight: 700;
}
.profit-negative {
  color: #d65262;
  font-weight: 700;
}
.product-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 11px 18px;
  border-top: 1px solid #edf1f5;
  background: #fafbfd;
  color: #8491a2;
  font-size: 12px;
}
@media (max-width: 900px) {
  .product-summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .product-summary-grid {
    grid-template-columns: 1fr;
  }
  .product-pagination {
    align-items: flex-start;
    flex-direction: column;
  }
}

/* 1366px 笔记本在展开数据看板时避免六张卡片被压成窄列。 */
@media (max-width: 1440px) {
  .metric-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .metric-grid.compact {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .filter-bar {
    flex-wrap: wrap;
  }
  .filter-summary {
    width: 100%;
    margin-left: 0;
  }
  .chart-grid {
    grid-template-columns: minmax(0, 1.35fr) minmax(260px, 0.85fr);
  }
}
.fee-breakdown {
  min-width: 236px;
  padding: 2px;
  color: #31435b;
}
.fee-breakdown strong {
  display: block;
  margin-bottom: 5px;
  color: #243e65;
  font-size: 13px;
}
.fee-breakdown > p {
  margin: 0 0 9px;
  color: #7d8b9d;
  font-size: 11px;
  line-height: 1.5;
}
.fee-breakdown-line {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 5px 0;
  border-top: 1px dashed #e6ecf4;
  font-size: 12px;
}
.fee-breakdown-line span {
  overflow: hidden;
  color: #617289;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fee-breakdown-line b {
  flex: none;
  color: #2f4669;
  font-variant-numeric: tabular-nums;
}
.fee-breakdown-empty {
  padding: 8px 0;
  color: #97a3b2;
  font-size: 12px;
}
.fee-breakdown footer {
  display: flex;
  justify-content: space-between;
  margin-top: 5px;
  padding-top: 8px;
  border-top: 1px solid #dbe5f0;
  color: #536983;
  font-size: 12px;
}
.fee-breakdown footer b {
  color: #c47c12;
  font-size: 14px;
}
.delivery-platform-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  white-space: nowrap;
}
.delivery-platform-switch > span {
  color: #69778c;
  font-size: 12px;
  font-weight: 700;
}
.delivery-platform-switch :deep(.el-radio-button__inner) {
  padding: 8px 11px;
  font-size: 12px;
}
@media (max-width: 560px) {
  .delivery-platform-switch {
    flex-wrap: wrap;
    width: 100%;
  }
}
.fee-breakdown {
  width: min(304px, calc(100vw - 36px));
  min-width: 0;
  max-height: calc(100vh - 76px);
  display: flex;
  flex-direction: column;
  padding: 4px 2px;
}
.fee-breakdown header {
  flex: none;
  padding: 0 4px 8px;
}
.fee-breakdown header > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.fee-breakdown header strong {
  margin: 0;
}
.fee-breakdown header span {
  flex: none;
  padding: 3px 7px;
  border-radius: 9px;
  background: #edf4ff;
  color: #4e77ad;
  font-size: 10px;
  font-weight: 700;
}
.fee-breakdown header p {
  margin: 6px 0 0;
  color: #7d8b9d;
  font-size: 11px;
  line-height: 1.45;
}
.fee-breakdown-scroll {
  min-height: 0;
  max-height: min(224px, calc(100vh - 190px));
  overflow-y: auto;
  padding: 0 5px 0 4px;
  scrollbar-width: thin;
  scrollbar-color: #c9d5e4 transparent;
}
.fee-breakdown-scroll::-webkit-scrollbar {
  width: 5px;
}
.fee-breakdown-scroll::-webkit-scrollbar-thumb {
  border-radius: 5px;
  background: #c9d5e4;
}
.fee-breakdown-line {
  min-height: 28px;
  padding: 5px 0;
}
.fee-breakdown-line span {
  padding-right: 8px;
}
.fee-breakdown footer {
  flex: none;
  margin: 7px 4px 0;
  padding-top: 8px;
}
.meituan-op-panel {
  margin-top: 14px;
}
.meituan-op-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 13px;
  border-bottom: 1px solid #edf1f5;
}
.meituan-op-header h3 {
  margin: 0;
  color: #243d5e;
  font-size: 16px;
}
.meituan-op-header p {
  margin: 5px 0 0;
  color: #8a97a7;
  font-size: 11px;
}
.meituan-op-header .panel-badge {
  margin-top: 3px;
}
.meituan-op-tiles {
  display: grid;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  gap: 10px;
  padding: 16px 18px;
  border-bottom: 1px solid #edf1f5;
  background: linear-gradient(180deg, #fbfdff, #f7faff);
}
.meituan-op-tiles article {
  min-width: 0;
  padding: 12px 13px;
  border: 1px solid #e3eaf4;
  border-radius: 10px;
  background: #fff;
}
.meituan-op-tiles span,
.meituan-op-tiles strong,
.meituan-op-tiles small {
  display: block;
}
.meituan-op-tiles span {
  overflow: hidden;
  color: #718096;
  font-size: 10px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.meituan-op-tiles strong {
  margin: 6px 0 3px;
  color: #1f5fb9;
  font-size: 17px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.meituan-op-tiles small {
  overflow: hidden;
  color: #97a4b5;
  font-size: 9px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.meituan-op-tiles article.op-rate strong {
  color: #0f9d7b;
}
.group-operation-tiles {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}
.group-operation-tiles article {
  min-height: 86px;
  padding: 15px 16px;
}
.group-operation-tiles strong {
  font-size: 19px;
}
.group-operation-tiles article:nth-child(-n + 4) {
  border-top: 2px solid #7ca9ef;
}
.group-operation-tiles article:nth-child(n + 5):nth-child(-n + 9) {
  border-top: 2px solid #56a58d;
}
.group-operation-tiles article:nth-child(n + 10) {
  border-top: 2px solid #ab8de1;
}
.meituan-op-table {
  border: 0;
}
.meituan-op-table :deep(.el-table__inner-wrapper:before) {
  display: none;
}
.compare-mode .meituan-op-panel {
  border-color: rgba(118, 157, 213, 0.22);
  background: rgba(13, 30, 53, 0.92);
}
.compare-mode .meituan-op-header {
  border-bottom-color: rgba(128, 163, 216, 0.18);
}
.compare-mode .meituan-op-header h3 {
  color: #e6efff;
}
.compare-mode .meituan-op-header p {
  color: #a9bbd6;
}
.compare-mode .meituan-op-tiles {
  border-bottom-color: rgba(128, 163, 216, 0.18);
  background: rgba(13, 30, 53, 0.85);
}
.compare-mode .meituan-op-tiles article {
  border-color: rgba(118, 157, 213, 0.22);
  background: rgba(18, 42, 74, 0.9);
}
.compare-mode .meituan-op-tiles span,
.compare-mode .meituan-op-tiles small {
  color: #a9bbd6;
}
.compare-mode .meituan-op-tiles strong {
  color: #e7f1ff;
}
.compare-mode .meituan-op-tiles article.op-rate strong {
  color: #55d8a6;
}
@media (max-width: 1280px) {
  .meituan-op-tiles {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
  .group-operation-tiles {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
@media (max-width: 760px) {
  .meituan-op-tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .meituan-op-header {
    align-items: flex-start;
    flex-direction: column;
  }
}
.mt-op-note {
  color: #8a97a7;
  font-size: 11px;
  line-height: 1.6;
  padding: 9px 18px;
  border-top: 1px solid #edf1f5;
  background: #fafbfd;
}
.meituan-op-table .profit-positive {
  color: #16865a;
  font-weight: 700;
}
.meituan-op-table .profit-negative {
  color: #d65262;
  font-weight: 700;
}
.mt-trend-panel {
  margin-top: 14px;
}
.mt-trend-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px 13px;
  border-bottom: 1px solid #edf1f5;
}
.mt-trend-title {
  min-width: 180px;
}
.mt-trend-header h3 {
  margin: 0;
  color: #243d5e;
  font-size: 16px;
}
.mt-trend-header p {
  margin: 5px 0 0;
  color: #8a97a7;
  font-size: 11px;
  line-height: 1.6;
}
.mt-trend-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.mt-metric-group {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 4px;
  border: 1px solid #e3eaf3;
  border-radius: 9px;
  background: #f8fafc;
}
.mt-metric-funnel {
  background: #fbfcfe;
}
.mt-metric-label {
  padding: 0 5px;
  color: #8a97a7;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.mt-metric-group button {
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 5px 8px;
  background: transparent;
  color: #66778e;
  font-size: 11px;
  line-height: 1.25;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.16s ease,
    border-color 0.16s ease,
    color 0.16s ease;
}
.mt-metric-group button:hover {
  background: #edf4ff;
  color: #2455a6;
}
.mt-metric-group button.active {
  border-color: #c9ddff;
  background: #eaf2ff;
  color: #1757b4;
  font-weight: 700;
}
.mt-trend-toolbar .panel-badge {
  margin-left: 2px;
}
.mt-trend-body {
  display: block;
  padding: 12px 18px 0;
}
.mt-chart {
  width: 100%;
  height: 340px;
}
.mt-chart-note {
  display: block;
  color: #97a4b5;
  font-size: 10px;
  margin: 3px 0 8px;
  text-align: center;
}
.chart-grid.single {
  grid-template-columns: minmax(0, 1fr);
}
.compare-mode .mt-trend-panel {
  border-color: rgba(118, 157, 213, 0.22);
  background: rgba(13, 30, 53, 0.92);
}
.compare-mode .mt-trend-header {
  border-bottom-color: rgba(128, 163, 216, 0.18);
}
.compare-mode .mt-trend-header h3 {
  color: #e6efff;
}
.compare-mode .mt-trend-header p {
  color: #a9bbd6;
}
.compare-mode .mt-metric-group {
  border-color: rgba(118, 157, 213, 0.3);
  background: rgba(18, 42, 74, 0.72);
}
.compare-mode .mt-metric-label {
  color: #9fb5d2;
}
.compare-mode .mt-metric-group button {
  color: #c7d8f2;
}
.compare-mode .mt-metric-group button:hover {
  background: rgba(64, 113, 194, 0.3);
  color: #fff;
}
.compare-mode .mt-metric-group button.active {
  border-color: #3f74d8;
  background: #1e40af;
  color: #fff;
}
.compare-mode .mt-chart-note {
  color: #91a7c5;
}
@media (max-width: 980px) {
  .mt-trend-header {
    flex-direction: column;
  }
  .mt-trend-toolbar {
    justify-content: flex-start;
  }
}
@media (max-width: 560px) {
  .mt-chart {
    height: 300px;
  }
  .mt-trend-toolbar {
    gap: 6px;
  }
  .mt-metric-group {
    width: 100%;
    flex-wrap: wrap;
  }
  .mt-metric-group button {
    flex: 1 1 auto;
    text-align: center;
  }
  .mt-trend-toolbar .panel-badge {
    display: none;
  }
}
.meituan-group-settlement,
.douyin-group-settlement {
  min-height: 92px;
  box-sizing: border-box;
}
.meituan-group-settlement > div,
.douyin-group-settlement > div {
  justify-content: center;
}
.mt-trend-panel .mt-chart {
  height: 340px;
}
.meituan-op-tiles.group-operation-tiles {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.group-operation-tiles article {
  min-height: 78px;
  box-sizing: border-box;
}
@media (max-width: 900px) {
  .meituan-op-tiles.group-operation-tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.group-query-overlay {
  position: fixed;
  z-index: 2200;
  left: 50%;
  top: 94px;
  display: flex;
  align-items: center;
  gap: 13px;
  min-width: 330px;
  padding: 12px 14px;
  border: 1px solid #bcd5fb;
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 14px 38px rgba(31, 78, 147, 0.18);
  backdrop-filter: blur(12px);
  transform: translateX(-50%);
}
.group-query-overlay b,
.group-query-overlay span {
  display: block;
}
.group-query-overlay b {
  color: #245ea9;
  font-size: 13px;
}
.group-query-overlay span {
  margin-top: 3px;
  color: #7c8da4;
  font-size: 11px;
}
.group-query-orbit {
  position: relative;
  width: 28px;
  height: 28px;
  flex: none;
}
.group-query-orbit i {
  position: absolute;
  inset: 0;
  border: 2px solid transparent;
  border-top-color: #2e6fe0;
  border-radius: 50%;
  animation: group-query-spin 1s linear infinite;
}
.group-query-orbit i:nth-child(2) {
  inset: 5px;
  border-top-color: #21a77d;
  animation-direction: reverse;
  animation-duration: 0.76s;
}
.group-query-orbit i:nth-child(3) {
  inset: 10px;
  border-top-color: #f2a429;
  animation-duration: 0.52s;
}
.group-query-track {
  position: absolute;
  right: 14px;
  bottom: 9px;
  left: 55px;
  height: 2px;
  overflow: hidden;
  border-radius: 4px;
  background: #e6effc;
}
.group-query-track i {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #3b82f6, #49b98e);
  transition: width 0.34s ease;
}
@keyframes group-query-spin {
  to {
    transform: rotate(360deg);
  }
}
.group-query-enter-active,
.group-query-leave-active {
  transition:
    opacity 0.22s ease,
    transform 0.22s ease;
}
.group-query-enter-from,
.group-query-leave-to {
  opacity: 0;
  transform: translate(-50%, -12px);
}
.settlement-hover {
  cursor: help;
  outline: 0;
}
.settlement-hover:hover,
.settlement-hover:focus-visible {
  border-radius: 9px;
  background: rgba(39, 120, 218, 0.07);
  box-shadow: inset 0 0 0 1px rgba(94, 153, 237, 0.36);
}
:global(.douyin-settlement-tooltip) {
  max-width: min(340px, calc(100vw - 30px));
  padding: 10px 12px !important;
  border-color: #cfe8e4 !important;
  box-shadow: 0 14px 34px rgba(20, 95, 85, 0.15) !important;
}
.douyin-settlement-detail {
  min-width: 242px;
  color: #40506a;
}
.douyin-settlement-detail header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 7px;
}
.douyin-settlement-detail header strong {
  color: #176d5e;
  font-size: 13px;
}
.douyin-settlement-detail header span {
  padding: 3px 7px;
  border-radius: 9px;
  background: #eaf8f1;
  color: #16865a;
  font-size: 10px;
  font-weight: 700;
}
.douyin-settlement-line {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 5px 0;
  border-top: 1px dashed #dceee9;
  font-size: 12px;
}
.douyin-settlement-line span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.douyin-settlement-line b {
  flex: none;
  color: #197764;
  font-variant-numeric: tabular-nums;
}
.douyin-settlement-detail p {
  margin: 7px 0 0;
  color: #7e918f;
  font-size: 11px;
  line-height: 1.5;
}
.douyin-settlement-detail footer {
  display: flex;
  justify-content: space-between;
  margin-top: 7px;
  padding-top: 8px;
  border-top: 1px solid #cfe7df;
  font-size: 12px;
}
.douyin-settlement-detail footer b {
  color: #0b8064;
  font-size: 14px;
}
.group-operation-tiles {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  padding: 16px 18px;
}
.group-operation-tiles article {
  min-height: 82px;
  padding: 15px 16px;
  box-shadow: 0 2px 7px rgba(33, 63, 106, 0.025);
}
.group-operation-tiles strong {
  font-size: 19px;
}
@media (max-width: 640px) {
  .group-query-overlay {
    top: 74px;
    min-width: 0;
    width: calc(100vw - 32px);
  }
  .group-operation-tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.meituan-op-tiles.group-operation-tiles {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  padding: 18px;
  background: #f7f9fd;
}
.meituan-op-tiles.group-operation-tiles .operation-metric-card {
  position: relative;
  min-height: 118px;
  padding: 14px 15px 13px;
  overflow: hidden;
  border: 1px solid #e2e9f3;
  border-radius: 12px;
  background: linear-gradient(145deg, #fff 0%, #fbfcff 100%);
  box-shadow: 0 4px 12px rgba(33, 63, 106, 0.055);
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    border-color 0.18s ease;
}
.meituan-op-tiles.group-operation-tiles .operation-metric-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 20px rgba(33, 63, 106, 0.1);
}
.operation-card-kicker {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.operation-card-kicker i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 8%, transparent);
}
.operation-card-kicker em {
  color: #90a0b5;
  font-size: 10px;
  font-style: normal;
  font-weight: 700;
  letter-spacing: 0.05em;
}
.meituan-op-tiles.group-operation-tiles .operation-metric-card > span {
  color: #60718a;
  font-size: 12px;
}
.meituan-op-tiles.group-operation-tiles .operation-metric-card strong {
  margin: 7px 0 5px;
  color: #1e5fbd;
  font-size: 21px;
  letter-spacing: -0.015em;
}
.meituan-op-tiles.group-operation-tiles .operation-metric-card small {
  color: #9aa7b8;
  font-size: 10px;
}
.meituan-op-tiles.group-operation-tiles .operation-metric-card.metric-revenue {
  border-color: #d8e6fb;
  background: linear-gradient(145deg, #fff, #f4f8ff);
}
.meituan-op-tiles.group-operation-tiles .operation-metric-card.metric-traffic {
  border-color: #d6eee7;
  background: linear-gradient(145deg, #fff, #f3fbf8);
}
.meituan-op-tiles.group-operation-tiles
  .operation-metric-card.metric-traffic
  strong,
.meituan-op-tiles.group-operation-tiles .operation-metric-card.op-rate strong {
  color: #0e9472;
}
.meituan-op-tiles.group-operation-tiles .operation-metric-card.metric-rating {
  border-color: #e6dcfb;
  background: linear-gradient(145deg, #fff, #faf8ff);
}
.meituan-op-tiles.group-operation-tiles
  .operation-metric-card.metric-rating
  strong {
  color: #7050b8;
}
@media (max-width: 900px) {
  .meituan-op-tiles.group-operation-tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    padding: 14px;
  }
  .meituan-op-tiles.group-operation-tiles .operation-metric-card {
    min-height: 108px;
  }
}
.total-product-local-sku {
  color: #087f5b;
  font-weight: 700;
}
.total-product-unmapped {
  color: #98a4b5;
}
.total-product-breakdown {
  margin: 2px 22px 6px;
  padding: 12px 15px;
  border: 1px solid #e3eaf4;
  border-radius: 10px;
  background: #f8fbff;
}
.total-product-breakdown-title {
  margin-bottom: 8px;
  color: #4d6380;
  font-size: 12px;
  font-weight: 700;
}
.total-product-breakdown-row {
  display: grid;
  grid-template-columns: 130px minmax(180px, 1fr) 92px 130px 130px 80px;
  gap: 10px;
  align-items: center;
  min-height: 32px;
  border-top: 1px dashed #e2e9f2;
  color: #52657d;
  font-size: 12px;
}
.total-product-breakdown-row:first-of-type { border-top: 0; }
.total-product-source { color: #2369b8; font-weight: 700; }
.total-product-origin { color: #233c5c; }
.total-product-breakdown-row b { color: #176b59; font-weight: 700; }
@media (max-width: 900px) {
  .total-product-breakdown { margin: 2px 0; overflow-x: auto; }
  .total-product-breakdown-row { min-width: 680px; }
}
</style>
