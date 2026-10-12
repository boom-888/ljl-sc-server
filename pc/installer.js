/* ============================================================================
 * 安装师傅工作台 —— /pc/installer.js
 * registerRole('installer', { menus, defaultRoute })
 * ==========================================================================*/
(function () {
  const { defineComponent, ref, reactive, computed, onMounted } = Vue;

  // ---------- 1. Dashboard ----------
  const InstallerDash = makeDashPage('installer', {
    cards: [
      { key: 'activeQuotes',           label: '活跃报价',   theme: 'blue'   },
      { key: 'acceptedQuotes',         label: '已接单',     theme: 'green'  },
      { key: 'activeOrders',           label: '进行中',     theme: 'orange' },
      { key: 'completedOrders',        label: '已完工',     theme: 'purple' },
      { key: 'warrantyClaims',         label: '质保索赔',   theme: 'red'    },
      { key: 'withdrawInfo.available', label: '可用余额',   theme: 'blue', subKey: 'withdrawInfo.frozen' },
      { key: 'totalInstalls',          label: '累计安装',   theme: 'green'  },
      { key: 'avgRating',              label: '平均评分',   theme: 'purple' },
    ],
    todos: true,
  });

  // ---------- 2. 接单大厅 ----------
  const HallPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);
      const sort = ref('newest');
      const dialog = reactive({ show: false, demand: null, price: null, eta: '', description: '' });

      async function load() {
        loading.value = true;
        try {
          const r = await window.__api.get('/installer/hall?sort=' + sort.value);
          const d = r.data || {};
          list.value = Array.isArray(d.jobs) ? d.jobs : [];
        } catch {}
        loading.value = false;
      }

      function openQuote(row) {
        dialog.show = true;
        dialog.demand = row;
        dialog.price = 0;
        dialog.eta = '';
        dialog.description = '';
      }

      async function submitQuote() {
        if (!Number(dialog.price)) return window.__toast('warning', '请填写报价');
        try {
          await window.__api.post('/installer/quote', {
            demandId: Number(dialog.demand.id),
            price: Number(dialog.price),
            eta: dialog.eta,
            description: dialog.description,
          });
          window.__toast('success', '报价已提交');
          dialog.show = false;
          await load();
        } catch {}
      }

      return { list, loading, sort, dialog, load, openQuote, submitQuote };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>接单大厅</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
          <el-radio-group v-model="sort" size="small" @change="load">
            <el-radio-button label="newest">最新发布</el-radio-button>
            <el-radio-button label="distance">距离优先</el-radio-button>
          </el-radio-group>
          <div style="flex:1"></div>
          <el-button type="primary" size="small" @click="load" :loading="loading">刷新</el-button>
        </div>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column prop="title" label="需求" min-width="200" />
          <el-table-column label="预算" width="140">
            <template #default="{row}"><span style="color:#ef4444;font-weight:600">{{ row.budget }}</span></template>
          </el-table-column>
          <el-table-column prop="address" label="地址" min-width="180" show-overflow-tooltip />
          <el-table-column prop="distance" label="距离" width="90" />
          <el-table-column label="等级" width="100">
            <template #default="{row}">Lv.{{ row.gradeMin }}-{{ row.gradeMax }}</template>
          </el-table-column>
          <el-table-column prop="publishTime" label="发布时间" width="180" />
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{row}">
              <el-button size="small" type="primary" @click="openQuote(row)">提交报价</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <el-dialog v-model="dialog.show" :title="'对需求 #' + (dialog.demand?.id || '') + ' 提交报价'" width="480px">
        <div v-if="dialog.demand" style="margin-bottom:12px;padding:10px;background:#f9fafb;border-radius:6px">
          <div style="font-weight:600">{{ dialog.demand.title }}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px">预算 {{ dialog.demand.budget }} · 距离 {{ dialog.demand.distance }}</div>
        </div>
        <el-form label-width="90px">
          <el-form-item label="报价金额"><el-input-number v-model="dialog.price" :min="1" style="width:100%" /></el-form-item>
          <el-form-item label="预计工期"><el-input v-model="dialog.eta" placeholder="如 3 天内 / 本周" /></el-form-item>
          <el-form-item label="说明备注"><el-input v-model="dialog.description" type="textarea" :rows="3" placeholder="简单介绍你的资质或类似安装经验..." /></el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialog.show = false">取消</el-button>
          <el-button type="primary" @click="submitQuote">确认提交</el-button>
        </template>
      </el-dialog>
    `,
  });

  // ---------- 3. 我的报价 ----------
  const QuotesPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);

      async function load() {
        loading.value = true;
        try {
          const r = await window.__api.get('/installer/quotes');
          list.value = r.data?.list || [];
        } catch {}
        loading.value = false;
      }

      const statusLabel = { pending: '等待客户选择', accepted: '已被接受', cancelled: '已撤销', rejected: '已拒绝' };
      const statusType = { pending: 'warning', accepted: 'success', cancelled: 'info', rejected: 'danger' };

      async function cancel(row) {
        try {
          await window.ElementPlus.ElMessageBox.confirm('确定撤销此报价？', '提示', { type: 'warning' });
          await window.__api.post('/installer/quote/' + row.id + '/cancel');
          window.__toast('success', '报价已撤销');
          await load();
        } catch {}
      }

      return { list, loading, statusLabel, statusType, load, cancel };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>我的报价</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px">
          <div style="flex:1"></div>
          <el-button type="primary" size="small" @click="load" :loading="loading">刷新</el-button>
        </div>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column prop="id" label="报价ID" width="100" />
          <el-table-column prop="demandId" label="需求ID" width="100" />
          <el-table-column label="报价" width="110"><template #default="{row}"><span style="color:#ef4444;font-weight:600">¥{{ row.price }}</span></template></el-table-column>
          <el-table-column prop="eta" label="工期" width="120" />
          <el-table-column prop="description" label="说明" min-width="200" show-overflow-tooltip />
          <el-table-column label="状态" width="130">
            <template #default="{row}">
              <el-tag :type="statusType[row.status]" size="small">{{ statusLabel[row.status] || row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="报价时间" width="180"><template #default="{row}">{{ row.createdAt || '-' }}</template></el-table-column>
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{row}">
              <el-button v-if="row.status === 'pending'" size="small" type="danger" plain @click="cancel(row)">撤销报价</el-button>
              <span v-else style="color:#9ca3af;font-size:12px">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    `,
  });

  // ---------- 4. 安装订单 ----------
  const OrdersPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);
      const activeTab = ref('all');

      async function load() {
        loading.value = true;
        try {
          const r = await window.__api.get('/installer/orders?tab=' + activeTab.value);
          list.value = Array.isArray(r.data) ? r.data : (r.data?.list || []);
        } catch {}
        loading.value = false;
      }

      const statusLabel = { pending: '待上门', in_progress: '进行中', completed: '已完工', reviewed: '已评价', cancelled: '已取消' };
      const statusType = { pending: 'warning', in_progress: '', completed: 'success', reviewed: 'success', cancelled: 'info' };

      async function startOrder(row) {
        try {
          await window.__api.post('/installer/orders/' + row.id + '/start', {});
          window.__toast('success', '已标记开工');
          await load();
        } catch {}
      }
      async function completeOrder(row) {
        try {
          await window.ElementPlus.ElMessageBox.confirm('确定该订单施工全部完成？完成后客户将收到验收通知', '完工确认', { type: 'warning' });
          await window.__api.post('/installer/orders/' + row.id + '/complete', {});
          window.__toast('success', '已标记完工');
          await load();
        } catch {}
      }

      return { list, loading, activeTab, statusLabel, statusType, load, startOrder, completeOrder };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>安装订单</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px">
          <el-radio-group v-model="activeTab" size="small" @change="load">
            <el-radio-button label="all">全部</el-radio-button>
            <el-radio-button label="pending">待上门</el-radio-button>
            <el-radio-button label="in_progress">进行中</el-radio-button>
            <el-radio-button label="completed">已完工</el-radio-button>
          </el-radio-group>
          <div style="flex:1"></div>
          <el-button type="primary" size="small" @click="load" :loading="loading">刷新</el-button>
        </div>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column prop="orderNo" label="订单号" width="140" />
          <el-table-column label="安装需求" min-width="200">
            <template #default="{row}">
              <div style="font-weight:500">{{ row.serviceType || row.demand?.title || row.title || '安装服务' }}</div>
              <div style="color:#9ca3af;font-size:12px">{{ row.address || row.demand?.address || '-' }}</div>
            </template>
          </el-table-column>
          <el-table-column label="金额" width="100">
            <template #default="{row}">¥{{ row.finalPrice || row.price || row.amount || '-' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{row}">
              <el-tag :type="statusType[row.status]" size="small">{{ statusLabel[row.status] || row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="阶段" width="90">
            <template #default="{row}">
              <template v-if="row.currentStage != null">{{ row.currentStage }}/4</template>
              <template v-else>-</template>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="240" fixed="right">
            <template #default="{row}">
              <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="startOrder(row)">开始上门</el-button>
              <el-button v-if="row.status === 'pending' || row.status === 'in_progress'" size="small" type="success" @click="completeOrder(row)">完工确认</el-button>
              <el-button v-if="row.status === 'in_progress'" size="small">上传进度照</el-button>
              <span v-if="row.status === 'completed' || row.status === 'reviewed'" style="color:#9ca3af;font-size:12px">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    `,
  });

  // ---------- 5. 质保索赔 ----------
  const WarrantyPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);
      const detail = ref(null);
      const dialog = reactive({ show: false, id: null, showResp: false, action: 'accept', response: '' });

      async function load() {
        loading.value = true;
        try {
          const r = await window.__api.get('/installer/warranty-claims');
          list.value = Array.isArray(r.data) ? r.data : (r.data?.list || []);
        } catch {}
        loading.value = false;
      }

      const statusLabel = { pending: '待处理', accepted: '师傅已接受', rejected: '师傅已拒绝', arbitrated: '平台仲裁中', processing: '处理中', completed: '已结案' };
      const statusType = { pending: 'warning', accepted: 'success', rejected: 'danger', arbitrated: 'warning', processing: '', completed: 'info' };

      async function openDetail(row) {
        dialog.show = true;
        dialog.id = row.id;
        try {
          const r = await window.__api.get('/installer/warranty-claims/' + row.id);
          detail.value = r.data;
        } catch { dialog.show = false; }
      }

      function openRespond() {
        dialog.showResp = true;
        dialog.action = 'accept';
        dialog.response = '';
      }

      async function submitRespond() {
        try {
          await window.__api.post('/installer/warranty-claims/' + dialog.id + '/respond', {
            action: dialog.action,
            response: dialog.response,
          });
          window.__toast('success', '响应已提交');
          dialog.showResp = false;
          await load();
          dialog.show = false;
        } catch {}
      }

      return { list, loading, statusLabel, statusType, detail, dialog, load, openDetail, openRespond, submitRespond };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>质保索赔</h2>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column prop="claimNo" label="索赔单号" width="160" />
          <el-table-column prop="orderNo" label="订单号" width="140" />
          <el-table-column label="索赔金额" width="110"><template #default="{row}">¥{{ row.claimAmount ?? 0 }}</template></el-table-column>
          <el-table-column prop="reason" label="索赔原因" min-width="240" show-overflow-tooltip />
          <el-table-column label="状态" width="130">
            <template #default="{row}">
              <el-tag :type="statusType[row.status]" size="small">{{ statusLabel[row.status] || row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="160" fixed="right">
            <template #default="{row}">
              <el-button size="small" @click="openDetail(row)">查看</el-button>
              <el-button v-if="row.status === 'pending'" size="small" type="primary" @click="openDetail(row).then(() => openRespond())">响应</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <el-dialog v-model="dialog.show" title="质保索赔详情" width="560px">
        <div v-if="detail">
          <div style="line-height:2">
            <div>索赔单号：{{ detail.claimNo }}</div>
            <div>订单号：{{ detail.orderNo }}</div>
            <div>索赔金额：¥{{ detail.claimAmount }}</div>
            <div>原因类型：{{ detail.reasonType }}</div>
            <div>索赔原因：{{ detail.reason }}</div>
            <div v-if="detail.images?.length">
              凭证图片：
              <el-image v-for="(img, i) in detail.images" :key="i" :src="img" fit="cover" :preview-src-list="detail.images" style="width:80px;height:80px;margin-right:6px" />
            </div>
            <div style="margin-top:10px">
              <el-tag :type="statusType[detail.status]">{{ statusLabel[detail.status] || detail.status }}</el-tag>
            </div>
          </div>
        </div>
        <template #footer>
          <el-button @click="dialog.show = false">关闭</el-button>
          <el-button v-if="detail?.status === 'pending'" type="primary" @click="openRespond">我要响应</el-button>
        </template>
      </el-dialog>

      <el-dialog v-model="dialog.showResp" title="响应索赔" width="440px">
        <el-form label-width="90px">
          <el-form-item label="处理方式">
            <el-radio-group v-model="dialog.action">
              <el-radio-button label="accept">接受</el-radio-button>
              <el-radio-button label="reject">拒绝(自动升级平台仲裁)</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="响应说明"><el-input v-model="dialog.response" type="textarea" :rows="3" placeholder="请填写处理方案或拒绝原因..." /></el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialog.showResp = false">取消</el-button>
          <el-button type="primary" @click="submitRespond">提交</el-button>
        </template>
      </el-dialog>
    `,
  });

  // ---------- 6. 财务中心 ----------
  const FinancePage = defineComponent({
    setup() {
      const earnings = ref(null);
      const withdrawInfo = ref(null);
      const bankCards = ref([]);
      const loading = ref(true);
      const dialog = reactive({ show: false, amount: null });

      async function load() {
        loading.value = true;
        try {
          const [e, w, b] = await Promise.all([
            window.__api.get('/installer/earnings').catch(() => ({ data: null })),
            window.__api.get('/installer/withdraw-info').catch(() => ({ data: null })),
            window.__api.get('/installer/bank-cards').catch(() => ({ data: null })),
          ]);
          earnings.value = e.data;
          withdrawInfo.value = w.data;
          bankCards.value = Array.isArray(b.data) ? b.data : (b.data?.list || []);
        } catch {}
        loading.value = false;
      }

      async function doWithdraw() {
        try {
          await window.__api.post('/installer/withdraw', { amount: Number(dialog.amount) });
          window.__toast('success', '提现申请已提交');
          dialog.show = false; dialog.amount = null;
          await load();
        } catch {}
      }

      return { earnings, withdrawInfo, bankCards, loading, dialog, load, doWithdraw };
    },
    mounted() { this.load(); },
    template: `
      <div v-loading="loading">
        <div class="page-card">
          <h2>收益概览</h2>
          <div class="dash-grid" v-if="earnings">
            <div class="dash-card green"><div class="label">可提现余额</div><div class="value">¥{{ earnings.available ?? 0 }}</div></div>
            <div class="dash-card orange"><div class="label">冻结金额</div><div class="value">¥{{ earnings.frozen ?? 0 }}</div></div>
            <div class="dash-card"><div class="label">累计毛收入</div><div class="value">¥{{ earnings.grossTotal ?? 0 }}</div></div>
            <div class="dash-card purple"><div class="label">平台抽佣</div><div class="value">¥{{ earnings.commissionTotal ?? 0 }}</div><div class="sub">抽佣率 {{ earnings.rate ? (earnings.rate * 100).toFixed(0) + '%' : '—' }}</div></div>
            <div class="dash-card red"><div class="label">质保扣留</div><div class="value">¥{{ earnings.warrantyHeld ?? 0 }}</div><div class="sub">待释放 ¥{{ earnings.warrantyPendingRelease ?? 0 }}</div></div>
            <div class="dash-card"><div class="label">质保索赔中</div><div class="value">¥{{ earnings.warrantyClaimed ?? 0 }}</div></div>
          </div>
          <div style="margin-top:12px">
            <el-button type="primary" @click="dialog.show = true">发起提现</el-button>
          </div>
        </div>

        <div class="page-card">
          <h2>绑定的银行卡</h2>
          <el-table :data="bankCards" stripe size="small" empty-text="暂无绑定银行卡">
            <el-table-column label="银行" prop="bankName" />
            <el-table-column label="卡号"><template #default="{row}">{{ row.cardNoMasked || row.cardNo || '-' }}</template></el-table-column>
            <el-table-column label="持卡人"><template #default="{row}">{{ row.accountName || '-' }}</template></el-table-column>
            <el-table-column label="默认" width="80"><template #default="{row}"><el-tag v-if="row.isDefault" type="success" size="small">默认</el-tag></template></el-table-column>
          </el-table>
        </div>

        <div class="page-card" v-if="withdrawInfo?.recent?.length">
          <h2>最近提现</h2>
          <el-table :data="withdrawInfo.recent" stripe size="small">
            <el-table-column prop="withdrawNo" label="提现单号" />
            <el-table-column label="金额"><template #default="{row}">¥{{ row.amount }}</template></el-table-column>
            <el-table-column label="银行"><template #default="{row}">{{ row.bankName }}</template></el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{row}">
                <el-tag :type="row.status==='approved'?'success':row.status==='pending'?'warning':'info'" size="small">
                  {{ row.status === 'pending' ? '审核中' : row.status === 'approved' ? '已打款' : row.status }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <el-dialog v-model="dialog.show" title="发起提现" width="360px">
        <el-form-item label="提现金额"><el-input-number v-model="dialog.amount" :min="1" /></el-form-item>
        <template #footer>
          <el-button @click="dialog.show = false">取消</el-button>
          <el-button type="primary" @click="doWithdraw">提交</el-button>
        </template>
      </el-dialog>
    `,
  });

  // ---------- 7. 师傅档案 + 专长标签 CRUD ----------
  const ProfilePage = defineComponent({
    setup() {
      const profile = ref(null);
      const specs = ref([]);
      const loading = ref(false);
      const allCategories = ref([
        { id: 1, name: '家具安装', icon: '🪑' },
        { id: 2, name: '家电安装', icon: '📺' },
        { id: 3, name: '灯具安装', icon: '💡' },
        { id: 4, name: '卫浴安装', icon: '🚿' },
        { id: 5, name: '地板铺设', icon: '🪵' },
        { id: 6, name: '门窗安装', icon: '🚪' },
        { id: 7, name: '晾衣架安装', icon: '🧺' },
        { id: 8, name: '窗帘安装', icon: '🪟' },
        { id: 9, name: '空调安装', icon: '❄️' },
        { id: 10, name: '热水器安装', icon: '🔥' },
        { id: 11, name: '橱柜安装', icon: '🍳' },
        { id: 12, name: '净水器安装', icon: '💧' },
      ]);
      const selectedIds = ref([]); // 已选 categoryIds

      async function load() {
        loading.value = true;
        try {
          const [p, s] = await Promise.all([
            window.__api.get('/installer/profile').catch(() => ({ data: null })),
            window.__api.get('/installer/specialties').catch(() => ({ data: [] })),
          ]);
          profile.value = p.data;
          specs.value = Array.isArray(s.data) ? s.data : [];
          selectedIds.value = specs.value.map(x => Number(x.categoryId)).filter(Boolean);
        } catch {}
        loading.value = false;
      }

      function toggle(cid) {
        const idx = selectedIds.value.indexOf(cid);
        if (idx >= 0) selectedIds.value.splice(idx, 1);
        else selectedIds.value.push(cid);
      }

      async function saveSpecs() {
        try {
          await window.__api.post('/installer/specialties', { specialties: selectedIds.value });
          window.__toast('success', '专长标签已更新');
          await load();
        } catch {}
      }

      async function removeSpec(row) {
        try {
          await window.ElementPlus.ElMessageBox.confirm('确定移除此专长？', '提示', { type: 'warning' });
          await window.__api.del('/installer/specialties/' + row.id);
          window.__toast('success', '已移除');
          await load();
        } catch {}
      }

      return { profile, specs, loading, allCategories, selectedIds, load, toggle, saveSpecs, removeSpec };
    },
    mounted() { this.load(); },
    template: `
      <div v-loading="loading">
        <div class="page-card">
          <h2>师傅资料</h2>
          <div v-if="profile" style="line-height:2">
            <div>姓名：{{ profile.realName || profile.name || '-' }}</div>
            <div>手机：{{ profile.phone || '-' }}</div>
            <div>服务地址：{{ profile.serviceAddress || '-' }}</div>
            <div>服务半径：{{ profile.serviceRadiusKm ? profile.serviceRadiusKm + ' km' : '-' }}</div>
            <div>完成订单：{{ profile.completedOrders ?? 0 }}</div>
            <div>评分：{{ profile.rating ?? '-' }} ({{ profile.ratingCount ?? 0 }} 条评价)</div>
            <div>等级：Lv.{{ profile.grade ?? 1 }} {{ profile.gradeTitle || '' }}</div>
            <div>状态：
              <el-tag v-if="profile.verified === 1 || profile.verified === true" type="success" size="small">已认证</el-tag>
              <el-tag v-else type="warning" size="small">审核中</el-tag>
            </div>
          </div>
          <div v-else class="loading">加载中…</div>
        </div>

        <div class="page-card">
          <h2>专长标签（共 {{ selectedIds.length }} 项）</h2>
          <div style="margin-bottom:12px">
            <el-button type="primary" size="small" @click="saveSpecs">保存专长</el-button>
            <span style="margin-left:10px;color:#9ca3af;font-size:12px">勾选你擅长的安装类型，系统会优先派单给匹配的师傅</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px">
            <div v-for="c in allCategories" :key="c.id"
                 @click="toggle(c.id)"
                 :style="{ cursor: 'pointer', padding: '12px', borderRadius: '8px', border: selectedIds.includes(c.id) ? '2px solid #60a5fa' : '2px solid #e5e7eb', background: selectedIds.includes(c.id) ? '#eff6ff' : '#fff', transition: 'all .2s' }">
              <div style="font-size:24px">{{ c.icon }}</div>
              <div style="font-weight:500;margin-top:4px">{{ c.name }}</div>
              <el-tag v-if="selectedIds.includes(c.id)" type="primary" size="small" style="margin-top:4px">已选择</el-tag>
            </div>
          </div>

          <el-divider>当前已绑定</el-divider>
          <div v-if="specs.length" style="display:flex;flex-wrap:wrap;gap:8px">
            <el-tag v-for="sp in specs" :key="sp.id" closable @close="removeSpec(sp)" size="large">
              {{ allCategories.find(c => c.id === Number(sp.categoryId))?.name || '#' + sp.categoryId }}
              <span style="color:#9ca3af;font-size:11px">Lv.{{ sp.level || 1 }}</span>
            </el-tag>
          </div>
          <div v-else class="empty" style="padding:20px 0">
            <div class="tip">暂无专长，请在上方勾选你擅长的安装类型</div>
          </div>
        </div>
      </div>
    `,
  });

  // ---------- 8. 纠纷处理 ----------
  const DisputesPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);
      const activeTab = ref('all');
      const detail = ref(null);
      const respondText = ref('');
      const detailDialog = reactive({ show: false, id: null });

      async function load() {
        loading.value = true;
        try {
          const q = activeTab.value !== 'all' ? '?tab=' + activeTab.value : '';
          const r = await window.__api.get('/installer/disputes' + q);
          list.value = Array.isArray(r.data) ? r.data : (r.data?.list || []);
        } catch {}
        loading.value = false;
      }

      const statusLabel = { pending: '待处理', processing: '进行中', resolved: '已解决' };
      const statusType = { pending: 'danger', processing: 'warning', resolved: 'success' };

      async function openDetail(row) {
        detailDialog.show = true;
        detailDialog.id = row.id;
        respondText.value = '';
        try {
          const r = await window.__api.get('/installer/disputes/' + row.id);
          detail.value = r.data;
        } catch { detailDialog.show = false; }
      }

      async function submitRespond() {
        if (!respondText.value?.trim()) return window.__toast('warning', '请输入响应内容');
        try {
          await window.__api.post('/installer/disputes/' + detailDialog.id + '/respond', { message: respondText.value.trim() });
          window.__toast('success', '响应已提交');
          respondText.value = '';
          await load();
          await openDetail(list.value.find(x => x.id === detailDialog.id) || {});
        } catch {}
      }

      return { list, loading, activeTab, statusLabel, statusType, detail, respondText, detailDialog, load, openDetail, submitRespond };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>纠纷处理</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px">
          <el-radio-group v-model="activeTab" size="small" @change="load">
            <el-radio-button label="all">全部</el-radio-button>
            <el-radio-button label="pending">待处理</el-radio-button>
            <el-radio-button label="processing">进行中</el-radio-button>
            <el-radio-button label="resolved">已解决</el-radio-button>
          </el-radio-group>
          <div style="flex:1"></div>
          <el-button type="primary" size="small" @click="load" :loading="loading">刷新</el-button>
        </div>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column prop="reasonType" label="纠纷类型" width="130" />
          <el-table-column prop="reason" label="纠纷描述" min-width="220">
            <template #default="{row}">{{ row.reason?.slice(0, 60) || '-' }}</template>
          </el-table-column>
          <el-table-column label="索赔金额" width="110"><template #default="{row}">¥{{ row.claimAmount ?? 0 }}</template></el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{row}">
              <el-tag :type="statusType[row.status] || 'info'" size="small">{{ statusLabel[row.status] || row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="100">
            <template #default="{row}"><el-button size="small" @click="openDetail(row)">详情</el-button></template>
          </el-table-column>
        </el-table>
      </div>

      <el-dialog v-model="detailDialog.show" title="纠纷详情" width="640px">
        <div v-if="detail">
          <div style="margin-bottom:10px">
            <el-tag :type="statusType[detail.status]">{{ statusLabel[detail.status] || detail.status }}</el-tag>
            <span style="margin-left:10px;color:#6b7280;font-size:13px">{{ detail.reasonType }}</span>
          </div>
          <div v-if="detail.images?.length" style="margin-bottom:10px">
            <el-image v-for="(img, i) in detail.images" :key="i" :src="img" fit="cover" :preview-src-list="detail.images" style="width:80px;height:80px;margin-right:6px" />
          </div>
          <div style="margin-bottom:12px;color:#374151">{{ detail.reason }}</div>
          <el-divider>时间线</el-divider>
          <div v-for="(m, i) in (detail.timeline || [])" :key="i" style="margin-bottom:10px">
            <el-tag :type="m.role==='buyer' ? 'warning' : m.role==='provider' ? '' : 'success'" size="small">
              {{ m.role === 'buyer' ? '买家' : m.role === 'provider' ? '我(师傅)' : m.role === 'admin' ? '平台' : m.role }}
            </el-tag>
            <span style="margin-left:8px;color:#6b7280;font-size:12px">{{ m.createdAt }}</span>
            <div style="margin-top:4px;background:#f9fafb;padding:8px 12px;border-radius:6px;color:#374151">{{ m.message }}</div>
          </div>
          <el-divider />
          <div style="margin-bottom:8px">补充响应：</div>
          <el-input v-model="respondText" type="textarea" :rows="3" placeholder="请输入你的解释或提供相关证据说明..." />
          <div style="margin-top:8px;text-align:right">
            <el-button type="primary" @click="submitRespond">提交响应</el-button>
          </div>
        </div>
      </el-dialog>
    `,
  });

  // ---------- 9. 通知消息 ----------
  const NotificationsPage = defineComponent({
    setup() {
      const list = ref([]);
      const unread = ref(0);
      const loading = ref(false);
      async function load() {
        loading.value = true;
        try {
          const [r, u] = await Promise.all([
            window.__api.notifications().catch(() => ({ data: [] })),
            window.__api.unreadCount().catch(() => ({ data: 0 })),
          ]);
          list.value = Array.isArray(r.data) ? r.data : (r.data?.list || []);
          unread.value = Number(u.data || 0);
        } catch {}
        loading.value = false;
      }
      async function markAll() {
        try { await window.__api.markRead(); window.__toast('success', '已全部标为已读'); await load(); } catch {}
      }
      return { list, unread, loading, load, markAll };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>通知消息 <span v-if="unread" style="margin-left:8px;font-size:12px;background:#ef4444;color:#fff;border-radius:10px;padding:1px 8px">{{ unread }} 条未读</span></h2>
        <div style="margin-bottom:12px"><el-button size="small" @click="markAll" :disabled="!unread">全部标为已读</el-button></div>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column label="标题" min-width="240">
            <template #default="{row}">
              <span style="font-weight:500">{{ row.title || row.subject || '-' }}</span>
              <el-tag v-if="!row.isRead && row.status !== 'read'" type="danger" size="small" style="margin-left:6px">未读</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="content" label="内容" min-width="260" show-overflow-tooltip />
          <el-table-column prop="createdAt" label="时间" width="180" />
        </el-table>
      </div>
    `,
  });

  // ---------- 注册 ----------
  registerRole('installer', {
    defaultRoute: '/dashboard',
    menus: [
      { path: '/dashboard',    label: '工作台概览', icon: '📊', component: InstallerDash },
      { path: '/hall',         label: '接单大厅',   icon: '🔥', component: HallPage },
      { path: '/quotes',       label: '我的报价',   icon: '📋', component: QuotesPage },
      { path: '/orders',       label: '安装订单',   icon: '🛠️', component: OrdersPage },
      { path: '/warranty',     label: '质保索赔',   icon: '🛡️', component: WarrantyPage },
      { path: '/finance',      label: '财务中心',   icon: '💰', component: FinancePage },
      { path: '/profile',      label: '师傅档案',   icon: '👷', component: ProfilePage },
      { path: '/disputes',     label: '纠纷处理',   icon: '⚠️', component: DisputesPage },
      { path: '/notifications',label: '通知消息',   icon: '🔔', component: NotificationsPage },
    ],
  });
})();
