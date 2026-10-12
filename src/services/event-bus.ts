// ============================================================================
// 🔔 Event Bus — 轻量 SSE 事件总线（替代 WebSocket，零依赖）
// 业务节点 emit 事件 → HTTP SSE 端点主动推给客户端
// 前端用 EventSource 监听，自动重连
// ============================================================================
import { EventEmitter } from 'events';
import type { Response } from 'express';

type EventType =
  | 'new_demand' // 用户发布新需求 → 推给附近师傅
  | 'new_quote' // 师傅报价 → 推给用户
  | 'quote_accepted' // 用户接受报价 → 推给师傅
  | 'quote_rejected' // 用户拒绝报价 → 推给师傅
  | 'order_started' // 师傅开工 → 推给用户
  | 'order_completed' // 师傅完工 → 推给用户
  | 'installer_approved' // admin 审核通过 → 推给师傅
  | 'installer_rejected' // admin 审核拒绝 → 推给师傅
  | 'counter_offer' // 砍价消息 → 推给对方
  // — 设计场景 —
  | 'new_design_demand' // 用户发布设计需求 → 广播给设计师
  | 'new_design_quote' // 设计师接单 → 推给用户
  | 'design_accepted' // 用户接受设计师 → 推给设计师
  | 'design_completed' // 设计师完工 → 推给用户
  | 'design_delivery' // 设计师交付 → 推给用户确认
  | 'acceptance_confirmed' // 用户确认验收 → 推给设计师
  | 'revision_requested' // 用户要求修改 → 推给设计师
  | 'design_file_ready' // 设计文件就绪 → 推给用户
  | 'new_warranty_claim' // 新增质保索赔 → 推给 admin
  | 'designer_approved' // admin 审核设计师通过 → 推给设计师
  | 'designer_rejected' // admin 审核设计师拒绝 → 推给设计师
  | 'vendor_approved' // admin 审核供应商通过 → 推给供应商
  | 'vendor_rejected' // admin 审核供应商拒绝 → 推给供应商
  | 'warranty_arbitrated' // admin 质保仲裁 → 推给用户+师傅
  | 'warranty_claim_responded' // installer 响应质保索赔 → 推给用户
  // — 电商场景 —
  | 'order_paid' // 买家付款 → 推给 vendor（待发货）
  | 'order_shipped' // vendor 发货 → 推给 buyer
  | 'order_cancelled' // 订单取消 → 推给 vendor（回滚库存）
  | 'order_completed' // 订单完成 → 推给 vendor（可结算佣金）
  | 'refund_requested' // 买家发起退款 → 推给 vendor
  | 'refund_handled' // vendor 处理退款 → 推给 buyer
  | 'withdraw_pending' // vendor 提现申请 → 推给 admin
  | 'withdraw_handled' // admin 处理提现 → 推给 vendor
  | 'generic';

interface BusEvent {
  type: EventType;
  targetId: number; // 用户ID/师傅ID/设计师ID/VendorID（根据 type 判断）
  targetRole: 'user' | 'installer' | 'designer' | 'vendor' | 'admin' | 'broadcast';
  payload: any;
  ts: number;
}

class EventBus {
  private emitter = new EventEmitter();
  private connections = new Map<string, Response>();
  private seq = 0;

  subscribe(clientId: string, res: Response) {
    this.connections.set(clientId, res);
    res.on('close', () => {
      this.connections.delete(clientId);
    });
    // 心跳：每 25s 发送注释，保持连接
    const heartbeat = setInterval(() => {
      if (!this.connections.has(clientId)) {
        clearInterval(heartbeat);
        return;
      }
      res.write(': keep-alive\n\n');
    }, 25000);
    res.on('close', () => clearInterval(heartbeat));
  }

  private send(res: Response, evt: BusEvent) {
    this.seq++;
    const data = JSON.stringify(evt);
    res.write(`id: ${this.seq}\n`);
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${data}\n\n`);
  }

  emit(type: EventType, targetRole: BusEvent['targetRole'], targetId: number, payload: any) {
    const evt: BusEvent = { type, targetRole, targetId, payload, ts: Date.now() };
    for (const [cid, res] of this.connections) {
      // broadcast 推给所有人；否则只推给匹配 targetId 的
      if (targetRole === 'broadcast') {
        this.send(res, evt);
      } else {
        const [role, idStr] = cid.split(':');
        const id = Number(idStr);
        if (role === targetRole && id === targetId) {
          this.send(res, evt);
        }
      }
    }
  }

  getConnectionCount() {
    return this.connections.size;
  }
}

export const eventBus = new EventBus();
export type { BusEvent, EventType };
