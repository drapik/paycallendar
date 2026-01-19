'use client';

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { format, parseISO } from 'date-fns';
import {
  Account,
  AppSettings,
  CashEvent,
  CashPlanResult,
  Counterparty,
  Currency,
  DailyStat,
  IncomingPayment,
  PlannedExpense,
  Supplier,
  SupplierOrder,
} from '@/types/finance';
import { buildCashPlan, projectBalanceOnDate } from '@/lib/cashflow';
import { DEFAULT_SETTINGS, normalizeSettings, currencyRate } from '@/lib/settings';
import { getBrowserSupabase } from '@/lib/supabaseBrowser';

interface OrderFormState {
  title: string;
  supplierId: string;
  newSupplier: string;
  totalAmount: string;
  depositAmount: string;
  depositPaid: boolean;
  depositDate: string;
  dueDate: string;
  description: string;
  currency: Currency;
}

interface AccountFormState {
  name: string;
  balance: string;
}

interface InflowFormState {
  counterpartyId: string;
  newCounterparty: string;
  amount: string;
  expectedDate: string;
  kind: 'fixed' | 'planned';
  notes: string;
}

interface ExpenseFormState {
  title: string;
  totalAmount: string;
  primaryAmount: string;
  secondaryAmount: string;
  dayPrimary: string;
  daySecondary: string;
}

interface CheckResult {
  ok: boolean;
  cashGap: number;
}

type AccountRow = Account & { balance: number | string };
type OrderWithSupplier = SupplierOrder & {
  supplier_name?: string | null;
  suppliers?: { name?: string | null } | null;
  total_amount: number | string;
  deposit_amount: number | string;
};
type InflowRow = IncomingPayment & { amount: number | string; counterparties?: { name?: string | null } | null };
type ExpenseRow = Omit<PlannedExpense, 'amount' | 'amount_primary' | 'amount_secondary'> & {
  amount: number | string;
  amount_primary?: number | string | null;
  amount_secondary?: number | string | null;
};
type CleanupTarget = 'all' | 'accounts' | 'suppliers' | 'counterparties' | 'orders' | 'inflows' | 'expenses';
interface DataResponse {
  accounts: AccountRow[];
  suppliers: Supplier[];
  counterparties: Counterparty[];
  orders: OrderWithSupplier[];
  inflows: InflowRow[];
  expenses: ExpenseRow[];
  settings: AppSettings;
  error?: string;
}

interface SettingsFormState {
  cnyRate: string;
}

const today = new Date().toISOString().slice(0, 10);
const ORDERS_PAGE_SIZE = 5;
const ACCOUNTS_PAGE_SIZE = 5;
const INFLOWS_PAGE_SIZE = 5;
const EXPENSES_PAGE_SIZE = 5;
const DAILY_PAGE_SIZE = 10;
const DEFAULT_CHART_WINDOW = 30;
const MIN_CHART_WINDOW = 7;
const CHART_WIDTH = 820;
const CHART_HEIGHT = 280;
const CHART_MARGIN = { top: 20, right: 24, bottom: 40, left: 72 };
const CHART_Y_TICKS = 5;
const CHART_X_TICKS = 6;
const EXPENSE_DAY_OPTIONS = Array.from({ length: 31 }, (_, idx) => idx + 1);

function formatDate(date: string) {
  try {
    return format(parseISO(date), 'dd.MM.yyyy');
  } catch {
    return date;
  }
}

function extractErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : 'Неизвестная ошибка';
}

function formatCurrency(amount: number, currency: Currency) {
  const symbol = currency === 'CNY' ? '¥' : '₽';
  return `${Number(amount ?? 0).toLocaleString('ru-RU')} ${symbol}`;
}

function formatRubEquivalent(amount: number, currency: Currency, settings: AppSettings) {
  const rate = currencyRate(currency, settings);
  return (Number(amount ?? 0) * rate).toLocaleString('ru-RU');
}

function parseAmountInput(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function formatAmountInput(value: number): string {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

type ParsedJson = { error?: string; [key: string]: any };

async function parseJsonSafe<T extends ParsedJson = ParsedJson>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    return response.json() as Promise<T>;
  }

  const fallback = await response.text();

  return {
    error:
      fallback ||
      'Сервер вернул некорректный ответ. Проверьте подключение к БД и переменные SUPABASE_URL/SUPABASE_KEY в .env.local.',
  } as T;
}

function Badge({ type }: { type: CashEvent['type'] }) {
  const map: Record<CashEvent['type'], string> = {
    opening: 'bg-blue-100 text-blue-700',
    inflow: 'bg-emerald-100 text-emerald-700',
    outflow: 'bg-amber-100 text-amber-700',
  };
  const label: Record<CashEvent['type'], string> = {
    opening: 'Старт',
    inflow: 'Поступление',
    outflow: 'Платёж',
  };

  return <span className={`px-2 py-1 text-xs font-semibold rounded-full ${map[type]}`}>{label[type]}</span>;
}

