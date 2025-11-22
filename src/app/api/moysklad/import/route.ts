import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { Currency } from '@/types/finance';

export const dynamic = 'force-dynamic';

const MOYSKLAD_BASE = 'https://api.moysklad.ru/api/remap/1.2';
const PURCHASE_ORDER_ENDPOINT = `${MOYSKLAD_BASE}/entity/purchaseorder`;

const AGENT_ID = '9953552f-c1f8-11ef-0a80-10830010cc4c';
const STATE_IDS = [
  '58aee5f8-d27c-11ef-0a80-0883000f7902',
  '58aee70e-d27c-11ef-0a80-0883000f7903',
  '58aee762-d27c-11ef-0a80-0883000f7904',
];

const supplierCache = new Map<string, string>();

interface MoyskladMeta {
  href?: string;
}

interface MoyskladCurrency {
  meta?: MoyskladMeta;
  name?: string;
  fullName?: string;
  code?: string;
  isoCode?: string;
}

interface MoyskladRate {
  currency?: MoyskladCurrency;
  value?: number;
}

interface MoyskladAgent {
  meta?: MoyskladMeta;
  name?: string;
}

interface MoyskladState {
  meta?: MoyskladMeta;
  name?: string;
}

interface MoyskladOrder {
  id: string;
  name?: string | null;
  description?: string | null;
  sum?: number | null;
  payedSum?: number | null;
  moment?: string | null;
  deliveryPlannedMoment?: string | null;
  rate?: MoyskladRate | null;
  agent?: MoyskladAgent | null;
  state?: MoyskladState | null;
}

interface MoyskladListResponse<T> {
  meta?: { nextHref?: string | null };
  rows?: T[];
}

function buildFilterQuery() {
  const agentFilter = `agent=${PURCHASE_ORDER_ENDPOINT.replace('/entity/purchaseorder', '')}/entity/counterparty/${AGENT_ID}`;
  const stateFilters = STATE_IDS.map(
    (id) =>
      `state=${PURCHASE_ORDER_ENDPOINT}/metadata/states/${id}`,
  );

  return [...stateFilters, agentFilter].join(';');
}

async function fetchPurchaseOrders(token: string) {
  const orders: MoyskladOrder[] = [];
  const filter = buildFilterQuery();
  let nextUrl = `${PURCHASE_ORDER_ENDPOINT}?expand=agent,state,rate.currency&filter=${encodeURIComponent(filter)}`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Ошибка запроса к МойСклад: ${response.status} ${response.statusText}. ${details}`);
    }

    const payload = (await response.json()) as MoyskladListResponse<MoyskladOrder>;
    orders.push(...(payload.rows ?? []));
    nextUrl = payload.meta?.nextHref ?? null;
  }

  return orders;
}

function pickCurrency(order: MoyskladOrder): Currency {
  const currency = order.rate?.currency;
  const code = currency?.isoCode || currency?.code || '';
  const name = currency?.name || currency?.fullName || '';

  if (code.toUpperCase() === 'CNY' || /юан/i.test(name)) return 'CNY';

  return 'RUB';
}

function toDateOnly(value: string | null | undefined) {
  if (!value) return new Date().toISOString().slice(0, 10);
  return value.slice(0, 10);
}

async function ensureSupplierId(name: string) {
  const safeName = name?.trim() || 'Без названия';

  if (supplierCache.has(safeName)) {
    return supplierCache.get(safeName) as string;
  }

  const { data, error } = await supabase
    .from('suppliers')
    .upsert({ name: safeName }, { onConflict: 'name' })
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`Не удалось сохранить поставщика «${safeName}»: ${error?.message ?? 'нет данных'}`);
  }

  supplierCache.set(safeName, data.id as string);

  return data.id as string;
}

export async function POST() {
  const token = process.env.MOYSKLAD_TOKEN;

  if (!token) {
    return NextResponse.json(
      { error: 'Задайте переменную окружения MOYSKLAD_TOKEN для доступа к API МойСклад' },
      { status: 500 },
    );
  }

  try {
    const externalOrders = await fetchPurchaseOrders(token);

    const rows = [] as {
      supplier_id: string | null;
      title: string;
      total_amount: number;
      deposit_amount: number;
      deposit_date: string;
      due_date: string;
      currency: Currency;
      description: string | null;
      moysklad_id: string;
    }[];

    for (const order of externalOrders) {
      const supplierName = order.agent?.name || 'Неизвестный поставщик';
      const supplierId = await ensureSupplierId(supplierName);
      const currency = pickCurrency(order);
      const totalAmount = Number(order.sum ?? 0) / 100;
      const depositAmount = Number(order.payedSum ?? 0) / 100;

      rows.push({
        supplier_id: supplierId,
        title: order.name || 'Заказ поставщику',
        total_amount: totalAmount,
        deposit_amount: depositAmount,
        deposit_date: toDateOnly(order.moment),
        due_date: toDateOnly(order.deliveryPlannedMoment || order.moment),
        currency,
        description: order.description || null,
        moysklad_id: order.id,
      });
    }

    if (!rows.length) {
      return NextResponse.json({ imported: 0, message: 'Нет заказов по заданным фильтрам' });
    }

    const { data, error } = await supabase
      .from('supplier_orders')
      .upsert(rows, { onConflict: 'moysklad_id' })
      .select('id');

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({ imported: rows.length, saved: data?.length ?? 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Неизвестная ошибка при импортировании заказов';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  const token = process.env.MOYSKLAD_TOKEN;

  if (!token) {
    return NextResponse.json(
      { error: 'Задайте переменную окружения MOYSKLAD_TOKEN для доступа к API МойСклад' },
      { status: 500 },
    );
  }

  try {
    const externalOrders = await fetchPurchaseOrders(token);
    return NextResponse.json({ count: externalOrders.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось получить количество заказов';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
