/* ============================================================================
 * 设计师工作台 —— /pc/designer.js
 * registerRole('designer', { menus, defaultRoute })
 * ==========================================================================*/
(function () {
  const { defineComponent, ref, reactive, computed, onMounted } = Vue;

  // ---------- 1. Dashboard ----------
  const DesignerDash = makeDashPage('designer', {
    cards: [
      { key: 'activeQuotes',   label: '活跃报价',   theme: 'blue'   },
      { key: 'acceptedQuotes', label: '被选中',     theme: 'green'  },
      { key: 'activeOrders',   label: '进行中订单', theme: 'orange' },
      { key: 'completedOrders',label: '已交付',    theme: 'purple' },
      { key: 'withdrawInfo.available', label: '可用余额', theme: 'blue', subKey: 'withdrawInfo.frozen' },
    ],
    todos: true,
  });

  // ---------- 2. 抢单大厅 ----------
  const HallPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);
      const keyword = ref('');
      const sortBy = ref('latest');
      const dialog = reactive({ show: false, demand: null, price: null, note: '' });

      async function load() {
        loading.value = true;
        try {
          const qp = new URLSearchParams();
          if (keyword.value) qp.set('keyword', keyword.value);
          if (sortBy.value) qp.set('sortBy', sortBy.value);
          const r = await window.__api.get('/designer/hall' + (qp.toString() ? '?' + qp.toString() : ''));
          const d = r.data || {};
          list.value = Array.isArray(d) ? d : (d.demands || []);
        } catch {}
        loading.value = false;
      }

      function openQuote(row) {
        dialog.show = true;
        dialog.demand = row;
        dialog.price = Number(row.budgetMin || row.budget || 0) || 0;
        dialog.note = '';
      }

      async function submitQuote() {
        try {
          await window.__api.post('/designer/quote', {
            demandId: Number(dialog.demand.id),
            quotePrice: Number(dialog.price),
            note: dialog.note,
          });
          window.__toast('success', '报价已提交');
          dialog.show = false;
          await load();
        } catch {}
      }

      function myBidStatus(row) {
        if (!row.myBid) return { label: '未报价', type: 'info' };
        if (row.myBid.accepted) return { label: '已被选中', type: 'success' };
        return { label: '报价中', type: 'warning' };
      }

      return { list, loading, keyword, sortBy, dialog, load, openQuote, submitQuote, myBidStatus };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>抢单大厅</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <el-input v-model="keyword" placeholder="搜索关键词" style="width:200px" clearable @keyup.enter="load" />
          <el-radio-group v-model="sortBy" size="small">
            <el-radio-button label="latest">最新发布</el-radio-button>
            <el-radio-button label="budget">预算从高到低</el-radio-button>
          </el-radio-group>
          <div style="flex:1"></div>
          <el-button type="primary" size="small" @click="load" :loading="loading">刷新</el-button>
        </div>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column prop="title" label="设计需求" min-width="200">
            <template #default="{row}">
              <div style="font-weight:500">{{ row.title }}</div>
              <div style="color:#9ca3af;font-size:12px">{{ row.desc?.slice(0, 50) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="预算" width="140">
            <template #default="{row}"><span style="color:#ef4444;font-weight:600">{{ row.budget }}</span></template>
          </el-table-column>
          <el-table-column prop="deliveryTime" label="交付周期" width="120" />
          <el-table-column label="已有报价" width="100" align="center">
            <template #default="{row}">{{ row.biddersCount || 0 }}</template>
          </el-table-column>
          <el-table-column label="我的状态" width="110">
            <template #default="{row}">
              <el-tag :type="myBidStatus(row).type" size="small">{{ myBidStatus(row).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="已有报价参考" width="200">
            <template #default="{row}">
              <div v-for="(b, i) in row.biddersPreview" :key="i" style="font-size:12px;color:#6b7280">
                #{{ i+1 }} ¥{{ b.quotePrice }} <span v-if="b.accepted" style="color:#10b981">✓已选中</span>
              </div>
              <div v-if="!row.biddersPreview?.length" style="color:#9ca3af;font-size:12px">暂无报价</div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{row}">
              <el-button size="small" type="primary" @click="openQuote(row)">
                {{ row.myBid ? '修改报价' : '提交报价' }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <el-dialog v-model="dialog.show" :title="'对需求 #' + (dialog.demand?.id || '') + ' 提交报价'" width="480px">
        <div v-if="dialog.demand" style="margin-bottom:12px;padding:10px;background:#f9fafb;border-radius:6px">
          <div style="font-weight:600">{{ dialog.demand.title }}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px">预算 {{ dialog.demand.budget }} · 交付周期 {{ dialog.demand.deliveryTime }}</div>
        </div>
        <el-form label-width="90px">
          <el-form-item label="报价金额"><el-input-number v-model="dialog.price" :min="1" style="width:100%" /></el-form-item>
          <el-form-item label="说明备注"><el-input v-model="dialog.note" type="textarea" :rows="3" placeholder="简单介绍你的设计思路或类似作品..." /></el-form-item>
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
      const activeTab = ref('all');

      async function load() {
        loading.value = true;
        try {
          const r = await window.__api.get('/designer/quotes?tab=' + activeTab.value);
          list.value = Array.isArray(r.data) ? r.data : [];
        } catch {}
        loading.value = false;
      }

      const statusLabel = { pending: '等待买家选择', accepted: '已被选中', cancelled: '已撤销' };
      const statusType = { pending: 'warning', accepted: 'success', cancelled: 'info' };

      async function cancel(row) {
        try {
          await window.ElementPlus.ElMessageBox.confirm('确定撤销此报价？', '提示', { type: 'warning' });
          await window.__api.post('/designer/quote/' + row.demandId + '/cancel');
          window.__toast('success', '报价已撤销');
          await load();
        } catch (e) {}
      }

      return { list, loading, activeTab, statusLabel, statusType, load, cancel };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>我的报价</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px">
          <el-radio-group v-model="activeTab" size="small" @change="load">
            <el-radio-button label="all">全部</el-radio-button>
            <el-radio-button label="pending">待买家选</el-radio-button>
            <el-radio-button label="accepted">已选中</el-radio-button>
            <el-radio-button label="cancelled">已撤销</el-radio-button>
          </el-radio-group>
          <div style="flex:1"></div>
          <el-button type="primary" size="small" @click="load" :loading="loading">刷新</el-button>
        </div>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column prop="demandId" label="需求ID" width="90" />
          <el-table-column label="需求内容" min-width="240">
            <template #default="{row}">
              <div>{{ row.demandTitle || row.designCategory || '-' }}</div>
              <div v-if="row.finalOrderNo" style="color:#10b981;font-size:12px">已生成订单：{{ row.finalOrderNo }}</div>
            </template>
          </el-table-column>
          <el-table-column label="报价" width="110">
            <template #default="{row}"><span style="color:#ef4444;font-weight:600">¥{{ row.quotePrice }}</span></template>
          </el-table-column>
          <el-table-column prop="note" label="备注" min-width="160" show-overflow-tooltip />
          <el-table-column label="状态" width="130">
            <template #default="{row}">
              <el-tag :type="statusType[row.bidStatus]" size="small">{{ statusLabel[row.bidStatus] || row.bidStatus }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="报价时间" width="180">
            <template #default="{row}">{{ row.createdAt || '-' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{row}">
              <el-button v-if="row.bidStatus === 'pending'" size="small" type="danger" plain @click="cancel(row)">撤销报价</el-button>
              <span v-else style="color:#9ca3af;font-size:12px">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    `,
  });

  // ---------- 4. 我的订单 ----------
  const OrdersPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);
      const activeTab = ref('all');

      async function load() {
        loading.value = true;
        try {
          const r = await window.__api.get('/designer/orders?tab=' + activeTab.value);
          list.value = Array.isArray(r.data) ? r.data : (r.data?.list || []);
        } catch {}
        loading.value = false;
      }

      const statusLabel = { accepted: '已接单', designing: '进行中', completed: '已交付', reviewed: '已评价', cancelled: '已取消' };
      const statusType = { accepted: '', designing: 'warning', completed: 'success', reviewed: 'success', cancelled: 'info' };

      return { list, loading, activeTab, statusLabel, statusType, load };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>我的订单</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px">
          <el-radio-group v-model="activeTab" size="small" @change="load">
            <el-radio-button label="all">全部</el-radio-button>
            <el-radio-button label="accepted">已接单</el-radio-button>
            <el-radio-button label="in_progress">进行中</el-radio-button>
            <el-radio-button label="completed">已交付</el-radio-button>
          </el-radio-group>
          <div style="flex:1"></div>
          <el-button type="primary" size="small" @click="load" :loading="loading">刷新</el-button>
        </div>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column prop="orderNo" label="订单号" width="140" />
          <el-table-column prop="title" label="设计需求" min-width="220">
            <template #default="{row}">{{ row.title || row.demandText?.slice(0, 40) || '-' }}</template>
          </el-table-column>
          <el-table-column label="金额" width="100">
            <template #default="{row}">¥{{ row.budget || row.amount || '-' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{row}">
              <el-tag :type="statusType[row.status]" size="small">{{ statusLabel[row.status] || row.statusText || row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="创建时间" width="180">
            <template #default="{row}">{{ row.createdAt || '-' }}</template>
          </el-table-column>
        </el-table>
      </div>
    `,
  });

  // ---------- 5. 作品集管理 ----------
  const PortfolioPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);
      const dialog = reactive({ show: false, edit: null, title: '', description: '', images: '', designCategory: '', year: new Date().getFullYear() });

      async function load() {
        loading.value = true;
        try {
          const r = await window.__api.get('/designer/portfolio');
          list.value = Array.isArray(r.data) ? r.data : (r.data?.list || []);
        } catch {}
        loading.value = false;
      }

      function openAdd() {
        Object.assign(dialog, { show: true, edit: null, title: '', description: '', images: '', designCategory: '', year: new Date().getFullYear() });
      }
      function openEdit(row) {
        Object.assign(dialog, { show: true, edit: row, title: row.title, description: row.description || '', images: Array.isArray(row.images) ? row.images.join(',') : (row.images || ''), designCategory: row.designCategory || '', year: row.year || new Date().getFullYear() });
      }

      async function save() {
        const payload = {
          title: dialog.title.trim(),
          description: dialog.description.trim(),
          designCategory: dialog.designCategory.trim(),
          year: Number(dialog.year),
          images: dialog.images.split(',').map(s => s.trim()).filter(Boolean),
        };
        if (!payload.title) return window.__toast('warning', '请填写作品标题');
        try {
          if (dialog.edit) {
            await window.__api.del('/designer/portfolio/' + dialog.edit.id);
            await window.__api.post('/designer/portfolio', payload);
            window.__toast('success', '已更新');
          } else {
            await window.__api.post('/designer/portfolio', payload);
            window.__toast('success', '已新增');
          }
          dialog.show = false;
          await load();
        } catch {}
      }

      async function del(row) {
        try {
          await window.ElementPlus.ElMessageBox.confirm('确定删除该作品？', '提示', { type: 'warning' });
          await window.__api.del('/designer/portfolio/' + row.id);
          window.__toast('success', '已删除');
          await load();
        } catch {}
      }

      return { list, loading, dialog, load, openAdd, openEdit, save, del };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>作品集管理</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px">
          <div style="flex:1"></div>
          <el-button type="primary" size="small" @click="openAdd">新增作品</el-button>
          <el-button size="small" @click="load" :loading="loading">刷新</el-button>
        </div>
        <div v-loading="loading">
          <div v-if="list.length" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px">
            <div v-for="item in list" :key="item.id" style="background:#f9fafb;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
              <div style="height:140px;background:linear-gradient(135deg,#60a5fa,#a78bfa);display:flex;align-items:center;justify-content:center;color:#fff;font-size:40px;font-weight:700">
                <template v-if="item.images?.[0]">
                  <el-image :src="item.images[0]" fit="cover" style="width:100%;height:100%" />
                </template>
                <template v-else>{{ item.title?.slice(0,1) || '?' }}</template>
              </div>
              <div style="padding:12px">
                <div style="font-weight:600">{{ item.title }}</div>
                <div style="color:#9ca3af;font-size:12px;margin-top:4px">{{ item.designCategory || '—' }} · {{ item.year || '—' }}</div>
                <div style="color:#6b7280;font-size:12px;margin-top:6px;line-height:1.4">{{ (item.description || '').slice(0, 60) }}{{ (item.description || '').length > 60 ? '…' : '' }}</div>
                <div style="display:flex;gap:6px;margin-top:10px">
                  <el-button size="small" @click="openEdit(item)">编辑</el-button>
                  <el-button size="small" type="danger" plain @click="del(item)">删除</el-button>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="empty">
            <div class="emoji">🎨</div>
            <div class="tip">还没有作品，快去新增一个吧</div>
          </div>
        </div>
      </div>

      <el-dialog v-model="dialog.show" :title="dialog.edit ? '编辑作品' : '新增作品'" width="520px">
        <el-form label-width="90px">
          <el-form-item label="作品标题"><el-input v-model="dialog.title" /></el-form-item>
          <el-form-item label="分类"><el-input v-model="dialog.designCategory" placeholder="如 logo / poster / banner" /></el-form-item>
          <el-form-item label="年份"><el-input-number v-model="dialog.year" :min="2000" :max="2099" /></el-form-item>
          <el-form-item label="描述"><el-input v-model="dialog.description" type="textarea" :rows="3" /></el-form-item>
          <el-form-item label="图片URL">
            <el-input v-model="dialog.images" type="textarea" :rows="2" placeholder="多个图片URL用英文逗号分隔" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialog.show = false">取消</el-button>
          <el-button type="primary" @click="save">保存</el-button>
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
            window.__api.get('/designer/earnings').catch(() => ({ data: null })),
            window.__api.get('/designer/withdraw-info').catch(() => ({ data: null })),
            window.__api.get('/designer/bank-cards').catch(() => ({ data: null })),
          ]);
          earnings.value = e.data;
          withdrawInfo.value = w.data;
          bankCards.value = Array.isArray(b.data) ? b.data : (b.data?.list || []);
        } catch {}
        loading.value = false;
      }

      async function doWithdraw() {
        try {
          await window.__api.post('/designer/withdraw', { amount: Number(dialog.amount) });
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

  // ---------- 7. 纠纷处理 ----------
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
          const r = await window.__api.get('/designer/disputes' + q);
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
          const r = await window.__api.get('/designer/disputes/' + row.id);
          detail.value = r.data;
        } catch { detailDialog.show = false; }
      }

      async function submitRespond() {
        if (!respondText.value?.trim()) return window.__toast('warning', '请输入响应内容');
        try {
          await window.__api.post('/designer/disputes/' + detailDialog.id + '/respond', { message: respondText.value.trim() });
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
              {{ m.role === 'buyer' ? '买家' : m.role === 'provider' ? '我(设计师)' : m.role === 'admin' ? '平台' : m.role }}
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

  // ---------- 8. 通知消息 ----------
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
  registerRole('designer', {
    defaultRoute: '/dashboard',
    menus: [
      { path: '/dashboard',  label: '工作台概览', icon: '📊', component: DesignerDash },
      { path: '/hall',       label: '抢单大厅',   icon: '🔥', component: HallPage },
      { path: '/quotes',     label: '我的报价',   icon: '📋', component: QuotesPage },
      { path: '/orders',     label: '我的订单',   icon: '🎨', component: OrdersPage },
      { path: '/portfolio',  label: '作品集',     icon: '💼', component: PortfolioPage },
      { path: '/finance',    label: '财务中心',   icon: '💰', component: FinancePage },
      { path: '/disputes',  label: '纠纷处理',   icon: '⚠️', component: DisputesPage },
      { path: '/notifications', label: '通知消息', icon: '🔔', component: NotificationsPage },
    ],
  });
})();
