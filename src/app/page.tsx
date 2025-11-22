'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import {
  Account,
  AppSettings,
  CashEvent,
  CashPlanResult,
  Counterparty,
  Currency,
  IncomingPayment,
  Supplier,
  SupplierOrder,
} from '@/types/finance';
import { buildCashPlan, projectBalanceOnDate } from '@/lib/cashflow';
import { DEFAULT_SETTINGS, normalizeSettings, currencyRate } from '@/lib/settings';

interface OrderFormState {
  title: string;
  supplierId: string;
  newSupplier: string;
  totalAmount: string;
  depositAmount: string;
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
type CleanupTarget = 'all' | 'accounts' | 'suppliers' | 'counterparties' | 'orders' | 'inflows';
interface DataResponse {
  accounts: AccountRow[];
  suppliers: Supplier[];
  counterparties: Counterparty[];
  orders: OrderWithSupplier[];
  inflows: InflowRow[];
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
const DAILY_PAGE_SIZE = 10;

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

async function parseJsonSafe<T = unknown>(response: Response): Promise<T> {
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
  const [dailyPage, setDailyPage] = useState(1);
  const [cleaningTarget, setCleaningTarget] = useState<CleanupTarget | null>(null);

  const [accountForm, setAccountForm] = useState<AccountFormState>({ name: '', balance: '' });
  const [inflowForm, setInflowForm] = useState<InflowFormState>({
    counterpartyId: '',
    newCounterparty: '',
    amount: '',
    expectedDate: today,
    kind: 'fixed',
    notes: '',
  });
  const [orderForm, setOrderForm] = useState<OrderFormState>({
    title: '',
    supplierId: '',
    newSupplier: '',
    totalAmount: '',
    depositAmount: '',
    depositDate: today,
    dueDate: today,
    description: '',
    currency: 'RUB',
  });
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsForm, setSettingsForm] = useState<SettingsFormState>({
    cnyRate: DEFAULT_SETTINGS.cnyRate.toString(),
  });

  const totalBalance = useMemo(
    () => accounts.reduce((sum, item) => sum + Number(item.balance ?? 0), 0),
    [accounts],
  );

  const orderTotals = useMemo(
    () =>
      orders.reduce(
        (acc, order) => ({
          total:
            acc.total + Number(order.total_amount ?? 0) * currencyRate(order.currency ?? 'RUB', settings),
          deposits:
            acc.deposits + Number(order.deposit_amount ?? 0) * currencyRate(order.currency ?? 'RUB', settings),
        }),
        { total: 0, deposits: 0 },
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
        currency: (item.currency as Currency) || 'RUB',
      }));

      const normalizedInflows: InflowRow[] = (payload.inflows ?? []).map((item) => ({
        ...item,
        counterparty: item.counterparty || item.counterparties?.name || 'Без контрагента',
        amount: Number(item.amount ?? 0),
      }));

      const normalizedSettings = normalizeSettings(payload.settings || DEFAULT_SETTINGS);

