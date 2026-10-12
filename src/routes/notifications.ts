// ============================================================================
// Notifications Routes — /api/notifications/*（站内通知）
// 数据源优先级：
//   1. NotificationsEntity（理想数据源，事件驱动时同步写入）
//   2. PushLogEntity fallback（从 push_logs 聚合，前端可读化 eventType）
// ============================================================================
import { Router, type Response } from 'express';
import { getDataSource } from '../db-manager';
import { requireAuth, ok, fail, badRequest, serverError, log, AuthedRequest } from '../middleware/auth';
import { NotificationsEntity, PushLogEntity } from '../entities';

const router = Router();

// ============================================================================
// GET /api/notifications — 通知列表（按时间倒序 + 分页）
// ============================================================================
router.get('/', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

  const ds = getDataSource();
  if (!ds?.isInitialized) {
    return ok(res, { list: [], pagination: { page, pageSize, total: 0 } });
  }

  try {
    const notifRepo = ds.getRepository(NotificationsEntity);
    const [list, total] = await notifRepo
      .createQueryBuilder('n')
      .where('n.userId = :uid', { uid: userId })
      .orderBy('n.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    // 如果 NotificationsEntity 里有数据，直接返回
    if (list.length > 0 || total > 0) {
      return ok(res, {
        list: list.map((n: any) => ({
          id: Number(n.id),
          type: n.type,
          title: n.title,
          content: n.content,
          isRead: Number(n.isRead) === 1,
          createdAt: n.createdAt,
          meta: n.meta || null,
        })),
        pagination: { page, pageSize, total },
      });
    }

    // — Fallback：从 push_logs 聚合最近 30 条 —
    // 前端可读化：eventType → title/content
    const logRepo = ds.getRepository(PushLogEntity);
    const logs = await logRepo
      .createQueryBuilder('pl')
      .where('pl.userId = :uid', { uid: userId })
      .orderBy('pl.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();

    const totalLogs = await logRepo
      .createQueryBuilder('pl')
      .where('pl.userId = :uid', { uid: userId })
      .getCount();

    // 把 push_logs.eventType 翻译成前端可读文案
    const EVENT_MAP: Record<string, { title: string; content: string }> = {
      order_paid:     { title: '订单已付款',   content: '您有新的支付订单待处理' },
      order_shipped:  { title: '订单已发货',   content: '您的订单已发出，请及时签收' },
      order_completed:{ title: '订单已完成',   content: '您的订单已确认收货' },
      order_cancelled:{ title: '订单已取消',   content: '您的订单已被取消' },
      refund_new:     { title: '新退款申请',   content: '有新的退款申请待处理' },
      refund_approved:{ title: '退款已同意',   content: '您的退款申请已通过' },
      refund_rejected:{ title: '退款被拒绝',   content: '您的退款申请未通过' },
      dispute_new:    { title: '新纠纷工单',   content: '有新的纠纷工单待处理' },
      dispute_resolved:{title: '纠纷已解决',   content: '您的纠纷工单已处理完毕' },
      design_uploaded:{ title: '设计稿已上传', content: '您有新的设计稿待查看' },
      quote_submitted:{ title: '报价已提交',   content: '您有新的报价待确认' },
      quote_accepted: { title: '报价被接受',   content: '您的报价已被接受，请开始服务' },
      system:         { title: '系统通知',     content: '来自平台的重要通知' },
    };

    const mappedList = logs.map((l: any) => {
      const ev = EVENT_MAP[l.eventType] || { title: l.eventType, content: '您有一条新消息' };
      return {
        id: Number(l.id),
        type: l.eventType,
        title: ev.title,
        content: ev.content,
        isRead: false, // push_logs 来源一律视为未读（前端读过后调 read 端点）
        createdAt: l.createdAt,
        meta: null,
      };
    });

    log(`[notifications] userId=${userId} (push_logs fallback) count=${totalLogs}`);
    ok(res, {
      list: mappedList,
      pagination: { page, pageSize, total: totalLogs },
    });
  } catch (e: any) {
    log(`[notifications] list error: ${e?.message || e}`, 'error');
    serverError(res, '通知列表加载失败');
  }
});

// ============================================================================
// GET /api/notifications/unread-count — 未读通知数量
// ============================================================================
router.get('/unread-count', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { unreadCount: 0 });

  try {
    const notifRepo = ds.getRepository(NotificationsEntity);
    let count = await notifRepo
      .createQueryBuilder('n')
      .where('n.userId = :uid AND n.isRead = 0', { uid: userId })
      .getCount();

    // 如果 NotificationsEntity 里没有记录，从 push_logs 补
    // （push_logs 里每条视为一条未读通知，且 dedupKey 去重）
    if (count === 0) {
      const logRepo = ds.getRepository(PushLogEntity);
      const logs = await logRepo
        .createQueryBuilder('pl')
        .select('pl.dedupKey')
        .where('pl.userId = :uid', { uid: userId })
        .distinct(true)
        .getMany();
      count = logs.length;
    }

    ok(res, { unreadCount: count });
  } catch (e: any) {
    log(`[notifications/unread-count] error: ${e?.message || e}`, 'error');
    serverError(res, '未读数查询失败');
  }
});

// ============================================================================
// POST /api/notifications/read — 标记已读
// body: { ids: number[] } 或 { all: true }
// ============================================================================
router.post('/read', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const body = req.body || {};

  const ds = getDataSource();
  if (!ds?.isInitialized) {
    return ok(res, { updated: 0 }, 'mock 模式，无数据库可更新');
  }

  const notifRepo = ds.getRepository(NotificationsEntity);

  try {
    if (body.all === true) {
      // — 全部标记已读 —
      const result = await notifRepo
        .createQueryBuilder()
        .update({ isRead: 1, readAt: new Date() } as any)
        .where('userId = :uid AND isRead = 0', { uid: userId })
        .execute();
      const updated = result.affected || 0;
      log(`[notifications/read] userId=${userId} all=true updated=${updated}`);
      return ok(res, { updated }, '已全部标记为已读');
    }

    // — 按 ids 标记 —
    const ids: number[] = Array.isArray(body.ids)
      ? body.ids.filter((v) => Number.isFinite(Number(v))).map((v) => Number(v))
      : [];

    if (ids.length === 0) {
      return badRequest(res, 'ids 必须是非空数字数组，或传 { all: true }');
    }

    const result = await notifRepo
      .createQueryBuilder()
      .update({ isRead: 1, readAt: new Date() } as any)
      .where('id IN (:...ids) AND userId = :uid AND isRead = 0', { ids, uid: userId })
      .execute();

    const updated = result.affected || 0;
    log(`[notifications/read] userId=${userId} ids=[${ids.join(',')}] updated=${updated}`);
    ok(res, { updated }, `已标记 ${updated} 条为已读`);
  } catch (e: any) {
    log(`[notifications/read] error: ${e?.message || e}`, 'error');
    serverError(res, '标记已读失败');
  }
});

/** GET /api/notifications/list — 站内通知列表（兼容旧路径，自动转到 /） */
router.get('/list', requireAuth, (req, res) => {
  const userId = (req as any).userId;
  log(`notifications/list userId=${userId} → 重定向到 /api/notifications`);
  res.redirect(301, '/api/notifications');
});

export default router;
