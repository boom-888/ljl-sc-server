// ============================================================================
// ⏰ Scheduler — 定时任务
// 每分钟触发一次，扫描：
//   1. 质保到期 → 自动释放质保金（warrantyStatus active → expired）
//   2. 师傅 24h 未响应索赔 → 自动升级仲裁（claim status pending → arbitrated）
// ============================================================================
import { getDataSource } from '../db-manager';
import { InstallationOrderEntity, WarrantyClaimEntity } from '../entities/sprint4';
import { WARRANTY_CONFIG } from './settle';
import { log } from '../logger';
import { eventBus } from './event-bus';

let intervalId: NodeJS.Timeout | null = null;

export function startScheduler() {
  if (intervalId) {
    log('[Scheduler] already running', 'warn');
    return;
  }

  // 每分钟扫一次（精度够用，90天=129600分钟，24h=1440分钟）
  intervalId = setInterval(() => {
    try {
      tick();
    } catch (e: any) {
      log(`[Scheduler] tick error: ${e.message}`, 'error');
    }
  }, 60 * 1000);

  log('[Scheduler] started (tick=1min)', 'info');

  // 启动时立即跑一次（避免等 1 分钟）
  tick();
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log('[Scheduler] stopped', 'info');
  }
}

async function tick() {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return;
  }
  const now = new Date();

  // ── 1. 质保到期 → 自动释放 ──
  const orderRepo = ds.getRepository(InstallationOrderEntity);
  const expiredOrders = await orderRepo.find({
    where: {
      warrantyStatus: 'active',
    },
  });

  let released = 0;
  for (const o of expiredOrders) {
    if (o.warrantyExpireAt && new Date(o.warrantyExpireAt) <= now) {
      o.warrantyStatus = 'expired';
      await orderRepo.save(o);
      released++;
      log(`[Warranty] expired order ${o.orderNo}, release hold ¥${o.warrantyHoldAmount}`, 'info');
      // 真实资金流：holdAmount 加到师傅 earningsAvailable
      try {
        const { InstallerProfileEntity, MoneyFlowEntity } = await import('../entities');
        const installerRepo = ds.getRepository(InstallerProfileEntity);
        const flowRepo = ds.getRepository(MoneyFlowEntity);
        const profile = await installerRepo.findOne({ where: { userId: o.installerId } });
        if (profile) {
          profile.earningsAvailable = Number(
            (profile.earningsAvailable + (o.warrantyHoldAmount || 0)).toFixed(2),
          );
          await installerRepo.save(profile);
          // 审计流水
          const flow = flowRepo.create({
            flowNo: 'FL' + Date.now() + Math.floor(Math.random() * 10000).toString().padStart(4, '0'),
            type: 'warranty_release',
            refNo: o.orderNo,
            toUserId: o.installerId,
            toRole: 'installer',
            amount: Number((o.warrantyHoldAmount || 0).toFixed(2)),
            remark: `质保到期自动释放 ${o.orderNo} hold ¥${o.warrantyHoldAmount}`,
          });
          await flowRepo.save(flow);
        }
      } catch (err: any) {
        log(`[Warranty] release holdAmount failed: ${err.message}`, 'error');
      }
    }
  }
  if (released > 0) {
    log(`[Scheduler] tick: ${released} warranty expired & released`, 'info');
  }

  // ── 3. settle 7 天到期 → 自动解冻（earningsFrozen → earningsAvailable）─
  try {
    const { unfreezeSettles } = await import('./settle');
    await unfreezeSettles();
  } catch (e: any) {
    log(`[Scheduler] unfreezeSettles error: ${e.message}`, 'error');
  }

  // ── 2. 师傅 24h 未响应 → 自动升级仲裁 ──
  const claimRepo = ds.getRepository(WarrantyClaimEntity);
  const pendingClaims = await claimRepo.find({
    where: { status: 'pending' },
  });

  let escalated = 0;
  for (const c of pendingClaims) {
    const ageHours = (now.getTime() - new Date(c.createdAt).getTime()) / (3600 * 1000);
    if (ageHours >= WARRANTY_CONFIG.respondHours) {
      c.status = 'arbitrated';
      c.resolution = `师傅 ${Math.round(ageHours)}h 未响应，平台自动升级仲裁`;
      await claimRepo.save(c);
      escalated++;
      log(`[Warranty] claim ${c.claimNo} escalated (no response ${Math.round(ageHours)}h)`, 'warn');
      // 通知 admin（简化：emit 事件，未来 admin 后台可订阅）
      eventBus.emit('warranty_arbitrated', 'admin', 0, {
        claimId: c.id,
        claimNo: c.claimNo,
        orderNo: c.orderNo,
        ageHours: Math.round(ageHours),
      });
    }
  }
  if (escalated > 0) {
    log(`[Scheduler] tick: ${escalated} claims escalated (no response)`, 'info');
  }
}
