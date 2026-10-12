// ============================================================================
// 💬 Chat Routes — /api/chat/*（点对点即时聊天）
// GET    /chat/list        某会话的历史消息（返回脱敏后的内容）
// POST   /chat/send       发送消息（经 scanText 敏感词过滤）
// ============================================================================
import { Router } from 'express';
import { requireAuth, ok, fail, badRequest, log } from '../middleware/auth';
import { scanText, desensitizeText } from '../services/chat-filter';
import { getDataSource } from '../db-manager';
import { ConversationEntity, ChatMessageEntity } from '../entities/sprint6';
import { eventBus } from '../services/event-bus';

const router = Router();

// — 获取或创建会话 —
async function getOrCreateConv(
  ds: any,
  user1: number,
  user2: number,
  refType?: string,
  refId?: number,
) {
  const repo = ds.getRepository(ConversationEntity);
  const sorted = [Math.min(user1, user2), Math.max(user1, user2)];
  let conv = await repo.findOne({ where: { user1Id: sorted[0], user2Id: sorted[1] } });
  if (!conv) {
    conv = repo.create({ user1Id: sorted[0], user2Id: sorted[1], refType, refId });
    conv = await repo.save(conv);
  }
  return conv;
}

// — GET /chat/list —
router.get('/list', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { conversationId, otherUserId, refType, refId } = req.query as any;
  const ds = getDataSource();

  if (!ds || !ds.isInitialized) {
    return ok(res, { list: [] });
  }

  try {
    let convId: number;
    if (conversationId) {
      convId = Number(conversationId);
    } else if (otherUserId) {
      const conv = await getOrCreateConv(
        ds,
        userId,
        Number(otherUserId),
        refType,
        refId ? Number(refId) : undefined,
      );
      convId = conv.id;
    } else {
      return badRequest(res, 'conversationId 或 otherUserId 必填');
    }

    const repo = ds.getRepository(ChatMessageEntity);
    const list = await repo.find({
      where: { conversationId: convId },
      order: { createdAt: 'ASC' },
    });

    // 脱敏 + 过滤被拦截的
    const safeList = list
      .filter((m) => m.passedFilter === 1)
      .map((m) => {
        const { content } = desensitizeText(m.content);
        return {
          id: m.id,
          conversationId: m.conversationId,
          senderId: m.senderId,
          senderType: (m as any).senderType ?? 1,
          content,
          time: m.createdAt,
          type: m.msgType,
          cardType: (m as any).cardType || undefined,
          cardData: (m as any).cardData
            ? typeof (m as any).cardData === 'string'
              ? JSON.parse((m as any).cardData)
              : (m as any).cardData
            : undefined,
        };
      });

    log(`chat-list userId=${userId} convId=${convId} count=${safeList.length}`);
    ok(res, { list: safeList, conversationId: convId });
  } catch (e: any) {
    log(`chat-list ERROR: ${e?.message}`, 'error');
    fail(res, 500, '服务器错误', 500);
  }
});

// — POST /chat/send — ⚠️ 防跳单核心：scanText 中间件
router.post('/send', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { text, otherUserId, conversationId, refType, refId, image, cardType, cardData } = req.body || {};

  if (!text && !image && !cardType) {
    return fail(res, 400, '消息内容不能为空');
  }

  // 1. 敏感词 + 联系方式检测（跳单防护核心）
  let filterPassed = 1;
  let filterReason: string | undefined;
  if (text) {
    const scan = scanText(String(text));
    if (!scan.passed) {
      filterPassed = 0;
      filterReason = scan.reason;
      log(
        `[CHAT-BLOCKED] userId=${userId} reason=${scan.reason} matched=${scan.matched?.join(',')}`,
        'warn',
      );
      // 仍然存 DB 但标记拦截
    }
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    // fallback: 内存直接返回
    return filterPassed
      ? ok(res, {
          id: 'm_' + Date.now(),
          conversationId: conversationId || 0,
          senderId: userId,
          content: String(text || ''),
          time: new Date().toISOString(),
          type: text ? 'text' : 'image',
        })
      : fail(res, 400, filterReason || '消息内容违规');
  }

  try {
    // 2. 确定会话
    let convId: number;
    if (conversationId) {
      convId = Number(conversationId);
    } else if (otherUserId) {
      const conv = await getOrCreateConv(ds, userId, Number(otherUserId), refType, refId);
      convId = conv.id;
    } else {
      return badRequest(res, 'conversationId 或 otherUserId 必填');
    }

    // 3. 写消息
    const repo = ds.getRepository(ChatMessageEntity);
    const msg = repo.create({
      conversationId: convId,
      senderId: userId,
      content: String(text || image || cardType || ''),
      msgType: cardType ? 'card' : image ? 'image' : 'text',
      cardType: cardType || null,
      cardData: cardData ? (typeof cardData === 'string' ? cardData : JSON.stringify(cardData)) : null,
      senderType: 1,
      passedFilter: filterPassed,
      filterReason,
    });
    const saved = await repo.save(msg);

    // 4. 更新会话 lastMsgTime + 查 conv 算对方 userId（用于 SSE 推送）
    const convRepo = ds.getRepository(ConversationEntity);
    await convRepo.update(convId, { lastMsgTime: new Date() });
    const conv = await convRepo.findOne({ where: { id: convId } });

    if (filterPassed === 0) {
      return fail(res, 400, filterReason || '消息内容违规', 400);
    }

    log(`[CHAT-SEND] userId=${userId} conv=${convId}`);

    // 5. SSE 实时推给对方（排除敏感词拦截的消息不推）
    if (!conv) {
      return ok(res, { messageId: String(saved.id) });
    }
    try {
      const otherUserId = conv.user1Id === userId ? conv.user2Id : conv.user1Id;
      eventBus.emit('generic', 'user', otherUserId, {
        messageType: 'chat',
        conversationId: convId,
        senderId: userId,
        content: desensitizeText(saved.content).content,
        msgType: saved.msgType,
        createdAt: saved.createdAt?.toISOString(),
      });
    } catch (e: any) {
      log(`[CHAT-SSE] emit fail: ${e?.message}`, 'warn');
    }

    ok(
      res,
      {
        id: saved.id,
        conversationId: convId,
        senderId: userId,
        content: desensitizeText(saved.content).content,
        time: saved.createdAt,
        type: saved.msgType,
      },
      '发送成功',
    );
  } catch (e: any) {
    log(`chat-send ERROR: ${e?.message}`, 'error');
    fail(res, 500, '服务器错误', 500);
  }
});

export default router;
