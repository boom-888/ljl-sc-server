// ============================================================================
// 🛠️ Service Routes — /api/service/*（服务大厅 + 详情）
// GET    /service/list          服务大厅（安装+设计）
// GET    /service/:type         某类服务的详情列表
// ============================================================================
import { Router } from 'express';
import { ok, log } from '../middleware/auth';

const router = Router();

// — GET /service/list — 公开路由，不需要登录
router.get('/list', (req, res) => {
  const list = [
    // 安装服务类
    {
      serviceType: 'install',
      serviceKey: 'install-poster',
      name: '喷绘写真安装',
      category: '安装服务',
      icon: '🏗️',
      startPrice: 30,
      unit: '元/㎡',
      score: 4.8,
      orders: 1280,
      skill: ['户外', '高空', '玻璃'],
    },
    {
      serviceType: 'install',
      serviceKey: 'install-glow',
      name: '发光字安装',
      category: '安装服务',
      icon: '💡',
      startPrice: 50,
      unit: '元/字',
      score: 4.9,
      orders: 860,
      skill: ['门头', 'LED', '不锈钢'],
    },
    {
      serviceType: 'install',
      serviceKey: 'install-lightbox',
      name: '灯箱安装',
      category: '安装服务',
      icon: '🖼️',
      startPrice: 40,
      unit: '元/个',
      score: 4.7,
      orders: 520,
      skill: ['超薄', '拉布', '磁吸'],
    },
    {
      serviceType: 'install',
      serviceKey: 'install-sign',
      name: '标识标牌安装',
      category: '安装服务',
      icon: '🪧',
      startPrice: 80,
      unit: '元/个',
      score: 4.8,
      orders: 410,
      skill: ['导向牌', '立牌', '壁挂'],
    },
    {
      serviceType: 'install',
      serviceKey: 'install-acrylic',
      name: '亚克力安装',
      category: '安装服务',
      icon: '✨',
      startPrice: 35,
      unit: '元/㎡',
      score: 4.6,
      orders: 340,
      skill: ['水晶字', 'UV 打印'],
    },
    {
      serviceType: 'install',
      serviceKey: 'install-wall',
      name: '文化墙安装',
      category: '安装服务',
      icon: '🎨',
      startPrice: 200,
      unit: '元/项',
      score: 4.9,
      orders: 280,
      skill: ['UV 板', '墙面打底'],
    },
    // 设计服务类
    {
      serviceType: 'design',
      serviceKey: 'design-logo',
      name: 'Logo 设计',
      category: '设计服务',
      icon: '🎯',
      startPrice: 500,
      unit: '元/款',
      score: 4.9,
      orders: 2100,
      skill: ['原创', 'AI 辅助', '3 次修改'],
    },
    {
      serviceType: 'design',
      serviceKey: 'design-vi',
      name: 'VI 品牌识别',
      category: '设计服务',
      icon: '📐',
      startPrice: 2000,
      unit: '元/套',
      score: 4.8,
      orders: 560,
      skill: ['Logo+名片+物料', '全套规范'],
    },
    {
      serviceType: 'design',
      serviceKey: 'design-poster',
      name: '海报设计',
      category: '设计服务',
      icon: '🖼️',
      startPrice: 200,
      unit: '元/张',
      score: 4.7,
      orders: 1850,
      skill: ['活动', '商业', '电商'],
    },
    {
      serviceType: 'design',
      serviceKey: 'design-uv',
      name: 'UV 打印设计',
      category: '设计服务',
      icon: '🖨️',
      startPrice: 300,
      unit: '元/图',
      score: 4.6,
      orders: 780,
      skill: ['户外', '高清', '吸塑'],
    },
  ];
  log(`service-list count=${list.length}`);
  ok(res, {
    installServices: list.filter((s) => s.serviceType === 'install'),
    designServices: list.filter((s) => s.serviceType === 'design'),
  });
});

// — GET /service/:type — 某类服务下的师傅/设计师列表
router.get('/:type', (req, res) => {
  const { type } = req.params;
  const service = [
    {
      id: 'i1',
      name: '李师傅',
      serviceType: type,
      score: 4.9,
      completed: 520,
      avatar: '',
      tag: '5 年老技师',
    },
    {
      id: 'i2',
      name: '王师傅',
      serviceType: type,
      score: 4.8,
      completed: 380,
      avatar: '',
      tag: '高空作业资质',
    },
    {
      id: 'i3',
      name: '张师傅',
      serviceType: type,
      score: 4.7,
      completed: 260,
      avatar: '',
      tag: '亚克力专家',
    },
    {
      id: 'i4',
      name: '陈师傅',
      serviceType: type,
      score: 4.8,
      completed: 410,
      avatar: '',
      tag: '10 年老团队',
    },
  ];
  ok(res, { list: service, total: service.length });
});

export default router;
