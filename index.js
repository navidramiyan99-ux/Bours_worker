/**
 * index.js — نسخه ساده‌شده Worker
 *
 * معماری جدید (بر پایه یافته‌های تست با Termux):
 * Termux (داخل ایران) → داده واقعی از tsetmc می‌گیرد → POST به /api/push
 * داشبورد (هر جای دنیا) → GET از /api/data → آخرین داده ذخیره‌شده در KV را می‌گیرد
 *
 * این معماری از محدودیت CORS/جغرافیایی Cloudflare عبور می‌کند چون
 * Worker دیگر مستقیم به tsetmc وصل نمی‌شود؛ فقط واسط ذخیره‌سازی است.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

const DATA_KEY = 'latest_bourse_data';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // ===== دریافت داده از Termux (فقط این اسکریپت باید اینجا POST کند) =====
      if (path === '/api/push' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) {
          return jsonResponse({ status: 'error', message: 'داده نامعتبر است.' }, 400);
        }
        if (!env.BOURSE_KV) {
          return jsonResponse({ status: 'error', message: 'KV تنظیم نشده است.' }, 500);
        }
        await env.BOURSE_KV.put(DATA_KEY, JSON.stringify(body));
        return jsonResponse({ status: 'ok', message: 'داده ذخیره شد.', receivedAt: Date.now() });
      }

      // ===== تحویل آخرین داده به داشبورد =====
      if (path === '/api/data' && request.method === 'GET') {
        if (!env.BOURSE_KV) {
          return jsonResponse({ status: 'error', message: 'KV تنظیم نشده است.' }, 500);
        }
        const stored = await env.BOURSE_KV.get(DATA_KEY);
        if (!stored) {
          return jsonResponse({ status: 'error', message: 'هنوز داده‌ای ارسال نشده است.' }, 404);
        }
        const data = JSON.parse(stored);
        return jsonResponse({ status: 'ok', data });
      }

      // ===== واچ‌لیست: افزودن نماد به لیست درخواستی (Termux بعداً می‌خواند) =====
      if (path === '/api/watchlist/add' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const symbol = (body.symbol || '').trim();
        if (!symbol) return jsonResponse({ status: 'error', message: 'نام نماد ارسال نشده است.' }, 400);

        const stored = await env.BOURSE_KV.get('watchlist_symbols');
        const list = stored ? JSON.parse(stored) : [];
        if (!list.includes(symbol) && list.length < 50) {
          list.push(symbol);
          await env.BOURSE_KV.put('watchlist_symbols', JSON.stringify(list));
        }
        return jsonResponse({ status: 'ok', watchlist: list });
      }

      if (path === '/api/watchlist/remove' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const symbol = (body.symbol || '').trim();
        const stored = await env.BOURSE_KV.get('watchlist_symbols');
        let list = stored ? JSON.parse(stored) : [];
        list = list.filter((s) => s !== symbol);
        await env.BOURSE_KV.put('watchlist_symbols', JSON.stringify(list));
        return jsonResponse({ status: 'ok', watchlist: list });
      }

      if (path === '/api/watchlist' && request.method === 'GET') {
        const stored = await env.BOURSE_KV.get('watchlist_symbols');
        const list = stored ? JSON.parse(stored) : [];
        return jsonResponse({ status: 'ok', watchlist: list });
      }

      // ===== سلامت سرویس =====
      if (path === '/api/health') {
        return jsonResponse({ status: 'ok', message: 'Worker در حال اجراست.' });
      }

      return jsonResponse({ status: 'error', message: 'مسیر یافت نشد.' }, 404);
    } catch (err) {
      return jsonResponse({ status: 'error', message: `خطای سرور: ${err.message}` }, 500);
    }
  },
};
