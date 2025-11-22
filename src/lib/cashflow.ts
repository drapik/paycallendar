import { addDays, formatISO, isAfter, parseISO, startOfDay } from 'date-fns';
import {
  Account,
  AppSettings,
  CashEvent,
  CashPlanResult,
  Currency,
  DailyStat,
  IncomingPayment,
  OrderImpact,
  SupplierOrder,
} from '@/types/finance';
import { currencyRate } from '@/lib/settings';

function toDateKey(value: string | Date): string {
  return formatISO(startOfDay(typeof value === 'string' ? parseISO(value) : value), { representation: 'date' });
}

function normalizeAmount(value: number | string | null): number {
  if (!value) return 0;
  const parsed = typeof value === 'string' ? parseFloat(value) : value;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function collectEvents(
  accounts: Account[],
  inflows: IncomingPayment[],
  orders: SupplierOrder[],
  rates: Record<Currency, number>,
): CashEvent[] {
  const events: CashEvent[] = [];
  const openingBalance = accounts.reduce((sum, account) => sum + normalizeAmount(account.balance), 0);

  events.push({
    amount: openingBalance,
    date: toDateKey(new Date()),
    description: 'Стартовый баланс',
    type: 'opening',
  });

  inflows.forEach((inflow) => {
    events.push({
      amount: normalizeAmount(inflow.amount),
      date: toDateKey(inflow.expected_date),
      description: `${inflow.counterparty} (${inflow.kind === 'fixed' ? 'фиксированный' : 'плановый'})`,
      type: 'inflow',
    });
  });

  orders.forEach((order) => {
    const currency = order.currency ?? 'RUB';
    const rate = rates[currency] ?? 1;
    const deposit = normalizeAmount(order.deposit_amount) * rate;
    const remainder = normalizeAmount(order.total_amount) * rate - deposit;

    if (deposit > 0) {
      events.push({
        amount: -deposit,
        date: toDateKey(order.deposit_date || new Date()),
        description: `${order.title} — аванс поставщику` + (order.supplier_name ? ` ${order.supplier_name}` : ''),
        type: 'outflow',
        source: order.id,
      });
    }

    if (remainder > 0) {
      events.push({
        amount: -remainder,
        date: toDateKey(order.due_date),
        description: `${order.title} — финальный платёж` + (order.supplier_name ? ` ${order.supplier_name}` : ''),
        type: 'outflow',
        source: order.id,
      });
    }
  });

  return events;
}

export function buildCashPlan(
  accounts: Account[],
  inflows: IncomingPayment[],
  orders: SupplierOrder[],
  settings?: AppSettings,
  horizonDays = 120,
): CashPlanResult {
  const rates: Record<Currency, number> = {
    RUB: 1,
    CNY: currencyRate('CNY', settings),
  };
  const events = collectEvents(accounts, inflows, orders, rates).sort((a, b) => (a.date > b.date ? 1 : -1));
  const openingBalance = accounts.reduce((sum, account) => sum + normalizeAmount(account.balance), 0);

  if (events.length === 0) {
    return { openingBalance: 0, daily: [], minBalance: 0, cashGap: 0 };
  }

  const firstDate = parseISO(events[0].date);
  const lastEventDate = parseISO(events[events.length - 1].date);
  const horizonLimit = addDays(new Date(), horizonDays);
  const endDate = isAfter(lastEventDate, horizonLimit) ? horizonLimit : lastEventDate;

  const daily: DailyStat[] = [];
  let cursor = firstDate;
  let balance = openingBalance;
  let minBalance = balance;

  while (!isAfter(cursor, endDate)) {
    const dateKey = toDateKey(cursor);
    const todaysEvents = events.filter((event) => event.date === dateKey);
    todaysEvents.forEach((event) => {
      balance += event.amount;
    });

    minBalance = Math.min(minBalance, balance);

    if (todaysEvents.length > 0) {
      daily.push({
        date: dateKey,
        balance: Number(balance.toFixed(2)),
        events: todaysEvents,
      });
    }

    cursor = addDays(cursor, 1);
  }

  return {
    openingBalance: Number(openingBalance.toFixed(2)),
    daily,
    minBalance: Number(minBalance.toFixed(2)),
    cashGap: minBalance < 0 ? Number((-minBalance).toFixed(2)) : 0,
  };
}

export function projectBalanceOnDate(plan: CashPlanResult, targetDate: string): number | null {
  if (!plan.daily.length) return null;
  const target = toDateKey(targetDate);
  const relevantDay = plan.daily.find((day) => day.date === target) || plan.daily[plan.daily.length - 1];
  return relevantDay.balance;
}

export function evaluateOrderImpact(
  accounts: Account[],
  inflows: IncomingPayment[],
  orders: SupplierOrder[],
  candidate: Omit<SupplierOrder, 'id'>,
  settings?: AppSettings,
): OrderImpact {
  const placeholderOrder: SupplierOrder = {
    ...candidate,
    id: 'new-order',
    supplier_id: candidate.supplier_id,
  };

  const plan = buildCashPlan(accounts, inflows, [...orders, placeholderOrder], settings);

  return {
    ok: plan.minBalance >= 0,
    minBalance: plan.minBalance,
    cashGap: plan.cashGap,
  };
}
