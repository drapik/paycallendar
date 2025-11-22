'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import {
  Account,
  CashEvent,
  CashPlanResult,
  IncomingPayment,
  Supplier,
  SupplierOrder,
} from '@/types/finance';
import { buildCashPlan, projectBalanceOnDate } from '@/lib/cashflow';

interface OrderFormState {
  title: string;
  supplierId: string;
  newSupplier: string;
  totalAmount: string;
  depositAmount: string;
  depositDate: string;
  dueDate: string;
  description: string;
}

interface AccountFormState {
  name: string;
  balance: string;
}

interface InflowFormState {
  counterparty: string;
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
type InflowRow = IncomingPayment & { amount: number | string };
interface DataResponse {
  accounts: AccountRow[];
  suppliers: Supplier[];
  orders: OrderWithSupplier[];
  inflows: InflowRow[];
  error?: string;
}

const today = new Date().toISOString().slice(0, 10);
const ORDERS_PAGE_SIZE = 5;

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
  const [orders, setOrders] = useState<OrderWithSupplier[]>([]);
  const [inflows, setInflows] = useState<IncomingPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<CashPlanResult | null>(null);
  const [calculatorDate, setCalculatorDate] = useState(today);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [ordersPage, setOrdersPage] = useState(1);

  const [accountForm, setAccountForm] = useState<AccountFormState>({ name: '', balance: '' });
  const [inflowForm, setInflowForm] = useState<InflowFormState>({
    counterparty: '',
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
  });

  const totalBalance = useMemo(
    () => accounts.reduce((sum, item) => sum + Number(item.balance ?? 0), 0),
    [accounts],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/data');
      const payload = (await response.json()) as Partial<DataResponse>;
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
      }));

      const normalizedInflows: IncomingPayment[] = (payload.inflows ?? []).map((item) => ({
        ...item,
        amount: Number(item.amount ?? 0),
      }));

      setAccounts(normalizedAccounts);
      setSuppliers(payload.suppliers || []);
      setOrders(normalizedOrders);
      setInflows(normalizedInflows);
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
    const cashPlan = buildCashPlan(accounts, inflows, orders);
    setPlan(cashPlan);
  }, [accounts, inflows, orders]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(orders.length / ORDERS_PAGE_SIZE));
    setOrdersPage((prev) => Math.min(prev, totalPages));
  }, [orders.length]);

  const resetMessages = () => {
    setMessage(null);
    setError(null);
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

      const payload = await response.json();
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
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Не удалось обновить счёт');
      loadData();
      setMessage('Баланс обновлён');
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleInflowSubmit = async () => {
    resetMessages();
    try {
      const response = await fetch('/api/inflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          counterparty: inflowForm.counterparty,
          amount: Number(inflowForm.amount),
          expected_date: inflowForm.expectedDate,
          kind: inflowForm.kind,
          notes: inflowForm.notes,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Не удалось добавить поступление');
      setInflowForm({ counterparty: '', amount: '', expectedDate: today, kind: 'fixed', notes: '' });
      setMessage('Поступление добавлено');
      loadData();
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

    const payload = await response.json();
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
          description: orderForm.description,
        }),
      });

      const payload = await response.json();
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
      });
      setMessage('Заказ добавлен');
      loadData();
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
          description: orderForm.description,
        }),
      });

      const payload = await response.json();
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

        <section className="mt-8 grid gap-6 md:grid-cols-2">
          <div className="space-y-4 rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Счета</h2>
              <span className="text-xs text-slate-500">Баланс можно редактировать</span>
            </div>
            <div className="space-y-3">
              {accounts.map((account) => (
                <div key={account.id} className="flex items-center justify-between rounded-lg border p-3">
                  <div>
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
                  </div>
                </div>
              ))}
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
              {inflows.map((item) => (
                <div key={item.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold">{item.counterparty}</p>
                      <p className="text-xs text-slate-500">{item.kind === 'fixed' ? 'фиксированный' : 'плановый'}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-slate-500">Дата: {formatDate(item.expected_date)}</p>
                      <p className="font-semibold">{Number(item.amount).toLocaleString('ru-RU')} ₽</p>
                    </div>
                  </div>
                  {item.notes && <p className="mt-1 text-sm text-slate-600">{item.notes}</p>}
                </div>
              ))}

              <div className="rounded-lg border border-dashed p-3">
                <p className="mb-2 text-sm font-semibold">Добавить поступление</p>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    placeholder="Контрагент"
                    value={inflowForm.counterparty}
                    onChange={(e) => setInflowForm((prev) => ({ ...prev, counterparty: e.target.value }))}
                    className="rounded-lg border px-3 py-2"
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
                    className="rounded-lg border px-3 py-2"
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
                <input
                  type="number"
                  placeholder="Сумма заказа"
                  value={orderForm.totalAmount}
                  onChange={(e) => setOrderForm((prev) => ({ ...prev, totalAmount: e.target.value }))}
                  className="rounded-lg border px-3 py-2"
                />
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
                    <div className="text-right">
                      <p className="text-xs text-slate-500">Срок оплаты: {formatDate(order.due_date)}</p>
                      <p className="font-semibold">{Number(order.total_amount).toLocaleString('ru-RU')} ₽</p>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-3 text-sm text-slate-600 sm:grid-cols-4">
                    <p>Аванс: {Number(order.deposit_amount).toLocaleString('ru-RU')} ₽</p>
                    <p>Дата аванса: {formatDate(order.deposit_date)}</p>
                    <p>Остаток: {(Number(order.total_amount) - Number(order.deposit_amount)).toLocaleString('ru-RU')} ₽</p>
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
                {plan?.daily.map((day) => (
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
        </section>
      </div>
    </div>
  );
}
