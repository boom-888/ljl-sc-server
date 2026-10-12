// ============================================================================
// 🧩 API Response Adapters — 后端 → 前端类型对齐
// 后端内部用 number id + 嵌套对象，前端 types/index.ts 用 string id + flat 结构
// 所有路由返回前必须经过这里转换
// ============================================================================
import {
  db,
  CartItem as DbCart,
  Order as DbOrder,
  OrderItem as DbOrderItem,
  Address as DbAddress,
} from './db';

function cartToFront(
  c: DbCart & { product?: { name: string; cover?: string; price: number; stock: number } },
): any {
  return {
    id: String(c.id),
    productId: String(c.productId),
    productName: c.product?.name || '商品',
    cover: c.product?.cover || '',
    specText: c.specId || '',
    price: c.product?.price || 0,
    quantity: c.quantity,
    selected: !!c.selected,
    stock: c.product?.stock || 999,
  };
}

function orderToFront(o: DbOrder & { items?: DbOrderItem[] }): any {
  const statusMap: Record<string, string> = {
    pending: '待支付',
    paid: '已支付',
    shipped: '已发货',
    completed: '已完成',
    cancelled: '已取消',
  };
  const items = (o.items || []).map((i) => ({
    id: String(i.id),
    productId: String(i.productId),
    productName: i.productName,
    cover: i.productCover || '',
    specText: '',
    price: i.price,
    quantity: i.quantity,
    // @ts-ignore — vendorId/vendorName 是 db-orm 层 find 时 enrich 的业务字段，不是 Entity 属性
    vendorId: i.vendorId ?? null,
    // @ts-ignore
    vendorName: i.vendorName ?? null,
  }));
  const frontOrder: any = {
    id: String(o.id),
    orderNo: o.orderNo,
    status: o.status,
    statusText: statusMap[o.status] || o.status,
    items,
    // @ts-ignore — db-orm 返回的 enriched 字段
    vendorId: (o as any).vendorId ?? null,
    vendorName: (o as any).vendorName ?? null,
    totalAmount: o.totalAmount,
    actualAmount: Number((o.totalAmount + (o.shippingFee || 0) - (o.discount || 0)).toFixed(2)),
    freight: o.shippingFee || 0,
    discount: o.discount || 0,
    addressId: '',
    addressSnapshot: {
      id: '',
      name: o.receiverName || '',
      phone: o.receiverPhone || '',
      province: '',
      city: '',
      district: '',
      detail: o.receiverAddress || '',
      isDefault: false,
    },
    remark: o.remark,
    payMethod: o.payMethod,
    contractSignedAt: (o as any).contractSignedAt || null, // 🔒 设计文件责任合同
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    shippedAt: o.shippedAt,
    completedAt: o.completedAt,
  };
  return frontOrder;
}

function addressToFront(a: DbAddress): any {
  return {
    id: String(a.id),
    name: a.name,
    phone: a.phone,
    province: a.province,
    city: a.city,
    district: a.district,
    detail: a.detail,
    isDefault: !!a.isDefault,
  };
}

export const adapters = { cartToFront, orderToFront, addressToFront };
