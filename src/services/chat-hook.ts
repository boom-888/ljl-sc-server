// ============================================================================
// 🔗 自动聊天会话创建钩子 — 状态变更 → 自动建 Conversation
// 核心设计：v3.0 "消息 = 状态变更副产品"
// 用法：路由里 import { ensureBusinessConv } from '../services/chat-hook';
//       然后在 eventBus.emit 之后调 await ensureBusinessConv(ds, { ... });
// ============================================================================
import { getDataSource } from '../db-manager';
import { ConversationEntity, ChatMessageEntity } from '../entities/sprint6';
import { log } from '../middleware/auth';

export interface EnsureConvOptions {
  /** 业务类型：design_demand | installation_order | goods_order */
  refType: string;
  /** 业务实体 id（DesignDemand.id / InstallationDemand.id / Order.id）*/
  refId: number;
  /** 双方 user id（会自动排序 min/max）*/
  partyA: number;
  partyB: number;
  /** 可选：业务事件名，日志用 */
  event?: string;
}

/**
 * 确保指定业务实体有一条关联的 ConversationEntity。
 * 不重复创建——已有 conv（按 refType + refId 匹配）直接复用。
 * 纯 no-op：TypeORM 未就绪时静默返回 null。
 */
export async function ensureBusinessConv(opts: EnsureConvOptions): Promise<ConversationEntity | null> {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return null;

  const { refType, refId, partyA, partyB, event } = opts;
  if (!refType || !refId || !partyA || !partyB) return null;
  if (partyA === partyB) return null; // 自己跟自己不建

  try {
    const repo = ds.getRepository(ConversationEntity);

    // 1. 优先按 refType + refId 找已关联的会话
    let conv = await repo.findOne({ where: { refType, refId } });

    if (!conv) {
      // 2. 再按用户对找（同两个人可能已有其他 ref 的会话）
      const sorted = [Math.min(partyA, partyB), Math.max(partyA, partyB)];
      conv = await repo.findOne({ where: { user1Id: sorted[0], user2Id: sorted[1] } });

      if (conv) {
        // 3. 找到已有会话但 refType/refId 不对，补写关联（不新建）
        conv.refType = refType;
        conv.refId = refId;
        conv = await repo.save(conv);
        log(`[chat-hook] conv#${conv.id} retroactively linked to ${refType}#${refId}${event ? ` (${event})` : ''}`);
      }
    }

    if (!conv) {
      // 4. 完全没有 → 新建
      const sorted = [Math.min(partyA, partyB), Math.max(partyA, partyB)];
      conv = repo.create({
        user1Id: sorted[0],
        user2Id: sorted[1],
        refType,
        refId,
        lastMsgTime: new Date(),
      });
      conv = await repo.save(conv);
      log(`[chat-hook] auto-created conv#${conv.id} ${refType}#${refId} users=${partyA}&${partyB}${event ? ` (${event})` : ''}`);
    }

    return conv;
  } catch (e: any) {
    log(`[chat-hook] ensureBusinessConv fail: ${e?.message}`, 'warn');
    return null;
  }
}

// ----------------------------------------------------------------------------
// v3.0 卡片消息自动写入 — 业务状态变更 → 自动在已关联会话里写一条卡片
// ----------------------------------------------------------------------------
export interface WriteCardMessageOptions {
  /** 业务类型：design_demand | installation_order | goods_order */
  refType: string;
  /** 业务实体 id */
  refId: number;
  /** 双方 user id（会自动排序 min/max）*/
  partyA: number;
  partyB: number;
  /** 卡片类型 */
  cardType: 'quote' | 'change' | 'progress' | 'deliver' | 'confirm';
  /** 卡片 payload（会 JSON.stringify 入库）*/
  cardData: any;
  /** 可选的文字描述，写入 content 字段 */
  content?: string;
}

/**
 * 向指定会话写一条系统卡片消息。
 * - 先 ensureBusinessConv 确保会话存在
 * - 找不到 conv 直接返回 null
 * - senderType=0 表示系统自动写入，senderId 取 Math.min(partyA, partyB)
 * - 失败静默兜底（跟 ensureBusinessConv 一样），不抛异常
 */
export async function writeCardMessage(opts: WriteCardMessageOptions): Promise<ChatMessageEntity | null> {
  const conv = await ensureBusinessConv(opts);
  if (!conv) return null;

  try {
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) return null;

    const { cardType, cardData, content } = opts;

    const repo = ds.getRepository(ChatMessageEntity);
    const msg = repo.create({
      conversationId: conv.id,
      senderId: Math.min(conv.user1Id, conv.user2Id),
      content: content || cardType,
      msgType: 'card',
      cardType,
      cardData: cardData ? (typeof cardData === 'string' ? cardData : JSON.stringify(cardData)) : null,
      senderType: 0, // 系统自动写入
      passedFilter: 1,
    });
    const saved = await repo.save(msg);
    log(`[chat-hook] writeCardMessage conv#${conv.id} type=${cardType}`);

    // 同步更新会话 lastMsgTime
    const convRepo = ds.getRepository(ConversationEntity);
    await convRepo.update(conv.id, { lastMsgTime: new Date() });

    return saved;
  } catch (e: any) {
    log(`[chat-hook] writeCardMessage fail: ${e?.message}`, 'warn');
    return null;
  }
}
