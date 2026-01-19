import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const OZON_ENDPOINT = 'https://api-seller.ozon.ru/v1/finance/cash-flow-statement/list';

interface OzonDetailItem {
  price?: number;
}

interface OzonDetailTotals {
  total?: number;
}

interface OzonDetail {
  period?: {
    begin?: string;
    end?: string;
  };
  delivery?: OzonDetailTotals;
  services?: OzonDetailTotals;
  others?: {
    items?: OzonDetailItem[];
  };
  'return'?: OzonDetailTotals;
}

interface OzonResponse {
  result?: {
    details?: OzonDetail[];
  };
}

interface OzonPayoutItem {
  period: {
    begin: string;
    end: string;
  };
  amount: number;
  payout_date: string;
}

function dateOnly(value?: string) {
  if (!value) return '';
  return value.slice(0, 10);
}

function addDaysUtc(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatUtcDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function computePlannedPayoutDate(periodEnd: string) {
  const parsed = new Date(periodEnd);
  if (Number.isNaN(parsed.getTime())) return '';

  const day = parsed.getUTCDay();
  let daysToWednesday = (3 - day + 7) % 7;
  if (daysToWednesday === 0) daysToWednesday = 7;

  const nextWednesday = addDaysUtc(parsed, daysToWednesday);
  const payoutDate = addDaysUtc(nextWednesday, 21);

  return formatUtcDate(payoutDate);
}

function buildDefaultRange() {
  const now = new Date();
  const fromDate = new Date(now);
  const toDate = new Date(now);

  fromDate.setDate(fromDate.getDate() - 90);
  fromDate.setHours(0, 0, 0, 0);

  toDate.setDate(toDate.getDate() + 120);
  toDate.setHours(23, 59, 59, 999);

  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
  };
}

function sumNegativeOthers(items?: OzonDetailItem[]) {
  if (!items?.length) return 0;

  return items.reduce((total, item) => {
    const price = Number(item.price ?? 0);
    return price < 0 ? total + price : total;
  }, 0);
}

function calcPayout(detail: OzonDetail) {
  const delivery = Number(detail.delivery?.total ?? 0);
  const returns = Number(detail['return']?.total ?? 0);
  const services = Number(detail.services?.total ?? 0);
  const others = sumNegativeOthers(detail.others?.items);

  return delivery + returns + services + others;
}

export async function POST(request: Request) {
  let body: { clientId?: string; apiKey?: string; from?: string; to?: string; today?: string } = {};

  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const clientId = body.clientId?.trim();
  const apiKey = body.apiKey?.trim();

  if (!clientId || !apiKey) {
    return NextResponse.json({ error: 'clientId and apiKey are required.' }, { status: 400 });
  }

  const range = buildDefaultRange();
  const payload = {
    date: {
      from: body.from || range.from,
      to: body.to || range.to,
    },
    page: 1,
    page_size: 100,
    with_details: true,
  };

  let response: Response;

  try {
    response = await fetch(OZON_ENDPOINT, {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return NextResponse.json({ error: 'Failed to reach Ozon API.' }, { status: 502 });
  }

  const rawText = await response.text();

  if (!response.ok) {
    return NextResponse.json(
      { error: `Ozon API error: ${response.status} ${response.statusText}. ${rawText}` },
      { status: response.status },
    );
  }

  let data: OzonResponse;

  try {
    data = JSON.parse(rawText) as OzonResponse;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON from Ozon API.' }, { status: 502 });
  }

  const details = data.result?.details ?? [];
  const today = body.today?.trim() || new Date().toISOString().slice(0, 10);

  const items = details
    .map((detail) => {
      const begin = dateOnly(detail.period?.begin);
      const end = dateOnly(detail.period?.end);

      if (!begin || !end) return null;
      const payoutDate = computePlannedPayoutDate(end);
      if (!payoutDate) return null;

      return {
        period: { begin, end },
        amount: calcPayout(detail),
        payout_date: payoutDate,
      };
    })
    .filter((item): item is OzonPayoutItem => Boolean(item))
    .filter((item) => item.period.end < today)
    .sort((a, b) => {
      const payoutSort = b.payout_date.localeCompare(a.payout_date);
      if (payoutSort !== 0) return payoutSort;
      return a.period.begin.localeCompare(b.period.begin);
    })
    .slice(0, 5);

  return NextResponse.json({ items });
}