export default function Home() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [orders, setOrders] = useState<OrderWithSupplier[]>([]);
  const [inflows, setInflows] = useState<InflowRow[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [importingOrders, setImportingOrders] = useState(false);
  const [checkingOrders, setCheckingOrders] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<CashPlanResult | null>(null);
  const [calculatorDate, setCalculatorDate] = useState(today);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [ordersPage, setOrdersPage] = useState(1);
  const [accountsPage, setAccountsPage] = useState(1);
  const [inflowsPage, setInflowsPage] = useState(1);
  const [expensesPage, setExpensesPage] = useState(1);
  const [dailyPage, setDailyPage] = useState(1);
  const [cleaningTarget, setCleaningTarget] = useState<CleanupTarget | null>(null);
  const [chartWindowSize, setChartWindowSize] = useState(DEFAULT_CHART_WINDOW);
  const [chartWindowStart, setChartWindowStart] = useState(0);
  const [hoveredChartIndex, setHoveredChartIndex] = useState<number | null>(null);
  const [serviceOpen, setServiceOpen] = useState(false);

  const [accountForm, setAccountForm] = useState<AccountFormState>({ name: '', balance: '' });
  const [inflowForm, setInflowForm] = useState<InflowFormState>({
    counterpartyId: '',
    newCounterparty: '',
    amount: '',
    expectedDate: today,
    kind: 'fixed',
    notes: '',
  });
  const [expenseForm, setExpenseForm] = useState<ExpenseFormState>({
    title: '',
    totalAmount: '',
    primaryAmount: '',
    secondaryAmount: '',
    dayPrimary: String(new Date().getDate()),
    daySecondary: '',
  });
  const [expensePartEdited, setExpensePartEdited] = useState<'primary' | 'secondary' | null>(null);
  const [orderForm, setOrderForm] = useState<OrderFormState>({
    title: '',
    supplierId: '',
    newSupplier: '',
    totalAmount: '',
    depositAmount: '',
    depositPaid: false,
    depositDate: today,
    dueDate: today,
    description: '',
    currency: 'RUB',
  });
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editingOrderUpdatedAt, setEditingOrderUpdatedAt] = useState<string | null>(null);
  const [editingOrderStale, setEditingOrderStale] = useState(false);
  const [orderDialogOpen, setOrderDialogOpen] = useState(false);
  const [orderDialogMode, setOrderDialogMode] = useState<'details' | 'form'>('details');
  const [orderDialogOrderId, setOrderDialogOrderId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsForm, setSettingsForm] = useState<SettingsFormState>({
    cnyRate: DEFAULT_SETTINGS.cnyRate.toString(),
  });
  const [activeTab, setActiveTab] = useState<'orders' | 'accounts' | 'inflows' | 'expenses'>('orders');

  const totalBalance = useMemo(
    () => accounts.reduce((sum, item) => sum + Number(item.balance ?? 0), 0),
    [accounts],
  );
  const orderDialogOrder = useMemo(
    () => orders.find((order) => order.id === orderDialogOrderId) ?? null,
    [orders, orderDialogOrderId],
  );

  const orderTotals = useMemo(
    () =>
      orders.reduce(
        (acc, order) => ({
          total:
            acc.total + Number(order.total_amount ?? 0) * currencyRate(order.currency ?? 'RUB', settings),
          depositsPlanned:
            acc.depositsPlanned +
            (order.deposit_paid
              ? 0
              : Number(order.deposit_amount ?? 0) * currencyRate(order.currency ?? 'RUB', settings)),
          depositsPaid:
            acc.depositsPaid +
            (order.deposit_paid
              ? Number(order.deposit_amount ?? 0) * currencyRate(order.currency ?? 'RUB', settings)
              : 0),
        }),
        { total: 0, depositsPlanned: 0, depositsPaid: 0 },
      ),
    [orders, settings],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/data');
      const payload = (await parseJsonSafe(response)) as Partial<DataResponse>;
      if (!response.ok) {
        throw new Error(payload.error || 'Не удалось загрузить данные');
      }

      const normalizedAccounts: Account[] = (payload.accounts ?? []).map((item) => ({
        ...item,
        balance: Number(item.balance ?? 0),
      }));

      const normalizedOrders: OrderWithSupplier[] = (payload.orders ?? []).map((item) => ({
        ...item,
        total_amount: Number(item.total_amount ?? 0),
        deposit_amount: Number(item.deposit_amount ?? 0),
        deposit_paid: Boolean(item.deposit_paid),
        currency: (item.currency as Currency) || 'RUB',
      }));

      const normalizedInflows: InflowRow[] = (payload.inflows ?? []).map((item) => ({
        ...item,
        counterparty: item.counterparty || item.counterparties?.name || 'Без контрагента',
        amount: Number(item.amount ?? 0),
      }));

      const normalizedExpenses: ExpenseRow[] = (payload.expenses ?? []).map((item) => ({
        ...item,
        amount: Number(item.amount ?? 0),
        amount_primary:
          item.amount_primary === null || item.amount_primary === undefined ? null : Number(item.amount_primary),
        amount_secondary:
          item.amount_secondary === null || item.amount_secondary === undefined ? null : Number(item.amount_secondary),
        day_primary: Number(item.day_primary ?? 1),
        day_secondary:
          item.day_secondary === null || item.day_secondary === undefined
            ? null
            : Number(item.day_secondary),
      }));

      const normalizedSettings = normalizeSettings(payload.settings || DEFAULT_SETTINGS);

      setAccounts(normalizedAccounts);
      setSuppliers(payload.suppliers || []);
      setCounterparties(payload.counterparties || []);
      setOrders(normalizedOrders);
      setInflows(normalizedInflows);
      setExpenses(normalizedExpenses);
      setSettings(normalizedSettings);
      setSettingsForm({ cnyRate: normalizedSettings.cnyRate.toString() });
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const supabaseBrowser = getBrowserSupabase();
    if (!supabaseBrowser) return;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        loadData();
      }, 200);
    };

    const channel = supabaseBrowser
      .channel('paycallendar-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'suppliers' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'counterparties' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supplier_orders' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'incoming_payments' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'planned_expenses' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, scheduleRefresh)
      .subscribe();

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      supabaseBrowser.removeChannel(channel);
    };
  }, [loadData]);

  useEffect(() => {
    const cashPlan = buildCashPlan(accounts, inflows, orders, expenses, settings);
    setPlan(cashPlan);
  }, [accounts, inflows, orders, expenses, settings]);

  useEffect(() => {
    if (!editingOrderId) {
      setEditingOrderStale(false);
      return;
    }

    const latest = orders.find((order) => order.id === editingOrderId);
    if (!latest?.updated_at || !editingOrderUpdatedAt) return;

    setEditingOrderStale(latest.updated_at !== editingOrderUpdatedAt);
  }, [editingOrderId, editingOrderUpdatedAt, orders]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(orders.length / ORDERS_PAGE_SIZE));
    setOrdersPage((prev) => Math.min(prev, totalPages));
  }, [orders.length]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(accounts.length / ACCOUNTS_PAGE_SIZE));
    setAccountsPage((prev) => Math.min(prev, totalPages));
  }, [accounts.length]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(inflows.length / INFLOWS_PAGE_SIZE));
    setInflowsPage((prev) => Math.min(prev, totalPages));
  }, [inflows.length]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(expenses.length / EXPENSES_PAGE_SIZE));
    setExpensesPage((prev) => Math.min(prev, totalPages));
  }, [expenses.length]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil((plan?.daily.length || 0) / DAILY_PAGE_SIZE));
    setDailyPage((prev) => Math.min(prev, totalPages));
  }, [plan?.daily.length]);

  const resetMessages = () => {
    setMessage(null);
    setError(null);
  };

  const handleSettingsSave = async () => {
    resetMessages();
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cnyRate: Number(settingsForm.cnyRate) }),
      });

      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось сохранить настройки');

      const normalizedSettings = normalizeSettings(payload.settings ?? settings);
      setSettings(normalizedSettings);
      setSettingsForm({ cnyRate: normalizedSettings.cnyRate.toString() });
      setMessage('Настройки сохранены');
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleMoyskladImport = async () => {
    resetMessages();
    setImportingOrders(true);

    try {
      const response = await fetch('/api/moysklad/import', { method: 'POST' });
      const payload = await parseJsonSafe(response);

      if (!response.ok) throw new Error(payload.error || 'Не удалось выгрузить заказы');

      const imported = Number(payload.saved ?? payload.imported ?? 0);
      const total = Number(payload.imported ?? imported);
      const label = imported || total ? `${imported || total}` : '0';

      setMessage(`Выгружено и сохранено ${label} заказов из МойСклад`);
      await loadData();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setImportingOrders(false);
    }
  };

  const handleMoyskladCount = async () => {
    resetMessages();
    setCheckingOrders(true);

    try {
      const response = await fetch('/api/moysklad/import');
      const payload = await parseJsonSafe(response);

      if (!response.ok) throw new Error(payload.error || 'Не удалось получить количество заказов');

      const total = Number(payload.count ?? payload.total ?? payload.imported ?? 0);
      setMessage(`Сейчас по фильтрам в МойСклад ${total} заказов`);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setCheckingOrders(false);
    }
  };

  const cleanupLabels: Record<CleanupTarget, string> = {
    all: 'всех таблицах',
    accounts: 'счетах',
    suppliers: 'поставщиках',
    counterparties: 'контрагентах',
    orders: 'заказах поставщикам',
    inflows: 'поступлениях',
    expenses: 'расходах',
  };

  const handleCleanup = async (target: CleanupTarget) => {
    resetMessages();
    setCleaningTarget(target);

    try {
      const response = await fetch('/api/admin/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });

      const payload = await parseJsonSafe(response);

      if (!response.ok) {
        throw new Error(payload.error || 'Не удалось очистить данные');
      }

      await loadData();

      if (target === 'all') {
        setMessage('Все ключевые таблицы очищены');
      } else {
        const deleted = Number(payload.deleted ?? 0);
        setMessage(`Удалено ${deleted} записей в ${cleanupLabels[target]}`);
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setCleaningTarget(null);
    }
  };

  const handleAccountSubmit = async () => {
    resetMessages();
    try {
      const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: accountForm.name,
          balance: Number(accountForm.balance || 0),
        }),
      });

      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось сохранить счёт');

      setAccountForm({ name: '', balance: '' });
      setMessage('Счёт сохранён');
      loadData();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleAccountUpdate = async (account: Account, newBalance: number) => {
    resetMessages();
    try {
      if (!account.updated_at) {
        throw new Error('Не удалось обновить счёт: обновите данные и попробуйте ещё раз.');
      }
      const response = await fetch('/api/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...account, balance: newBalance, updated_at: account.updated_at }),
      });
      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось обновить счёт');
      loadData();
      setMessage('Баланс обновлён');
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleAccountDelete = async (account: Account) => {
    resetMessages();
    try {
      const response = await fetch(`/api/accounts?id=${account.id}`, { method: 'DELETE' });
      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось удалить счёт');
      setMessage('Счёт удалён');
      await loadData();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const resolveCounterparty = async (): Promise<{ id: string | null; name: string } | null> => {
    if (inflowForm.counterpartyId) {
      const selected = counterparties.find((item) => item.id === inflowForm.counterpartyId);
      return selected ? { id: selected.id, name: selected.name } : null;
    }

    if (!inflowForm.newCounterparty) return null;

    const response = await fetch('/api/counterparties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: inflowForm.newCounterparty }),
    });

    const payload = await parseJsonSafe(response);
    if (!response.ok) throw new Error(payload.error || 'Не удалось создать контрагента');
    await loadData();

    return { id: payload.data?.id ?? null, name: payload.data?.name ?? inflowForm.newCounterparty };
  };

  const handleInflowSubmit = async () => {
    resetMessages();
    try {
      const counterparty = await resolveCounterparty();
      if (!counterparty) throw new Error('Укажите контрагента');

      const response = await fetch('/api/inflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          counterparty_id: counterparty.id,
          counterparty_name: counterparty.name,
          amount: Number(inflowForm.amount),
          expected_date: inflowForm.expectedDate,
          kind: inflowForm.kind,
          notes: inflowForm.notes,
        }),
      });
      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось добавить поступление');
      setInflowForm({
        counterpartyId: '',
        newCounterparty: '',
        amount: '',
        expectedDate: today,
        kind: 'fixed',
        notes: '',
      });
      setMessage('Поступление добавлено');
      loadData();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleInflowDelete = async (inflow: IncomingPayment) => {
    resetMessages();
    try {
      const response = await fetch(`/api/inflows?id=${inflow.id}`, { method: 'DELETE' });
      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось удалить поступление');
      setMessage('Поступление удалено');
      await loadData();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleExpenseSubmit = async () => {
    resetMessages();
    try {
      const totalAmount = parseAmountInput(expenseForm.totalAmount);
      if (!expenseForm.title || totalAmount === null || !expenseForm.dayPrimary) {
        throw new Error('Укажите название, сумму и дату расхода');
      }
      if (totalAmount < 0) {
        throw new Error('Сумма расхода не может быть отрицательной');
      }

      const secondaryDay = expenseForm.daySecondary ? Number(expenseForm.daySecondary) : null;
      const primaryProvided = expenseForm.primaryAmount.trim() !== '';
      const secondaryProvided = expenseForm.secondaryAmount.trim() !== '';
      const primaryAmount = primaryProvided ? parseAmountInput(expenseForm.primaryAmount) : null;
      const secondaryAmount = secondaryProvided ? parseAmountInput(expenseForm.secondaryAmount) : null;

      if (primaryProvided && primaryAmount === null) {
        throw new Error('Неверная сумма для первой даты');
      }

      if (secondaryProvided && secondaryAmount === null) {
        throw new Error('Неверная сумма для второй даты');
      }

      let resolvedPrimary: number | null = null;
      let resolvedSecondary: number | null = null;

      if (secondaryDay) {
        if (!primaryProvided && !secondaryProvided) {
          throw new Error('Укажите сумму для одной из дат');
        }

        resolvedPrimary = primaryAmount;
        resolvedSecondary = secondaryAmount;

        if (resolvedPrimary !== null && resolvedSecondary === null) {
          resolvedSecondary = totalAmount - resolvedPrimary;
        }

        if (resolvedSecondary !== null && resolvedPrimary === null) {
          resolvedPrimary = totalAmount - resolvedSecondary;
        }

        if (resolvedPrimary === null || resolvedSecondary === null) {
          throw new Error('Не удалось рассчитать суммы расхода');
        }

        if (resolvedPrimary < 0 || resolvedSecondary < 0) {
          throw new Error('Суммы частей не могут быть отрицательными');
        }

        if (Math.abs(resolvedPrimary + resolvedSecondary - totalAmount) > 0.01) {
          throw new Error('Сумма частей должна равняться общей сумме');
        }
      }

      const response = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: expenseForm.title,
          amount: totalAmount,
          day_primary: Number(expenseForm.dayPrimary),
          day_secondary: secondaryDay,
          amount_primary: secondaryDay ? resolvedPrimary : null,
          amount_secondary: secondaryDay ? resolvedSecondary : null,
        }),
      });
      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось добавить расход');
      setExpenseForm({
        title: '',
        totalAmount: '',
        primaryAmount: '',
        secondaryAmount: '',
        dayPrimary: String(new Date().getDate()),
        daySecondary: '',
      });
      setExpensePartEdited(null);
      setMessage('Расход добавлен');
      loadData();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleExpenseDelete = async (expense: { id: string }) => {
    resetMessages();
    try {
      const response = await fetch(`/api/expenses?id=${expense.id}`, { method: 'DELETE' });
      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось удалить расход');
      setMessage('Расход удалён');
      await loadData();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleExpenseTotalChange = (value: string) => {
    setExpenseForm((prev) => {
      const next = { ...prev, totalAmount: value };
      if (!prev.daySecondary) return next;
      const total = parseAmountInput(value);
      if (total === null) return next;

      const primary = parseAmountInput(prev.primaryAmount);
      const secondary = parseAmountInput(prev.secondaryAmount);

      if (expensePartEdited === 'primary' && primary !== null) {
        next.secondaryAmount = formatAmountInput(total - primary);
      } else if (expensePartEdited === 'secondary' && secondary !== null) {
        next.primaryAmount = formatAmountInput(total - secondary);
      } else if (primary !== null) {
        next.secondaryAmount = formatAmountInput(total - primary);
      } else if (secondary !== null) {
        next.primaryAmount = formatAmountInput(total - secondary);
      }

      return next;
    });
  };

  const handleExpensePrimaryChange = (value: string) => {
    setExpensePartEdited('primary');
    setExpenseForm((prev) => {
      const next = { ...prev, primaryAmount: value };
      if (!prev.daySecondary) return next;
      const total = parseAmountInput(prev.totalAmount);
      const primary = parseAmountInput(value);
      if (total === null || primary === null) return next;
      next.secondaryAmount = formatAmountInput(total - primary);
      return next;
    });
  };

  const handleExpenseSecondaryChange = (value: string) => {
    setExpensePartEdited('secondary');
    setExpenseForm((prev) => {
      const next = { ...prev, secondaryAmount: value };
      if (!prev.daySecondary) return next;
      const total = parseAmountInput(prev.totalAmount);
      const secondary = parseAmountInput(value);
      if (total === null || secondary === null) return next;
      next.primaryAmount = formatAmountInput(total - secondary);
      return next;
    });
  };

  const handleExpenseSecondaryDayChange = (value: string) => {
    if (!value) {
      setExpensePartEdited(null);
    }
    setExpenseForm((prev) => {
      const next = { ...prev, daySecondary: value };
      if (!value) {
        next.primaryAmount = '';
        next.secondaryAmount = '';
        return next;
      }
      const total = parseAmountInput(prev.totalAmount);
      if (total === null) return next;
      const primary = parseAmountInput(prev.primaryAmount);
      const secondary = parseAmountInput(prev.secondaryAmount);
      if (primary !== null) {
        next.secondaryAmount = formatAmountInput(total - primary);
      } else if (secondary !== null) {
        next.primaryAmount = formatAmountInput(total - secondary);
      }
      return next;
    });
  };

  const resolveSupplierId = async (): Promise<string | null> => {
    if (orderForm.supplierId) return orderForm.supplierId;
    if (!orderForm.newSupplier) return null;

    const response = await fetch('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: orderForm.newSupplier }),
    });

    const payload = await parseJsonSafe(response);
    if (!response.ok) throw new Error(payload.error || 'Не удалось создать поставщика');
    await loadData();
    return payload.data?.id ?? null;
  };

  const resetOrderForm = () => {
    setOrderForm({
      title: '',
      supplierId: '',
      newSupplier: '',
      totalAmount: '',
      depositAmount: '',
      depositPaid: false,
      depositDate: today,
      dueDate: today,
      description: '',
      currency: 'RUB',
    });
    setEditingOrderId(null);
    setEditingOrderUpdatedAt(null);
    setEditingOrderStale(false);
    setCheckResult(null);
  };

  const startOrderEdit = (order: OrderWithSupplier) => {
    resetMessages();
    setCheckResult(null);
    setEditingOrderId(order.id);
    setEditingOrderUpdatedAt(order.updated_at ?? null);
    setEditingOrderStale(false);
    setOrderForm({
      title: order.title,
      supplierId: order.supplier_id || '',
      newSupplier: '',
      totalAmount: String(order.total_amount ?? ''),
      depositAmount: String(order.deposit_amount ?? ''),
      depositPaid: Boolean(order.deposit_paid),
      depositDate: order.deposit_date || today,
      dueDate: order.due_date || today,
      description: order.description || '',
      currency: order.currency ?? 'RUB',
    });
  };

  const closeOrderDialog = () => {
    setOrderDialogOpen(false);
    setOrderDialogMode('details');
    setOrderDialogOrderId(null);
    resetOrderForm();
  };

  const openOrderCreate = () => {
    resetMessages();
    resetOrderForm();
    setOrderDialogMode('form');
    setOrderDialogOrderId(null);
    setOrderDialogOpen(true);
  };

  const openOrderEdit = (order: OrderWithSupplier) => {
    startOrderEdit(order);
    setOrderDialogMode('form');
    setOrderDialogOrderId(order.id);
    setOrderDialogOpen(true);
  };

  const openOrderDetails = (order: OrderWithSupplier) => {
    resetMessages();
    setOrderDialogMode('details');
    setOrderDialogOrderId(order.id);
    setOrderDialogOpen(true);
  };

  const handleOrderSubmit = async () => {
    resetMessages();
    try {
      const supplier_id = await resolveSupplierId();
      if (editingOrderId && !editingOrderUpdatedAt) {
        throw new Error('Не удалось сохранить: обновите данные и попробуйте ещё раз.');
      }
      const response = await fetch('/api/orders', {
        method: editingOrderId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingOrderId ?? undefined,
          supplier_id,
          title: orderForm.title,
          total_amount: Number(orderForm.totalAmount),
          deposit_amount: Number(orderForm.depositAmount) || 0,
          deposit_paid: orderForm.depositPaid,
          deposit_date: orderForm.depositDate,
          due_date: orderForm.dueDate,
          currency: orderForm.currency,
          description: orderForm.description,
          updated_at: editingOrderUpdatedAt ?? undefined,
        }),
      });

      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось сохранить заказ');
      closeOrderDialog();
      setMessage(editingOrderId ? 'Заказ обновлён' : 'Заказ добавлен');
      await loadData();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleOrderDelete = async (order: SupplierOrder) => {
    resetMessages();
    try {
      const response = await fetch(`/api/orders?id=${order.id}`, { method: 'DELETE' });
      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось удалить заказ');
      setMessage('Заказ удалён');
      if (orderDialogOrderId === order.id) {
        closeOrderDialog();
      } else if (editingOrderId === order.id) {
        resetOrderForm();
      }
      await loadData();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleOrderCheck = async () => {
    resetMessages();
    setCheckResult(null);
    try {
      const supplier_id = orderForm.supplierId || null;
      const response = await fetch('/api/orders/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingOrderId ?? undefined,
          supplier_id,
          title: orderForm.title || 'Новый заказ',
          total_amount: Number(orderForm.totalAmount),
          deposit_amount: Number(orderForm.depositAmount) || 0,
          deposit_paid: orderForm.depositPaid,
          deposit_date: orderForm.depositDate,
          due_date: orderForm.dueDate,
          currency: orderForm.currency,
          description: orderForm.description,
        }),
      });

      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось проверить заказ');
      setCheckResult(payload.impact);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const availableOnDate = useMemo(() => {
    if (!plan) return null;
    return projectBalanceOnDate(plan, calculatorDate || today);
  }, [plan, calculatorDate]);

  const totalOrderPages = Math.max(1, Math.ceil(orders.length / ORDERS_PAGE_SIZE));
  const paginatedOrders = useMemo(() => {
    const start = (ordersPage - 1) * ORDERS_PAGE_SIZE;
    return orders.slice(start, start + ORDERS_PAGE_SIZE);
  }, [orders, ordersPage]);

  const totalAccountPages = Math.max(1, Math.ceil(accounts.length / ACCOUNTS_PAGE_SIZE));
  const paginatedAccounts = useMemo(() => {
    const start = (accountsPage - 1) * ACCOUNTS_PAGE_SIZE;
    return accounts.slice(start, start + ACCOUNTS_PAGE_SIZE);
  }, [accounts, accountsPage]);

  const totalInflowPages = Math.max(1, Math.ceil(inflows.length / INFLOWS_PAGE_SIZE));
  const paginatedInflows = useMemo(() => {
    const start = (inflowsPage - 1) * INFLOWS_PAGE_SIZE;
    return inflows.slice(start, start + INFLOWS_PAGE_SIZE);
  }, [inflows, inflowsPage]);

  const totalExpensePages = Math.max(1, Math.ceil(expenses.length / EXPENSES_PAGE_SIZE));
  const paginatedExpenses = useMemo(() => {
    const start = (expensesPage - 1) * EXPENSES_PAGE_SIZE;
    return expenses.slice(start, start + EXPENSES_PAGE_SIZE);
  }, [expenses, expensesPage]);

  const totalDailyPages = Math.max(1, Math.ceil((plan?.daily.length || 0) / DAILY_PAGE_SIZE));
  const paginatedDaily = useMemo(() => {
    const start = (dailyPage - 1) * DAILY_PAGE_SIZE;
    return plan?.daily.slice(start, start + DAILY_PAGE_SIZE) || [];
  }, [dailyPage, plan?.daily]);

  const chartData = useMemo(() => plan?.daily ?? [], [plan?.daily]);
  const cashGapDays = useMemo(() => plan?.daily.filter((day) => day.balance < 0) ?? [], [plan?.daily]);

  useEffect(() => {
    if (!chartData.length) {
      setChartWindowSize(DEFAULT_CHART_WINDOW);
      setChartWindowStart(0);
      setHoveredChartIndex(null);
      return;
    }

    const minWindow = Math.min(MIN_CHART_WINDOW, chartData.length);
    const fallback = Math.min(DEFAULT_CHART_WINDOW, chartData.length);

    setChartWindowSize((prev) => {
      const next = Math.min(Math.max(prev || fallback, minWindow), chartData.length);
      return next;
    });
  }, [chartData.length]);

  useEffect(() => {
    if (!chartData.length) return;
    const maxStart = Math.max(0, chartData.length - chartWindowSize);
    setChartWindowStart((prev) => Math.min(prev, maxStart));
  }, [chartData.length, chartWindowSize]);

  const visibleChartData = useMemo(
    () => chartData.slice(chartWindowStart, chartWindowStart + chartWindowSize),
    [chartData, chartWindowStart, chartWindowSize],
  );

  useEffect(() => {
    if (hoveredChartIndex === null) return;
    if (hoveredChartIndex >= visibleChartData.length) {
      setHoveredChartIndex(null);
    }
  }, [hoveredChartIndex, visibleChartData.length]);

  const chartBounds = useMemo(() => {
    if (!visibleChartData.length) return { min: 0, max: 0 };
    const balances = visibleChartData.map((day) => day.balance);
    const min = Math.min(...balances);
    const max = Math.max(...balances);
    return { min, max };
  }, [visibleChartData]);

  const chartScale = useMemo(() => {
    const range = chartBounds.max - chartBounds.min || 1;
    const padding = range * 0.1;
    return { min: chartBounds.min - padding, max: chartBounds.max + padding };
  }, [chartBounds.max, chartBounds.min]);

  const chartMetrics = useMemo(() => {
    if (!visibleChartData.length) {
      return {
        points: [] as { x: number; y: number; day: DailyStat }[],
        polyline: '',
        area: '',
        xTicks: [] as { x: number; label: string }[],
        yTicks: [] as { y: number; label: string }[],
        xStep: 0,
      };
    }

    const { top, right, bottom, left } = CHART_MARGIN;
    const innerWidth = CHART_WIDTH - left - right;
    const innerHeight = CHART_HEIGHT - top - bottom;
    const range = chartScale.max - chartScale.min || 1;
    const xStep = visibleChartData.length > 1 ? innerWidth / (visibleChartData.length - 1) : 0;

    const scaleX = (idx: number) => left + idx * xStep;
    const scaleY = (value: number) => top + ((chartScale.max - value) / range) * innerHeight;

    const points = visibleChartData.map((day, idx) => ({
      x: scaleX(idx),
      y: scaleY(day.balance),
      day,
    }));
    const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');
    const baseline = top + innerHeight;
    const area = points.length
      ? `${points[0].x},${baseline} ${polyline} ${points[points.length - 1].x},${baseline}`
      : '';

    const yTickCount = Math.max(2, CHART_Y_TICKS);
    const yTicks = Array.from({ length: yTickCount }).map((_, idx) => {
      const value = chartScale.min + (range * idx) / (yTickCount - 1);
      return { y: scaleY(value), label: value.toLocaleString('ru-RU') };
    });

    const xTickCount = Math.min(CHART_X_TICKS, visibleChartData.length);
    const xIndexes = xTickCount > 1
      ? Array.from({ length: xTickCount }).map((_, idx) =>
          Math.round((visibleChartData.length - 1) * (idx / (xTickCount - 1))),
        )
      : [0];
    const xTicks = Array.from(new Set(xIndexes)).map((idx) => ({
      x: scaleX(idx),
      label: formatDate(visibleChartData[idx].date),
    }));

    return { points, polyline, area, xTicks, yTicks, xStep };
  }, [chartScale.max, chartScale.min, visibleChartData]);

  const handleChartMove = useCallback(
    (event: MouseEvent<SVGSVGElement>) => {
      if (!chartMetrics.points.length) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const relativeX = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;
      const clampedX = Math.max(CHART_MARGIN.left, Math.min(CHART_WIDTH - CHART_MARGIN.right, relativeX));
      const index = chartMetrics.xStep ? Math.round((clampedX - CHART_MARGIN.left) / chartMetrics.xStep) : 0;
      const safeIndex = Math.max(0, Math.min(chartMetrics.points.length - 1, index));
      setHoveredChartIndex(safeIndex);
    },
    [chartMetrics.points.length, chartMetrics.xStep],
  );

  const chartRangeLabel =
    visibleChartData.length > 0
      ? `${formatDate(visibleChartData[0].date)} — ${formatDate(visibleChartData[visibleChartData.length - 1].date)}`
      : '—';
  const chartWindowMin = Math.min(MIN_CHART_WINDOW, chartData.length || MIN_CHART_WINDOW);
  const chartWindowMax = Math.max(chartData.length, chartWindowMin);
  const chartWindowSizeValue = Math.min(chartWindowSize, chartWindowMax);
  const maxChartStart = Math.max(0, chartData.length - chartWindowSizeValue);

  const hoveredPoint = hoveredChartIndex !== null ? chartMetrics.points[hoveredChartIndex] : null;
  const tooltipWidth = 170;
  const tooltipHeight = 46;
  const tooltipOffset = 12;
  const tooltipX = hoveredPoint
    ? Math.min(
        CHART_WIDTH - CHART_MARGIN.right - tooltipWidth,
        Math.max(CHART_MARGIN.left, hoveredPoint.x + tooltipOffset),
      )
    : 0;
  const tooltipY = hoveredPoint
    ? Math.min(
        CHART_HEIGHT - CHART_MARGIN.bottom - tooltipHeight,
        Math.max(CHART_MARGIN.top, hoveredPoint.y - tooltipHeight / 2),
      )
    : 0;
  const orderDialogSupplierName =
    orderDialogOrder?.supplier_name || orderDialogOrder?.suppliers?.name || '—';
  const orderDialogTotalAmount = orderDialogOrder ? Number(orderDialogOrder.total_amount) : 0;
  const orderDialogDepositAmount = orderDialogOrder ? Number(orderDialogOrder.deposit_amount) : 0;
  const orderDialogRemainingAmount = orderDialogTotalAmount - orderDialogDepositAmount;

  const inputClassName =
    'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400';
  const inputMutedClassName =
    'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900';
  const textareaClassName = `${inputClassName} min-h-[88px]`;
  const tabButtonClass = (tab: 'orders' | 'accounts' | 'inflows' | 'expenses') =>
    `rounded-lg border px-4 py-2 text-sm font-semibold transition ${
      activeTab === tab
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : 'border-slate-200 text-slate-600 hover:border-slate-300'
    }`;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.25rem] text-slate-500">PAYCALLENDAR</p>
            <h1 className="text-3xl font-bold text-slate-900">Платёжный помощник</h1>
            <p className="text-slate-600">Сводный баланс, кассовые разрывы и контроль заказов поставщикам.</p>
          </div>
          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs text-slate-500">Свободные деньги</p>
            <p className={`text-3xl font-semibold ${totalBalance >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              {totalBalance.toLocaleString('ru-RU', { minimumFractionDigits: 0 })} ₽
            </p>
            {cashGapDays.length > 0 && <p className="mt-1 text-xs text-rose-600">Обнаружен кассовый разрыв</p>}
          </div>
        </header>

        {loading && (
          <p className="mt-2 text-sm text-slate-500">Обновляем данные…</p>
        )}

        {(message || error) && (
          <div
            className={`mt-6 rounded-xl border px-4 py-3 text-sm ${
              error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'
            }`}
          >
            {error || message}
          </div>
        )}

        <section className="mt-8">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Технические настройки</p>
                <h2 className="text-lg font-semibold text-slate-900">Сервисный блок</h2>
                <p className="text-sm text-slate-600">Курс валют, импорт заказов и очистка данных.</p>
              </div>
              <button
                type="button"
                onClick={() => setServiceOpen((prev) => !prev)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-300"
                aria-expanded={serviceOpen}
                aria-controls="service-panel"
              >
                {serviceOpen ? 'Свернуть' : 'Развернуть'}
              </button>
            </div>
            {!serviceOpen && (
              <p className="mt-3 text-xs text-slate-500">
                Разверните блок, чтобы настроить курс валют и сервисные действия.
              </p>
            )}
            {serviceOpen && (
              <div id="service-panel" className="mt-4 space-y-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">Курс валют</p>
                      <p className="text-sm font-semibold text-slate-900">Курс юаня (CNY → ₽)</p>
                      <p className="text-xs text-slate-600">
                        Все расчёты ведутся в рублях, суммы в юанях пересчитываются по указанному курсу.
                      </p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                      <p>Курс применяется ко всем заказам с валютой «Юань»</p>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                    <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
                      Курс юаня (CNY → ₽)
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={settingsForm.cnyRate}
                        onChange={(e) => setSettingsForm((prev) => ({ ...prev, cnyRate: e.target.value }))}
                        className="w-full rounded-lg border px-3 py-2"
                      />
                    </label>
                    <button
                      onClick={handleSettingsSave}
                      className="h-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      Сохранить настройки
                    </button>
                  </div>
                  <div className="mt-3 rounded-lg bg-white p-3 text-xs text-slate-600">
                    <p>Текущий курс: {settings.cnyRate.toLocaleString('ru-RU')} ₽ за 1 ¥</p>
                    <p>Базовая валюта: российские рубли</p>
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <p className="text-xs uppercase tracking-wide text-slate-500">МойСклад</p>
                    <p className="mt-1 text-xs text-slate-600">
                      Импорт заказов поставщикам по фильтрам (агент «Маркетплейсы», статусы «Не принято», «В пути», «Частично принято»).
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={handleMoyskladCount}
                        disabled={checkingOrders || importingOrders}
                        className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 hover:border-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {checkingOrders ? 'Проверяем…' : 'Проверить количество'}
                      </button>
                      <button
                        onClick={handleMoyskladImport}
                        disabled={importingOrders}
                        className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {importingOrders ? 'Выгружаем…' : 'Выгрузить заказы'}
                      </button>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-500">
                      Источник: https://api.moysklad.ru/api/remap/1.2/entity/purchaseorder
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-slate-700">Очистка данных</p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <button
                          onClick={() => handleCleanup('all')}
                          disabled={!!cleaningTarget}
                          className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {cleaningTarget === 'all' ? 'Очищаем всё…' : 'Очистить всю базу'}
                        </button>
                        <button
                          onClick={() => handleCleanup('orders')}
                          disabled={!!cleaningTarget}
                          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {cleaningTarget === 'orders' ? 'Удаляем заказы…' : 'Удалить заказы поставщикам'}
                        </button>
                        <button
                          onClick={() => handleCleanup('accounts')}
                          disabled={!!cleaningTarget}
                          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {cleaningTarget === 'accounts' ? 'Удаляем счета…' : 'Удалить счета'}
                        </button>
                        <button
                          onClick={() => handleCleanup('inflows')}
                          disabled={!!cleaningTarget}
                          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {cleaningTarget === 'inflows' ? 'Удаляем поступления…' : 'Удалить поступления'}
                        </button>
                        <button
                          onClick={() => handleCleanup('expenses')}
                          disabled={!!cleaningTarget}
                          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {cleaningTarget === 'expenses' ? 'Удаляем расходы…' : 'Удалить расходы'}
                        </button>
                        <button
                          onClick={() => handleCleanup('suppliers')}
                          disabled={!!cleaningTarget}
                          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {cleaningTarget === 'suppliers' ? 'Удаляем поставщиков…' : 'Удалить поставщиков'}
                        </button>
                        <button
                          onClick={() => handleCleanup('counterparties')}
                          disabled={!!cleaningTarget}
                          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {cleaningTarget === 'counterparties' ? 'Удаляем контрагентов…' : 'Удалить контрагентов'}
                        </button>
                      </div>
                      <p className="text-xs text-slate-500">
                        Очистка удаляет записи из таблиц без восстановления. Используйте осторожно.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="mt-8">
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Управление сущностями</h2>
                <p className="text-sm text-slate-600">
                  Счета, расходы, ожидаемые поступления и заказы поставщикам — единый интерфейс с вкладками.
                </p>
              </div>
              <span className="text-xs text-slate-500">Заказы — в карточке, остальные сущности — во вкладках</span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Сущности">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'orders'}
                className={tabButtonClass('orders')}
                onClick={() => setActiveTab('orders')}
              >
                Заказы поставщикам
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'accounts'}
                className={tabButtonClass('accounts')}
                onClick={() => setActiveTab('accounts')}
              >
                Счета
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'inflows'}
                className={tabButtonClass('inflows')}
                onClick={() => setActiveTab('inflows')}
              >
                Ожидаемые поступления
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'expenses'}
                className={tabButtonClass('expenses')}
                onClick={() => setActiveTab('expenses')}
              >
                Расходы
              </button>
            </div>

            <div className="mt-4">
              {activeTab === 'orders' && (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Общая сумма заказов</p>
                      <p className="text-2xl font-semibold text-slate-900">
                        {orderTotals.total.toLocaleString('ru-RU')} ₽
                      </p>
                    </div>
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <p className="text-xs uppercase tracking-wide text-emerald-700">Авансы к оплате</p>
                      <p className="text-2xl font-semibold text-emerald-700">
                        {orderTotals.depositsPlanned.toLocaleString('ru-RU')} ₽
                      </p>
                      <p className="text-xs text-emerald-700">
                        Оплачено: {orderTotals.depositsPaid.toLocaleString('ru-RU')} ₽
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">Заказы поставщикам</p>
                      <p className="text-xs text-slate-500">Кликните по заказу, чтобы открыть карточку.</p>
                    </div>
                    <button
                      onClick={openOrderCreate}
                      className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      Добавить заказ
                    </button>
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="min-w-[960px] table-fixed text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                          <th className="w-[20%] px-3 py-2">Заказ</th>
                          <th className="w-[12%] px-3 py-2">Срок оплаты</th>
                          <th className="w-[12%] px-3 py-2 text-right">Сумма</th>
                          <th className="w-[12%] px-3 py-2">Аванс</th>
                          <th className="w-[12%] px-3 py-2 text-right">Остаток</th>
                          <th className="w-[20%] px-3 py-2">Комментарий</th>
                          <th className="w-[12%] px-3 py-2 text-right">Действия</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {paginatedOrders.map((order) => {
                          const supplierName = order.supplier_name || order.suppliers?.name || '—';
                          const totalAmount = Number(order.total_amount);
                          const depositAmount = Number(order.deposit_amount);
                          const remainingAmount = totalAmount - depositAmount;

                          return (
                            <tr key={order.id} className="hover:bg-slate-50">
                              <td className="px-3 py-3 align-top">
                                <button
                                  type="button"
                                  onClick={() => openOrderDetails(order)}
                                  className="block w-full truncate text-left font-semibold text-slate-900 hover:text-emerald-600"
                                  title={order.title}
                                >
                                  {order.title}
                                </button>
                                <p className="w-full truncate text-xs text-slate-500">{supplierName}</p>
                                <button
                                  type="button"
                                  onClick={() => openOrderDetails(order)}
                                  className="mt-1 text-xs font-semibold text-emerald-600 hover:text-emerald-500"
                                >
                                  Открыть
                                </button>
                              </td>
                              <td className="px-3 py-3 align-top text-sm text-slate-700">
                                {formatDate(order.due_date)}
                              </td>
                              <td className="px-3 py-3 align-top text-right">
                                <p className="font-semibold text-slate-900">
                                  {formatCurrency(totalAmount, order.currency ?? 'RUB')}
                                </p>
                                {order.currency === 'CNY' && (
                                  <p className="text-xs text-slate-500">
                                    ≈ {formatRubEquivalent(totalAmount, order.currency, settings)} ₽
                                  </p>
                                )}
                              </td>
                              <td className="px-3 py-3 align-top">
                                <p className="font-semibold text-slate-900">
                                  {formatCurrency(depositAmount, order.currency ?? 'RUB')}
                                </p>
                                {order.currency === 'CNY' && (
                                  <p className="text-xs text-slate-500">
                                    ≈ {formatRubEquivalent(depositAmount, order.currency, settings)} ₽
                                  </p>
                                )}
                                {depositAmount > 0 && (
                                  <p
                                    className={`text-xs font-semibold ${
                                      order.deposit_paid ? 'text-emerald-600' : 'text-amber-600'
                                    }`}
                                  >
                                    {order.deposit_paid ? 'оплачен' : 'ожидается'}
                                  </p>
                                )}
                              </td>
                              <td className="px-3 py-3 align-top text-right">
                                <p className="font-semibold text-slate-900">
                                  {formatCurrency(remainingAmount, order.currency ?? 'RUB')}
                                </p>
                                {order.currency === 'CNY' && (
                                  <p className="text-xs text-slate-500">
                                    ≈ {formatRubEquivalent(remainingAmount, order.currency, settings)} ₽
                                  </p>
                                )}
                              </td>
                              <td className="px-3 py-3 align-top">
                                <span className="block truncate text-slate-600" title={order.description || ''}>
                                  {order.description || '—'}
                                </span>
                              </td>
                              <td className="px-3 py-3 align-top">
                                <div className="flex flex-wrap justify-end gap-2">
                                  <button
                                    onClick={() => openOrderEdit(order)}
                                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                                  >
                                    Редактировать
                                  </button>
                                  <button
                                    onClick={() => handleOrderDelete(order)}
                                    className="rounded-lg border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                                  >
                                    Удалить
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {orders.length > ORDERS_PAGE_SIZE && (
                    <div className="flex flex-col gap-3 rounded-lg border border-dashed p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="text-sm text-slate-600">
                        Страница {ordersPage} из {totalOrderPages}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => setOrdersPage((page) => Math.max(1, page - 1))}
                          disabled={ordersPage === 1}
                          className="rounded-lg border px-3 py-1 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Назад
                        </button>
                        {Array.from({ length: totalOrderPages }).map((_, idx) => {
                          const page = idx + 1;
                          return (
                            <button
                              key={page}
                              onClick={() => setOrdersPage(page)}
                              className={`rounded-lg border px-3 py-1 text-sm font-medium ${
                                page === ordersPage
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                  : 'text-slate-700 hover:border-slate-300'
                              }`}
                            >
                              {page}
                            </button>
                          );
                        })}
                        <button
                          onClick={() => setOrdersPage((page) => Math.min(totalOrderPages, page + 1))}
                          disabled={ordersPage === totalOrderPages}
                          className="rounded-lg border px-3 py-1 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Вперёд
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'accounts' && (
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">Счета</p>
                      <span className="text-xs text-slate-500">Баланс можно редактировать</span>
                    </div>
                    {paginatedAccounts.map((account) => (
                      <div
                        key={`${account.id}-${account.updated_at ?? ''}`}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                      >
                        <div className="min-w-0">
                          <p className="font-medium">{account.name}</p>
                          <p className="text-xs text-slate-500">
                            Создан: {formatDate(account.created_at || today)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            defaultValue={account.balance}
                            onBlur={(e) => handleAccountUpdate(account, Number(e.target.value))}
                            className={`${inputMutedClassName} w-28 text-right`}
                          />
                          <span className="text-slate-500">₽</span>
                          <button
                            onClick={() => handleAccountDelete(account)}
                            className="rounded-lg border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                          >
                            Удалить
                          </button>
                        </div>
                      </div>
                    ))}

                    {accounts.length > ACCOUNTS_PAGE_SIZE && (
                      <div className="flex flex-col gap-3 rounded-lg border border-dashed p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="text-sm text-slate-600">
                          Страница {accountsPage} из {totalAccountPages}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => setAccountsPage((page) => Math.max(1, page - 1))}
                            disabled={accountsPage === 1}
                            className="rounded-lg border px-3 py-1 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Назад
                          </button>
                          {Array.from({ length: totalAccountPages }).map((_, idx) => {
                            const page = idx + 1;
                            return (
                              <button
                                key={page}
                                onClick={() => setAccountsPage(page)}
                                className={`rounded-lg border px-3 py-1 text-sm font-medium ${
                                  page === accountsPage
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                    : 'text-slate-700 hover:border-slate-300'
                                }`}
                              >
                                {page}
                              </button>
                            );
                          })}
                          <button
                            onClick={() => setAccountsPage((page) => Math.min(totalAccountPages, page + 1))}
                            disabled={accountsPage === totalAccountPages}
                            className="rounded-lg border px-3 py-1 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Вперёд
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 rounded-xl border border-dashed p-4">
                    <p className="text-sm font-semibold">Добавить счёт</p>
                    <div className="grid grid-cols-2 gap-3">
                      <input
                        type="text"
                        placeholder="Название"
                        value={accountForm.name}
                        onChange={(e) => setAccountForm((prev) => ({ ...prev, name: e.target.value }))}
                        className={inputClassName}
                      />
                      <input
                        type="number"
                        placeholder="Баланс"
                        value={accountForm.balance}
                        onChange={(e) => setAccountForm((prev) => ({ ...prev, balance: e.target.value }))}
                        className={inputClassName}
                      />
                    </div>
                    <button
                      onClick={handleAccountSubmit}
                      className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      Сохранить счёт
                    </button>
                  </div>
                </div>
              )}

              {activeTab === 'inflows' && (
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">Ожидаемые поступления</p>
                      <span className="text-xs text-slate-500">Фиксированные и плановые</span>
                    </div>
                    {paginatedInflows.map((item) => (
                      <div key={item.id} className="rounded-lg border p-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="font-semibold">{item.counterparty}</p>
                            <p className="text-xs text-slate-500">
                              {item.kind === 'fixed' ? 'фиксированный' : 'плановый'}
                            </p>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="text-right">
                              <p className="text-xs text-slate-500">Дата: {formatDate(item.expected_date)}</p>
                              <p className="font-semibold">{Number(item.amount).toLocaleString('ru-RU')} ₽</p>
                            </div>
                            <button
                              onClick={() => handleInflowDelete(item)}
                              className="rounded-lg border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                            >
                              Удалить
                            </button>
                          </div>
                        </div>
                        {item.notes && <p className="mt-1 text-sm text-slate-600">{item.notes}</p>}
                      </div>
                    ))}

                    {inflows.length > INFLOWS_PAGE_SIZE && (
                      <div className="flex flex-col gap-3 rounded-lg border border-dashed p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="text-sm text-slate-600">
                          Страница {inflowsPage} из {totalInflowPages}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => setInflowsPage((page) => Math.max(1, page - 1))}
                            disabled={inflowsPage === 1}
                            className="rounded-lg border px-3 py-1 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Назад
                          </button>
                          {Array.from({ length: totalInflowPages }).map((_, idx) => {
                            const page = idx + 1;
                            return (
                              <button
                                key={page}
                                onClick={() => setInflowsPage(page)}
                                className={`rounded-lg border px-3 py-1 text-sm font-medium ${
                                  page === inflowsPage
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                    : 'text-slate-700 hover:border-slate-300'
                                }`}
                              >
                                {page}
                              </button>
                            );
                          })}
                          <button
                            onClick={() => setInflowsPage((page) => Math.min(totalInflowPages, page + 1))}
                            disabled={inflowsPage === totalInflowPages}
                            className="rounded-lg border px-3 py-1 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Вперёд
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 rounded-xl border border-dashed p-4">
                    <p className="text-sm font-semibold">Добавить поступление</p>
                    <div className="grid grid-cols-2 gap-3">
                      <select
                        value={inflowForm.counterpartyId}
                        onChange={(e) =>
                          setInflowForm((prev) => ({ ...prev, counterpartyId: e.target.value, newCounterparty: '' }))
                        }
                        className={`col-span-2 ${inputClassName}`}
                      >
                        <option value="">Выбрать контрагента</option>
                        {counterparties.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        placeholder="Или введите нового контрагента"
                        value={inflowForm.newCounterparty}
                        onChange={(e) =>
                          setInflowForm((prev) => ({ ...prev, newCounterparty: e.target.value, counterpartyId: '' }))
                        }
                        className={`col-span-2 ${inputClassName}`}
                      />
                      <input
                        type="number"
                        placeholder="Сумма"
                        value={inflowForm.amount}
                        onChange={(e) => setInflowForm((prev) => ({ ...prev, amount: e.target.value }))}
                        className={inputClassName}
                      />
                      <input
                        type="date"
                        value={inflowForm.expectedDate}
                        onChange={(e) => setInflowForm((prev) => ({ ...prev, expectedDate: e.target.value }))}
                        className={inputClassName}
                      />
                      <select
                        value={inflowForm.kind}
                        onChange={(e) =>
                          setInflowForm((prev) => ({ ...prev, kind: e.target.value as 'fixed' | 'planned' }))
                        }
                        className={`col-span-2 ${inputClassName}`}
                      >
                        <option value="fixed">Фиксированный</option>
                        <option value="planned">Плановый</option>
                      </select>
                      <textarea
                        placeholder="Комментарий"
                        value={inflowForm.notes}
                        onChange={(e) => setInflowForm((prev) => ({ ...prev, notes: e.target.value }))}
                        className={`col-span-2 ${textareaClassName}`}
                      />
                    </div>
                    <button
                      onClick={handleInflowSubmit}
                      className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      Сохранить поступление
                    </button>
                  </div>
                </div>
              )}

              {activeTab === 'expenses' && (
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">Плановые расходы</p>
                      <span className="text-xs text-slate-500">Ежемесячно по выбранным датам</span>
                    </div>
                    {paginatedExpenses.map((item) => {
                      const totalAmount = Number(item.amount ?? 0);
                      const hasSplit = item.day_secondary !== null && item.day_secondary !== undefined;
                      const primaryProvided = item.amount_primary !== null && item.amount_primary !== undefined;
                      const secondaryProvided = item.amount_secondary !== null && item.amount_secondary !== undefined;
                      let primaryAmount = primaryProvided ? Number(item.amount_primary) : null;
                      let secondaryAmount = secondaryProvided ? Number(item.amount_secondary) : null;

                      if (hasSplit) {
                        if (primaryAmount !== null && secondaryAmount === null) {
                          secondaryAmount = totalAmount - primaryAmount;
                        }

                        if (secondaryAmount !== null && primaryAmount === null) {
                          primaryAmount = totalAmount - secondaryAmount;
                        }
                        if (primaryAmount === null && secondaryAmount === null) {
                          primaryAmount = totalAmount;
                        }
                      } else if (primaryAmount === null) {
                        primaryAmount = totalAmount;
                      }

                      return (
                        <div key={item.id} className="rounded-lg border p-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="font-semibold">{item.title}</p>
                              <p className="text-xs text-slate-500">
                                {hasSplit
                                  ? `Даты: ${item.day_primary} и ${item.day_secondary} числа`
                                  : `Дата: ${item.day_primary} числа`}
                              </p>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="text-right">
                                <p className="text-xs text-slate-500">Общая сумма</p>
                                <p className="font-semibold">{totalAmount.toLocaleString('ru-RU')} ₽</p>
                                {primaryAmount !== null && (
                                  <p className="text-xs text-slate-500">
                                    {item.day_primary} число — {primaryAmount.toLocaleString('ru-RU')} ₽
                                  </p>
                                )}
                                {hasSplit && secondaryAmount !== null && (
                                  <p className="text-xs text-slate-500">
                                    {item.day_secondary} число — {secondaryAmount.toLocaleString('ru-RU')} ₽
                                  </p>
                                )}
                              </div>
                              <button
                                onClick={() => handleExpenseDelete(item)}
                                className="rounded-lg border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                              >
                                Удалить
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    {expenses.length > EXPENSES_PAGE_SIZE && (
                      <div className="flex flex-col gap-3 rounded-lg border border-dashed p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="text-sm text-slate-600">
                          Страница {expensesPage} из {totalExpensePages}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => setExpensesPage((page) => Math.max(1, page - 1))}
                            disabled={expensesPage === 1}
                            className="rounded-lg border px-3 py-1 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Назад
                          </button>
                          {Array.from({ length: totalExpensePages }).map((_, idx) => {
                            const page = idx + 1;
                            return (
                              <button
                                key={page}
                                onClick={() => setExpensesPage(page)}
                                className={`rounded-lg border px-3 py-1 text-sm font-medium ${
                                  page === expensesPage
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                    : 'text-slate-700 hover:border-slate-300'
                                }`}
                              >
                                {page}
                              </button>
                            );
                          })}
                          <button
                            onClick={() => setExpensesPage((page) => Math.min(totalExpensePages, page + 1))}
                            disabled={expensesPage === totalExpensePages}
                            className="rounded-lg border px-3 py-1 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Вперёд
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 rounded-xl border border-dashed p-4">
                    <p className="text-sm font-semibold">Добавить расход</p>
                    <div className="grid grid-cols-2 gap-3">
                      <input
                        type="text"
                        placeholder="Название расхода"
                        value={expenseForm.title}
                        onChange={(e) => setExpenseForm((prev) => ({ ...prev, title: e.target.value }))}
                        className={`col-span-2 ${inputClassName}`}
                      />
                      <input
                        type="number"
                        placeholder="Общая сумма"
                        value={expenseForm.totalAmount}
                        onChange={(e) => handleExpenseTotalChange(e.target.value)}
                        className={`col-span-2 ${inputClassName}`}
                      />
                      <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                        Первая дата
                        <select
                          value={expenseForm.dayPrimary}
                          onChange={(e) => setExpenseForm((prev) => ({ ...prev, dayPrimary: e.target.value }))}
                          className={inputClassName}
                        >
                          {EXPENSE_DAY_OPTIONS.map((day) => (
                            <option key={day} value={day}>
                              {day}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                        Вторая дата (опционально)
                        <select
                          value={expenseForm.daySecondary}
                          onChange={(e) => handleExpenseSecondaryDayChange(e.target.value)}
                          className={inputClassName}
                        >
                          <option value="">—</option>
                          {EXPENSE_DAY_OPTIONS.map((day) => (
                            <option key={day} value={day}>
                              {day}
                            </option>
                          ))}
                        </select>
                      </label>
                      {expenseForm.daySecondary ? (
                        <>
                          <input
                            type="number"
                            placeholder="Сумма на первую дату"
                            value={expenseForm.primaryAmount}
                            onChange={(e) => handleExpensePrimaryChange(e.target.value)}
                            className={inputClassName}
                          />
                          <input
                            type="number"
                            placeholder="Сумма на вторую дату"
                            value={expenseForm.secondaryAmount}
                            onChange={(e) => handleExpenseSecondaryChange(e.target.value)}
                            className={inputClassName}
                          />
                          <p className="col-span-2 text-xs text-slate-500">
                            Вторая сумма пересчитывается автоматически при вводе первой и наоборот.
                          </p>
                        </>
                      ) : (
                        <p className="col-span-2 text-xs text-slate-500">
                          Если вторая дата не указана, расход списывается целиком в первую дату.
                        </p>
                      )}
                      <p className="col-span-2 text-xs text-slate-500">
                        Если выбрать 31-е число, в коротких месяцах дата сдвигается на последний день.
                      </p>
                    </div>
                    <button
                      onClick={handleExpenseSubmit}
                      className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      Сохранить расход
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm">
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Калькулятор и здоровье кассы</h2>
            <div className="rounded-lg border p-4">
              <p className="text-sm font-semibold">Калькулятор даты</p>
              <div className="mt-2 flex gap-3">
                <input
                  type="date"
                  value={calculatorDate}
                  onChange={(e) => setCalculatorDate(e.target.value)}
                  className={inputClassName}
                />
              </div>
              {availableOnDate !== null && (
                <p className="mt-3 text-sm text-slate-700">
                  На выбранную дату доступно:{' '}
                  <span className={`${availableOnDate >= 0 ? 'text-emerald-600' : 'text-rose-600'} font-semibold`}>
                    {availableOnDate.toLocaleString('ru-RU')} ₽
                  </span>
                </p>
              )}
            </div>

            <div className="rounded-lg border p-4">
              <p className="text-sm font-semibold">Статус кассовых разрывов</p>
              {cashGapDays.length > 0 ? (
                <div className="mt-2 space-y-2 text-sm text-rose-700">
                  <p>План уходит в минус. Усильте поступления или сдвиньте платежи.</p>
                  <ul className="divide-y divide-rose-100 overflow-hidden rounded-lg border border-rose-100 bg-rose-50/50">
                    {cashGapDays.map((day) => (
                      <li key={day.date} className="flex items-center justify-between px-3 py-2">
                        <span className="font-medium">{formatDate(day.date)}</span>
                        <span className="font-semibold">{Math.abs(day.balance).toLocaleString('ru-RU')} ₽</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mt-2 text-sm text-emerald-600">Разрывов не найдено</p>
              )}
            </div>

            <div className="rounded-lg border p-4">
              <p className="text-sm font-semibold">Ключевые даты</p>
              {plan?.daily.slice(0, 5).map((day) => (
                <div key={day.date} className="mt-2 rounded-lg bg-slate-50 p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{formatDate(day.date)}</span>
                    <span className={`font-semibold ${day.balance >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {day.balance.toLocaleString('ru-RU')} ₽
                    </span>
                  </div>
                  <ul className="mt-1 space-y-1 text-sm text-slate-600">
                    {day.events.map((event, idx) => (
                      <li key={idx} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                        <span className="flex items-center gap-2">
                          <Badge type={event.type} /> {event.description}
                        </span>
                        <span className={event.amount >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                          {event.amount.toLocaleString('ru-RU')} ₽
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-8 rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Дневная статистика (DDR)</h2>
            <span className="text-xs text-slate-500">Операции за день и итоговый баланс</span>
          </div>
          <div className="mt-4 rounded-xl border bg-slate-50 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-700">Динамика баланса по дням</p>
                <p className="text-xs text-slate-500">Диапазон дат: {chartRangeLabel}</p>
                {chartData.length > 0 && (
                  <p className="text-xs text-slate-500">
                    Баланс: {chartBounds.min.toLocaleString('ru-RU')} ₽ — {chartBounds.max.toLocaleString('ru-RU')} ₽
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2 text-xs text-slate-600 sm:flex-row sm:items-center sm:gap-4">
                <label className="flex items-center gap-2">
                  Масштаб
                  <input
                    type="range"
                    min={chartWindowMin}
                    max={chartWindowMax}
                    value={chartWindowSizeValue}
                    onChange={(e) => setChartWindowSize(Number(e.target.value))}
                    disabled={!chartData.length}
                    className="w-32"
                  />
                  <span className="w-10 text-right">{chartWindowSizeValue} дн.</span>
                </label>
                <label className="flex items-center gap-2">
                  Сдвиг
                  <input
                    type="range"
                    min="0"
                    max={maxChartStart}
                    value={chartWindowStart}
                    onChange={(e) => setChartWindowStart(Number(e.target.value))}
                    disabled={!chartData.length || maxChartStart === 0}
                    className="w-32"
                  />
                </label>
              </div>
            </div>
            <div className="mt-3 overflow-hidden rounded-lg bg-white">
              {chartData.length ? (
                <svg
                  viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                  className="h-64 w-full"
                  onMouseMove={handleChartMove}
                  onMouseLeave={() => setHoveredChartIndex(null)}
                >
                  <defs>
                    <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <rect x="0" y="0" width={CHART_WIDTH} height={CHART_HEIGHT} fill="#ffffff" />
                  {chartMetrics.yTicks.map((tick, idx) => (
                    <g key={`y-${idx}`}>
                      <line
                        x1={CHART_MARGIN.left}
                        y1={tick.y}
                        x2={CHART_WIDTH - CHART_MARGIN.right}
                        y2={tick.y}
                        stroke="#e2e8f0"
                        strokeDasharray="4 4"
                      />
                      <text
                        x={CHART_MARGIN.left - 8}
                        y={tick.y + 4}
                        textAnchor="end"
                        fontSize="11"
                        fill="#64748b"
                      >
                        {tick.label}
                      </text>
                    </g>
                  ))}
                  <line
                    x1={CHART_MARGIN.left}
                    y1={CHART_HEIGHT - CHART_MARGIN.bottom}
                    x2={CHART_WIDTH - CHART_MARGIN.right}
                    y2={CHART_HEIGHT - CHART_MARGIN.bottom}
                    stroke="#e2e8f0"
                  />
                  {chartMetrics.xTicks.map((tick, idx) => (
                    <text
                      key={`x-${idx}`}
                      x={tick.x}
                      y={CHART_HEIGHT - CHART_MARGIN.bottom + 18}
                      textAnchor="middle"
                      fontSize="11"
                      fill="#64748b"
                    >
                      {tick.label}
                    </text>
                  ))}
                  {chartMetrics.area && (
                    <polyline points={chartMetrics.area} fill="url(#balanceGradient)" stroke="none" />
                  )}
                  <polyline
                    points={chartMetrics.polyline}
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="3"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {chartMetrics.points
                    .filter((point) => point.day.balance < 0)
                    .map((point) => (
                      <circle
                        key={point.day.date}
                        cx={point.x}
                        cy={point.y}
                        r="4"
                        fill="#fecdd3"
                        stroke="#fb7185"
                        strokeWidth="2"
                      />
                    ))}
                  {hoveredPoint && (
                    <>
                      <line
                        x1={hoveredPoint.x}
                        y1={CHART_MARGIN.top}
                        x2={hoveredPoint.x}
                        y2={CHART_HEIGHT - CHART_MARGIN.bottom}
                        stroke="#94a3b8"
                        strokeDasharray="4 4"
                      />
                      <circle
                        cx={hoveredPoint.x}
                        cy={hoveredPoint.y}
                        r="5"
                        fill="#10b981"
                        stroke="#ffffff"
                        strokeWidth="2"
                      />
                      <g>
                        <rect
                          x={tooltipX}
                          y={tooltipY}
                          width={tooltipWidth}
                          height={tooltipHeight}
                          rx="8"
                          fill="#ffffff"
                          stroke="#e2e8f0"
                        />
                        <text x={tooltipX + 10} y={tooltipY + 18} fontSize="12" fill="#0f172a" fontWeight="600">
                          {formatDate(hoveredPoint.day.date)}
                        </text>
                        <text
                          x={tooltipX + 10}
                          y={tooltipY + 34}
                          fontSize="12"
                          fill={hoveredPoint.day.balance >= 0 ? '#059669' : '#e11d48'}
                        >
                          {hoveredPoint.day.balance.toLocaleString('ru-RU')} ₽
                        </text>
                      </g>
                    </>
                  )}
                </svg>
              ) : (
                <p className="p-4 text-sm text-slate-500">Нет данных для графика</p>
              )}
            </div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2">Дата</th>
                  <th className="px-3 py-2">События</th>
                  <th className="px-3 py-2 text-right">Баланс дня</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginatedDaily.map((day) => (
                  <tr key={day.date}>
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-700">{formatDate(day.date)}</td>
                    <td className="px-3 py-2">
                      <ul className="space-y-1">
                        {day.events.map((event, idx) => (
                          <li key={idx} className="flex items-center justify-between gap-3">
                            <span className="flex items-center gap-2 text-slate-700">
                              <Badge type={event.type} />
                              {event.description}
                            </span>
                            <span className={event.amount >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                              {event.amount.toLocaleString('ru-RU')} ₽
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right font-semibold ${
                      day.balance >= 0 ? 'text-emerald-600' : 'text-rose-600'
                    }`}>
                      {day.balance.toLocaleString('ru-RU')} ₽
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan && plan.daily.length > DAILY_PAGE_SIZE && (
            <div className="mt-4 flex flex-col gap-3 rounded-lg border border-dashed p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-slate-600">
                Страница {dailyPage} из {totalDailyPages}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setDailyPage((page) => Math.max(1, page - 1))}
                  disabled={dailyPage === 1}
                  className="rounded-lg border px-3 py-1 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Назад
                </button>
                {Array.from({ length: totalDailyPages }).map((_, idx) => {
                  const page = idx + 1;
                  return (
                    <button
                      key={page}
                      onClick={() => setDailyPage(page)}
                      className={`rounded-lg border px-3 py-1 text-sm font-medium ${
                        page === dailyPage
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'text-slate-700 hover:border-slate-300'
                      }`}
                    >
                      {page}
                    </button>
                  );
                })}
                <button
                  onClick={() => setDailyPage((page) => Math.min(totalDailyPages, page + 1))}
                  disabled={dailyPage === totalDailyPages}
                  className="rounded-lg border px-3 py-1 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Вперёд
                </button>
              </div>
            </div>
          )}
        </section>

        {orderDialogOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="order-dialog-title"
            onClick={closeOrderDialog}
          >
            <div
              className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    {orderDialogMode === 'form'
                      ? editingOrderId
                        ? 'Редактирование заказа'
                        : 'Новый заказ'
                      : 'Карточка заказа'}
                  </p>
                  <h3 className="text-lg font-semibold text-slate-900" id="order-dialog-title">
                    {orderDialogMode === 'form'
                      ? orderForm.title || 'Заказ без названия'
                      : orderDialogOrder?.title || 'Заказ'}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={closeOrderDialog}
                  className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Закрыть
                </button>
              </div>

              {orderDialogMode === 'details' ? (
                orderDialogOrder ? (
                  <div className="mt-4 space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-lg border border-slate-200 p-3">
                        <p className="text-xs text-slate-500">Поставщик</p>
                        <p className="text-sm font-semibold">{orderDialogSupplierName}</p>
                      </div>
                      <div className="rounded-lg border border-slate-200 p-3">
                        <p className="text-xs text-slate-500">Срок оплаты</p>
                        <p className="text-sm font-semibold">{formatDate(orderDialogOrder.due_date)}</p>
                      </div>
                      <div className="rounded-lg border border-slate-200 p-3">
                        <p className="text-xs text-slate-500">Сумма заказа</p>
                        <p className="text-sm font-semibold">
                          {formatCurrency(orderDialogTotalAmount, orderDialogOrder.currency ?? 'RUB')}
                        </p>
                        {orderDialogOrder.currency === 'CNY' && (
                          <p className="text-xs text-slate-500">
                            ≈ {formatRubEquivalent(orderDialogTotalAmount, orderDialogOrder.currency, settings)} ₽
                          </p>
                        )}
                      </div>
                      <div className="rounded-lg border border-slate-200 p-3">
                        <p className="text-xs text-slate-500">Аванс</p>
                        <p className="text-sm font-semibold">
                          {formatCurrency(orderDialogDepositAmount, orderDialogOrder.currency ?? 'RUB')}
                        </p>
                        {orderDialogOrder.currency === 'CNY' && (
                          <p className="text-xs text-slate-500">
                            ≈ {formatRubEquivalent(orderDialogDepositAmount, orderDialogOrder.currency, settings)} ₽
                          </p>
                        )}
                        {orderDialogDepositAmount > 0 && (
                          <p
                            className={`text-xs font-semibold ${
                              orderDialogOrder.deposit_paid ? 'text-emerald-600' : 'text-amber-600'
                            }`}
                          >
                            {orderDialogOrder.deposit_paid ? 'оплачен' : 'ожидается'}
                          </p>
                        )}
                      </div>
                      <div className="rounded-lg border border-slate-200 p-3">
                        <p className="text-xs text-slate-500">Дата аванса</p>
                        <p className="text-sm font-semibold">{formatDate(orderDialogOrder.deposit_date)}</p>
                      </div>
                      <div className="rounded-lg border border-slate-200 p-3">
                        <p className="text-xs text-slate-500">Остаток к оплате</p>
                        <p className="text-sm font-semibold">
                          {formatCurrency(orderDialogRemainingAmount, orderDialogOrder.currency ?? 'RUB')}
                        </p>
                        {orderDialogOrder.currency === 'CNY' && (
                          <p className="text-xs text-slate-500">
                            ≈ {formatRubEquivalent(orderDialogRemainingAmount, orderDialogOrder.currency, settings)} ₽
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 p-4">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Комментарий</p>
                      <p className="mt-2 text-sm text-slate-700 whitespace-pre-wrap">
                        {orderDialogOrder.description || '—'}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => openOrderEdit(orderDialogOrder)}
                        className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Редактировать
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOrderDelete(orderDialogOrder)}
                        className="rounded-lg border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-slate-500">Заказ не найден или был удалён.</p>
                )
              ) : (
                <div className="mt-4 space-y-3">
                  {editingOrderStale && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Заказ обновлён другим пользователем. Обновите данные перед сохранением.
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="text"
                      placeholder="Название / номер заказа"
                      value={orderForm.title}
                      onChange={(e) => setOrderForm((prev) => ({ ...prev, title: e.target.value }))}
                      className={`col-span-2 ${inputClassName}`}
                    />
                    <select
                      value={orderForm.supplierId}
                      onChange={(e) => setOrderForm((prev) => ({ ...prev, supplierId: e.target.value }))}
                      className={inputClassName}
                    >
                      <option value="">Выбрать поставщика</option>
                      {suppliers.map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="Или введите нового поставщика"
                      value={orderForm.newSupplier}
                      onChange={(e) => setOrderForm((prev) => ({ ...prev, newSupplier: e.target.value }))}
                      className={inputClassName}
                    />
                    <div className="col-span-2 grid grid-cols-[1fr_auto] gap-2">
                      <input
                        type="number"
                        placeholder="Сумма заказа"
                        value={orderForm.totalAmount}
                        onChange={(e) => setOrderForm((prev) => ({ ...prev, totalAmount: e.target.value }))}
                        className={inputClassName}
                      />
                      <select
                        value={orderForm.currency}
                        onChange={(e) => setOrderForm((prev) => ({ ...prev, currency: e.target.value as Currency }))}
                        className={inputClassName}
                      >
                        <option value="RUB">₽ Рубли</option>
                        <option value="CNY">¥ Юани</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs font-semibold text-slate-600">Аванс поставщику</label>
                      <input
                        type="number"
                        placeholder="Аванс поставщику"
                        value={orderForm.depositAmount}
                        onChange={(e) => setOrderForm((prev) => ({ ...prev, depositAmount: e.target.value }))}
                        className={inputClassName}
                      />
                    </div>
                    <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={orderForm.depositPaid}
                        onChange={(e) => setOrderForm((prev) => ({ ...prev, depositPaid: e.target.checked }))}
                        className="h-4 w-4 accent-emerald-600"
                      />
                      Аванс уже оплачен
                    </label>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs font-semibold text-slate-600">Дата аванса</label>
                      <input
                        type="date"
                        value={orderForm.depositDate}
                        onChange={(e) => setOrderForm((prev) => ({ ...prev, depositDate: e.target.value }))}
                        className={inputClassName}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs font-semibold text-slate-600">Срок оплаты</label>
                      <input
                        type="date"
                        value={orderForm.dueDate}
                        onChange={(e) => setOrderForm((prev) => ({ ...prev, dueDate: e.target.value }))}
                        className={inputClassName}
                      />
                    </div>
                    <textarea
                      placeholder="Комментарий"
                      value={orderForm.description}
                      onChange={(e) => setOrderForm((prev) => ({ ...prev, description: e.target.value }))}
                      className={`col-span-2 ${textareaClassName}`}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleOrderCheck}
                      className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                    >
                      Проверить заказ
                    </button>
                    <button
                      type="button"
                      onClick={handleOrderSubmit}
                      disabled={editingOrderStale}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {editingOrderId ? 'Сохранить изменения' : 'Сохранить заказ'}
                    </button>
                    {editingOrderId && (
                      <button
                        type="button"
                        onClick={closeOrderDialog}
                        className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                      >
                        Отменить редактирование
                      </button>
                    )}
                  </div>
                  {checkResult && (
                    <div
                      className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
                        checkResult.ok
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                          : 'border-rose-200 bg-rose-50 text-rose-800'
                      }`}
                    >
                      {checkResult.ok
                        ? 'Можно оформлять: кассовый разрыв не возникает'
                        : `Кассовый разрыв составит ${checkResult.cashGap.toLocaleString('ru-RU')} ₽`}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
