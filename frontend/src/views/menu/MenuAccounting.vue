<template>
  <!--
    菜品核算 —— 禽类消耗反推
    临时挂在「菜品管理」下，功能打通后整体迁往「成本核算」。
    迁移步骤：① 本文件移到 views/cost/ ② 把下方 active 与 App.vue / stores/app.js /
    MenuModuleHeader.vue / router 里的 tab id 前缀 menu-management-accounting 改成 cost-accounting-accounting
    ③ 路由 path 改为 /cost-accounting/accounting。接口与业务逻辑无需改动。
  -->
  <div class="menu-module-page">
    <MenuModuleHeader
      title="菜品核算"
      description="选门店与时间段查菜品销量，按整只出成拆解反推这段时间大概消耗了多少只鹅鸭鸡。"
      active="menu-management-accounting"
      :metrics="heroMetrics"
    >
      <template #action>
        <el-button class="hero-action" @click="downloadTemplate">下载模板</el-button>
        <el-button class="hero-action" @click="openArchive('birds')">基础档案</el-button>
      </template>
    </MenuModuleHeader>

    <!-- ===== 筛选条 ===== -->
    <section class="menu-panel accounting-filter-panel">
      <header class="menu-panel-header">
        <div class="menu-panel-title">
          <h3>核算条件</h3>
          <span>
            只数 = max（身体各部位折鸟数<b>相加</b>，副产品各部位折鸟数<b>取最大</b>）
            —— 一只鸟同时产出多个部位，所以副产品不额外占鸟
            <template v-if="result?.data_range?.max_date"> · 销量数据截止 {{ result.data_range.max_date }}</template>
          </span>
        </div>
        <div class="menu-filters">
          <el-select v-model="filters.storeId" filterable clearable placeholder="全部门店" style="width: 210px;">
            <el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.id" />
          </el-select>
          <el-date-picker
            v-model="filters.range"
            type="daterange"
            unlink-panels
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            value-format="YYYY-MM-DD"
            style="width: 260px;"
          />
          <el-select v-model="filters.channel" style="width: 150px;">
            <el-option label="全部渠道" value="all" />
            <el-option label="堂食" value="dine_in" />
            <el-option label="团购核销" value="group" />
            <el-option label="外卖" value="delivery" />
            <el-option label="其他/未分类" value="other" />
          </el-select>
          <el-select v-model="filters.animal" clearable placeholder="全部禽类" style="width: 130px;">
            <el-option v-for="animal in animals" :key="animal" :label="animal" :value="animal" />
          </el-select>
          <el-button type="primary" :loading="loading" @click="loadAccounting">查询</el-button>
        </div>
      </header>
      <div v-if="rangeOutOfData" class="accounting-hint">
        <el-alert type="warning" :closable="false" show-icon
          :title="`所选区间超出销量数据范围：系统内销量只覆盖 ${result.data_range.min_date} ~ ${result.data_range.max_date}，超出部分按 0 计。`" />
      </div>
    </section>

    <!-- ===== 口径未建立时的引导 ===== -->
    <section v-if="!loading && !hasArchiveData" class="menu-panel accounting-empty-panel">
      <div class="accounting-empty">
        <h3>{{ hasAnyBird ? '禽类档案还没配齐，暂时算不出只数' : '还没有禽类出成档案，暂时算不出只数' }}</h3>
        <p>菜品核算依赖三层基础数据：<b>① 一只禽的品种与净重</b> → <b>② 一只禽出哪些部位、各出几个</b> → <b>③ 每份菜吃掉几个部位</b>。</p>
        <ol>
          <li>点「下载模板」，在 Excel 里填好「禽类档案」「整只出成」「菜品耗用」三个页签（菜品行已预填本地全部菜品，只需补品种、部位、每份耗用数量）；</li>
          <li>点「基础档案」逐项核对，或直接导入模板；</li>
          <li>回到本页选门店和时间段查询即可。</li>
        </ol>
        <div class="accounting-empty-actions">
          <el-button type="primary" @click="downloadTemplate">下载模板</el-button>
          <el-button @click="openArchive(hasAnyBird ? 'yields' : 'birds')">{{ hasAnyBird ? '去录入整只出成' : '手工录入禽类档案' }}</el-button>
        </div>
      </div>
    </section>

    <!-- 关键：核算结果未返回前不能进主区块，否则 summary 为空会渲染报错 -->
    <template v-else-if="result">
      <!-- ===== 只数汇总 ===== -->
      <section class="metric-strip">
        <div v-for="card in summaryCards" :key="card.label" class="metric-card" :class="{ 'metric-main': card.main }">
          <span>{{ card.label }}</span>
          <strong :class="card.tone">{{ card.value }}</strong>
          <small>{{ card.hint }}</small>
        </div>
      </section>

      <!-- ===== 覆盖率提示（两个口径：禽类菜品覆盖率是风控该看的数，全量覆盖率作参考） ===== -->
      <section class="menu-panel coverage-panel">
        <div class="coverage-body">
          <div class="coverage-head">
            <span :class="['coverage-badge', coverageTone]">
              禽类菜品覆盖 {{ percent(poultryCoverage.covered_rate) }}
            </span>
            <span class="coverage-badge reference" title="分母含柠檬茶/白米饭/打包盒等无需配禽类系数的品类，只作参考">
              全量覆盖 {{ percent(result.summary.covered_rate) }}
            </span>
            <span class="coverage-text">
              本期<b>禽类菜</b>共 <b>{{ number(poultryCoverage.scope_quantity) }}</b> 份销量
              （判定依据：名称含 {{ scopeIncludeText }}<template v-if="poultryCoverage.exclude_keywords?.length">，排除 {{ scopeExcludeText }}</template>），
              已配齐 <b>{{ number(poultryCoverage.covered_quantity) }}</b> 份，
              还差 <b>{{ number(poultryCoverage.uncovered_quantity) }}</b> 份没配
              （<b>{{ number(poultryCoverage.unbound_quantity) }}</b> 份是报表菜名没关联到本地菜品，
              需去「堂食菜品绑定」；<b>{{ number(poultryCoverage.no_usage_quantity) }}</b> 份是已关联但没配部位系数，
              需去「菜品耗用」）。
              全量覆盖率的分母 {{ number(result.summary.total_quantity) }} 份里含无需配禽类系数的品类，所以它天然偏低，只看参考。
            </span>
            <el-button link type="primary" @click="openGapDialog">
              查看缺口明细
            </el-button>
            <el-button link type="primary" @click="openScopeDialog">
              维护禽类菜范围
            </el-button>
          </div>
          <div v-if="poultryCoverage.fallback" class="coverage-warnings">
            <el-alert type="warning" :closable="false" show-icon
              title="禽类菜关键词表为空，当前用的是内置默认（鹅/鸭/鸡）—— 请到「维护禽类菜范围」里确认。" />
          </div>
          <div v-if="result.coverage.warning_count" class="coverage-warnings">
            <el-alert type="warning" :closable="false" show-icon
              :title="`有 ${result.coverage.warning_count} 条配置需要复核（每份折合超过 1 只禽，或出成数量为 0）`">
              <div class="warning-list">
                <div v-for="(row, index) in result.coverage.warnings.slice(0, 5)" :key="index">{{ row.message }}</div>
                <div v-if="result.coverage.warning_count > 5">……其余 {{ result.coverage.warning_count - 5 }} 条请在「基础档案」里核对</div>
              </div>
            </el-alert>
          </div>
          <div class="channel-chips">
            <span class="chip-label">渠道构成</span>
            <span v-for="row in result.channel_breakdown" :key="row.channel" :class="['channel-chip', row.channel]">
              {{ row.label }} {{ number(row.quantity) }} 份
            </span>
            <span v-if="hasUnclassifiedChannel" class="chip-tip">
              「其他/未分类」是收银流水里未记录渠道来源的记录（如「扫码支付-微信 25.00」），既非堂食也非外卖，单独列出不参与渠道筛选。
            </span>
          </div>
        </div>
      </section>

      <!-- ===== 口径说明 + 按部位汇总（看得出瓶颈在哪） ===== -->
      <section class="menu-panel">
        <header class="menu-panel-header">
          <div class="menu-panel-title">
            <h3>按部位汇总 · 瓶颈在哪</h3>
            <span>一只鸟同时产出多个部位，所以「身体」各卖法相加、「副产品」取最大，两者再取大的那个作为只数</span>
          </div>
          <div class="menu-filters">
            <el-select v-model="partKindFilter" clearable placeholder="全部类别" style="width: 130px;">
              <el-option label="身体" value="身体" />
              <el-option label="副产品" value="副产品" />
            </el-select>
          </div>
        </header>
        <div v-if="linearGap" class="caliber-note">
          <div class="caliber-row">
            <span class="caliber-label">当前口径（料篮）</span>
            <b class="caliber-value">{{ linearGap.now }} 只</b>
            <span class="caliber-desc">同一只鸟的多个部位只算一次鸟</span>
          </div>
          <div class="caliber-row muted">
            <span class="caliber-label">旧口径（各菜品独立）</span>
            <span class="caliber-value small">{{ linearGap.linear }} 只</span>
            <span class="caliber-desc">
              等于假设每个菜品都单独买一只鸟，多算了 {{ linearGap.diff }} 只
              <template v-if="linearGap.times">（{{ linearGap.times }} 倍）</template>，仅作对照参考
            </span>
          </div>
        </div>
        <el-table :data="filteredParts" class="menu-data-table" max-height="420" row-key="yield_id">
          <el-table-column label="部位" min-width="180">
            <template #default="{ row }">
              <div class="bird-cell">
                <span class="part-name">{{ row.part_name }}</span>
                <span v-if="row.is_bottleneck" class="bottleneck-tag">瓶颈</span>
              </div>
              <small class="config-line">{{ row.animal }} · {{ row.breed_name }}</small>
            </template>
          </el-table-column>
          <el-table-column label="类别" width="100" align="center">
            <template #default="{ row }">
              <span :class="['kind-chip', row.part_kind === '副产品' ? 'byproduct' : 'body']">{{ row.part_kind }}</span>
            </template>
          </el-table-column>
          <el-table-column label="一只出成" width="100" align="right">
            <template #default="{ row }">{{ row.parts_per_bird }} 份</template>
          </el-table-column>
          <el-table-column label="总需求" width="120" align="right">
            <template #default="{ row }"><span class="menu-price">{{ number(row.demand) }}</span></template>
          </el-table-column>
          <el-table-column label="折合只数" width="130" align="right">
            <template #default="{ row }">
              <span :class="['menu-price', row.is_bottleneck ? 'birds' : '']">{{ row.birds }} 只</span>
            </template>
          </el-table-column>
          <el-table-column label="参与方式" min-width="260">
            <template #default="{ row }">
              <span class="muted-text">
                {{ row.part_kind === '副产品'
                  ? '随鸟附带产出，不额外占鸟；只与其他副产品比大小'
                  : '与身体其它卖法相加（抢同一块身体）' }}
              </span>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="!(result.parts || []).length" class="menu-empty">还没有已配置的部位耗用</div>
        <footer v-if="(result.parts || []).length" class="menu-pagination-footer">
          <span>
            共 {{ (result.parts || []).length }} 个部位 · 资源池约束：{{ constraintText }} →
            只数取<b>最大者</b> {{ result.summary.total_birds }} 只
          </span>
        </footer>
      </section>

      <!-- ===== 采购校准（模型 vs 门店实际，MAPE） ===== -->
      <section class="menu-panel">
        <header class="menu-panel-header">
          <div class="menu-panel-title">
            <h3>采购校准 · 模型 vs 门店实际</h3>
            <span class="muted-text">
              用真实只数评价参数好坏 —— MAPE 越小说明出成系数越准；改完系数再校准一次，就能看出是否真的改善
            </span>
          </div>
          <el-button :loading="calibLoading" @click="loadCalibration">开始校准</el-button>
        </header>
        <div v-if="calibData" class="calib-body">
          <div class="calib-summary">
            <div :class="['calib-card', calibLevelTone]">
              <span>MAPE（平均绝对偏差）</span>
              <strong>{{ percent(calibData.summary.mape) }}</strong>
              <small>{{ calibData.summary.level_label }}</small>
            </div>
            <div class="calib-card">
              <span>样本数（门店 × 月）</span>
              <strong>{{ calibData.summary.sample_count }}</strong>
              <small>来自「实际采购只数」录入</small>
            </div>
            <div class="calib-card">
              <span>平均偏差（带正负）</span>
              <strong>{{ percent(calibData.summary.avg_deviation) }}</strong>
              <small>正值=模型偏高，负值=模型偏低</small>
            </div>
            <div class="calib-card">
              <span>中位绝对偏差</span>
              <strong>{{ percent(calibData.summary.median_abs_deviation) }}</strong>
              <small>比平均值更抗个别异常</small>
            </div>
          </div>
          <el-table v-if="calibData.rows.length" :data="calibData.rows" class="menu-data-table" size="small" max-height="320">
            <el-table-column prop="month" label="月份" width="100" />
            <el-table-column prop="store_name" label="门店" min-width="180" />
            <el-table-column prop="animal" label="禽类" width="80" />
            <el-table-column label="模型理论" width="110" align="right">
              <template #default="{ row }">{{ number(row.theory_birds) }} 只</template>
            </el-table-column>
            <el-table-column label="门店实际" width="110" align="right">
              <template #default="{ row }">{{ number(row.actual_birds) }} 只</template>
            </el-table-column>
            <el-table-column label="偏差" width="110" align="right">
              <template #default="{ row }">
                <span :class="['calib-dev', Math.abs(row.deviation) > 0.1 ? 'bad' : Math.abs(row.deviation) > 0.05 ? 'warn' : 'ok']">
                  {{ row.deviation > 0 ? '+' : '' }}{{ percent(row.deviation) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="governing" label="瓶颈" min-width="130" />
          </el-table>
          <p v-else class="menu-empty">
            还没有可校准的数据 —— 请先在「理论 vs 实际采购」里录入门店每月的实际只数（每店每月每禽类一条）
          </p>
          <p v-if="calibData.truncated" class="archive-note">（本次只算了最近 12 条；数据多时可指定门店再校准）</p>
        </div>
        <p v-else class="menu-empty">点右上角「开始校准」：把每个门店每月录入的实际只数与模型算出的只数逐条对比（数据多时需要几秒）</p>
      </section>

      <!-- ===== 食材去向对账（风控） ===== -->
      <section class="menu-panel">
        <header class="menu-panel-header">
          <div class="menu-panel-title">
            <h3>食材去向对账（风控）</h3>
            <span>
              一只禽固定产出 1 个头颈 + 2 只翅 + 一整只身体的肉，三者记录必须互相吻合；
              对不上的差额就是「去向不明」（报损 / 员工餐 / 赠送 / 没进 POS / 菜品没绑定）
            </span>
          </div>
        </header>
        <div class="risk-body">
          <el-alert v-if="riskLowCoverage" type="warning" :closable="false" show-icon
            :title="`当前禽类菜品覆盖率只有 ${percent(poultryCoverage.covered_rate)}，还有 ${number(poultryCoverage.uncovered_quantity)} 份禽类菜销量没落到已配系数的菜品上。此时「身体差额」主要来自覆盖不足，不能当损耗看 —— 先把覆盖率补上来这个指标才有意义。`" />

          <div v-for="bird in riskBirds" :key="bird.bird_id" class="risk-block">
            <div class="risk-head">
              <span :class="['animal-pill', animalTone(bird.animal)]">{{ bird.animal }}</span>
              <b>{{ bird.breed_name }}</b>
              <span class="muted-text">推算加工 {{ bird.risk.processed_birds }} 只（瓶颈在{{ bird.governing }} · {{ bird.governing_part }}）</span>
            </div>

            <div class="risk-cards">
              <div class="risk-card">
                <span>推算加工只数</span>
                <strong>{{ bird.risk.processed_birds }}</strong>
                <small>由瓶颈部位反推</small>
              </div>
              <div class="risk-card">
                <span>身体已记录</span>
                <strong>{{ bird.risk.body_recorded }}</strong>
                <small>已配系数的身体类菜品合计</small>
              </div>
              <div :class="['risk-card', Math.abs(bird.risk.body_gap) > 0.5 ? 'warn' : 'ok']">
                <span>身体差额</span>
                <strong>{{ bird.risk.body_gap > 0 ? '+' : '' }}{{ bird.risk.body_gap }}</strong>
                <small>
                  {{ bird.risk.body_gap > 0.5
                    ? `约 ${bird.risk.body_gap} 只份量的肉去向不明（${percent(bird.risk.body_gap_rate)}）`
                    : bird.risk.body_gap < -0.5
                      ? `身体记录比推算多 ${Math.abs(bird.risk.body_gap)} 只，说明副产品少记录了`
                      : '对得上 ✅' }}
                </small>
              </div>
            </div>

            <div v-if="bird.risk.byproducts.length" class="risk-sub">
              <div class="risk-sub-title">
                副产品互相校验
                <span v-if="bird.risk.byproduct_conflict" class="risk-flag">⚠ 推算只数差 {{ bird.risk.byproduct_spread }} 只，明显不一致</span>
                <span v-else class="muted-text">互相吻合 ✅</span>
              </div>
              <el-table :data="bird.risk.byproducts" class="menu-data-table" size="small">
                <el-table-column prop="part_name" label="部位" min-width="120" />
                <el-table-column label="一只出" width="90" align="right">
                  <template #default="{ row }">{{ row.parts_per_bird }}</template>
                </el-table-column>
                <el-table-column label="应有" width="120" align="right">
                  <template #default="{ row }">{{ number(row.expected) }}</template>
                </el-table-column>
                <el-table-column label="实际记录" width="120" align="right">
                  <template #default="{ row }"><span class="menu-price">{{ number(row.demand) }}</span></template>
                </el-table-column>
                <el-table-column label="差额" width="120" align="right">
                  <template #default="{ row }">
                    <span :class="['menu-price', row.gap > 0.5 ? 'diff-up' : 'diff-down']">
                      {{ row.gap > 0 ? '+' : '' }}{{ number(row.gap) }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="反推只数" width="110" align="right">
                  <template #default="{ row }">{{ number(row.implied_birds) }}</template>
                </el-table-column>
              </el-table>
            </div>
            <div v-else class="muted-text risk-no-bp">
              还没有配【副产品】类部位（头颈/翅/掌），无法做副产品互相校验。建议把这类部位标成「副产品」并配上菜品，风控就能跨渠道交叉验证。
            </div>
          </div>
          <div v-if="!riskBirds.length" class="menu-empty">还没有可对账的部位配置</div>
        </div>
        <footer v-if="riskBirds.length" class="menu-pagination-footer">
          <span>
            差额口径：以模型只数为基准的「应有份量 − 实际记录份量」。
            差额大时先看覆盖率 —— 未绑定的菜品会被算成差额，不是真的丢了。
          </span>
        </footer>
      </section>

      <!-- ===== 按菜品下钻 ===== -->
      <section class="menu-panel">
        <header class="menu-panel-header">
          <div class="menu-panel-title">
            <h3>按菜品下钻</h3>
            <span>哪些菜品贡献了多少只禽 —— 占比越高越值得先复核其出成与耗用配置</span>
          </div>
          <div class="menu-filters">
            <el-input v-model="dishKeyword" clearable placeholder="搜索菜品 / 部位" class="wide-filter" />
            <el-select v-model="dishAnimal" clearable placeholder="全部禽类" style="width: 130px;">
              <el-option v-for="animal in animals" :key="animal" :label="animal" :value="animal" />
            </el-select>
          </div>
        </header>
        <el-table v-loading="loading" :data="paginatedDishes" class="menu-data-table" row-key="rowKey">
          <el-table-column label="菜品" min-width="220">
            <template #default="{ row }">
              <div class="dish-name">
                <span class="dish-monogram">{{ String(row.menu_name || '菜').slice(0, 1) }}</span>
                <div>
                  <b>{{ row.menu_name }}</b>
                  <small>{{ [row.menu_spec, row.category].filter(Boolean).join(' · ') || '未分类' }}</small>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="禽类 / 部位" min-width="170">
            <template #default="{ row }">
              <div class="bird-cell">
                <span :class="['animal-pill', animalTone(row.animal)]">{{ row.animal }}</span>
                <span class="part-name">{{ row.part_name }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="出成配置" min-width="190">
            <template #default="{ row }">
              <small class="config-line">
                一只出 {{ row.parts_per_bird }} 份 · 每份耗用 {{ row.usage_qty }}
                <template v-if="row.per_portion_birds > 1"> ⚠️</template>
              </small>
              <small class="config-line strong">每份折合 {{ row.per_portion_birds }} 只</small>
            </template>
          </el-table-column>
          <el-table-column label="销量" width="110" align="right">
            <template #default="{ row }"><span class="menu-price">{{ number(row.quantity) }}</span></template>
          </el-table-column>
          <el-table-column label="折合只数" width="130" align="right">
            <template #default="{ row }">
              <span class="menu-price">{{ row.birds_count }} 只</span>
              <small class="config-line">线性贡献</small>
            </template>
          </el-table-column>
          <el-table-column label="占比" min-width="150">
            <template #default="{ row }">
              <div class="share-cell">
                <span class="share-value">{{ percent(row.share) }}</span>
                <span class="margin-track"><i :style="{ width: Math.min(100, row.share * 100) + '%' }"></i></span>
              </div>
              <small class="config-line">占线性口径</small>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="!loading && !filteredDishes.length" class="menu-empty">没有符合条件的核算明细</div>
        <footer class="menu-pagination-footer">
          <span>共 {{ filteredDishes.length }} 条核算明细 · 只数保留 2 位小数</span>
          <el-pagination
            v-model:current-page="dishPage"
            v-model:page-size="dishPageSize"
            :page-sizes="[10, 20, 50]"
            :total="filteredDishes.length"
            layout="total, sizes, prev, pager, next"
            background
          />
        </footer>
      </section>

      <!-- ===== 理论 vs 实际采购 ===== -->
      <section class="menu-panel">
        <header class="menu-panel-header">
          <div class="menu-panel-title">
            <h3>理论用量 vs 实际采购</h3>
            <span>
              对比区间 {{ result.period.date_from }} ~ {{ result.period.date_to }}
              <template v-if="comparison"> · 采购月份 {{ comparison.months.join('、') }}</template>
            </span>
          </div>
          <div class="menu-filters">
            <el-button @click="openPurchaseDialog()">录入采购只数</el-button>
            <el-button type="primary" :loading="comparisonLoading" @click="loadComparison">刷新对比</el-button>
          </div>
        </header>
        <div v-if="comparison && !comparison.is_whole_month" class="accounting-hint">
          <el-alert type="info" :closable="false" show-icon
            title="当前核算区间不是完整自然月，而采购只数按月录入，两者口径不完全对齐，差异率仅供参考。" />
        </div>
        <el-table v-loading="comparisonLoading" :data="comparison?.comparison || []" class="menu-data-table" row-key="bird_id">
          <el-table-column label="禽类" min-width="170">
            <template #default="{ row }">
              <div class="bird-cell">
                <span :class="['animal-pill', animalTone(row.animal)]">{{ row.animal }}</span>
                <span class="part-name">{{ row.breed_name }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="理论用量" width="130" align="right">
            <template #default="{ row }"><span class="menu-price">{{ row.theoretical_birds }} 只</span></template>
          </el-table-column>
          <el-table-column label="实际采购" width="130" align="right">
            <template #default="{ row }">
              <span v-if="row.has_purchase" class="menu-price">{{ row.purchased_birds }} 只</span>
              <span v-else class="muted-text">未录入</span>
            </template>
          </el-table-column>
          <el-table-column label="差异" width="130" align="right">
            <template #default="{ row }">
              <span v-if="!row.has_purchase" class="muted-text">—</span>
              <span v-else :class="['menu-price', row.diff_birds > 0 ? 'diff-up' : 'diff-down']">
                {{ row.diff_birds > 0 ? '+' : '' }}{{ row.diff_birds }} 只
              </span>
            </template>
          </el-table-column>
          <el-table-column label="差异率" width="120" align="right">
            <template #default="{ row }">
              <span v-if="row.diff_rate === null" class="muted-text">—</span>
              <span v-else :class="['menu-price', row.diff_rate > 0 ? 'diff-up' : 'diff-down']">
                {{ row.diff_rate > 0 ? '+' : '' }}{{ percent(row.diff_rate) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="采购金额" width="130" align="right">
            <template #default="{ row }">
              <span v-if="row.has_purchase" class="menu-price">¥{{ money(row.purchased_amount) }}</span>
              <span v-else class="muted-text">—</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right" align="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openPurchaseDialog(row)">录入</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="comparison && !comparison.comparison.length" class="menu-empty">
          既没有理论用量也没有采购记录，先到「基础档案」补出成关系，或先录入采购只数
        </div>
        <footer v-if="comparison" class="menu-pagination-footer">
          <span>
            理论合计 {{ comparison.totals.theoretical_birds }} 只 / 实际合计 {{ comparison.totals.purchased_birds }} 只 ·
            理论成本 ¥{{ money(comparison.totals.theoretical_cost) }} / 采购金额 ¥{{ money(comparison.totals.purchased_amount) }}
          </span>
        </footer>
      </section>
    </template>

    <!-- 档案已配齐但核算尚未返回（首次加载或查询中）时的占位，避免空白页 -->
    <section v-else class="menu-panel">
      <div class="menu-empty">{{ loading ? '正在核算…' : '暂无核算结果，请点「查询」' }}</div>
    </section>

    <!-- ===== 缺口明细 ===== -->
    <el-dialog v-model="gapVisible" title="未覆盖明细" width="min(960px, calc(100vw - 32px))" align-center class="menu-dialog">
      <el-tabs v-model="gapTab">
        <el-tab-pane :label="`未绑定本地菜品（${result?.coverage?.unbound?.length || 0}）`" name="unbound">
          <p class="gap-desc">
            这些菜品有销量，但在「<b>堂食菜品绑定</b>」里没有关联本地菜品，系统无法得知它用了什么部位 —— 这是覆盖率偏低最常见的原因。
            判定方式：这条收银流水先查绑定表，再按「菜品名 + 规格」匹配本地菜品，最后按「同名唯一」兜底；三级都没命中就落到这里。
            <b>点右侧「去绑定」会自动带着菜名跳到绑定页</b>。
          </p>
          <el-table :data="result?.coverage?.unbound || []" max-height="420" class="menu-data-table">
            <el-table-column prop="product_name" label="收银菜品名" min-width="220" />
            <el-table-column prop="spec" label="规格" width="110" />
            <el-table-column prop="product_code" label="编码" width="120" />
            <el-table-column label="销量" width="110" align="right">
              <template #default="{ row }">{{ number(row.quantity) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="100" fixed="right" align="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="goBindDish(row)">去绑定</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`已绑定但未配出成（${result?.coverage?.no_usage?.length || 0}）`" name="no_usage">
          <p class="gap-desc">
            这些菜品已关联本地菜品，但还没配「每份耗用哪个部位」，属于「基础档案 → 菜品耗用」里待补的项。同名同规格的多个收银分组已合并统计。
          </p>
          <el-table :data="result?.coverage?.no_usage || []" max-height="420" class="menu-data-table">
            <el-table-column prop="menu_name" label="本地菜品" min-width="200" />
            <el-table-column prop="menu_spec" label="规格" width="100" />
            <el-table-column label="收银菜品名" min-width="220">
              <template #default="{ row }">
                <span>{{ (row.product_names || []).join('、') || '—' }}</span>
                <small v-if="row.sales_group_count > 1" class="group-count">{{ row.sales_group_count }} 个收银分组</small>
              </template>
            </el-table-column>
            <el-table-column label="销量" width="110" align="right">
              <template #default="{ row }">{{ number(row.quantity) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="120" fixed="right" align="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openUsageDialog({ id: row.menu_item_id, name: row.menu_name, spec: row.menu_spec })">
                  去配置
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`需复核配置（${result?.coverage?.warning_count || 0}）`" name="warnings">
          <el-table :data="result?.coverage?.warnings || []" max-height="420" class="menu-data-table">
            <el-table-column prop="message" label="提示" min-width="380" />
            <el-table-column prop="part_name" label="部位" width="130" />
          </el-table>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <span class="drawer-footer-tip">缺口要补的是「堂食菜品绑定」和「菜品耗用」两处，前者提升覆盖率，后者让已绑的菜真正参与核算。</span>
        <el-button @click="goBindDish(null)">去堂食菜品绑定批量处理</el-button>
        <el-button @click="gapVisible = false">关闭</el-button>
        <el-button type="primary" @click="gapVisible = false; openArchive('usage')">去「菜品耗用」补配置</el-button>
      </template>
    </el-dialog>

    <!-- ===== 采购只数录入 ===== -->
    <el-dialog v-model="purchaseVisible" title="录入实际采购只数" width="560px" align-center class="menu-dialog">
      <el-alert type="info" :closable="false" show-icon
        title="按「门店 + 月份 + 禽类」唯一，同一组合重复保存会覆盖原值。用于和理论用量做对比。" />
      <el-form label-position="top" class="purchase-form">
        <el-form-item label="门店">
          <el-select v-model="purchaseForm.store_id" filterable placeholder="请选择门店" style="width: 100%;">
            <el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="月份">
          <el-date-picker v-model="purchaseForm.month" type="month" value-format="YYYY-MM" placeholder="选择月份" style="width: 100%;" />
        </el-form-item>
        <el-form-item label="禽类品种">
          <el-select v-model="purchaseForm.bird_id" placeholder="请选择品种" style="width: 100%;">
            <el-option v-for="bird in birds" :key="bird.id" :label="`${bird.animal} · ${bird.breed_name}`" :value="bird.id" />
          </el-select>
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="采购只数">
            <el-input-number v-model="purchaseForm.quantity" :min="0" :precision="2" :step="1" style="width: 100%;" />
          </el-form-item>
          <el-form-item label="采购金额（元，选填）">
            <el-input-number v-model="purchaseForm.amount" :min="0" :precision="2" style="width: 100%;" />
          </el-form-item>
        </div>
        <el-form-item label="备注">
          <el-input v-model="purchaseForm.remark" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="purchaseVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="savePurchase">保存</el-button>
      </template>
    </el-dialog>

    <!-- ===== 基础档案（抽屉） ===== -->
    <el-drawer v-model="archiveVisible" title="菜品核算 · 基础档案" size="94%" class="accounting-drawer">
      <el-tabs v-model="archiveTab" @tab-change="onArchiveTabChange">
        <!-- ① 禽类档案 -->
        <el-tab-pane label="① 禽类档案" name="birds">
          <div class="archive-bar">
            <span class="archive-tip">定义「一只禽」：品种、单只净重（用于折重）、单只成本（用于理论成本）。</span>
            <div class="menu-filters">
              <el-button @click="downloadTemplate">下载模板</el-button>
              <el-button @click="importVisible = true">导入 Excel</el-button>
              <el-button type="primary" @click="openBirdDialog()">新增品种</el-button>
            </div>
          </div>
          <el-table v-loading="birdLoading" :data="birds" class="menu-data-table" row-key="id">
            <el-table-column label="禽类" width="100">
              <template #default="{ row }"><span :class="['animal-pill', animalTone(row.animal)]">{{ row.animal }}</span></template>
            </el-table-column>
            <el-table-column prop="breed_name" label="品种名称" min-width="180" />
            <el-table-column label="单只净重" width="120" align="right">
              <template #default="{ row }">{{ row.net_weight_kg ? row.net_weight_kg + ' kg' : '未设置' }}</template>
            </el-table-column>
            <el-table-column label="单只成本" width="120" align="right">
              <template #default="{ row }">{{ row.unit_cost ? '¥' + money(row.unit_cost) : '未设置' }}</template>
            </el-table-column>
            <!-- 每个禽类各配各的：直接从这里进它的拆解 / 菜品耗用 -->
            <el-table-column label="② 拆解配置" width="150" align="center">
              <template #default="{ row }">
                <el-button link type="primary" @click="openYields(row)">
                  {{ row.yield_count ? `${row.yield_count} 个部位 →` : '去配置 →' }}
                </el-button>
              </template>
            </el-table-column>
            <el-table-column label="③ 菜品耗用" width="150" align="center">
              <template #default="{ row }">
                <el-button link type="primary" @click="openUsageForAnimal(row)">
                  {{ row.dish_count ? `${row.dish_count} 个菜品 →` : '去配置 →' }}
                </el-button>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90" align="center">
              <template #default="{ row }"><span :class="['status-pill', row.status === '停用' ? 'off' : 'on']">{{ row.status }}</span></template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
            <el-table-column label="操作" width="150" fixed="right" align="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openBirdDialog(row)">编辑</el-button>
                <el-button link type="danger" @click="removeBird(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!birdLoading && !birds.length" class="menu-empty">还没有禽类档案，点「新增品种」或「导入 Excel」开始</div>
        </el-tab-pane>

        <!-- ② 整只出成 -->
        <el-tab-pane label="② 整只出成拆解" name="yields">
          <!-- 当前禽类：从「① 禽类档案」某一行点进来会带上；每个禽类各配各的 -->
          <div class="yield-current">
            <span class="yield-current-tag">正在配置</span>
            <b>{{ currentYieldBird ? `${currentYieldBird.animal} · ${currentYieldBird.breed_name}` : '未选择禽类' }}</b>
            <span class="muted-text">共 {{ yieldRows.length }} 个部位 —— 鹅/鸡/鸭各有一套拆解，互不影响</span>
            <el-select v-model="yieldBirdId" size="small" style="width: 180px;" @change="loadYields">
              <el-option v-for="bird in birds" :key="bird.id" :label="`${bird.animal} · ${bird.breed_name}`" :value="bird.id" />
            </el-select>
          </div>
          <!-- 整只部位示意图：点选部位 → 高亮下方表格行；右侧做「整只份量自检」 -->
          <PoultryBodyMap
            v-if="yieldBirdId"
            :rows="yieldRows"
            :animal="currentYieldBird ? currentYieldBird.animal : ''"
            @pick="onPickBodyZone" />
          <p v-if="pickedPartHint" class="body-map-hint">{{ pickedPartHint }}</p>
          <div class="archive-bar">
            <span class="archive-tip">
              「一只禽出几个该部位」—— 例如一只鹅出 2 份上庄、2 份下庄、1 个鹅头带颈，就分别填 2、2、1。
              这里是只数的除基准，填错会成倍影响结果。
            </span>
            <div class="menu-filters">
              <el-select v-model="yieldBirdId" placeholder="选择禽类品种" style="width: 220px;" @change="loadYields">
                <el-option v-for="bird in birds" :key="bird.id" :label="`${bird.animal} · ${bird.breed_name}`" :value="bird.id" />
              </el-select>
              <el-button @click="addYieldRow">新增部位</el-button>
              <el-button type="primary" :loading="saving" @click="saveYields">保存出成</el-button>
            </div>
          </div>
          <el-table v-if="yieldBirdId" :data="yieldRows" class="menu-data-table" row-key="_key" :row-class-name="yieldRowClass">
            <el-table-column label="部位名称" min-width="190">
              <template #default="{ row }">
                <el-input v-model="row.part_name" placeholder="如 上庄 / 下庄 / 鹅腿 / 鹅头带颈" />
              </template>
            </el-table-column>
            <el-table-column label="部位类别" width="130">
              <template #default="{ row }">
                <el-select v-model="row.part_kind" style="width: 100%;">
                  <el-option label="身体" value="身体" />
                  <el-option label="副产品" value="副产品" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="图示区域" width="140">
              <template #default="{ row }">
                <el-select v-model="row.zone_code" style="width: 100%;" placeholder="选择区域">
                  <el-option v-for="z in zoneOptions" :key="z.value" :label="z.label" :value="z.value" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="口径类型" width="185">
              <template #default="{ row }">
                <el-select v-model="row.yield_mode" style="width: 100%;">
                  <el-option v-for="m in yieldModeOptions" :key="m.value" :label="m.label" :value="m.value" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="一只出几份" width="140">
              <template #default="{ row }">
                <el-input-number v-model="row.parts_per_bird" :min="0" :precision="2" :step="1" style="width: 100%;" />
              </template>
            </el-table-column>
            <el-table-column label="一份占整只" width="140">
              <template #default="{ row }">
                <span class="menu-price">{{ portionShareText(row) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="单份克重(g)" width="130">
              <template #default="{ row }">
                <el-input-number v-model="row.part_weight_g" :min="0" :precision="1" style="width: 100%;" />
              </template>
            </el-table-column>
            <el-table-column label="被引用" width="95" align="center">
              <template #default="{ row }">
                <span :class="['status-pill', row.usage_count ? 'on' : 'off']">{{ row.usage_count || 0 }} 个菜品</span>
              </template>
            </el-table-column>
            <el-table-column label="配置检查" min-width="240">
              <template #default="{ row }">
                <span v-if="portionWarning(row)" class="portion-warning">⚠ {{ portionWarning(row) }}</span>
                <span v-else class="muted-text">✓ 份量口径正常</span>
              </template>
            </el-table-column>
            <el-table-column label="说明" min-width="140">
              <template #default="{ row }"><el-input v-model="row.remark" placeholder="选填" /></template>
            </el-table-column>
            <el-table-column label="操作" width="80" align="right">
              <template #default="{ $index }">
                <el-button link type="danger" @click="yieldRows.splice($index, 1)">移除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="yieldBirdId" class="kind-legend">
            <b>「一只出几份」填的是一只禽能出几份这种「份量」的菜</b>（＝ 1 ÷ 一份占整只的比例）。<br />
            例：上庄一份占整只 <b>1/4</b> → 填 <b>4</b>；半只占 <b>1/2</b> → 填 <b>2</b>；整只 → 填 <b>1</b>；鹅肉能出 11 份饭 → 填 <b>11</b>。<br />
            ⚠️ 最容易错的是<b>按块数数</b>：一只鹅的上半身确实切成 <b>2 块</b>上庄，但一份上庄只占整只的 1/4，所以这里要填 <b>4</b>。填 2 等于说"一份上庄吃掉半只鹅"，会把同一只鹅在上庄、下庄里各算一次，结果虚高近一倍。<br />
            <b>部位类别：</b>
            <span class="kind-chip body">身体</span> 同一块身体的不同卖法（整只/半只/上庄/下庄/腿/腩/切片肉），互相抢鸟，<b>需求相加</b>；
            <span class="kind-chip byproduct">副产品</span> 随鸟附带产出（翅/头颈/掌/杂），一只鸟同时就出，<b>不额外算鸟，只取其中最大</b>。
          </div>
          <div v-else class="menu-empty">请先在上方选择一个禽类品种</div>
          <p v-if="yieldBirdId" class="archive-note">
            保存时会以当前表格为准：删掉某一行等于删除该部位，被它引用的菜品耗用关系也会一并清除，请留意保存后的提示。
          </p>
        </el-tab-pane>

        <!-- ③ 菜品耗用 -->
        <el-tab-pane label="③ 菜品耗用" name="usage">
          <!-- 当前禽类：从「① 禽类档案」某一行点进来会带上禽类，也可在此切换 -->
          <div class="yield-current">
            <span class="yield-current-tag">正在配置</span>
            <b>{{ usageAnimal || '全部禽类' }}</b>
            <span class="muted-text">的菜品耗用 —— 每个禽类的部位各配各的，互不影响</span>
            <el-select v-model="usageAnimal" size="small" style="width: 150px;" @change="loadUsageOverview">
              <el-option label="全部禽类" value="" />
              <el-option label="鹅" value="鹅" />
              <el-option label="鸡" value="鸡" />
              <el-option label="鸭" value="鸭" />
            </el-select>
          </div>
          <div class="archive-bar">
            <span class="archive-tip">
              先<b>按分组挑菜</b>（同一分组的菜通常用同一套部位耗用），勾选后一次关联整组，再按需微调单个菜品。
              一个菜品可以挂多条关系，双拼、鸡鸭双拼、套餐都能配上。
            </span>
            <div class="menu-filters">
              <el-input v-model="usageKeyword" clearable placeholder="搜索菜品 / 规格" class="wide-filter" @input="loadUsageOverview" />
              <el-select v-model="usageFilter" style="width: 140px;" @change="loadUsageOverview">
                <el-option label="全部菜品" value="all" />
                <el-option label="已配置" value="set" />
                <el-option label="未配置" value="unset" />
              </el-select>
              <span class="archive-count">
                全局已配置 {{ usageOverview.configured || 0 }} / {{ usageOverview.all_total || 0 }} 个菜品
              </span>
            </div>
          </div>

          <!-- 分组选择：每个分组带「已配置/总数」进度，一眼看出哪组还没配 -->
          <div class="usage-group-bar">
            <span class="usage-group-label">分组</span>
            <button
              class="usage-group-chip"
              :class="{ active: !usageCategory }"
              @click="selectUsageCategory('')"
            >
              全部分组<em>{{ usageOverview.all_total || 0 }}</em>
            </button>
            <button
              v-for="group in usageOverview.categories || []"
              :key="group.name || '__uncategorized__'"
              class="usage-group-chip"
              :class="{ active: usageCategory === group.name, done: group.total > 0 && group.configured === group.total }"
              @click="selectUsageCategory(group.name)"
            >
              {{ group.name || '未分类' }}
              <em>{{ group.configured }}/{{ group.total }}</em>
              <i v-if="group.total > 0 && group.configured === group.total">✓</i>
            </button>
          </div>

          <!-- 批量操作条：有勾选才出现 -->
          <div v-if="usageSelection.length" class="usage-batch-bar">
            <span class="usage-batch-count">
              已选 <b>{{ usageSelection.length }}</b> 个菜品
              <template v-if="usageCategory"> · 分组「{{ usageCategory }}」共 {{ usageOverview.total }} 个，用表头勾选可整组选中</template>
            </span>
            <el-button link type="primary" @click="selectAllInGroup">选中本组全部</el-button>
            <el-button @click="clearUsageSelection">清空选择</el-button>
            <el-button type="primary" @click="openBatchUsageDialog">批量关联禽类耗用</el-button>
          </div>

          <el-table
            ref="usageTableRef"
            v-loading="usageLoading"
            :data="usageOverview.items || []"
            max-height="calc(94vh - 330px)"
            class="menu-data-table"
            row-key="id"
            @selection-change="onUsageSelectionChange"
          >
            <el-table-column type="selection" width="46" :reserve-selection="false" />
            <el-table-column label="菜品" min-width="220">
              <template #default="{ row }">
                <div class="dish-name">
                  <span class="dish-monogram">{{ String(row.name || '菜').slice(0, 1) }}</span>
                  <div><b>{{ row.name }}</b><small>{{ [row.spec, row.category].filter(Boolean).join(' · ') || '未分类' }}</small></div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="禽类耗用配置" min-width="360">
              <template #default="{ row }">
                <div v-if="row.usage.length" class="usage-chips">
                  <span v-for="(usage, i) in row.usage" :key="i" class="usage-chip">
                    {{ usage.animal }}·{{ usage.part_name }} ×{{ usage.usage_qty }}
                    <em>每份 {{ usage.per_portion_birds }} 只</em>
                  </span>
                </div>
                <span v-else class="muted-text">未配置</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120" fixed="right" align="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openUsageDialog(row)">{{ row.usage.length ? '编辑' : '去配置' }}</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!usageLoading && !(usageOverview.items || []).length" class="menu-empty">
            该分组下没有符合条件的菜品
          </div>
        </el-tab-pane>
      </el-tabs>

      <template #footer>
        <span class="drawer-footer-tip">档案改动会立即影响「消耗核算」结果，改完回主页面点一次「查询」即可刷新。</span>
        <el-button @click="archiveVisible = false">关闭</el-button>
      </template>
    </el-drawer>

    <!-- 禽类档案编辑 -->
    <el-dialog v-model="birdDialogVisible" :title="birdForm.id ? '编辑禽类品种' : '新增禽类品种'" width="520px" align-center class="menu-dialog">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="禽类">
            <el-select v-model="birdForm.animal" style="width: 100%;">
              <el-option v-for="animal in animals" :key="animal" :label="animal" :value="animal" />
            </el-select>
          </el-form-item>
          <el-form-item label="品种名称">
            <el-input v-model="birdForm.breed_name" placeholder="如 清远黑鬃鹅" />
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="单只净重(kg)">
            <el-input-number v-model="birdForm.net_weight_kg" :min="0" :precision="2" style="width: 100%;" />
          </el-form-item>
          <el-form-item label="单只成本(元)">
            <el-input-number v-model="birdForm.unit_cost" :min="0" :precision="2" style="width: 100%;" />
          </el-form-item>
        </div>
        <el-form-item label="状态">
          <el-segmented v-model="birdForm.status" :options="['启用', '停用']" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="birdForm.remark" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="birdDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveBird">保存</el-button>
      </template>
    </el-dialog>

    <!-- 菜品耗用编辑 -->
    <el-dialog v-model="usageDialogVisible" title="配置菜品禽类耗用" width="min(760px, calc(100vw - 32px))" align-center class="menu-dialog">
      <div v-if="usageTarget" class="usage-dialog-head">
        <span class="dish-monogram">{{ String(usageTarget.name || '菜').slice(0, 1) }}</span>
        <div>
          <b>{{ usageTarget.name }}</b>
          <small>{{ usageTarget.spec || '无规格' }} · 每份该菜品消耗以下部位</small>
        </div>
      </div>
      <!-- 禽类快捷标签：一键收窄部位下拉（找「鸭腿」不必在 24 个部位里翻） -->
      <div class="usage-animal-bar">
        <span class="usage-kw-tag">禽类</span>
        <button type="button" :class="['usage-kw-btn', { active: !usageAnimalFilter }]" @click="usageAnimalFilter = ''">全部</button>
        <button v-for="a in yieldAnimalTabs" :key="a" type="button"
          :class="['usage-kw-btn', { active: usageAnimalFilter === a }]" @click="usageAnimalFilter = usageAnimalFilter === a ? '' : a">
          {{ a }}
        </button>
        <span class="muted-text">选禽类可只看它的部位；也可直接在下拉里输入「鸭腿」搜索</span>
      </div>
      <el-table :data="usageRows" class="menu-data-table">
        <el-table-column label="部位" min-width="260">
          <template #default="{ row }">
            <el-select v-model="row.yield_id" filterable placeholder="选择禽类部位" style="width: 100%;">
              <el-option-group v-for="group in yieldOptionGroups" :key="group.label" :label="group.label">
                <el-option
                  v-for="option in group.options"
                  :key="option.id"
                  :label="`${option.part_name}（一只出 ${option.parts_per_bird}）`"
                  :value="option.id"
                />
              </el-option-group>
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="每份耗用数量" width="180">
          <template #default="{ row }">
            <el-input-number v-model="row.usage_qty" :min="0" :precision="4" :step="0.5" style="width: 100%;" />
          </template>
        </el-table-column>
        <el-table-column label="折合" width="120" align="right">
          <template #default="{ row }">
            <span class="muted-text">{{ perPortionText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" align="right">
          <template #default="{ $index }">
            <el-button link type="danger" @click="usageRows.splice($index, 1)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-button class="usage-add-row" @click="usageRows.push({ yield_id: null, usage_qty: 1 })">+ 添加一行（双拼/套餐请加多行）</el-button>
      <template #footer>
        <el-button @click="usageDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveUsage">保存配置</el-button>
      </template>
    </el-dialog>

    <!-- 批量关联禽类耗用 -->
    <el-dialog v-model="batchDialogVisible" title="批量关联禽类耗用" width="min(820px, calc(100vw - 32px))" align-center class="menu-dialog">
      <div class="usage-dialog-head">
        <span class="dish-monogram">批</span>
        <div>
          <b>{{ batchTargetSummary }}</b>
          <small>{{ usageCategory ? `分组「${usageCategory}」` : '跨分组选择' }} · 下面这套配置会套用到全部选中菜品</small>
        </div>
      </div>

      <div class="batch-mode-row">
        <span class="batch-mode-label">应用方式</span>
        <el-segmented
          v-model="batchMode"
          :options="[
            { label: '覆盖（替换原配置）', value: 'replace' },
            { label: '追加（保留原配置）', value: 'append' },
          ]"
        />
        <span class="batch-mode-tip">
          <template v-if="batchMode === 'replace'">整组通常用同一套部位时选覆盖；会清掉这些菜品原有的{{ batchExistingCount }} 条配置。</template>
          <template v-else>给已有配置的菜再加一条时选追加，例如在烧鹅饭上补一条双拼部位。</template>
        </span>
      </div>

      <!-- 禽类快捷标签：批量套用时先收窄到目标禽类 -->
      <div class="usage-animal-bar">
        <span class="usage-kw-tag">禽类</span>
        <button type="button" :class="['usage-kw-btn', { active: !usageAnimalFilter }]" @click="usageAnimalFilter = ''">全部</button>
        <button v-for="a in yieldAnimalTabs" :key="a" type="button"
          :class="['usage-kw-btn', { active: usageAnimalFilter === a }]" @click="usageAnimalFilter = usageAnimalFilter === a ? '' : a">
          {{ a }}
        </button>
        <span class="muted-text">例如只看「鸭」就能直接挑到鸭腿</span>
      </div>
      <el-table :data="batchRows" class="menu-data-table">
        <el-table-column label="部位" min-width="280">
          <template #default="{ row }">
            <el-select v-model="row.yield_id" filterable placeholder="选择禽类部位" style="width: 100%;">
              <el-option-group v-for="group in yieldOptionGroups" :key="group.label" :label="group.label">
                <el-option
                  v-for="option in group.options"
                  :key="option.id"
                  :label="`${option.part_name}（一只出 ${option.parts_per_bird}）`"
                  :value="option.id"
                />
              </el-option-group>
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="每份耗用数量" width="170">
          <template #default="{ row }">
            <el-input-number v-model="row.usage_qty" :min="0" :precision="4" :step="0.5" style="width: 100%;" />
          </template>
        </el-table-column>
        <el-table-column label="折合" width="120" align="right">
          <template #default="{ row }">
            <span class="muted-text">{{ perPortionText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" align="right">
          <template #default="{ $index }">
            <el-button link type="danger" @click="batchRows.splice($index, 1)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-button class="usage-add-row" @click="batchRows.push({ yield_id: null, usage_qty: 1 })">+ 添加一行（双拼/套餐请加多行）</el-button>

      <div class="batch-preview">
        <span>将套用到：</span>
        <span v-for="name in batchPreviewNames" :key="name" class="batch-preview-name">{{ name }}</span>
        <span v-if="usageSelection.length > batchPreviewNames.length" class="muted-text">
          ……等共 {{ usageSelection.length }} 个
        </span>
      </div>

      <template #footer>
        <el-button @click="batchDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveBatchUsage">应用到 {{ usageSelection.length }} 个菜品</el-button>
      </template>
    </el-dialog>

    <!-- Excel 导入 -->
    <el-dialog v-model="importVisible" title="导入基础档案 Excel" width="520px" align-center class="menu-dialog">
      <el-alert type="info" :closable="false" show-icon
        title="请使用「下载模板」得到的文件填写。三个页签依次导入：禽类档案 → 整只出成 → 菜品耗用，逐行容错，出错的行会列出但不影响其它行。" />
      <el-upload
        class="import-upload"
        drag
        :auto-upload="false"
        :show-file-list="false"
        accept=".xlsx,.xls"
        :on-change="handleImportFile"
      >
        <div class="import-drop">
          <b>点击或拖拽 Excel 到这里</b>
          <small>支持 .xlsx / .xls</small>
        </div>
      </el-upload>
      <div v-if="importResult" class="import-result">
        <p>
          导入完成：禽类档案 <b>{{ importResult.birds }}</b> 条、整只出成 <b>{{ importResult.yields }}</b> 条、
          菜品耗用 <b>{{ importResult.usage }}</b> 条。
        </p>
        <div v-if="importResult.errors?.length" class="import-errors">
          <p class="import-errors-title">以下 {{ importResult.errors.length }} 行未导入：</p>
          <div v-for="(error, index) in importResult.errors.slice(0, 20)" :key="index">
            {{ error.sheet }} 第 {{ error.row }} 行：{{ error.message }}
          </div>
          <div v-if="importResult.errors.length > 20">……其余 {{ importResult.errors.length - 20 }} 行请下载模板核对</div>
        </div>
      </div>
      <template #footer>
        <el-button @click="importVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- ===== 禽类菜范围维护（覆盖率分母口径） ===== -->
    <el-dialog v-model="scopeDialogVisible" title="维护禽类菜范围 · 覆盖率分母口径" width="min(1100px, calc(100vw - 32px))"
      align-center class="menu-dialog" top="5vh">
      <div v-loading="scopeLoading" class="scope-body">
        <el-alert type="info" :closable="false" show-icon class="scope-intro"
          title="「禽类菜品覆盖率」的分母只算这里判定出来的禽类菜 —— 柠檬茶、白米饭、打包盒这类永远不用配禽类系数的品类不再拉低它。判定顺序：手动标记 → 已配禽类耗用 → 名称关键词（含 include 且不含 exclude）。" />

        <div class="scope-grid">
          <!-- 左：关键词规则 -->
          <section class="scope-column">
            <header class="scope-column-head">
              <h4>判定关键词</h4>
              <span class="muted-text">菜名包含即命中；排除词优先</span>
            </header>

            <div class="scope-kw-block">
              <div class="scope-kw-title">
                <span class="scope-kw-tag include">算作禽类菜</span>
                <el-button link type="primary" size="small" @click="addScopeKeyword('include')">+ 添加</el-button>
              </div>
              <div v-for="(row, index) in scopeIncludeRows" :key="'kw-in-' + index" class="scope-kw-row">
                <el-input v-model="row.keyword" size="small" placeholder="如 鹅 / 鸭 / 鸡 / 肶" style="width: 110px" />
                <el-switch v-model="row.enabled" size="small" />
                <el-input v-model="row.note" size="small" placeholder="备注（可空）" />
                <el-button link type="danger" size="small" @click="removeScopeKeyword(row)">删除</el-button>
              </div>
              <div v-if="!scopeIncludeRows.length" class="scope-kw-empty">至少需要一条，否则无法判定分母</div>
            </div>

            <div class="scope-kw-block">
              <div class="scope-kw-title">
                <span class="scope-kw-tag exclude">不算（排除）</span>
                <el-button link type="primary" size="small" @click="addScopeKeyword('exclude')">+ 添加</el-button>
              </div>
              <div v-for="(row, index) in scopeExcludeRows" :key="'kw-ex-' + index" class="scope-kw-row">
                <el-input v-model="row.keyword" size="small" placeholder="如 蛋 / 柠檬茶" style="width: 110px" />
                <el-switch v-model="row.enabled" size="small" />
                <el-input v-model="row.note" size="small" placeholder="备注（可空）" />
                <el-button link type="danger" size="small" @click="removeScopeKeyword(row)">删除</el-button>
              </div>
              <div v-if="!scopeExcludeRows.length" class="scope-kw-empty">没有排除词 —— 含「蛋」的滑蛋饭/咸鸭蛋会被算进分母</div>
            </div>

            <el-button type="primary" :loading="scopeSaving" @click="saveScopeRules">保存关键词并重新核算</el-button>

            <div v-if="scopePreviewData" class="scope-stat">
              <div class="scope-stat-row"><span>全部菜品</span><b>{{ scopePreviewData.summary.dish_total }} 个</b></div>
              <div class="scope-stat-row"><span>判定为禽类菜</span><b>{{ scopePreviewData.summary.scope_dish_count }} 个</b></div>
              <div class="scope-stat-row"><span>禽类菜销量（全区间）</span><b>{{ number(scopePreviewData.summary.scope_quantity) }} 份</b></div>
              <div class="scope-stat-row"><span>来源构成</span>
                <b>手动 {{ scopePreviewData.summary.scope_source.manual }} · 已配 {{ scopePreviewData.summary.scope_source.configured }} · 关键词 {{ scopePreviewData.summary.scope_source.keyword }}</b>
              </div>
              <div class="scope-stat-row"><span>被排除词挡掉</span><b>{{ scopePreviewData.summary.scope_source.excluded }} 个菜品</b></div>
              <p class="scope-stat-tip">预览用「菜名匹配 + 全区间销量」估算，用于核对规则；正式覆盖率以本次核算区间为准。</p>
            </div>
          </section>

          <!-- 右：菜品判定明细 -->
          <section class="scope-column">
            <header class="scope-column-head">
              <h4>菜品判定明细</h4>
              <span class="muted-text">勾选后可手动改判（优先级最高）</span>
            </header>
            <div class="scope-tools">
              <el-input v-model="scopePreviewFilter" size="small" placeholder="搜索菜名 / 分类 / 判定依据" clearable style="width: 220px" />
              <el-checkbox v-model="scopeOnlyInScope" size="small">只看禽类菜</el-checkbox>
              <span class="muted-text">已选 {{ scopeSelected.length }}</span>
            </div>
            <div class="scope-actions">
              <el-button size="small" :loading="scopeSaving" @click="markScopeDishes(true)">标为禽类菜</el-button>
              <el-button size="small" :loading="scopeSaving" @click="markScopeDishes(false)">标为不算</el-button>
              <el-button size="small" :loading="scopeSaving" @click="markScopeDishes(null)">清除标记</el-button>
            </div>
            <el-table :data="scopePreviewRows" max-height="420" class="menu-data-table" size="small"
              @selection-change="rows => { scopeSelected = rows.map(row => row.menu_item_id) }">
              <el-table-column type="selection" width="42" />
              <el-table-column label="菜品" min-width="180">
                <template #default="{ row }">
                  <span>{{ row.menu_name }}</span>
                  <span v-if="row.menu_spec" class="muted-text"> · {{ row.menu_spec }}</span>
                </template>
              </el-table-column>
              <el-table-column label="分类" width="110" prop="category" />
              <el-table-column label="判定" width="96" align="center">
                <template #default="{ row }">
                  <span :class="['scope-flag', row.in_scope ? 'in' : 'out']">{{ row.in_scope ? '禽类菜' : '不算' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="依据" min-width="150">
                <template #default="{ row }">
                  <span>{{ row.reason_label }}</span>
                  <span v-if="row.configured" class="muted-text"> · 已配系数</span>
                </template>
              </el-table-column>
              <el-table-column label="销量" width="96" align="right">
                <template #default="{ row }">{{ number(row.quantity) }}</template>
              </el-table-column>
            </el-table>
          </section>
        </div>
      </div>
      <template #footer>
        <el-button @click="scopeDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onActivated, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getStores,
  getPoultryAccounting, getPoultrySpecies, createPoultrySpecies, updatePoultrySpecies, deletePoultrySpecies,
  getPoultryYields, savePoultryYields,
  getPoultryDishUsageOverview, getPoultryDishUsage, savePoultryDishUsage, batchSavePoultryDishUsage,
  getPoultryPurchaseComparison, savePoultryPurchase,
  getPoultryTemplate, importPoultryWorkbook,
  getPoultryScope, savePoultryScopeKeywords, savePoultryScopeDishes, getPoultryScopePreview,
  getPoultryCalibration,
} from '@/api'
import MenuModuleHeader from './MenuModuleHeader.vue'
import PoultryBodyMap from '@/components/PoultryBodyMap.vue'
import './menu-theme.css'

const router = useRouter()

const animals = ['鹅', '鸭', '鸡']

// ===== 基础状态 =====
const stores = ref([])
const birds = ref([])
const loading = ref(false)
const saving = ref(false)
const birdLoading = ref(false)
const usageLoading = ref(false)
const comparisonLoading = ref(false)

const filters = reactive({
  storeId: '',
  range: [dayjs().startOf('month').format('YYYY-MM-DD'), dayjs().endOf('month').format('YYYY-MM-DD')],
  channel: 'all',
  animal: '',
})

const result = ref(null)
const comparison = ref(null)

// ===== 汇总卡 =====
const summaryCards = computed(() => {
  const summary = result.value?.summary
  if (!summary) return []
  const cards = animals.map(animal => {
    const row = summary.birds.find(item => item.animal === animal)
    if (!row) {
      return { label: `${animal}消耗`, value: '0 只', hint: '本次区间无消耗或未配该禽类', tone: 'muted' }
    }
    // 说清这个数是怎么来的：四个资源池约束里哪个是瓶颈（身体 / 腿 / 翅 / 头颈）
    const cb = row.constraint_birds || {}
    const why = `瓶颈：${row.governing_resource_label || row.governing || '身体'}`
      + (row.governing_part ? `（${row.governing_part}）` : '')
      + `—— 身体 ${cb.body || row.body_birds || 0} ｜ 腿 ${cb.leg || 0} ｜ 翅 ${cb.wing || 0} ｜ 头颈 ${cb.head_neck || 0} 只`
    return {
      label: `${animal}消耗`,
      value: `${row.birds_count} 只`,
      hint: `${row.breed_name} · ${why}`,
      tone: '',
    }
  })
  cards.push({
    label: '合计只数',
    value: `${summary.total_birds || 0} 只`,
    hint: `折重 ${summary.total_weight_kg} kg · 禽类菜覆盖 ${percent(poultryCoverage.value.covered_rate)}`,
    tone: 'metric-warning',
    main: true,
  })
  return cards
})

// 料篮口径 vs 旧口径（各菜品独立折鸟）的差值，用来解释「为什么和以前看到的不一样」
const linearGap = computed(() => {
  const summary = result.value?.summary
  if (!summary || !summary.total_birds_linear) return null
  const linear = summary.total_birds_linear
  const now = summary.total_birds || 0
  return { linear, now, diff: Math.round((linear - now) * 100) / 100, times: now > 0 ? Math.round((linear / now) * 100) / 100 : null }
})

const heroMetrics = computed(() => {
  const summary = result.value?.summary
  const scopeRate = poultryCoverage.value.covered_rate || 0
  return [
    { label: '合计只数', value: summary ? summary.total_birds : '—', tone: '' },
    { label: '禽类菜覆盖', value: result.value ? percent(scopeRate) : '—', tone: result.value && scopeRate < 0.6 ? 'warning' : 'success' },
    { label: '全量覆盖', value: result.value ? percent(summary.covered_rate) : '—', tone: 'muted' },
    { label: '缺配置菜品', value: result.value ? result.value.coverage.no_usage.length : '—', tone: result.value?.coverage?.no_usage?.length ? 'warning' : 'success' },
  ]
})

const hasArchiveData = computed(() => birds.value.some(bird => bird.yield_count > 0 && bird.dish_count > 0))
const hasAnyBird = computed(() => birds.value.some(bird => bird.yield_count > 0))

// 按部位汇总表的筛选与合计
const partKindFilter = ref('')
const filteredParts = computed(() => {
  const list = result.value?.parts || []
  if (!partKindFilter.value) return list
  return list.filter(row => row.part_kind === partKindFilter.value)
})
const bodyBirds = computed(() => {
  const rows = result.value?.summary?.birds || []
  return Math.round(rows.reduce((sum, row) => sum + (row.body_birds || 0), 0) * 100) / 100
})
// 各资源池最大约束（资源约束模型：身体相加、腿/翅/头颈各按每只禽的固定容量算需求只数，取 MAX）
const resourceMax = computed(() => {
  const rows = result.value?.summary?.birds || []
  const keys = ['body', 'leg', 'wing', 'head_neck']
  const out = {}
  keys.forEach(k => { out[k] = Math.round(rows.reduce((sum, row) => sum + ((row.constraint_birds || {})[k] || 0), 0) * 100) / 100 })
  return out
})
const constraintText = computed(() => {
  const r = resourceMax.value
  return `身体 ${r.body || 0} ｜ 腿 ${r.leg || 0} ｜ 翅 ${r.wing || 0} ｜ 头颈 ${r.head_neck || 0} 只`
})

// ===== 覆盖率两个口径 =====
// 风控可信度看「禽类菜品覆盖率」：分母只算禽类菜，把柠檬茶/白米饭/打包盒这类
// 永远不需要配禽类系数的品类排除在外；全量覆盖率保留作参考（老接口无该字段时回退到全量口径，保证页面不崩）。
const poultryCoverage = computed(() => {
  const block = result.value?.coverage?.poultry_scope
  if (block) return block
  const summary = result.value?.summary || {}
  return {
    covered_rate: summary.covered_rate || 0,
    covered_quantity: summary.covered_quantity || 0,
    scope_quantity: summary.total_quantity || 0,
    uncovered_quantity: summary.uncovered_quantity || 0,
    unbound_quantity: result.value?.coverage?.unbound_quantity || 0,
    no_usage_quantity: result.value?.coverage?.no_usage_quantity || 0,
    include_keywords: [], exclude_keywords: [], fallback: false,
    source_summary: { manual: 0, configured: 0, keyword: 0, excluded: 0 },
    unbound: result.value?.coverage?.unbound || [],
    no_usage: result.value?.coverage?.no_usage || [],
    dishes: [],
  }
})
const scopeIncludeText = computed(() => (poultryCoverage.value.include_keywords || []).join(' / ') || '未设置')
const scopeExcludeText = computed(() => (poultryCoverage.value.exclude_keywords || []).join(' / ') || '无')

// ===== 风控（食材去向对账）=====
const riskBirds = computed(() => (result.value?.summary?.birds || []).filter(b => b.risk))
// 覆盖率低时「身体差额」主要来自未绑定菜品，不能当损耗读，需要显式提示。
// 判断用禽类菜覆盖率 —— 全量口径含无需配系数的品类，永远达不到 90%，拿它当门槛会让告警永远亮着。
const riskLowCoverage = computed(() => {
  if (!result.value?.summary) return false
  return (poultryCoverage.value.covered_rate || 0) < 0.9 && (poultryCoverage.value.uncovered_quantity || 0) > 0
})
const rangeOutOfData = computed(() => {
  const maxDate = result.value?.data_range?.max_date
  const to = filters.range?.[1]
  return !!(maxDate && to && to > maxDate)
})
const hasUnclassifiedChannel = computed(() => (result.value?.channel_breakdown || []).some(row => row.channel === 'other' && row.quantity > 0))
const coverageTone = computed(() => {
  const rate = poultryCoverage.value.covered_rate || 0
  if (rate >= 0.9) return 'good'
  if (rate >= 0.6) return 'medium'
  return 'low'
})

// ===== 明细表筛选与分页 =====
const dishKeyword = ref('')
const dishAnimal = ref('')
const dishPage = ref(1)
const dishPageSize = ref(10)
const filteredDishes = computed(() => {
  const keyword = dishKeyword.value.trim().toLowerCase()
  return (result.value?.dishes || []).filter(row => {
    if (dishAnimal.value && row.animal !== dishAnimal.value) return false
    if (keyword && !`${row.menu_name} ${row.part_name} ${row.category}`.toLowerCase().includes(keyword)) return false
    return true
  }).map((row, index) => ({ ...row, rowKey: `${row.menu_item_id}-${row.part_name}-${index}` }))
})
const paginatedDishes = computed(() => {
  const start = (dishPage.value - 1) * dishPageSize.value
  return filteredDishes.value.slice(start, start + dishPageSize.value)
})
watch([dishKeyword, dishAnimal], () => { dishPage.value = 1 })

// ===== 格式化 =====
function number(value) {
  const num = Number(value) || 0
  return num.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}
function money(value) {
  return (Number(value) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function percent(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return '—'
  return `${(num * 100).toFixed(1)}%`
}
function animalTone(animal) {
  return { '鹅': 'goose', '鸭': 'duck', '鸡': 'chicken' }[animal] || ''
}

// ===== 数据加载 =====
async function loadStores() {
  try {
    const data = await getStores({ page: 1, page_size: 500 })
    stores.value = data.stores || []
  } catch (error) { ElMessage.error('门店加载失败：' + error.message) }
}
async function loadBirds() {
  birdLoading.value = true
  try {
    const data = await getPoultrySpecies()
    birds.value = data.birds || []
    if (!yieldBirdId.value && birds.value.length) yieldBirdId.value = birds.value[0].id
  } catch (error) { ElMessage.error('禽类档案加载失败：' + error.message) }
  finally { birdLoading.value = false }
}
async function loadAccounting() {
  if (!filters.range?.[0] || !filters.range?.[1]) { ElMessage.warning('请选择核算时间段'); return }
  loading.value = true
  try {
    result.value = await getPoultryAccounting({
      store_id: filters.storeId || '',
      date_from: filters.range[0],
      date_to: filters.range[1],
      channel: filters.channel,
      animal: filters.animal || '',
    })
    dishPage.value = 1
    comparison.value = null
  } catch (error) { ElMessage.error('核算失败：' + error.message) }
  finally { loading.value = false }
}
async function loadComparison() {
  if (!filters.range?.[0]) { ElMessage.warning('请先选择核算时间段'); return }
  comparisonLoading.value = true
  try {
    comparison.value = await getPoultryPurchaseComparison({
      store_id: filters.storeId || '',
      date_from: filters.range[0],
      date_to: filters.range[1],
      channel: filters.channel,
      animal: filters.animal || '',
    })
  } catch (error) { ElMessage.error('对比加载失败：' + error.message) }
  finally { comparisonLoading.value = false }
}

// ===== 禽类菜范围维护（覆盖率分母口径：哪些菜算禽类菜）=====
// 为什么要有这个：全量覆盖率的分母含柠檬茶 / 白米饭 / 打包盒等永远不用配禽类系数的品类，
// 所以永远到不了 90%，不能当风控可信度门槛。这里维护「禽类菜」范围，核算时另算一个禽类菜品覆盖率。
// 判定优先级（后端固定，配置可改）：显式名单 > 已配禽类耗用 > 名称关键词（include 命中且不含 exclude）。
const scopeDialogVisible = ref(false)
const scopeLoading = ref(false)
const scopeSaving = ref(false)
const scopeKeywords = ref([])        // 编辑中的关键词（本地副本，保存时整表提交）
const scopeDishScope = ref([])       // 已有显式名单
const scopePreviewData = ref(null)   // 规则预览（全部菜品 × 全区间销量）
const scopeSelected = ref([])
const scopePreviewFilter = ref('')
const scopeOnlyInScope = ref(true)

const scopeIncludeRows = computed(() => scopeKeywords.value.filter(row => row.kind === 'include'))
const scopeExcludeRows = computed(() => scopeKeywords.value.filter(row => row.kind === 'exclude'))
const scopePreviewRows = computed(() => {
  const rows = scopePreviewData.value?.dishes || []
  const keyword = scopePreviewFilter.value.trim().toLowerCase()
  return rows
    .filter(row => (scopeOnlyInScope.value ? row.in_scope : true))
    .filter(row => !keyword || `${row.menu_name} ${row.category} ${row.reason_label}`.toLowerCase().includes(keyword))
    .map(row => ({ ...row, rowKey: String(row.menu_item_id) }))
})

function openScopeDialog() {
  scopeDialogVisible.value = true
  scopeSelected.value = []
  Promise.all([loadScopeConfig(), loadScopePreview()])
}
async function loadScopeConfig() {
  scopeLoading.value = true
  try {
    const data = await getPoultryScope()
    scopeKeywords.value = (data.keywords || []).map(row => ({
      keyword: row.keyword, kind: row.kind, enabled: row.enabled !== false, note: row.note || '',
    }))
    scopeDishScope.value = data.dishes || []
  } catch (error) { ElMessage.error('禽类菜范围加载失败：' + error.message) }
  finally { scopeLoading.value = false }
}
async function loadScopePreview() {
  try { scopePreviewData.value = await getPoultryScopePreview() }
  catch (error) { ElMessage.error('规则预览加载失败：' + error.message) }
}
function addScopeKeyword(kind) { scopeKeywords.value.push({ keyword: '', kind, enabled: true, note: '' }) }
function removeScopeKeyword(row) { scopeKeywords.value = scopeKeywords.value.filter(item => item !== row) }

async function saveScopeRules() {
  const rows = scopeKeywords.value.filter(row => String(row.keyword || '').trim())
  if (!rows.length) { ElMessage.warning('请至少保留一条关键词'); return }
  scopeSaving.value = true
  try {
    const data = await savePoultryScopeKeywords(rows)
    ElMessage.success(`关键词已保存（${data.count} 条），已按新规则重新核算`)
    await Promise.all([loadScopeConfig(), loadScopePreview()])
    await loadAccounting()
  } catch (error) { ElMessage.error('保存失败：' + (error?.response?.data?.error || error.message)) }
  finally { scopeSaving.value = false }
}

/** 手动标记：inScope=true 强制算禽类菜 / false 强制不算 / null 清除标记（回退到关键词判定） */
async function markScopeDishes(inScope) {
  const ids = scopeSelected.value.map(Number).filter(Boolean)
  if (!ids.length) { ElMessage.warning('请先勾选菜品'); return }
  scopeSaving.value = true
  try {
    const data = await savePoultryScopeDishes({ menu_item_ids: ids, in_scope: inScope })
    const action = data.mode === 'clear' ? '清除标记' : (data.mode === 'include' ? '标为禽类菜' : '标为不算')
    ElMessage.success(`已${action} ${data.count} 个菜品，已重新核算`)
    scopeSelected.value = []
    await Promise.all([loadScopeConfig(), loadScopePreview()])
    await loadAccounting()
  } catch (error) { ElMessage.error('标记失败：' + (error?.response?.data?.error || error.message)) }
  finally { scopeSaving.value = false }
}

// ===== 采购校准（模型 vs 门店实际）=====
const calibData = ref(null)
const calibLoading = ref(false)
const calibLevelTone = computed(() => {
  const level = calibData.value?.summary?.level
  return level === 'good' ? 'ok' : level === 'fair' ? 'warn' : level === 'poor' ? 'bad' : ''
})
async function loadCalibration() {
  calibLoading.value = true
  try {
    calibData.value = await getPoultryCalibration({ store_id: filters.storeId || '', limit: 12 })
  } catch (error) {
    ElMessage.error('校准失败：' + error.message)
  } finally {
    calibLoading.value = false
  }
}

// ===== 基础档案 =====
const archiveVisible = ref(false)
const archiveTab = ref('birds')
function openArchive(tab) {
  archiveTab.value = tab || 'birds'
  archiveVisible.value = true
  // 每次打开抽屉都刷新部位下拉，避免用户先配耗用、再回来加出成后选不到新部位
  loadYieldOptions()
  if (tab === 'usage') loadUsageOverview()
}
// 抽屉内切页签时同步刷新：出成是耗用的数据源，两边必须一致，
// 否则在「整只出成」加完部位切到「菜品耗用」，看到的还是旧数据。
function onArchiveTabChange(name) {
  if (name === 'yields') loadYields()
  if (name === 'usage') { loadYieldOptions(); loadUsageOverview() }
}

// ① 禽类档案
const birdDialogVisible = ref(false)
const birdForm = reactive({ id: null, animal: '鹅', breed_name: '', net_weight_kg: 0, unit_cost: 0, status: '启用', remark: '' })
function openBirdDialog(row) {
  Object.assign(birdForm, row
    ? { id: row.id, animal: row.animal, breed_name: row.breed_name, net_weight_kg: row.net_weight_kg, unit_cost: row.unit_cost, status: row.status, remark: row.remark }
    : { id: null, animal: '鹅', breed_name: '', net_weight_kg: 0, unit_cost: 0, status: '启用', remark: '' })
  birdDialogVisible.value = true
}
async function saveBird() {
  if (!birdForm.breed_name.trim()) { ElMessage.warning('请填写品种名称'); return }
  saving.value = true
  try {
    const payload = {
      animal: birdForm.animal,
      breed_name: birdForm.breed_name.trim(),
      net_weight_kg: birdForm.net_weight_kg || 0,
      unit_cost: birdForm.unit_cost || 0,
      status: birdForm.status,
      remark: birdForm.remark || '',
    }
    if (birdForm.id) await updatePoultrySpecies(birdForm.id, payload)
    else await createPoultrySpecies(payload)
    birdDialogVisible.value = false
    await loadBirds()
    ElMessage.success('已保存')
  } catch (error) { ElMessage.error('保存失败：' + error.message) }
  finally { saving.value = false }
}
async function removeBird(row) {
  try {
    await ElMessageBox.confirm(`确认删除「${row.animal} · ${row.breed_name}」？其出成明细会一并删除。`, '删除确认', { type: 'warning' })
  } catch { return }
  try {
    await deletePoultrySpecies(row.id)
    await loadBirds()
    // 删品种会级联删掉它的出成，部位下拉必须同步，否则会留下指向已删部位的失效选项
    await loadYieldOptions()
    if (yieldBirdId.value === row.id) { yieldBirdId.value = ''; yieldRows.value = [] }
    ElMessage.success('已删除')
  } catch (error) { ElMessage.error('删除失败：' + error.message) }
}

// ② 整只出成
const yieldBirdId = ref('')
const yieldRows = ref([])
let yieldKeySeed = 0
async function loadYields() {
  if (!yieldBirdId.value) { yieldRows.value = []; return }
  try {
    const data = await getPoultryYields({ bird_id: yieldBirdId.value })
    yieldRows.value = (data.yields || []).map(row => ({
      ...row,
      part_kind: row.part_kind || '身体',
      _key: `y${yieldKeySeed++}`,
    }))
  } catch (error) { ElMessage.error('出成明细加载失败：' + error.message) }
}

// ===== 整只部位示意图（PoultryBodyMap）联动 =====
const currentYieldBird = computed(() => birds.value.find(b => b.id === yieldBirdId.value) || null)
const pickedPartNames = ref([])     // 图上点选后要高亮的表格行（按部位名匹配）
const pickedPartHint = ref('')
function onPickBodyZone(rows) {
  const list = Array.isArray(rows) ? rows : []
  pickedPartNames.value = list.map(r => r.part_name)
  pickedPartHint.value = list.length
    ? `已定位：${list.map(r => `${r.part_name}（一只出 ${r.parts_per_bird || 0} 份）`).join('、')}`
    : '该区域还没有配置部位 —— 可用上方「新增部位」补一行'
}
function yieldRowClass({ row }) {
  return pickedPartNames.value.includes(row.part_name) ? 'row-picked' : ''
}

// 把「一只出几份」换算成「一份占整只几分之一」，让份量口径一眼可见，
// 避免再把它当成「数块数」（一只鹅出 2 块上庄 ≠ 一份上庄吃掉半只鹅）
function portionShareText(row) {
  const per = Number(row.parts_per_bird) || 0
  if (per <= 0) return '未设置'
  if (row.part_kind === '副产品') return '随鸟附带'
  if (per === 1) return '一整只'
  // 用最简分数显示更直观：4 → 1/4，2 → 1/2，17.5 → 约 1/17.5
  const share = 1 / per
  const nice = { 0.5: '1/2', 0.25: '1/4', 0.3333: '约 1/3', 0.2: '1/5', 0.125: '1/8', 0.1: '1/10' }
  const rounded = Math.round(share * 10000) / 10000
  return nice[rounded] || `约 1/${Math.round(per * 100) / 100}`
}
// 防呆：身体类部位如果「一份 ≥ 半只鹅」又不是整只/半只本身，几乎都是把块数当成了份量
function portionWarning(row) {
  const per = Number(row.parts_per_bird) || 0
  if (row.part_kind === '副产品' || per <= 0) return ''
  const name = String(row.part_name || '')
  const isWholeLike = /整只|一只|全只|半只|整禽|只$/.test(name)
  if (per > 2) return ''
  if (per === 2 && /半只|半$/.test(name)) return ''
  if (per === 1 && isWholeLike) return ''
  if (per === 2 && !isWholeLike) {
    return `一份占了半只禽。若这一份实际只占 1/4 只，请把「一只出几份」改成 4`
  }
  if (per === 1 && !isWholeLike) {
    return `一份占了一整只禽。若只是其中一个部位（如腩、腿），请按它占整只的比例填（1/4 只 → 填 4）`
  }
  return ''
}
// 图示区域：与核算的「资源池约束」绑定（腿/翅/头颈是每只禽固定件数，靠它判定）
// 新增部位时由名称推荐（后端 normalizeZoneCode），落库后可在此手工改正，改名也不影响核算
const zoneOptions = [
  { value: 'whole', label: '整只' },
  { value: 'half', label: '半只' },
  { value: 'upper', label: '上庄' },
  { value: 'lower', label: '下庄' },
  { value: 'leg', label: '腿' },
  { value: 'wing', label: '翅 / 战斧' },
  { value: 'head_neck', label: '头颈' },
  { value: 'belly', label: '腩' },
  { value: 'meat', label: '切片肉' },
  { value: 'other', label: '其他' },
]
// 口径类型：把「一只出几份」的语义说清楚（份量型与件数型计算方式相同，只是读法不同）
const yieldModeOptions = [
  { value: 'fraction', label: '份量型（一只出几份）' },
  { value: 'count', label: '件数型（一只出几件）' },
  { value: 'weight', label: '重量型（一只出几克）' },
]

function addYieldRow() {
  yieldRows.value.push({
    _key: `n${yieldKeySeed++}`,
    part_name: '', part_kind: '身体', parts_per_bird: 1, part_weight_g: 0,
    zone_code: 'other', yield_mode: 'fraction', remark: '', usage_count: 0,
  })
}
async function saveYields() {
  if (!yieldBirdId.value) { ElMessage.warning('请先选择禽类品种'); return }
  saving.value = true
  try {
    const data = await savePoultryYields(yieldBirdId.value, yieldRows.value.map(row => ({
      part_name: row.part_name,
      part_kind: row.part_kind || '身体',
      parts_per_bird: row.parts_per_bird,
      part_weight_g: row.part_weight_g,
      zone_code: row.zone_code || 'other',
      yield_mode: row.yield_mode || 'fraction',
      remark: row.remark,
    })))
    await loadYields()
    await loadBirds()
    // 关键：出成是「菜品耗用」部位下拉的数据源，改完必须一起刷新，
    // 否则用户在「整只出成」里新增的部位，回到「菜品耗用」选不到（下拉会一直是旧快照）。
    await loadYieldOptions()
    if (data.dropped_usage) {
      ElMessage.warning(`出成已保存，同时清除了 ${data.dropped_usage} 条指向已删除部位的菜品耗用关系`)
    } else {
      ElMessage.success('出成明细已保存')
    }
  } catch (error) { ElMessage.error('保存失败：' + error.message) }
  finally { saving.value = false }
}
function openYields(bird) {
  archiveTab.value = 'yields'
  yieldBirdId.value = bird.id
  loadYields()
}
// 从「① 禽类档案」某一行点「菜品耗用」→ 切到 ③ 并只看该禽类的菜（默认看已配的，便于核对）
function openUsageForAnimal(bird) {
  archiveTab.value = 'usage'
  usageAnimal.value = bird.animal
  usageFilter.value = 'set'
  usageKeyword.value = ''
  loadYieldOptions()
  loadUsageOverview()
}

// ③ 菜品耗用
const usageOverview = ref({ items: [], categories: [], configured: 0, total: 0, all_total: 0 })
const usageKeyword = ref('')
const usageFilter = ref('all')
// 当前正在配置哪个禽类的菜品耗用（从「① 禽类档案」点「菜品耗用」进来会带上；空=全部禽类）
const usageAnimal = ref('')
const usageCategory = ref('')
const usageTableRef = ref(null)
const usageSelection = ref([])
const usageDialogVisible = ref(false)
const usageTarget = ref(null)
const usageRows = ref([])
const yieldOptions = ref([])

// 批量关联
const batchDialogVisible = ref(false)
const batchRows = ref([])
const batchMode = ref('replace')
const batchPreviewNames = computed(() => usageSelection.value.slice(0, 12).map(row => `${row.name}${row.spec ? ' · ' + row.spec : ''}`))
const batchExistingCount = computed(() => usageSelection.value.reduce((sum, row) => sum + (row.usage_count || 0), 0))
const batchTargetSummary = computed(() => {
  const count = usageSelection.value.length
  if (!count) return '未选择菜品'
  const animals = [...new Set(usageSelection.value.map(row => row.category || '未分类'))]
  return `将对 ${count} 个菜品生效${animals.length === 1 ? `（分组：${animals[0]}）` : ''}`
})

async function loadUsageOverview() {
  usageLoading.value = true
  try {
    usageOverview.value = await getPoultryDishUsageOverview({
      keyword: usageKeyword.value.trim(),
      filter: usageFilter.value === 'all' ? '' : usageFilter.value,
      category: usageCategory.value,
      animal: usageAnimal.value || '',
    })
    // 切换分组/筛选后旧勾选会失效，必须清掉，否则会误把上一次的选择一起提交
    usageSelection.value = []
    if (usageTableRef.value) usageTableRef.value.clearSelection()
  } catch (error) { ElMessage.error('菜品耗用加载失败：' + error.message) }
  finally { usageLoading.value = false }
}
function selectUsageCategory(name) {
  usageCategory.value = name || ''
  loadUsageOverview()
}
function onUsageSelectionChange(rows) {
  usageSelection.value = rows || []
}
function selectAllInGroup() {
  const table = usageTableRef.value
  if (!table) return
  ;(usageOverview.value.items || []).forEach(row => table.toggleRowSelection(row, true))
}
function clearUsageSelection() {
  if (usageTableRef.value) usageTableRef.value.clearSelection()
  usageSelection.value = []
}
async function loadYieldOptions() {
  try {
    const data = await getPoultryYields({})
    yieldOptions.value = (data.yields || []).filter(row => row.parts_per_bird > 0)
  } catch (error) { ElMessage.error('部位列表加载失败：' + error.message) }
}
// 部位按「禽类 · 品种」分组展示。一个品种挂十来个部位时，平铺列表很难找，
// 分组后鹅/鸭/鸡各自成块，双拼、套餐要跨禽类选部位也看得清。
// 2026-09-12 追加：① 顶部禽类标签可一键收窄（找「鸭腿」不必在 24 个部位里翻）
//                ② 组内按常用度排序（腿 > 单份/半只/整只 > 拼盘 > 上下庄 > 副产物）
const usageAnimalFilter = ref('')   // 耗用弹窗内：按禽类收窄部位下拉（空 = 全部）

function partPriority(name) {
  const n = String(name || '')
  if (/腿|肶/.test(n)) return 0
  if (/单份|肉|半只|整只|一只/.test(n)) return 1
  if (/双拼|三拼|三宝/.test(n)) return 2
  if (/上庄|下庄|例牌/.test(n)) return 3
  if (/翅|头|颈|掌|爪|肝|肠|腩|小料/.test(n)) return 4
  return 5
}

const yieldOptionGroups = computed(() => {
  const animal = usageAnimalFilter.value
  const groups = new Map()
  for (const option of yieldOptions.value) {
    if (animal && option.animal !== animal) continue
    const label = `${option.animal} · ${option.breed_name}`
    const list = groups.get(label) || []
    list.push(option)
    groups.set(label, list)
  }
  return [...groups.entries()].map(([label, options]) => ({
    label,
    options: options.slice().sort((a, b) => partPriority(a.part_name) - partPriority(b.part_name)
      || String(a.part_name).localeCompare(String(b.part_name), 'zh')),
  }))
})

// 弹窗里可选的禽类（按现有档案去重，没有的禽类不显示标签）
const yieldAnimalTabs = computed(() => {
  const set = new Set(yieldOptions.value.map(o => o.animal).filter(Boolean))
  return [...set]
})
async function openUsageDialog(row) {
  // 每次都重新拉：出成可能在「整只出成」页签里刚改过，缓存住会出现「新增的部位选不到」
  await loadYieldOptions()
  if (!yieldOptions.value.length) {
    ElMessage.warning('还没有可用的部位，请先在「整只出成拆解」里录入')
    return
  }
  // 跟随上下文：从「① 禽类档案」点某禽类的「菜品耗用」进来时，弹窗直接收窄到该禽类
  usageAnimalFilter.value = usageAnimal.value || ''
  usageTarget.value = row
  try {
    const data = await getPoultryDishUsage(row.id)
    usageRows.value = (data.rows || []).map(item => ({ yield_id: item.yield_id, usage_qty: item.usage_qty }))
  } catch (error) {
    ElMessage.error('读取配置失败：' + error.message)
    usageRows.value = []
  }
  if (!usageRows.value.length) usageRows.value = [{ yield_id: null, usage_qty: 1 }]
  usageDialogVisible.value = true
}
async function openBatchUsageDialog() {
  if (!usageSelection.value.length) { ElMessage.warning('请先勾选要关联的菜品'); return }
  await loadYieldOptions()
  if (!yieldOptions.value.length) {
    ElMessage.warning('还没有可用的部位，请先在「整只出成拆解」里录入')
    return
  }
  usageAnimalFilter.value = usageAnimal.value || ''
  // 选中的菜品若已配同一套部位，取第一个已配置的作为初值，减少重复录入
  const sample = usageSelection.value.find(row => (row.usage || []).length)
  batchRows.value = sample
    ? sample.usage.map(item => {
      const match = yieldOptions.value.find(option =>
        option.part_name === item.part_name && option.breed_name === item.breed_name)
      return { yield_id: match ? match.id : null, usage_qty: item.usage_qty }
    })
    : [{ yield_id: null, usage_qty: 1 }]
  batchMode.value = 'replace'
  batchDialogVisible.value = true
}
function perPortionText(row) {
  if (!row.yield_id) return '—'
  const option = yieldOptions.value.find(item => item.id === row.yield_id)
  if (!option || !option.parts_per_bird) return '—'
  const value = (Number(row.usage_qty) || 0) / option.parts_per_bird
  return `${Math.round(value * 10000) / 10000} 只`
}
async function saveUsage() {
  const rows = usageRows.value.filter(row => row.yield_id)
  if (!rows.length) { ElMessage.warning('请至少配置一条部位耗用'); return }
  saving.value = true
  try {
    const saved = await savePoultryDishUsage(usageTarget.value.id, rows.map(row => ({ yield_id: row.yield_id, usage_qty: row.usage_qty })))
    usageDialogVisible.value = false
    await loadUsageOverview()
    await loadBirds()
    // 父子部位同时配置（如「下庄」+「鹅腿」）会重复计量 —— 后端只提示不拦截，这里弹出来让用户判断
    const warnList = (saved && saved.warnings) || []
    if (warnList.length) {
      ElMessageBox.alert(warnList.map(w => w.message).join('\n\n'), '疑似重复计量', { confirmButtonText: '我知道了', type: 'warning' })
      ElMessage.warning('菜品耗用已保存（有疑似重复计量，请核对）')
    } else {
      ElMessage.success('菜品耗用已保存')
    }
  } catch (error) { ElMessage.error('保存失败：' + error.message) }
  finally { saving.value = false }
}
async function saveBatchUsage() {
  const rows = batchRows.value.filter(row => row.yield_id)
  if (!rows.length) { ElMessage.warning('请至少配置一条部位耗用'); return }
  const ids = usageSelection.value.map(row => row.id)
  if (!ids.length) { ElMessage.warning('请先勾选要关联的菜品'); return }
  saving.value = true
  try {
    const data = await batchSavePoultryDishUsage({
      menu_item_ids: ids,
      mode: batchMode.value,
      rows: rows.map(row => ({ yield_id: row.yield_id, usage_qty: row.usage_qty })),
    })
    batchDialogVisible.value = false
    clearUsageSelection()
    await loadUsageOverview()
    await loadBirds()
    const tail = data.mode === 'replace' && data.removed
      ? `，同时清除了 ${data.removed} 条被替换的旧配置`
      : ''
    const warnList = (data && data.warnings) || []
    if (warnList.length) {
      ElMessageBox.alert(warnList.map(w => w.message).join('\n\n'), '疑似重复计量', { confirmButtonText: '我知道了', type: 'warning' })
      ElMessage.warning(`已为 ${data.dishes} 个菜品套用 ${data.rows} 条耗用关系${tail}（有疑似重复计量，请核对）`)
    } else {
      ElMessage.success(`已为 ${data.dishes} 个菜品套用 ${data.rows} 条耗用关系${tail}`)
    }
  } catch (error) { ElMessage.error('批量关联失败：' + error.message) }
  finally { saving.value = false }
}

// ===== 采购录入 =====
const purchaseVisible = ref(false)
const purchaseForm = reactive({ store_id: '', month: dayjs().format('YYYY-MM'), bird_id: '', quantity: 0, amount: 0, remark: '' })
function openPurchaseDialog(row) {
  purchaseForm.store_id = filters.storeId || ''
  purchaseForm.month = (filters.range?.[0] || dayjs().format('YYYY-MM-DD')).slice(0, 7)
  purchaseForm.bird_id = row ? row.bird_id : (birds.value[0]?.id || '')
  purchaseForm.quantity = 0
  purchaseForm.amount = 0
  purchaseForm.remark = ''
  purchaseVisible.value = true
}
async function savePurchase() {
  if (!purchaseForm.store_id) { ElMessage.warning('请选择门店'); return }
  if (!purchaseForm.bird_id) { ElMessage.warning('请选择禽类品种'); return }
  saving.value = true
  try {
    await savePoultryPurchase({ ...purchaseForm, amount: purchaseForm.amount || 0, quantity: purchaseForm.quantity || 0 })
    purchaseVisible.value = false
    await loadComparison()
    ElMessage.success('采购只数已保存')
  } catch (error) { ElMessage.error('保存失败：' + error.message) }
  finally { saving.value = false }
}

// ===== 缺口明细 =====
const gapVisible = ref(false)
const gapTab = ref('unbound')
// 跳到「堂食菜品绑定」（数据分析 → 总数据视角 → 堂食菜品绑定）并带上菜名，
// 那边已支持 ?keyword= 预填搜索、?mapped=unbound 预筛未绑定。
async function goBindDish(row) {
  gapVisible.value = false
  const query = { mapped: 'unbound' }
  if (row?.product_name) query.keyword = String(row.product_name).trim()
  await router.push({ path: '/analysis/total/binding', query })
}

// ===== Excel =====
const importVisible = ref(false)
const importResult = ref(null)
async function downloadTemplate() {
  try {
    const data = await getPoultryTemplate()
    const link = document.createElement('a')
    link.href = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${data.data}`
    link.download = data.file_name || '菜品核算模板.xlsx'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    ElMessage.success('模板已开始下载')
  } catch (error) { ElMessage.error('模板下载失败：' + error.message) }
}
async function handleImportFile(uploadFile) {
  const raw = uploadFile?.raw
  if (!raw) return
  if (raw.size > 20 * 1024 * 1024) { ElMessage.warning('文件超过 20MB，请拆分后导入'); return }
  saving.value = true
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(raw)
    })
    importResult.value = await importPoultryWorkbook({ filename: raw.name, data: dataUrl })
    await loadBirds()
    if (yieldBirdId.value) await loadYields()
    if (archiveTab.value === 'usage') await loadUsageOverview()
    await loadYieldOptions()
    ElMessage.success(`导入完成：禽类 ${importResult.value.birds} / 出成 ${importResult.value.yields} / 耗用 ${importResult.value.usage}`)
  } catch (error) { ElMessage.error('导入失败：' + error.message) }
  finally { saving.value = false }
}

onMounted(async () => {
  await Promise.all([loadStores(), loadBirds(), loadYieldOptions()])
  await loadAccounting()
})

// 本页被 KeepAlive 缓存（见 App.vue），返回时不会重新 mount。
// 用户的常见路径是「核算页 → 缺口明细 → 去绑定 → 回核算页」，若不刷新就会看到
// 已经绑好的菜仍留在缺口清单里 —— 所以每次激活都重取一次核算结果。
onActivated(() => {
  if (filters.range?.[0] && filters.range?.[1]) loadAccounting()
})

/** 打开缺口明细前先刷新一次核算，保证清单是刚绑完的最新状态 */
async function openGapDialog() {
  gapVisible.value = true
  if (filters.range?.[0] && filters.range?.[1]) await loadAccounting()
}
</script>

<style scoped>
.accounting-filter-panel .menu-panel-header { flex-wrap: wrap; gap: 12px; }
.accounting-hint { padding: 0 18px 14px; }
.accounting-empty-panel { padding: 0; }
.accounting-empty { padding: 42px 28px; text-align: center; }
.accounting-empty h3 { margin: 0 0 10px; color: #18345d; font-size: 17px; }
.accounting-empty p { max-width: 760px; margin: 0 auto 14px; color: #6e809b; font-size: 13px; line-height: 1.8; }
.accounting-empty ol { display: inline-block; margin: 0 0 18px; padding-left: 20px; color: #6e809b; font-size: 13px; line-height: 2; text-align: left; }
.accounting-empty-actions { display: flex; justify-content: center; gap: 10px; }
.metric-card strong.muted { color: #b0b8c4; }

.coverage-panel { margin-bottom: 14px; }
.coverage-body { padding: 16px 18px; }
.coverage-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.coverage-badge { padding: 5px 11px; border-radius: 14px; font-size: 12px; font-weight: 700; }
.coverage-badge.good { color: #168160; background: #e9f8f3; }
.coverage-badge.medium { color: #bd772a; background: #fff5e7; }
.coverage-badge.low { color: #ca4744; background: #fff0ef; }
.coverage-text { flex: 1; min-width: 260px; color: #66768f; font-size: 12px; line-height: 1.7; }
.coverage-text b { color: #18345d; }
.coverage-warnings { margin-top: 12px; }
.warning-list { margin-top: 4px; font-size: 12px; line-height: 1.9; }
.channel-chips { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.chip-label { color: #8b98ab; font-size: 12px; }
.channel-chip { padding: 3px 9px; border-radius: 12px; color: #5b6b85; background: #f1f4f9; font-size: 11px; font-variant-numeric: tabular-nums; }
.channel-chip.group { color: #b8730f; background: #fff6e6; }
.channel-chip.delivery { color: #2468c9; background: #eef4ff; }
.channel-chip.dine_in { color: #168160; background: #eaf8f3; }
.channel-chip.other { color: #8b95a4; background: #f0f2f5; }
.chip-tip { color: #9aa3b1; font-size: 11px; line-height: 1.6; }

.bird-cell { display: flex; align-items: center; gap: 8px; }
.animal-pill { flex: none; padding: 3px 9px; border-radius: 12px; font-size: 11px; font-weight: 700; }
.animal-pill.goose { color: #b8730f; background: #fff6e6; }
.animal-pill.duck { color: #2468c9; background: #eef4ff; }
.animal-pill.chicken { color: #168160; background: #eaf8f3; }
.part-name { color: #344054; font-size: 13px; }
.menu-price.birds { color: #173f8a; font-weight: 700; }
.menu-price.diff-up { color: #ca4744; }
.menu-price.diff-down { color: #168160; }
.muted-text { color: #9aa3b1; font-size: 12px; }
.config-line { display: block; color: #8f99a9; font-size: 11px; line-height: 1.7; }
.config-line.strong { color: #5b6b85; font-weight: 650; }
.share-cell { display: flex; flex-direction: column; gap: 5px; }
.share-value { color: #344054; font-size: 12px; font-variant-numeric: tabular-nums; }
.share-cell .margin-track { width: 90px; height: 5px; border-radius: 3px; background: #eef1f6; overflow: hidden; color: #2468e8; }
.share-cell .margin-track i { display: block; height: 100%; border-radius: inherit; background: currentColor; }

.gap-desc { margin: 0 0 12px; padding: 10px 12px; border-radius: 9px; color: #66768f; background: #f7f9fc; font-size: 12px; line-height: 1.8; }
.group-count { display: block; margin-top: 2px; color: #9aa3b1; font-size: 11px; }
.purchase-form { margin-top: 14px; }
.purchase-form .form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 14px; }

.archive-bar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
.archive-tip { flex: 1; min-width: 260px; max-width: 640px; color: #6e809b; font-size: 12px; line-height: 1.7; }
.archive-note { margin: 12px 0 0; color: #9aa3b1; font-size: 12px; }
.archive-count { color: #66768f; font-size: 12px; white-space: nowrap; }

/* 部位类别（身体 / 副产品） */
.kind-chip { display: inline-block; padding: 3px 9px; border-radius: 11px; font-size: 11px; font-weight: 650; white-space: nowrap; }
.kind-chip.body { color: #2468c9; background: #eef4ff; }
.kind-chip.byproduct { color: #b8730f; background: #fff6e6; }
.kind-legend { margin: 12px 0 0; padding: 11px 14px; border: 1px solid #e7eaf0; border-radius: 10px; background: #f8fafd; color: #5b6b85; font-size: 12px; line-height: 2; }
.kind-legend b { color: #18345d; }
.portion-warning { color: #c4761a; background: #fff7e8; padding: 3px 8px; border-radius: 8px; font-size: 11px; line-height: 1.5; display: inline-block; }

/* 风控（食材去向对账） */
.risk-body { padding: 0 18px 16px; }
.risk-block + .risk-block { margin-top: 18px; padding-top: 16px; border-top: 1px dashed #e4e9f2; }
.risk-block { margin-top: 12px; }
.risk-head { display: flex; align-items: center; gap: 9px; margin-bottom: 11px; flex-wrap: wrap; }
.risk-head b { color: #18345d; font-size: 14px; }
.risk-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
.risk-card { padding: 12px 14px; border: 1px solid #e7eaf0; border-radius: 10px; background: #f8fafd; }
.risk-card span,
.risk-card strong,
.risk-card small { display: block; }
.risk-card span { color: #7e899a; font-size: 12px; }
.risk-card strong { margin: 5px 0 3px; color: #173f8a; font-size: 20px; font-variant-numeric: tabular-nums; }
.risk-card small { color: #98a2b1; font-size: 11px; line-height: 1.6; }
.risk-card.warn { border-color: #f3d19e; background: #fffaf0; }
.risk-card.warn strong { color: #c4761a; }
.risk-card.ok { border-color: #c8ecdf; background: #f2fbf8; }
.risk-card.ok strong { color: #168160; }
.risk-sub { margin-top: 10px; }
.risk-sub-title { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; color: #4a5a75; font-size: 12px; font-weight: 650; flex-wrap: wrap; }
.risk-flag { padding: 2px 9px; border-radius: 10px; color: #ca4744; background: #fff0ef; font-size: 11px; font-weight: 600; }
.risk-no-bp { padding: 10px 12px; border-radius: 9px; background: #f7f9fc; font-size: 12px; line-height: 1.8; }
.bottleneck-tag { flex: none; padding: 2px 8px; border-radius: 10px; color: #fff; background: #d9534f; font-size: 11px; font-weight: 700; }

/* 口径对照条 */
.caliber-note { margin: 0 18px 14px; padding: 12px 14px; border: 1px solid #cddffb; border-radius: 10px; background: #f4f8ff; }
.caliber-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.caliber-row + .caliber-row { margin-top: 7px; padding-top: 7px; border-top: 1px dashed #d8e4f8; }
.caliber-label { min-width: 130px; color: #5b6b85; font-size: 12px; font-weight: 650; }
.caliber-value { color: #173f8a; font-size: 19px; font-weight: 750; font-variant-numeric: tabular-nums; }
.caliber-value.small { color: #8b98ab; font-size: 15px; }
.caliber-desc { color: #7e899a; font-size: 11px; }
.caliber-row.muted .caliber-label { color: #9aa3b1; font-weight: 500; }
.usage-group-bar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin: 0 0 12px; }
.usage-group-label { color: #8b98ab; font-size: 12px; margin-right: 2px; }
.usage-group-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border: 1px solid #e2e8f2;
  border-radius: 13px;
  color: #4a5a75;
  background: #f8fafd;
  font-size: 12px;
  cursor: pointer;
  transition: all .15s;
}
.usage-group-chip:hover { border-color: #b9d0ff; color: #2468e8; background: #f2f7ff; }
.usage-group-chip.active { border-color: #2468e8; color: #fff; background: #2468e8; }
.usage-group-chip em { color: #9aa3b1; font-style: normal; font-size: 11px; font-variant-numeric: tabular-nums; }
.usage-group-chip.active em { color: rgba(255,255,255,.8); }
.usage-group-chip i { color: #21ba88; font-style: normal; font-weight: 700; }
.usage-group-chip.done:not(.active) { border-color: #c8ecdf; background: #f2fbf8; }
.usage-group-chip.done.active i { color: #b6f2da; }
.usage-batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 14px;
  border: 1px solid #cddffb;
  border-radius: 10px;
  background: #f4f8ff;
}
.usage-batch-count { flex: 1; color: #4a5a75; font-size: 12px; }
.usage-batch-count b { color: #173f8a; font-size: 14px; }
.batch-mode-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.batch-mode-label { color: #4a5a75; font-size: 13px; font-weight: 650; }
.batch-mode-tip { flex: 1; min-width: 200px; color: #8b98ab; font-size: 11px; line-height: 1.6; }
.batch-preview { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 14px; color: #8b98ab; font-size: 12px; }
.batch-preview-name { padding: 2px 8px; border-radius: 10px; color: #4a5a75; background: #f1f4f9; font-size: 11px; }
.usage-chips { display: flex; gap: 7px; flex-wrap: wrap; }
.usage-chip { padding: 4px 9px; border: 1px solid #e2e8f2; border-radius: 8px; color: #344054; background: #f8fafd; font-size: 11px; }
.usage-chip em { margin-left: 5px; color: #2468c9; font-style: normal; }
.usage-dialog-head { display: flex; align-items: center; gap: 11px; margin-bottom: 16px; padding: 12px; border: 1px solid #e7eaf0; border-radius: 11px; background: #f8f9fb; }
.usage-dialog-head b,
.usage-dialog-head small { display: block; }
.usage-dialog-head b { color: #344054; font-size: 14px; }
.usage-dialog-head small { margin-top: 3px; color: #7f899a; font-size: 11px; }
.usage-add-row { margin-top: 12px; }
.import-upload { margin-top: 16px; }
.import-drop { padding: 22px 0; text-align: center; }
.import-drop b,
.import-drop small { display: block; }
.import-drop b { color: #344054; font-size: 13px; }
.import-drop small { margin-top: 5px; color: #9aa3b1; font-size: 11px; }
.import-result { margin-top: 16px; padding: 12px 14px; border-radius: 10px; background: #f7f9fc; font-size: 12px; line-height: 1.9; }
.import-result b { color: #173f8a; }
.import-errors { margin-top: 10px; padding-top: 10px; border-top: 1px solid #e7eaf0; color: #b0603a; }
.import-errors-title { margin: 0 0 6px; font-weight: 700; }
.drawer-footer-tip { margin-right: auto; color: #9aa3b1; font-size: 12px; }
.hero-action { --el-button-bg-color: rgba(255,255,255,.14); --el-button-border-color: rgba(255,255,255,.3); --el-button-text-color: #fff; --el-button-hover-bg-color: rgba(255,255,255,.24); --el-button-hover-border-color: rgba(255,255,255,.5); --el-button-hover-text-color: #fff; }

/* 整只部位示意图：点选后高亮对应表格行 */
.body-map-hint { margin: 0 0 12px; padding: 8px 12px; border: 1px solid #f3dfb8; border-radius: 9px; background: #fffaf0; color: #9a6a12; font-size: 12px; line-height: 1.7; }
:deep(.menu-data-table .row-picked td.el-table__cell) { background: #fff6e0 !important; }
:deep(.menu-data-table .row-picked:hover td.el-table__cell) { background: #ffefcf !important; }

/* 耗用弹窗里的禽类快捷标签（一键收窄部位下拉） */
.usage-animal-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; padding: 9px 12px; border: 1px solid #e3e9f2; border-radius: 10px; background: #f8fafd; }
.usage-kw-tag { color: #7e899a; font-size: 12px; }
.usage-kw-btn { padding: 4px 12px; border: 1px solid #dfe6f0; border-radius: 13px; background: #fff; color: #4a5a75; font-size: 12px; cursor: pointer; transition: all .15s; }
.usage-kw-btn:hover { border-color: #b9d0ff; color: #2468e8; }
.usage-kw-btn.active { border-color: #2468e8; background: #2468e8; color: #fff; font-weight: 650; }
.usage-animal-bar .muted-text { flex: 1; min-width: 160px; }

/* 当前禽类提示条（② 拆解 / ③ 菜品耗用 各自显示正在配置哪个禽类） */
.yield-current { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; padding: 10px 14px; border: 1px solid #cddffb; border-radius: 10px; background: #f4f8ff; }
.yield-current-tag { padding: 2px 9px; border-radius: 10px; background: #dbe8ff; color: #3a62c0; font-size: 11px; font-weight: 700; }
.yield-current b { color: #1f3f6e; font-size: 15px; }
.yield-current .muted-text { flex: 1; min-width: 200px; }

/* 采购校准（MAPE） */
.calib-body { padding: 0 18px 16px; }
.calib-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
@media (max-width: 900px) { .calib-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.calib-card { padding: 12px 14px; border: 1px solid #e7eaf0; border-radius: 10px; background: #f8fafd; }
.calib-card span, .calib-card strong, .calib-card small { display: block; }
.calib-card span { color: #7e899a; font-size: 12px; }
.calib-card strong { margin: 5px 0 3px; color: #173f8a; font-size: 20px; font-variant-numeric: tabular-nums; }
.calib-card small { color: #98a2b1; font-size: 11px; line-height: 1.6; }
.calib-card.ok { border-color: #c8ecdf; background: #f2fbf8; }
.calib-card.ok strong { color: #168160; }
.calib-card.warn { border-color: #f3d19e; background: #fffaf0; }
.calib-card.warn strong { color: #c4761a; }
.calib-card.bad { border-color: #f2c4c1; background: #fff5f4; }
.calib-card.bad strong { color: #c0392b; }
.calib-dev { font-weight: 700; font-variant-numeric: tabular-nums; }
.calib-dev.ok { color: #168160; }
.calib-dev.warn { color: #c4761a; }
.calib-dev.bad { color: #c0392b; }

/* 禽类菜范围维护（覆盖率分母口径） */
.coverage-badge.reference { color: #5b6b85; background: #f1f4f9; font-weight: 600; }
.scope-body { max-height: 70vh; overflow: auto; }
.scope-intro { margin-bottom: 14px; }
.scope-intro :deep(.el-alert__title) { line-height: 1.8; font-size: 12px; }
.scope-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); gap: 18px; }
@media (max-width: 900px) { .scope-grid { grid-template-columns: minmax(0, 1fr); } }
.scope-column { min-width: 0; }
.scope-column-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.scope-column-head h4 { margin: 0; color: #18345d; font-size: 14px; }
.scope-kw-block { padding: 12px; border: 1px solid #e7eaf0; border-radius: 10px; background: #f8fafd; margin-bottom: 12px; }
.scope-kw-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.scope-kw-tag { padding: 2px 10px; border-radius: 10px; font-size: 12px; font-weight: 700; }
.scope-kw-tag.include { color: #168160; background: #e9f8f3; }
.scope-kw-tag.exclude { color: #ca4744; background: #fff0ef; }
.scope-kw-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.scope-kw-row :deep(.el-input) { flex: 1; }
.scope-kw-empty { color: #98a2b1; font-size: 11px; line-height: 1.8; }
.scope-stat { margin-top: 14px; padding: 12px; border: 1px dashed #d9e2f0; border-radius: 10px; background: #fbfdff; }
.scope-stat-row { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; color: #66768f; font-size: 12px; }
.scope-stat-row b { color: #173f8a; text-align: right; }
.scope-stat-tip { margin: 8px 0 0; color: #98a2b1; font-size: 11px; line-height: 1.7; }
.scope-tools { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
.scope-actions { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.scope-flag { padding: 2px 9px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.scope-flag.in { color: #168160; background: #e9f8f3; }
.scope-flag.out { color: #7e899a; background: #f1f3f7; }
</style>
