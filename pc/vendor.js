/* ============================================================================
 * 供应商工作台 —— /pc/vendor.js
 * registerRole('vendor', { menus, defaultRoute })
 * ==========================================================================*/
(function () {
  const { defineComponent, ref, reactive, computed, onMounted } = Vue;

  // ---------- 0. 通用小工具 ----------
  const _tag = (statusMap, val, def = 'info') => statusMap[val] || def;
  const _fmt = (v) => (v == null ? '-' : v);

  // ---------- 1. Dashboard（用框架 makeDashPage） ----------
  const VendorDash = makeDashPage('vendor', {
    cards: [
      { key: 'todayOrders',   label: '今日订单',   theme: 'blue'   },
      { key: 'pendingShip',   label: '待发货',     theme: 'orange' },
      { key: 'salesTotal',    label: '总销售额',   theme: 'green'  },
      { key: 'onSaleProducts',label: '在售商品',  theme: 'purple' },
      { key: 'outOfStock',    label: '缺货商品',   theme: 'red'    },
      { key: 'withdrawInfo.available', label: '可用余额', theme: 'blue', subKey: 'withdrawInfo.frozen' },
    ],
    todos: true,
  });

  // ---------- 2. 商品管理 ----------
  const ProductsPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);
      const activeTab = ref('all'); // all / on_sale / out_of_stock
      const stockDialog = reactive({ show: false, id: null, name: '', delta: 10, stock: null, mode: 'delta' });
      const addDialog = reactive({
        show: false,
        base: 99,               // 基础价（必填）
        form: {
          name: '', cover: '', price: 99, stock: 10, categoryId: null,
          detail: '', status: 1, productType: 'ready',
        },
        materials: [            // 材质行
          { key: 'aluminum', name: '铝合金（1.5mm）', surcharge: 0 },
        ],
        crafts: [               // 工艺列
          { key: 'plain', name: '光面', surcharge: 0 },
        ],
        useComboPrices: false,  // 是否启用组合定价覆盖
      });

      // 实时计算：基础价 + material surcharge + craft surcharge，或 comboPrices 覆盖
      function computeComboPrice(mKey, cKey) {
        if (addDialog.useComboPrices) {
          return addDialog.base; // 组合模式下 base 显示为"参考价"，矩阵格单独填
        }
        const m = addDialog.materials.find(x => x.key === mKey);
        const c = addDialog.crafts.find(x => x.key === cKey);
        return addDialog.base + (m?.surcharge ?? 0) + (c?.surcharge ?? 0);
      }

      function addMaterial() {
        const idx = addDialog.materials.length + 1;
        addDialog.materials.push({
          key: 'm' + idx, name: '新材质 ' + idx, surcharge: 0,
        });
      }
      function removeMaterial(i) {
        if (addDialog.materials.length > 1) addDialog.materials.splice(i, 1);
      }
      function addCraft() {
        const idx = addDialog.crafts.length + 1;
        addDialog.crafts.push({
          key: 'c' + idx, name: '新工艺 ' + idx, surcharge: 0,
        });
      }
      function removeCraft(i) {
        if (addDialog.crafts.length > 1) addDialog.crafts.splice(i, 1);
      }

      const filtered = computed(() => {
        if (activeTab.value === 'on_sale') return list.value.filter(x => x.status === 'on_sale' || x.status === 1);
        if (activeTab.value === 'out_of_stock') return list.value.filter(x => Number(x.stock) <= 0);
        return list.value;
      });

      const statusMap = { on_sale: { text: '在售', type: 'success' }, off_shelf: { text: '已下架', type: 'info' } };

      async function load() {
        loading.value = true;
        try {
          const r = await window.__api.get('/vendor/products');
          // 后端返回 { list:[], total, page } 分页对象 — 兼容直接数组和分页两种
          list.value = (r.data?.list ?? r.data) || [];
        } catch {}
        loading.value = false;
      }

      function openStock(row) {
        stockDialog.show = true;
        stockDialog.id = row.id;
        stockDialog.name = row.name || row.title || row.productName || '商品';
        stockDialog.stock = Number(row.stock || 0);
        stockDialog.delta = 10;
        stockDialog.mode = 'delta';
      }

      async function submitStock() {
        const payload = stockDialog.mode === 'delta'
          ? { delta: Number(stockDialog.delta || 0) }
          : { stock: Number(stockDialog.stock || 0) };
        try {
          await window.__api.patch('/vendor/products/' + stockDialog.id + '/stock', payload);
          window.__toast('success', '库存更新成功');
          stockDialog.show = false;
          await load();
        } catch {}
      }

      function openAdd() {
        addDialog.base = 99;
        addDialog.form = {
          name: '', cover: '', price: 99, stock: 10, categoryId: null,
          detail: '', status: 1, productType: 'ready',
        };
        // 给默认 2 材质 × 2 工艺示例，方便供应商直观感受
        addDialog.materials = [
          { key: 'aluminum', name: '铝合金（1.5mm）', surcharge: 0 },
          { key: 'stainless', name: '不锈钢（1.2mm）', surcharge: 45 },
        ];
        addDialog.crafts = [
          { key: 'plain', name: '光面', surcharge: 0 },
          { key: 'brushed', name: '拉丝', surcharge: 25 },
        ];
        addDialog.useComboPrices = false;
        addDialog.show = true;
      }

      async function submitAdd() {
        const f = addDialog.form;
        if (!f.name.trim()) { window.__toast('warning', '商品名称必填'); return; }
        if (!addDialog.base || addDialog.base <= 0) { window.__toast('warning', '基础价必须大于 0'); return; }
        try {
          const payload = {
            name: f.name.trim(),
            price: Number(addDialog.base),
            stock: Number(f.stock || 0),
            categoryId: f.categoryId || null,
            detail: f.detail,
            status: f.status === 1 ? 'on' : 'off',
            productType: f.productType,
            materials: addDialog.materials,
            crafts: addDialog.crafts,
            // 启用组合定价时，把 base 作为参考价；不启用则 comboPrices 不传
          };
          await window.__api.post('/vendor/products', payload);
          window.__toast('success', '商品已创建（含多材质/多工艺配置）');
          addDialog.show = false;
          await load();
        } catch {}
      }

      return {
        list, loading, activeTab, filtered, statusMap, stockDialog, addDialog,
        load, openStock, submitStock, openAdd, submitAdd,
        computeComboPrice, addMaterial, removeMaterial, addCraft, removeCraft,
      };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>商品管理</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px">
          <el-radio-group v-model="activeTab" size="small">
            <el-radio-button label="all">全部</el-radio-button>
            <el-radio-button label="on_sale">在售</el-radio-button>
            <el-radio-button label="out_of_stock">缺货</el-radio-button>
          </el-radio-group>
          <div style="flex:1"></div>
          <el-button type="primary" size="small" @click="openAdd">+ 新增商品</el-button>
          <el-button size="small" @click="load" :loading="loading">刷新</el-button>
        </div>
        <el-table :data="filtered" v-loading="loading" stripe size="small">
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column label="商品名称" min-width="200">
            <template #default="{row}">{{ row.name || row.title || row.productName || '-' }}</template>
          </el-table-column>
          <el-table-column label="价格" width="110">
            <template #default="{row}">¥{{ row.price ?? row.salePrice ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="库存" width="90">
            <template #default="{row}">
              <el-tag :type="Number(row.stock) <= 0 ? 'danger' : 'success'" size="small">
                {{ row.stock ?? '-' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{row}">
              <el-tag v-if="row.status === 'on_sale' || row.status === 1" type="success" size="small">在售</el-tag>
              <el-tag v-else type="info" size="small">已下架</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{row}">
              <el-button size="small" @click="openStock(row)">调整库存</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <el-dialog v-model="stockDialog.show" :title="'调整库存 - ' + stockDialog.name" width="420px">
        <div style="margin-bottom:12px">
          <el-radio-group v-model="stockDialog.mode">
            <el-radio-button label="delta">增减值</el-radio-button>
            <el-radio-button label="stock">绝对值</el-radio-button>
          </el-radio-group>
        </div>
        <div v-if="stockDialog.mode === 'delta'" style="display:flex;align-items:center;gap:10px">
          当前库存 {{ stockDialog.stock }}
          <el-input-number v-model="stockDialog.delta" :step="5" />
        </div>
        <div v-else>
          <el-input-number v-model="stockDialog.stock" :min="0" />
        </div>
        <template #footer>
          <el-button @click="stockDialog.show = false">取消</el-button>
          <el-button type="primary" @click="submitStock">确认</el-button>
        </template>
      </el-dialog>

      <el-dialog v-model="addDialog.show" title="新增商品 · 多材质多工艺定价" width="820px">
        <el-form label-width="90px">
          <div style="display:flex;gap:16px">
            <div style="flex:1;display:flex;flex-direction:column;gap:12px">
              <el-form-item label="商品名称"><el-input v-model="addDialog.form.name" placeholder="必填，如发光字招牌" /></el-form-item>
              <el-form-item label="基础价">
                <el-input-number v-model="addDialog.base" :min="0" :precision="2" :step="10" style="width:180px" />
                <span style="margin-left:8px;color:#888;font-size:12px">每款 SKU 的基准（+材质/工艺附加）</span>
              </el-form-item>
              <el-form-item label="库存">
                <el-input-number v-model="addDialog.form.stock" :min="0" :step="10" style="width:180px" />
              </el-form-item>
              <el-form-item label="分类ID">
                <el-input-number v-model="addDialog.form.categoryId" :min="1" placeholder="选填" style="width:180px" />
              </el-form-item>
              <el-form-item label="状态">
                <el-switch v-model="addDialog.form.status" :active-value="1" :inactive-value="0" active-text="在售" inactive-text="已下架" />
              </el-form-item>
              <el-form-item label="商品详情">
                <el-input v-model="addDialog.form.detail" type="textarea" :rows="2" placeholder="选填" />
              </el-form-item>
            </div>
          </div>
        </el-form>

        <!-- ========== 多材质编辑器 ========== -->
        <div style="margin-top:10px;border-top:1px solid #eee;padding-top:14px">
          <div style="font-weight:600;margin-bottom:8px">📦 材质选项（行） — 可增减附加价</div>
          <el-table :data="addDialog.materials" size="small" border>
            <el-table-column label="#" width="40" type="index" />
            <el-table-column label="材质 Key" width="140">
              <template #default="{row}"><el-input v-model="row.key" size="small" /></template>
            </el-table-column>
            <el-table-column label="名称">
              <template #default="{row}"><el-input v-model="row.name" size="small" /></template>
            </el-table-column>
            <el-table-column label="附加价(元)" width="130" align="right">
              <template #default="{row}"><el-input-number v-model="row.surcharge" size="small" :step="10" :precision="2" style="width:100px" /></template>
            </el-table-column>
            <el-table-column label="操作" width="60" align="center">
              <template #default="{ $index }">
                <el-button size="small" link type="danger" @click="removeMaterial($index)" :disabled="addDialog.materials.length<=1">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-button size="small" @click="addMaterial" style="margin-top:6px">+ 添加材质</el-button>
        </div>

        <!-- ========== 多工艺编辑器 ========== -->
        <div style="margin-top:16px;border-top:1px solid #eee;padding-top:14px">
          <div style="font-weight:600;margin-bottom:8px">🎨 工艺选项（列） — 可增减附加价</div>
          <el-table :data="addDialog.crafts" size="small" border>
            <el-table-column label="#" width="40" type="index" />
            <el-table-column label="工艺 Key" width="140">
              <template #default="{row}"><el-input v-model="row.key" size="small" /></template>
            </el-table-column>
            <el-table-column label="名称">
              <template #default="{row}"><el-input v-model="row.name" size="small" /></template>
            </el-table-column>
            <el-table-column label="附加价(元)" width="130" align="right">
              <template #default="{row}"><el-input-number v-model="row.surcharge" size="small" :step="10" :precision="2" style="width:100px" /></template>
            </el-table-column>
            <el-table-column label="操作" width="60" align="center">
              <template #default="{ $index }">
                <el-button size="small" link type="danger" @click="removeCraft($index)" :disabled="addDialog.crafts.length<=1">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-button size="small" @click="addCraft" style="margin-top:6px">+ 添加工艺</el-button>
        </div>

        <!-- ========== 实时价格矩阵预览 ========== -->
        <div style="margin-top:18px;border-top:2px solid #409eff;padding-top:14px;background:#fafbfc;border-radius:6px">
          <div style="font-weight:600;margin-bottom:10px;color:#409eff">💰 实时价格矩阵（基础价 ¥{{ addDialog.base }} + 材质附加 + 工艺附加）</div>
          <el-table :data="addDialog.materials" size="small" border :header-cell-style="{background:'#ecf5ff'}">
            <el-table-column label="材质 \\ 工艺" width="180" fixed>
              <template #default="{row}">
                <b>{{ row.name }}</b>
                <div style="font-size:11px;color:#888">基础 {{ addDialog.base }} + 材质 {{ row.surcharge >= 0 ? '+' : '' }}{{ row.surcharge }}</div>
              </template>
            </el-table-column>
            <el-table-column
              v-for="c in addDialog.crafts"
              :key="c.key"
              :label="c.name + ' (' + (c.surcharge>=0?'+':'') + c.surcharge + ')'"
              align="center"
            >
              <template #default="{row}">
                <el-tag type="success" effect="light" size="default" style="font-size:14px;font-weight:600">
                  ¥{{ computeComboPrice(row.key, c.key).toFixed(2) }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <template #footer>
          <el-button @click="addDialog.show = false">取消</el-button>
          <el-button type="primary" @click="submitAdd">创建商品</el-button>
        </template>
      </el-dialog>
    `,
  });

  // ---------- 3. 订单管理 ----------
  const OrdersPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);
      const activeTab = ref('all');
      const tabMap = { all: '', pending_ship: 'pending_ship', shipped: 'shipped', completed: 'completed' };

      async function load() {
        loading.value = true;
        try {
          const q = activeTab.value ? '?tab=' + activeTab.value : '';
          const r = await window.__api.get('/vendor/orders' + q);
          list.value = Array.isArray(r.data) ? r.data : (r.data?.list || []);
        } catch {}
        loading.value = false;
      }

      const statusLabel = { pending_ship: '待发货', shipped: '已发货', completed: '已完成', cancelled: '已取消', reviewing: '评价中' };

      async function markDone(row) {
        try {
          await window.__api.post('/vendor/orders/' + row.id + '/complete', {});
          window.__toast('success', '已标记完成');
          await load();
        } catch {}
      }

      return { list, loading, activeTab, statusLabel, load, markDone };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>订单管理</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px">
          <el-radio-group v-model="activeTab" size="small" @change="load">
            <el-radio-button label="all">全部</el-radio-button>
            <el-radio-button label="pending_ship">待发货</el-radio-button>
            <el-radio-button label="shipped">已发货</el-radio-button>
            <el-radio-button label="completed">已完成</el-radio-button>
          </el-radio-group>
          <div style="flex:1"></div>
          <el-button type="primary" size="small" @click="load" :loading="loading">刷新</el-button>
        </div>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column prop="id" label="订单号" width="110" />
          <el-table-column label="商品" min-width="200">
            <template #default="{row}">{{ row.productName || row.title || row.name || '-' }}</template>
          </el-table-column>
          <el-table-column label="金额" width="100">
            <template #default="{row}">¥{{ row.amount ?? row.totalAmount ?? row.price ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{row}">
              <el-tag :type="row.status==='pending_ship' ? 'warning' : row.status==='shipped' ? '' : row.status==='completed' ? 'success' : 'info'" size="small">
                {{ statusLabel[row.status] || row.status || '-' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="下单时间" width="180">
            <template #default="{row}">{{ row.createdAt || '-' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{row}">
              <el-button v-if="row.status==='shipped'" size="small" type="success" @click="markDone(row)">标记已完成</el-button>
              <span v-else style="color:#9ca3af;font-size:12px">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    `,
  });

  // ---------- 4. 财务中心 ----------
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
            window.__api.get('/vendor/earnings').catch(() => ({ data: null })),
            window.__api.get('/vendor/withdraw-info').catch(() => ({ data: null })),
            window.__api.get('/vendor/bank-cards').catch(() => ({ data: null })),
          ]);
          earnings.value = e.data;
          withdrawInfo.value = w.data;
          bankCards.value = Array.isArray(b.data) ? b.data : (b.data?.list || []);
        } catch {}
        loading.value = false;
      }

      async function doWithdraw() {
        try {
          await window.__api.post('/vendor/withdraw', { amount: Number(dialog.amount) });
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
            <div class="dash-card green">
              <div class="label">可提现余额</div>
              <div class="value">¥{{ earnings.available ?? 0 }}</div>
            </div>
            <div class="dash-card orange">
              <div class="label">冻结金额</div>
              <div class="value">¥{{ earnings.frozen ?? 0 }}</div>
            </div>
            <div class="dash-card">
              <div class="label">累计毛收入</div>
              <div class="value">¥{{ earnings.grossTotal ?? 0 }}</div>
            </div>
            <div class="dash-card purple">
              <div class="label">平台抽佣</div>
              <div class="value">¥{{ earnings.commissionTotal ?? 0 }}</div>
            </div>
          </div>
          <div style="margin-top:12px">
            <el-button type="primary" @click="dialog.show = true">发起提现</el-button>
          </div>
        </div>

        <div class="page-card">
          <h2>绑定的银行卡</h2>
          <el-table :data="bankCards" stripe size="small" empty-text="暂无绑定银行卡">
            <el-table-column label="银行" prop="bankName" />
            <el-table-column label="卡号">
              <template #default="{row}">{{ row.cardNoMasked || row.cardNo || '-' }}</template>
            </el-table-column>
            <el-table-column label="持卡人">
              <template #default="{row}">{{ row.accountName || '-' }}</template>
            </el-table-column>
            <el-table-column label="默认" width="80">
              <template #default="{row}">
                <el-tag v-if="row.isDefault" type="success" size="small">默认</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <div class="page-card" v-if="withdrawInfo?.recent?.length">
          <h2>最近提现</h2>
          <el-table :data="withdrawInfo.recent" stripe size="small">
            <el-table-column prop="withdrawNo" label="提现单号" />
            <el-table-column label="金额">
              <template #default="{row}">¥{{ row.amount }}</template>
            </el-table-column>
            <el-table-column label="银行">
              <template #default="{row}">{{ row.bankName }}</template>
            </el-table-column>
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
        <el-form-item label="提现金额">
          <el-input-number v-model="dialog.amount" :min="1" />
        </el-form-item>
        <template #footer>
          <el-button @click="dialog.show = false">取消</el-button>
          <el-button type="primary" @click="doWithdraw">提交</el-button>
        </template>
      </el-dialog>
    `,
  });

  // ---------- 5. 配送区域 ----------
  const DeliveryPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);
      const dialog = reactive({
        show: false, edit: null,
        province: '', city: '', district: '', address: '', fee: 0,
      });

      async function load() {
        loading.value = true;
        try {
          const r = await window.__api.get('/vendor/delivery-areas');
          list.value = r.data || [];
        } catch {}
        loading.value = false;
      }

      function openAdd() {
        Object.assign(dialog, { show: true, edit: null, province: '', city: '', district: '', address: '', fee: 0 });
      }
      function openEdit(row) {
        Object.assign(dialog, { show: true, edit: row, province: row.province || '', city: row.city || '', district: row.district || '', address: row.address || '', fee: Number(row.fee || 0) });
      }

      async function save() {
        const payload = { province: dialog.province, city: dialog.city, district: dialog.district, address: dialog.address, fee: dialog.fee };
        try {
          if (dialog.edit) {
            await window.__api.put('/vendor/delivery-areas/' + dialog.edit.id, payload);
            window.__toast('success', '已更新');
          } else {
            await window.__api.post('/vendor/delivery-areas', payload);
            window.__toast('success', '已新增');
          }
          dialog.show = false;
          await load();
        } catch {}
      }

      async function del(row) {
        try {
          await window.ElementPlus.ElMessageBox.confirm('确定删除该配送区域？', '提示', { type: 'warning' });
          await window.__api.del('/vendor/delivery-areas/' + row.id);
          window.__toast('success', '已删除');
          await load();
        } catch (e) { /* 用户取消或后端报错 */ }
      }

      return { list, loading, dialog, load, openAdd, openEdit, save, del };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>配送区域管理</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px">
          <div style="flex:1"></div>
          <el-button type="primary" size="small" @click="openAdd">新增配送区</el-button>
          <el-button size="small" @click="load" :loading="loading">刷新</el-button>
        </div>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column label="省/市/区">
            <template #default="{row}">{{ row.province }} / {{ row.city }} / {{ row.district }}</template>
          </el-table-column>
          <el-table-column prop="address" label="详细地址" min-width="200" />
          <el-table-column label="配送费" width="100">
            <template #default="{row}">¥{{ row.fee ?? 0 }}</template>
          </el-table-column>
          <el-table-column label="操作" width="160" fixed="right">
            <template #default="{row}">
              <el-button size="small" @click="openEdit(row)">编辑</el-button>
              <el-button size="small" type="danger" plain @click="del(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <el-dialog v-model="dialog.show" :title="dialog.edit ? '编辑配送区' : '新增配送区'" width="480px">
        <el-form label-width="80px">
          <el-form-item label="省"><el-input v-model="dialog.province" placeholder="如 广东省" /></el-form-item>
          <el-form-item label="市"><el-input v-model="dialog.city" placeholder="如 深圳市" /></el-form-item>
          <el-form-item label="区"><el-input v-model="dialog.district" placeholder="如 南山区" /></el-form-item>
          <el-form-item label="详细地址"><el-input v-model="dialog.address" type="textarea" :rows="2" /></el-form-item>
          <el-form-item label="配送费"><el-input-number v-model="dialog.fee" :min="0" /></el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialog.show = false">取消</el-button>
          <el-button type="primary" @click="save">保存</el-button>
        </template>
      </el-dialog>
    `,
  });

  // ---------- 6. 评价管理 ----------
  const ReviewsPage = defineComponent({
    setup() {
      const list = ref([]);
      const loading = ref(false);
      async function load() {
        loading.value = true;
        try {
          const r = await window.__api.get('/reviews/mine?role=vendor');
          list.value = Array.isArray(r.data) ? r.data : (r.data?.list || []);
        } catch {}
        loading.value = false;
      }
      return { list, loading, load };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>收到的评价</h2>
        <el-table :data="list" v-loading="loading" stripe size="small">
          <el-table-column label="评分" width="90">
            <template #default="{row}">
              <el-rate :model-value="Number(row.rating || 0)" disabled size="small" />
            </template>
          </el-table-column>
          <el-table-column prop="comment" label="评价内容" min-width="260" />
          <el-table-column prop="orderNo" label="订单号" width="160" />
          <el-table-column prop="createdAt" label="评价时间" width="180" />
        </el-table>
      </div>
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
          const r = await window.__api.get('/vendor/disputes' + q);
          list.value = Array.isArray(r.data) ? r.data : (r.data?.list || []);
        } catch {}
        loading.value = false;
      }

      const statusLabel = { pending: '待处理', processing: '进行中', resolved: '已解决', rejected: '已驳回' };
      const statusType = { pending: 'danger', processing: 'warning', resolved: 'success' };

      async function openDetail(row) {
        detailDialog.show = true;
        respondText.value = '';
        try {
          const r = await window.__api.get('/vendor/disputes/' + row.id);
          detail.value = r.data;
        } catch { detailDialog.show = false; }
      }

      async function submitRespond() {
        if (!respondText.value?.trim()) return window.__toast('warning', '请输入响应内容');
        try {
          await window.__api.post('/vendor/disputes/' + detailDialog.id + '/respond', { message: respondText.value.trim() });
          window.__toast('success', '响应已提交');
          respondText.value = '';
          await load();
          await openDetail(list.value.find(x => x.id === detailDialog.id) || {});
        } catch {}
      }

      // 修正 openDetail 保存 id
      function _openDetail(row) { detailDialog.id = row.id; openDetail(row); }

      return { list, loading, activeTab, statusLabel, statusType, detail, respondText, detailDialog, load, openDetail: _openDetail, submitRespond };
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
          <el-table-column label="索赔金额" width="110">
            <template #default="{row}">¥{{ row.claimAmount ?? 0 }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{row}">
              <el-tag :type="statusType[row.status] || 'info'" size="small">{{ statusLabel[row.status] || row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="100">
            <template #default="{row}">
              <el-button size="small" @click="openDetail(row)">详情</el-button>
            </template>
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
              {{ m.role === 'buyer' ? '买家' : m.role === 'provider' ? '我(供应商)' : m.role === 'admin' ? '平台' : m.role }}
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

  // ---------- 8. 店铺资料（占位） ----------
  const ProfilePage = defineComponent({
    setup() {
      const data = ref(null);
      async function load() {
        try {
          const r = await window.__api.get('/vendor/profile');
          data.value = r.data;
        } catch {}
      }
      return { data, load };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>店铺资料</h2>
        <div v-if="data" style="line-height:2">
          <div>店铺名：{{ data.nickname || data.shopName || data.storeName || '-' }}</div>
          <div>联系电话：{{ data.phone || '-' }}</div>
          <div>服务区域：{{ (data.serviceAreas || []).map(s => (s.province||'') + (s.city||'') + (s.district||'')).join('、') || '-' }}</div>
          <div>累计订单：{{ data.stats?.totalOrders ?? 0 }} 单 · 商品数 {{ data.stats?.totalProducts ?? 0 }}</div>
          <div style="margin-top:12px;color:#9ca3af;font-size:12px">更多编辑功能开发中…</div>
        </div>
        <div v-else class="loading">加载中…</div>
      </div>
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
        try {
          await window.__api.markRead();
          window.__toast('success', '已全部标为已读');
          await load();
        } catch {}
      }
      return { list, unread, loading, load, markAll };
    },
    mounted() { this.load(); },
    template: `
      <div class="page-card">
        <h2>通知消息 <span v-if="unread" style="margin-left:8px;font-size:12px;background:#ef4444;color:#fff;border-radius:10px;padding:1px 8px">{{ unread }} 条未读</span></h2>
        <div style="margin-bottom:12px">
          <el-button size="small" @click="markAll" :disabled="!unread">全部标为已读</el-button>
        </div>
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
  registerRole('vendor', {
    defaultRoute: '/dashboard',
    menus: [
      { path: '/dashboard',        label: '工作台概览', icon: '📊', component: VendorDash },
      { path: '/products',         label: '商品管理',   icon: '📦', component: ProductsPage },
      { path: '/orders',           label: '订单管理',   icon: '🚚', component: OrdersPage },
      { path: '/finance',          label: '财务中心',   icon: '💰', component: FinancePage },
      { path: '/delivery-areas',   label: '配送区域',   icon: '📍', component: DeliveryPage },
      { path: '/reviews',          label: '评价管理',   icon: '📝', component: ReviewsPage },
      { path: '/disputes',         label: '纠纷处理',   icon: '⚠️', component: DisputesPage },
      { path: '/profile',          label: '店铺资料',   icon: '👤', component: ProfilePage },
      { path: '/notifications',    label: '通知消息',   icon: '🔔', component: NotificationsPage },
    ],
  });
})();