      setAccounts(normalizedAccounts);
      setSuppliers(payload.suppliers || []);
      setCounterparties(payload.counterparties || []);
      setOrders(normalizedOrders);
      setInflows(normalizedInflows);
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
    const cashPlan = buildCashPlan(accounts, inflows, orders, settings);
    setPlan(cashPlan);
  }, [accounts, inflows, orders, settings]);

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
      const response = await fetch('/api/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...account, balance: newBalance }),
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

  const handleOrderSubmit = async () => {
    resetMessages();
    try {
      const supplier_id = await resolveSupplierId();
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_id,
          title: orderForm.title,
          total_amount: Number(orderForm.totalAmount),
          deposit_amount: Number(orderForm.depositAmount) || 0,
          deposit_date: orderForm.depositDate,
          due_date: orderForm.dueDate,
          currency: orderForm.currency,
          description: orderForm.description,
        }),
      });

      const payload = await parseJsonSafe(response);
      if (!response.ok) throw new Error(payload.error || 'Не удалось добавить заказ');
      setOrderForm({
        title: '',
        supplierId: '',
        newSupplier: '',
        totalAmount: '',
        depositAmount: '',
        depositDate: today,
        dueDate: today,
        description: '',
        currency: 'RUB',
      });
      setMessage('Заказ добавлен');
      loadData();
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
          supplier_id,
          title: orderForm.title || 'Новый заказ',
          total_amount: Number(orderForm.totalAmount),
          deposit_amount: Number(orderForm.depositAmount) || 0,
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

  const totalDailyPages = Math.max(1, Math.ceil((plan?.daily.length || 0) / DAILY_PAGE_SIZE));
  const paginatedDaily = useMemo(() => {
    const start = (dailyPage - 1) * DAILY_PAGE_SIZE;
    return plan?.daily.slice(start, start + DAILY_PAGE_SIZE) || [];
  }, [dailyPage, plan?.daily]);

  const chartData = useMemo(() => plan?.daily ?? [], [plan?.daily]);
  const chartBounds = useMemo(() => {
    if (!chartData.length) return { min: 0, max: 0 };
    const balances = chartData.map((day) => day.balance);
    return { min: Math.min(...balances), max: Math.max(...balances) };
  }, [chartData]);

  const chartPoints = useMemo(() => {
    if (!chartData.length) return '';
    const width = 800;
    const height = 240;
    const padding = 30;
    const min = chartBounds.min;
    const max = chartBounds.max === chartBounds.min ? chartBounds.min + 1 : chartBounds.max;
    const xStep = chartData.length > 1 ? (width - padding * 2) / (chartData.length - 1) : 0;

    const scaleY = (value: number) => {
      const ratio = (value - min) / (max - min);
      return height - padding - ratio * (height - padding * 2);
    };

    return chartData
      .map((day, idx) => {
        const x = padding + idx * xStep;
        const y = scaleY(day.balance);
        return `${x},${y}`;
      })
      .join(' ');
  }, [chartBounds.max, chartBounds.min, chartData]);

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
            {plan && plan.cashGap > 0 && (
              <p className="mt-1 text-xs text-rose-600">Внимание: кассовый разрыв {plan.cashGap.toLocaleString('ru-RU')} ₽</p>
            )}
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

        <div className="mt-6 rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-emerald-700">Выгрузка из МойСклад</p>
              <h2 className="text-lg font-semibold text-slate-900">Подтяните заказы поставщикам</h2>
              <p className="text-sm text-slate-600">
                Кнопки ниже сразу вызывают импорт или позволяют посмотреть текущее количество заказов по фильтрам
                (агент «Маркетплейсы», статусы «Не принято», «В пути», «Частично принято»).
              </p>
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <button
                onClick={handleMoyskladCount}
                disabled={checkingOrders || importingOrders}
                className="rounded-lg border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-700 hover:border-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {checkingOrders ? 'Проверяем…' : 'Проверить количество'}
              </button>
              <button
                onClick={handleMoyskladImport}
                disabled={importingOrders}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {importingOrders ? 'Выгружаем заказы…' : 'Выгрузить заказы'}
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">Источник: https://api.moysklad.ru/api/remap/1.2/entity/purchaseorder</p>
        </div>

        <section className="mt-8 grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl bg-white p-5 shadow-sm lg:col-span-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Технические настройки</p>
                <h2 className="text-lg font-semibold text-slate-900">Курс валют и сервисные действия</h2>
                <p className="text-sm text-slate-600">Все расчёты ведутся в рублях, суммы в юанях пересчитываются по указанному курсу.</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
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
          </div>
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-semibold text-slate-900">Сервисный блок</p>
            <p className="mt-2 text-sm text-slate-600">
              Здесь можно разместить технические кнопки вроде выгрузки заказов или очистки базы. Добавляйте новые элементы по мере необходимости.
            </p>
            <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              <p>Текущий курс: {settings.cnyRate.toLocaleString('ru-RU')} ₽ за 1 ¥</p>
              <p>Базовая валюта: российские рубли</p>
            </div>
            <button
              onClick={handleMoyskladImport}
              disabled={importingOrders}
              className="mt-4 w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {importingOrders ? 'Выгружаем заказы…' : 'Выгрузить заказы из МойСклад'}
            </button>
            <p className="mt-2 text-xs text-slate-500">
              Будут подтянуты заказы поставщикам из МойСклад по указанным фильтрам (агент «Маркетплейсы», статусы «Не принято», «В пути», «Частично принято»).
            </p>
            <div className="mt-4 space-y-2">
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
              <p className="text-xs text-slate-500">Очистка удаляет записи из таблиц без восстановления. Используйте осторожно.</p>
            </div>
          </div>
        </section>

        <section className="mt-8 grid gap-6 md:grid-cols-2">
          <div className="space-y-4 rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Счета</h2>
              <span className="text-xs text-slate-500">Баланс можно редактировать</span>
            </div>
            <div className="space-y-3">
              {paginatedAccounts.map((account) => (
                <div key={account.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="font-medium">{account.name}</p>
                    <p className="text-sm text-slate-500">Создан: {formatDate(account.created_at || today)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      defaultValue={account.balance}
                      onBlur={(e) => handleAccountUpdate(account, Number(e.target.value))}
                      className="w-28 rounded-lg border bg-slate-50 px-3 py-2 text-right text-sm"
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
              <div className="rounded-lg border border-dashed p-3">
                <p className="mb-2 text-sm font-semibold">Добавить счёт</p>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    placeholder="Название"
                    value={accountForm.name}
                    onChange={(e) => setAccountForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="rounded-lg border px-3 py-2"
                  />
                  <input
                    type="number"
                    placeholder="Баланс"
                    value={accountForm.balance}
                    onChange={(e) => setAccountForm((prev) => ({ ...prev, balance: e.target.value }))}
                    className="rounded-lg border px-3 py-2"
                  />
                </div>
                <button
                  onClick={handleAccountSubmit}
                  className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Сохранить счёт
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-4 rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Ожидаемые поступления</h2>
              <span className="text-xs text-slate-500">Фиксированные и плановые</span>
            </div>
            <div className="space-y-3">
              {paginatedInflows.map((item) => (
                <div key={item.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold">{item.counterparty}</p>
                      <p className="text-xs text-slate-500">{item.kind === 'fixed' ? 'фиксированный' : 'плановый'}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <p className="text-sm text-slate-500">Дата: {formatDate(item.expected_date)}</p>
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

              <div className="rounded-lg border border-dashed p-3">
                <p className="mb-2 text-sm font-semibold">Добавить поступление</p>
                <div className="grid grid-cols-2 gap-3">
                  <select
                    value={inflowForm.counterpartyId}
                    onChange={(e) =>
                      setInflowForm((prev) => ({ ...prev, counterpartyId: e.target.value, newCounterparty: '' }))
                    }
                    className="col-span-2 rounded-lg border px-3 py-2"
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
                    className="col-span-2 rounded-lg border px-3 py-2"
                  />
                  <input
                    type="number"
                    placeholder="Сумма"
                    value={inflowForm.amount}
                    onChange={(e) => setInflowForm((prev) => ({ ...prev, amount: e.target.value }))}
                    className="rounded-lg border px-3 py-2"
                  />
                  <input
                    type="date"
                    value={inflowForm.expectedDate}
                    onChange={(e) => setInflowForm((prev) => ({ ...prev, expectedDate: e.target.value }))}
                    className="rounded-lg border px-3 py-2"
                  />
                  <select
                    value={inflowForm.kind}
                    onChange={(e) => setInflowForm((prev) => ({ ...prev, kind: e.target.value as 'fixed' | 'planned' }))}
                    className="col-span-2 rounded-lg border px-3 py-2"
                  >
                    <option value="fixed">Фиксированный</option>
                    <option value="planned">Плановый</option>
                  </select>
                  <textarea
                    placeholder="Комментарий"
                    value={inflowForm.notes}
                    onChange={(e) => setInflowForm((prev) => ({ ...prev, notes: e.target.value }))}
                    className="col-span-2 rounded-lg border px-3 py-2"
                  />
                </div>
                <button
                  onClick={handleInflowSubmit}
                  className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Сохранить поступление
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-8 grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4 rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Заказы поставщикам</h2>
              <span className="text-xs text-slate-500">Аванс и остаток с контролем кассовых разрывов</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Общая сумма заказов</p>
                <p className="text-2xl font-semibold text-slate-900">
                  {orderTotals.total.toLocaleString('ru-RU')} ₽
                </p>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-xs uppercase tracking-wide text-emerald-700">Сумма авансов</p>
                <p className="text-2xl font-semibold text-emerald-700">
                  {orderTotals.deposits.toLocaleString('ru-RU')} ₽
                </p>
              </div>
            </div>
            <div className="rounded-lg border border-dashed p-4">
              <p className="mb-2 text-sm font-semibold">Добавить заказ</p>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  placeholder="Название / номер заказа"
                  value={orderForm.title}
                  onChange={(e) => setOrderForm((prev) => ({ ...prev, title: e.target.value }))}
                  className="col-span-2 rounded-lg border px-3 py-2"
                />
                <select
                  value={orderForm.supplierId}
                  onChange={(e) => setOrderForm((prev) => ({ ...prev, supplierId: e.target.value }))}
                  className="rounded-lg border px-3 py-2"
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
                  className="rounded-lg border px-3 py-2"
                />
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <input
                    type="number"
                    placeholder="Сумма заказа"
                    value={orderForm.totalAmount}
                    onChange={(e) => setOrderForm((prev) => ({ ...prev, totalAmount: e.target.value }))}
                    className="rounded-lg border px-3 py-2"
                  />
                  <select
                    value={orderForm.currency}
                    onChange={(e) => setOrderForm((prev) => ({ ...prev, currency: e.target.value as Currency }))}
                    className="rounded-lg border px-3 py-2 text-sm"
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
                    className="rounded-lg border px-3 py-2"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold text-slate-600">Дата аванса</label>
                  <input
                    type="date"
                    value={orderForm.depositDate}
                    onChange={(e) => setOrderForm((prev) => ({ ...prev, depositDate: e.target.value }))}
                    className="rounded-lg border px-3 py-2"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold text-slate-600">Срок оплаты</label>
                  <input
                    type="date"
                    value={orderForm.dueDate}
                    onChange={(e) => setOrderForm((prev) => ({ ...prev, dueDate: e.target.value }))}
                    className="rounded-lg border px-3 py-2"
                  />
                </div>
                <textarea
                  placeholder="Комментарий"
                  value={orderForm.description}
                  onChange={(e) => setOrderForm((prev) => ({ ...prev, description: e.target.value }))}
                  className="col-span-2 rounded-lg border px-3 py-2"
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={handleOrderCheck}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Проверить заказ
                </button>
                <button
                  onClick={handleOrderSubmit}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
                >
                  Сохранить заказ
                </button>
              </div>
              {checkResult && (
                <div
                  className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
                    checkResult.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'
                  }`}
                >
                  {checkResult.ok
                    ? 'Можно оформлять: кассовый разрыв не возникает'
                    : `Кассовый разрыв составит ${checkResult.cashGap.toLocaleString('ru-RU')} ₽`}
                </div>
              )}
            </div>

            <div className="space-y-3">
              {paginatedOrders.map((order) => (
                <div key={order.id} className="rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold">{order.title}</p>
                      {order.supplier_name && <p className="text-sm text-slate-500">{order.supplier_name}</p>}
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <p className="text-xs text-slate-500">Срок оплаты: {formatDate(order.due_date)}</p>
                        <p className="font-semibold">
                          {formatCurrency(Number(order.total_amount), order.currency ?? 'RUB')}
                        </p>
                        {order.currency === 'CNY' && (
                          <p className="text-xs text-slate-500">
                            ≈ {formatRubEquivalent(Number(order.total_amount), order.currency, settings)} ₽
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => handleOrderDelete(order)}
                        className="rounded-lg border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-3 text-sm text-slate-600 sm:grid-cols-4">
                    <p>
                      Аванс: {formatCurrency(Number(order.deposit_amount), order.currency ?? 'RUB')}
                      {order.currency === 'CNY' && (
                        <span className="text-xs text-slate-500"> · ≈ {formatRubEquivalent(Number(order.deposit_amount), order.currency, settings)} ₽</span>
                      )}
                    </p>
                    <p>Дата аванса: {formatDate(order.deposit_date)}</p>
                    <p>
                      Остаток: {formatCurrency(Number(order.total_amount) - Number(order.deposit_amount), order.currency ?? 'RUB')}
                      {order.currency === 'CNY' && (
                        <span className="text-xs text-slate-500"> · ≈ {formatRubEquivalent(Number(order.total_amount) - Number(order.deposit_amount), order.currency, settings)} ₽</span>
                      )}
                    </p>
                    <p>Комментарий: {order.description || '—'}</p>
                  </div>
                </div>
              ))}

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
          </div>

          <div className="space-y-4 rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Калькулятор и здоровье кассы</h2>
            <div className="rounded-lg border p-4">
              <p className="text-sm font-semibold">Калькулятор даты</p>
              <div className="mt-2 flex gap-3">
                <input
                  type="date"
                  value={calculatorDate}
                  onChange={(e) => setCalculatorDate(e.target.value)}
                  className="flex-1 rounded-lg border px-3 py-2"
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
              {plan && plan.cashGap > 0 ? (
                <p className="mt-2 text-sm text-rose-600">
                  План уходит в минус на {plan.cashGap.toLocaleString('ru-RU')} ₽. Усильте поступления или сдвиньте платежи.
                </p>
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
            <div className="flex items-center justify-between text-sm text-slate-600">
              <span>Динамика баланса по дням</span>
              {plan && <span>Диапазон: {chartBounds.min.toLocaleString('ru-RU')} ₽ — {chartBounds.max.toLocaleString('ru-RU')} ₽</span>}
            </div>
            <div className="mt-3 overflow-hidden rounded-lg bg-white">
              {chartData.length ? (
                <svg viewBox="0 0 800 240" className="h-56 w-full">
                  <defs>
                    <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <rect x="0" y="0" width="800" height="240" fill="#f8fafc" />
                  <polyline
                    points={`30,${240 - 30} 770,${240 - 30}`}
                    fill="none"
                    stroke="#e2e8f0"
                    strokeWidth="1"
                    strokeDasharray="4 4"
                  />
                  {chartPoints && (
                    <>
                      <polyline
                        points={`30,210 ${chartPoints} 770,210`}
                        fill="url(#balanceGradient)"
                        stroke="none"
                      />
                      <polyline
                        points={chartPoints}
                        fill="none"
                        stroke="#10b981"
                        strokeWidth="3"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </>
                  )}
                </svg>
              ) : (
                <p className="text-sm text-slate-500">Нет данных для графика</p>
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
      </div>
    </div>
  );
}
