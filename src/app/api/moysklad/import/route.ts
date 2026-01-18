import { addMonths } from 'date-fns';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { Currency } from '@/types/finance';

export const dynamic = 'force-dynamic';

const MOYSKLAD_BASE = 'https://api.moysklad.ru/api/remap/1.2';
const PURCHASE_ORDER_ENDPOINT = `${MOYSKLAD_BASE}/entity/purchaseorder`;

const ORGANIZATION_ID = '9953552f-c1f8-11ef-0a80-10830010cc4c';
const STATE_NAMES = ['Не принято', 'В пути', 'Частично принято'];

const supplierCache = new Map<string, string>();
const agentCache = new Map<string, string>();
const currencyCache = new Map<string, MoyskladCurrency>();

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

interface MoyskladPayment {
  meta?: MoyskladMeta;
  linkedSum?: number;
}

interface MoyskladAgent {
  meta?: MoyskladMeta;
  name?: string;
}

interface MoyskladCounterparty extends MoyskladAgent {
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
  payments?: MoyskladPayment[];
}

interface MoyskladListResponse<T> {
  meta?: { nextHref?: string | null };
  rows?: T[];
}

function buildFilterQuery() {
  const organizationFilter = `organization=${MOYSKLAD_BASE}/entity/organization/${ORGANIZATION_ID}`;
  const stateFilters = STATE_NAMES.map((name) => `state.name=${name}`);

  return [...stateFilters, organizationFilter].join(';');
}

async function fetchPurchaseOrders(token: string) {
  const orders: MoyskladOrder[] = [];
  const filter = buildFilterQuery();
  const url = new URL(PURCHASE_ORDER_ENDPOINT);

  url.searchParams.set('expand', 'agent,state,rate,rate.currency,payments');
  url.searchParams.set('filter', filter);
  url.searchParams.set('limit', '100');

  let nextUrl: string | null = url.toString();

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json;charset=utf-8',
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
  const metaHref = currency?.meta?.href;
  const currencyDetails = metaHref ? currencyCache.get(metaHref) : undefined;

  const code =
    currencyDetails?.isoCode ||
    currencyDetails?.code ||
    currency?.isoCode ||
    currency?.code ||
    '';
  const name =
    currencyDetails?.name ||
    currencyDetails?.fullName ||
    currency?.name ||
    currency?.fullName ||
    '';

  if (code.toUpperCase() === 'CNY' || /юан/i.test(name)) return 'CNY';

  return 'RUB';
}

function parsePaymentsSum(order: MoyskladOrder) {
  if (order.payments?.length) {
    return order.payments.reduce((total, payment) => total + Number(payment.linkedSum ?? 0), 0) / 100;
  }

  return Number(order.payedSum ?? 0) / 100;
}

function convertToRub(amount: number, rate?: number) {
  const multiplier = typeof rate === 'number' && rate > 0 ? rate : 1;
  return amount * multiplier;
}

async function fetchMoyskladEntity<T>(href: string, token: string) {
  const response = await fetch(href, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json;charset=utf-8',
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Ошибка запроса к МойСклад: ${response.status} ${response.statusText}. ${details}`);
  }

  return (await response.json()) as T;
}

async function preloadAgents(orders: MoyskladOrder[], token: string) {
  const hrefs = new Set<string>();

  for (const order of orders) {
    const agentHref = order.agent?.meta?.href;

    if (agentHref && !agentCache.has(agentHref) && !order.agent?.name) {
      hrefs.add(agentHref);
    }
  }

  await Promise.all(
    Array.from(hrefs).map(async (href) => {
      const agent = await fetchMoyskladEntity<MoyskladCounterparty>(href, token);
      agentCache.set(href, agent.name || 'Неизвестный поставщик');
    }),
  );
}

async function preloadCurrencies(orders: MoyskladOrder[], token: string) {
  const hrefs = new Set<string>();

  for (const order of orders) {
    const currencyHref = order.rate?.currency?.meta?.href;

    if (currencyHref && !currencyCache.has(currencyHref)) {
      hrefs.add(currencyHref);
    }
  }

  await Promise.all(
    Array.from(hrefs).map(async (href) => {
      const currency = await fetchMoyskladEntity<MoyskladCurrency>(href, token);
      currencyCache.set(href, currency);
    }),
  );
}

async function resolveAgentName(agent: MoyskladAgent | null | undefined, token: string) {
  if (!agent) return 'Неизвестный поставщик';

  if (agent.name?.trim()) return agent.name.trim();

  const href = agent.meta?.href;

  if (!href) return 'Неизвестный поставщик';

  if (agentCache.has(href)) {
    return agentCache.get(href) as string;
  }

  const fetchedAgent = await fetchMoyskladEntity<MoyskladCounterparty>(href, token);
  const name = fetchedAgent.name?.trim() || 'Неизвестный поставщик';

  agentCache.set(href, name);

  return name;
}

function toDateOnly(value: string | Date | null | undefined) {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
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
    await preloadCurrencies(externalOrders, token);
    await preloadAgents(externalOrders, token);

    const rows = [] as {
      supplier_id: string | null;
      title: string;
      total_amount: number;
      deposit_amount: number;
      deposit_paid: boolean;
      deposit_date: string;
      due_date: string;
      currency: Currency;
      description: string | null;
      moysklad_id: string;
    }[];

    for (const order of externalOrders) {
      const supplierName = await resolveAgentName(order.agent, token);
      const supplierId = await ensureSupplierId(supplierName);
      const currency = pickCurrency(order);
      const totalAmountBase = Number(order.sum ?? 0) / 100;
      const depositAmountBase = parsePaymentsSum(order);

      const rate = order.rate?.value;
      const shouldConvertToRub = currency !== 'RUB' && typeof rate === 'number' && rate > 0;
      const totalAmount = shouldConvertToRub ? convertToRub(totalAmountBase, rate) : totalAmountBase;
      const depositAmount = shouldConvertToRub
        ? convertToRub(depositAmountBase, rate)
        : depositAmountBase;
      const depositPaid = depositAmount > 0;
      const storedCurrency: Currency = shouldConvertToRub ? 'RUB' : currency;
      const orderDate = order.moment ? new Date(order.moment) : new Date();
      const finalPaymentDate = addMonths(orderDate, 1);

      rows.push({
        supplier_id: supplierId,
        title: order.name || 'Заказ поставщику',
        total_amount: totalAmount,
        deposit_amount: depositAmount,
        deposit_paid: depositPaid,
        deposit_date: toDateOnly(order.moment),
        due_date: toDateOnly(finalPaymentDate),
        currency: storedCurrency,
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
