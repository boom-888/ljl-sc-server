// ============================================================================
// 💬 Message Routes — /api/message/*（消息中心首页）
// 职责：聚合点对点聊天会话 + 系统通知，返回前端 message 页面期望的结构
// ============================================================================
import { Router } from 'express';
import { requireAuth, ok, fail, log } from '../middleware/auth';
import { getDataSource } from '../db-manager';
import { ConversationEntity, ChatMessageEntity } from '../entities/sprint6';
import { isTypeORMReady } from '../db';

const router = Router();

// — 消息分层配色常量（与前端 message/index.tsx 一致）—
const CHAT_ICON_BG = 'linear-gradient(135deg, #667EEA 0%, #764BA2 100%)';
const CHAT_ICON = 'message-circle';

/** GET /api/message/list — 消息中心首页
 *  返回 { threads: ThreadItem[], msgs: MsgItem[] }
 *  threads = 点对点聊天会话列表（真实 ConversationEntity + ChatMessageEntity）
 *  msgs    = 系统/业务通知（当前无 NotificationEntity → 返回空数组）
 */
router.get('/list', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const ds = getDataSource();

  try {
    let threads: any[] = [];

    if (isTypeORMReady() && ds && ds.isInitialized) {
      const convRepo = ds.getRepository(ConversationEntity);
      const msgRepo = ds.getRepository(ChatMessageEntity);

      // 1. 查当前用户参与的所有会话
      const convs = await convRepo
        .createQueryBuilder('c')
        .where('c.user1Id = :uid OR c.user2Id = :uid', { uid: userId })
        .orderBy('COALESCE(c.lastMsgTime, c.createdAt)', 'DESC')
        .take(50)
        .getMany();

      // 2. 组装 threads
      for (const conv of convs) {
        const isUser1 = conv.user1Id === userId;
        const otherId = isUser1 ? conv.user2Id : conv.user1Id;
        const unread = isUser1 ? conv.unreadUser1 : conv.unreadUser2;

        // 查最后一条消息（简单 LIMIT 1，避免复杂 join）
        const lastMsg = await msgRepo
          .createQueryBuilder('m')
          .where('m.conversationId = :cid', { cid: conv.id })
          .orderBy('m.id', 'DESC')
          .limit(1)
          .getOne();

        const lastContent = lastMsg?.content || '暂无消息';
        const lastTime = conv.lastMsgTime || conv.createdAt;

        threads.push({
          id: String(conv.id),
          otherId: String(otherId),
          icon: CHAT_ICON,
          iconBg: CHAT_ICON_BG,
          title: `用户${otherId}`,
          desc: lastContent.length > 50 ? lastContent.slice(0, 50) + '...' : lastContent,
          time: formatTime(lastTime),
          rawTime: lastTime?.toISOString?.() || new Date().toISOString(),
          badge: unread > 0 ? unread : undefined,
          refType: conv.refType || null,
        });
      }
    } else {
      log(`[message-list] TypeORM not ready, userId=${userId}`, 'warn');
    }

    const msgs: any[] = [];

    log(`message-list userId=${userId} threads=${threads.length}`);
    ok(res, { threads, msgs });
  } catch (e: any) {
    log(`message-list ERROR: ${e?.message}`, 'error');
    fail(res, 500, '服务器错误: ' + (e?.message || 'unknown'), 500);
  }
});

/** 时间格式化：相对时间 */
function formatTime(t: Date | string | undefined): string {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  if (hours < 48) return '昨天';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

export default router;
