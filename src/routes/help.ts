// ============================================================================
// 🆘 Help Routes — /api/help/*（帮助中心 FAQ）
// GET    /help/categories    帮助分类
// GET    /help/faq           FAQ 列表
// GET    /help/faq/:id       单个 FAQ 详情
// ============================================================================
import { Router } from 'express';
import { ok, log } from '../middleware/auth';

const router = Router();

router.get('/categories', (_req, res) => {
  const list = [
    { id: 'c1', name: '购物问题', icon: '🛒', count: 12 },
    { id: 'c2', name: '订单问题', icon: '📦', count: 18 },
    { id: 'c3', name: '设计定制', icon: '🎨', count: 15 },
    { id: 'c4', name: '安装服务', icon: '🔧', count: 14 },
    { id: 'c5', name: '账户问题', icon: '👤', count: 8 },
    { id: 'c6', name: '发票问题', icon: '🧾', count: 6 },
    { id: 'c7', name: '联系客服', icon: '📞', count: 1 },
  ];
  ok(res, { list });
});

router.get('/faq', (_req, res) => {
  const list = [
    {
      id: 'f1',
      categoryId: 'c1',
      question: '怎么搜索和筛选商品？',
      answer: '首页顶部点击搜索框，输入关键词后按回车。也可以在分类页按品类筛选。',
      hot: true,
    },
    {
      id: 'f2',
      categoryId: 'c1',
      question: '商品的规格怎么选？',
      answer: '进入商品详情页后，点击「选择规格」按钮，选好规格后加入购物车或直接下单。',
      hot: true,
    },
    {
      id: 'f3',
      categoryId: 'c2',
      question: '怎么查看订单状态？',
      answer: '底部 TabBar → 「订单」，可以按 Tab 切换待付款/待发货/待收货/已完成。',
      hot: true,
    },
    {
      id: 'f4',
      categoryId: 'c2',
      question: '订单可以取消吗？',
      answer: '待付款状态可以随时取消；待发货状态需联系客服；已发货后请走退款流程。',
    },
    {
      id: 'f5',
      categoryId: 'c3',
      question: '怎么发布设计需求？',
      answer: '首页 → 「我要发布」→ 「设计定制」，填写需求描述和预算即可。设计师会在大厅接单报价。',
      hot: true,
    },
    {
      id: 'f6',
      categoryId: 'c4',
      question: '怎么发布安装需求？',
      answer: '首页 → 「我要发布」→ 「安装服务」，填写地址、时间和需求详情即可。师傅会来报价。',
      hot: true,
    },
    {
      id: 'f7',
      categoryId: 'c5',
      question: '账号可以切换身份吗？',
      answer:
        '可以。「我的」→ 「角色身份」里可以申请成为设计师/安装师傅/供应商，通过审核后可切换。',
    },
    {
      id: 'f8',
      categoryId: 'c6',
      question: '发票怎么申请？',
      answer: '订单完成后进入订单详情 → 申请发票。支持普票和专票，电子发票 1-3 个工作日开出。',
    },
  ];
  ok(res, { list });
});

router.get('/faq/:id', (req, res) => {
  ok(res, { id: req.params.id, question: '示例问题', answer: '这是一个静态示例答案。' });
});

export default router;
