import { addDays, addMonths, formatISO, getDaysInMonth, isAfter, parseISO, startOfDay, startOfMonth } from 'date-fns';
import {
  Account,
  AppSettings,
  CashEvent,
  CashPlanResult,
  Currency,
  DailyStat,
  IncomingPayment,
  OrderImpact,
  PlannedExpense,
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

function normalizeDay(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed)) return null;
  const day = Math.trunc(parsed);
  if (day < 1 || day > 31) return null;
  return day;
}

function resolveMonthlyDate(monthStart: Date, day: number): Date {
  const daysInMonth = getDaysInMonth(monthStart);
  const safeDay = Math.min(day, daysInMonth);
  const result = new Date(monthStart);
  result.setDate(safeDay);
  return result;
}

function collectEvents(
  accounts: Account[],
  inflows: IncomingPayment[],
  orders: SupplierOrder[],
  rates: Record<Currency, number>,
): CashEvent[] {
  const events: CashEvent[] = [];
  const todayKey = toDateKey(new Date());

  inflows.forEach((inflow) => {
    const expectedDate = toDateKey(inflow.expected_date);

    if (inflow.kind === 'planned' && expectedDate < todayKey) {
      return;
    }

    events.push({
      amount: normalizeAmount(inflow.amount),
      date: expectedDate,
      description: `${inflow.counterparty} (${inflow.kind === 'fixed' ? 'фиксированный' : 'плановый'})`,
      type: 'inflow',
    });
  });

  orders.forEach((order) => {
    const currency = order.currency ?? 'RUB';
    const rate = rates[currency] ?? 1;
    const deposit = normalizeAmount(order.deposit_amount) * rate;
    const remainder = normalizeAmount(order.total_amount) * rate - deposit;
    const depositPaid = Boolean(order.deposit_paid);

    if (deposit > 0 && !depositPaid) {
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

function collectExpenseEvents(expenses: PlannedExpense[], horizonDays: number): CashEvent[] {
  if (!expenses.length) return [];

  const today = startOfDay(new Date());
  const horizonLimit = addDays(today, horizonDays);
  const firstMonth = startOfMonth(today);
  const lastMonth = startOfMonth(horizonLimit);
  const events: CashEvent[] = [];

  expenses.forEach((expense) => {
    const primaryDay = normalizeDay(expense.day_primary);
    const secondaryDay = normalizeDay(expense.day_secondary);
    if (!primaryDay) return;

    const totalAmount = normalizeAmount(expense.amount);
    const primaryProvided = expense.amount_primary !== null && expense.amount_primary !== undefined;
    const secondaryProvided = expense.amount_secondary !== null && expense.amount_secondary !== undefined;
    let primaryAmount = primaryProvided ? normalizeAmount(expense.amount_primary) : null;
    let secondaryAmount = secondaryProvided ? normalizeAmount(expense.amount_secondary) : null;
    const hasSplit = typeof secondaryDay === 'number';

    if (hasSplit) {
      if (primaryAmount !== null && secondaryAmount === null) {
        secondaryAmount = totalAmount - primaryAmount;
      }

      if (secondaryAmount !== null && primaryAmount === null) {
        primaryAmount = totalAmount - secondaryAmount;
      }

      if (primaryAmount === null) {
        primaryAmount = totalAmount;
      }

      if (secondaryAmount === null) {
        secondaryAmount = totalAmount - primaryAmount;
      }
    } else if (primaryAmount === null) {
      primaryAmount = totalAmount;
    }

    if (!primaryAmount && !secondaryAmount) return;

    let cursor = firstMonth;

    while (!isAfter(cursor, lastMonth)) {
      const hasSecondaryEvent = hasSplit && secondaryDay && (secondaryAmount ?? 0) > 0;
      const primaryDate = resolveMonthlyDate(cursor, primaryDay);
      if (!isAfter(today, primaryDate) && !isAfter(primaryDate, horizonLimit) && (primaryAmount ?? 0) > 0) {
        const suffix = hasSecondaryEvent ? ' (часть 1/2)' : '';
        events.push({
          amount: -(primaryAmount ?? 0),
          date: toDateKey(primaryDate),
          description: `${expense.title} — плановый расход${suffix}`,
          type: 'outflow',
          source: expense.id,
        });
      }

      if (hasSecondaryEvent) {
        const secondaryDate = resolveMonthlyDate(cursor, secondaryDay);
        if (!isAfter(today, secondaryDate) && !isAfter(secondaryDate, horizonLimit)) {
          events.push({
            amount: -(secondaryAmount ?? 0),
            date: toDateKey(secondaryDate),
            description: `${expense.title} — плановый расход (часть 2/2)`,
            type: 'outflow',
            source: expense.id,
          });
        }
      }

      cursor = addMonths(cursor, 1);
    }
  });

  return events;
}

export function buildCashPlan(
  accounts: Account[],
  inflows: IncomingPayment[],
  orders: SupplierOrder[],
  expenses: PlannedExpense[],
  settings?: AppSettings,
  horizonDays = 120,
): CashPlanResult {
  const rates: Record<Currency, number> = {
    RUB: 1,
    CNY: currencyRate('CNY', settings),
  };
  const events = [
    ...collectEvents(accounts, inflows, orders, rates),
    ...collectExpenseEvents(expenses, horizonDays),
  ].sort((a, b) => (a.date > b.date ? 1 : -1));
  const openingBalance = accounts.reduce((sum, account) => sum + normalizeAmount(account.balance), 0);

  if (events.length === 0) {
    const normalizedOpening = Number(openingBalance.toFixed(2));
    return {
      openingBalance: normalizedOpening,
      daily: [],
      minBalance: normalizedOpening,
      cashGap: normalizedOpening < 0 ? Number((-normalizedOpening).toFixed(2)) : 0,
    };
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
  expenses: PlannedExpense[],
  candidate: Omit<SupplierOrder, 'id'>,
  settings?: AppSettings,
): OrderImpact {
  const placeholderOrder: SupplierOrder = {
    ...candidate,
    id: 'new-order',
    supplier_id: candidate.supplier_id,
  };

  const plan = buildCashPlan(accounts, inflows, [...orders, placeholderOrder], expenses, settings);

  return {
    ok: plan.minBalance >= 0,
    minBalance: plan.minBalance,
    cashGap: plan.cashGap,
  };
}
