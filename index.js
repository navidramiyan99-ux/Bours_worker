/**
 * index.js — نسخه دوم Worker، بهینه برای سرعت
 * شامل: کلاینت tsetmc با timeout، هر ۱۶ ربات + طلا، واچ‌لیست، روتر اصلی
 */

/**
 * tsetmc-client.js — نسخه دوم، بهینه برای سرعت
 *
 * تغییرات کلیدی نسبت به نسخه قبل:
 * ۱. استفاده از اندپوینت‌های REST جدید (cdn.tsetmc.com/api/...) که JSON برمی‌گردانند
 *    به‌جای فرمت متنی قدیمی که پردازشش کندتر و شکننده‌تر بود.
 * ۲. Timeout سخت‌گیرانه (5 ثانیه) روی هر درخواست — اگر سایت مبدا جواب نداد،
 *    بلافاصله شکست اعلام می‌شود، به‌جای معلق ماندن کل صفحه.
 * ۳. کش کردن دیده‌بان بازار در حافظه‌ی موقت درخواست — چون چند ربات به یک داده نیاز دارند،
 *    فقط یک‌بار در هر اجرای /api/robots/all گرفته می‌شود.
 *
 * منبع تایید آدرس‌ها: فایل مرجع عمومی و شناخته‌شده‌ی exref (m-ahmadi/exref/tse/urls.txt)
 */

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'http://www.tsetmc.com/',
};

const REQUEST_TIMEOUT_MS = 5000;

// اندپوینت جدید REST که کل دیده‌بان بازار را به‌صورت JSON برمی‌گرداند
const MARKET_WATCH_URL = 'http://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch';

// اندپوینت قدیمی به‌عنوان پشتیبان (fallback) در صورت شکست اولی
const MARKET_WATCH_FALLBACK_URL = 'http://www.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0';

const INDEX_ALL_URL = 'http://tse.ir/archive/IndicesArchiveDate.json';

/**
 * fetch با timeout اجباری — اگر سرور مبدا در بازه‌ی مشخص جواب ندهد،
 * خودمان درخواست را لغو می‌کنیم تا کل صفحه معطل نماند.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return resp;
  } catch (err) {
    clearTimeout(timeoutId);
    return null;
  }
}

async function safeFetchText(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const resp = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS }, timeoutMs);
  if (resp && resp.ok) {
    try {
      return await resp.text();
    } catch (err) {
      return null;
    }
  }
  return null;
}

async function safeFetchJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const resp = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS }, timeoutMs);
  if (resp && resp.ok) {
    try {
      return await resp.json();
    } catch (err) {
      return null;
    }
  }
  return null;
}

function toFloatSafe(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-') return fallback;
  const num = parseFloat(cleaned);
  return isNaN(num) ? fallback : num;
}

/**
 * دریافت و تجزیه‌ی دیده‌بان بازار.
 * ابتدا اندپوینت REST جدید را امتحان می‌کند؛ در صورت شکست، به فرمت قدیمی برمی‌گردد.
 * خروجی استاندارد: آرایه‌ای از {symbol, name, finalPrice, changePct, volume, value, baseVolume, marketCap}
 */
async function getMarketWatch() {
  // تلاش اول: اندپوینت جدید JSON
  const jsonData = await safeFetchJson(MARKET_WATCH_URL);
  if (jsonData) {
    const parsed = parseMarketWatchJson(jsonData);
    if (parsed.length > 0) return parsed;
  }

  // تلاش دوم (fallback): فرمت متنی قدیمی
  const rawText = await safeFetchText(MARKET_WATCH_FALLBACK_URL);
  if (rawText) {
    const parsed = parseMarketWatchLegacyText(rawText);
    if (parsed.length > 0) return parsed;
  }

  return [];
}

function parseMarketWatchJson(data) {
  // ساختار دقیق پاسخ ممکن است instrumentList یا marketWatch یا آرایه‌ی مستقیم باشد؛
  // این تابع چند حالت محتمل را پوشش می‌دهد تا با تغییرات جزئی API سازگار بماند.
  const items = data.instrumentList || data.marketWatch || data.items || (Array.isArray(data) ? data : []);
  if (!Array.isArray(items) || items.length === 0) return [];

  return items.map((item) => ({
    symbol: item.lVal18AFC || item.symbol || item.lVal18 || '',
    name: item.lVal30 || item.name || '',
    finalPrice: toFloatSafe(item.pDrCotVal ?? item.finalPrice ?? item.pClosing),
    lastPrice: toFloatSafe(item.pDrCotVal ?? item.lastPrice),
    changePct: toFloatSafe(item.priceChangePercent ?? item.plc ?? item.changePct),
    volume: toFloatSafe(item.qTotTran5J ?? item.volume ?? item.tVol),
    value: toFloatSafe(item.qTotCap ?? item.value ?? item.tVal),
    baseVolume: toFloatSafe(item.baseVol ?? item.baseVolume),
    marketCap: toFloatSafe(item.marketCap ?? item.mCap ?? item.zTitad),
  })).filter((r) => r.symbol);
}

function parseMarketWatchLegacyText(rawText) {
  const symbols = [];
  try {
    const sections = rawText.split('@');
    if (sections.length < 3) return [];
    const rows = sections[2].split(';');
    for (const row of rows) {
      if (!row.trim()) continue;
      const cols = row.split(',');
      if (cols.length < 20) continue;
      symbols.push({
        symbol: cols[2],
        name: cols[3],
        lastPrice: toFloatSafe(cols[5]),
        finalPrice: toFloatSafe(cols[7]),
        changePct: toFloatSafe(cols[10]),
        volume: toFloatSafe(cols[8]),
        value: toFloatSafe(cols[9]),
        baseVolume: toFloatSafe(cols[16]),
        marketCap: toFloatSafe(cols[17]),
      });
    }
  } catch (err) {
    return [];
  }
  return symbols;
}

/**
 * دریافت مقادیر شاخص کل و هم‌وزن از آرشیو رسمی شاخص‌ها.
 */
async function getIndices() {
  const data = await safeFetchJson(INDEX_ALL_URL);
  if (!data) return { total: null, equalWeight: null };

  try {
    const list = Array.isArray(data) ? data : (data.indices || []);
    const total = list.find((i) => (i.name || i.indexName || '').includes('کل') && !(i.name || '').includes('هم'));
    const eq = list.find((i) => (i.name || i.indexName || '').includes('هم وزن') || (i.name || i.indexName || '').includes('هم‌وزن'));

    return {
      total: total ? { value: toFloatSafe(total.value ?? total.lastValue), changePct: toFloatSafe(total.changePercent ?? total.plc) } : null,
      equalWeight: eq ? { value: toFloatSafe(eq.value ?? eq.lastValue), changePct: toFloatSafe(eq.changePercent ?? eq.plc) } : null,
    };
  } catch (err) {
    return { total: null, equalWeight: null };
  }
}

function robotResponse(robotId, status, data, message = null) {
  return {
    robot: robotId,
    status,
    message,
    data,
    serverTime: Date.now(),
  };
}


/**
 * robots-part1.js — ربات‌های ۱ تا ۹ (نسخه سریع)
 * همه از یک دیده‌بان بازار مشترک (marketWatch) استفاده می‌کنند که یک‌بار گرفته می‌شود.
 */


// ========================================================================
// ربات ۱ — کدام شرکت‌ها بهترند
// ========================================================================
async function robot01() {
  const { total, equalWeight } = await getIndices();

  if (!total || !equalWeight) {
    return robotResponse('01', 'error', null, 'دریافت داده شاخص‌ها ممکن نشد.');
  }

  const totalRatio = total.value !== 0 ? total.changePct / total.value : 0;
  const eqRatio = equalWeight.value !== 0 ? equalWeight.changePct / equalWeight.value : 0;

  let conclusion, sentiment;
  if (total.changePct < 0 && equalWeight.changePct < 0) {
    conclusion = totalRatio > eqRatio
      ? 'شرکت‌ها کلاً در حال ضرر هستند (افت شاخص کل نسبتاً کمتر است)'
      : 'شرکت‌ها کلاً در حال ضرر هستند (افت شاخص هم‌وزن نسبتاً کمتر است)';
    sentiment = 'negative';
  } else if (totalRatio > eqRatio) {
    conclusion = 'شرکت‌های بزرگ در حال رشد هستند';
    sentiment = 'positive';
  } else {
    conclusion = 'شرکت‌های کوچک در حال رشد هستند';
    sentiment = 'positive';
  }

  return robotResponse('01', 'ok', {
    totalIndex: { value: total.value, changePct: total.changePct, ratio: totalRatio },
    equalWeightIndex: { value: equalWeight.value, changePct: equalWeight.changePct, ratio: eqRatio },
    conclusion,
    sentiment,
  });
}

// ========================================================================
// ربات ۲ — عرضه اولیه (بر پایه دیده‌بان بازار مشترک)
// ========================================================================
function robot02(marketWatch) {
  const categories = { comingSoon: null, firstDay: null, recentlyListed: null, newlyRegistered: null };

  if (!marketWatch || !marketWatch.length) {
    return robotResponse('02', 'error', categories, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const candidates = marketWatch.filter((s) => s.volume > 1 && s.baseVolume === 0);
  if (candidates.length > 0) {
    categories.recentlyListed = candidates.slice(0, 10).map((c) => ({ symbol: c.symbol, changePct: c.changePct }));
  }

  return robotResponse('02', 'ok', categories,
    'دسته «عرضه اولیه در راه است» نیازمند اتصال به اطلاعیه‌های رسمی سازمان بورس است.');
}

// ========================================================================
// ربات ۳ — حق تقدم
// ========================================================================
const RIGHTS_LABELS = { firstDay: 'اولین روز', newlyOpened: 'تازه باز شده', subscriptionOpen: 'در حال پذیره‌نویسی', closed: 'بسته شده' };
const RIGHTS_PRIORITY = { firstDay: 1, newlyOpened: 2, subscriptionOpen: 3, closed: 4 };

function classifyRights(s) {
  if (s.volume === 0) return 'closed';
  if (Math.abs(s.changePct) > 0 && s.volume > 0) return 'subscriptionOpen';
  return 'newlyOpened';
}

function robot03(marketWatch) {
  if (!marketWatch || !marketWatch.length) {
    return robotResponse('03', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const rightsSymbols = marketWatch.filter((s) => s.symbol && s.symbol.endsWith('ح'));
  const rows = rightsSymbols.map((s) => {
    const status = classifyRights(s);
    return { symbol: s.symbol, status, statusLabel: RIGHTS_LABELS[status], priority: RIGHTS_PRIORITY[status], changePct: s.changePct };
  });
  rows.sort((a, b) => a.priority - b.priority);

  return robotResponse('03', 'ok', rows);
}

// ========================================================================
// ربات ۴ — رفتار سهامداران عمده (تخمین اولیه بر پایه دیده‌بان بازار)
// ========================================================================
function robot04(marketWatch) {
  if (!marketWatch || !marketWatch.length) {
    return robotResponse('04', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const fundKeywords = ['صندوق', 'سرمایه گذاري', 'سرمایه‌گذاری'];
  const fundRelated = marketWatch.filter((s) => fundKeywords.some((kw) => (s.name || '').includes(kw)));

  const topFunds = fundRelated
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 15)
    .map((s) => ({ symbol: s.symbol, name: s.name, changePct: s.changePct, action: s.changePct >= 0 ? 'خرید/رشد' : 'فروش/افت' }));

  return robotResponse('04', 'ok', { fundActivity: topFunds });
}

// ========================================================================
// ربات ۵ — شاخص‌های منتخب
// ========================================================================
function robot05(marketWatch) {
  if (!marketWatch || !marketWatch.length) {
    return robotResponse('05', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const positive = marketWatch.filter((s) => s.changePct > 0);
  const top = positive.sort((a, b) => b.changePct - a.changePct).slice(0, 15)
    .map((s) => ({ symbol: s.symbol, changePct: s.changePct, sentiment: 'positive' }));

  return robotResponse('05', 'ok', top);
}

// ========================================================================
// ربات ۶ — نمادهای پربیننده
// ========================================================================
function robot06(marketWatch) {
  if (!marketWatch || !marketWatch.length) {
    return robotResponse('06', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const sorted = [...marketWatch].sort((a, b) => b.volume - a.volume).slice(0, 20);
  const rows = sorted.map((s, i) => ({ rank: i + 1, symbol: s.symbol, changePct: s.changePct, sentiment: s.changePct >= 0 ? 'positive' : 'negative', volume: s.volume }));

  return robotResponse('06', 'ok', rows);
}

// ========================================================================
// ربات ۷ — برترین گروه صنعت
// ========================================================================
function robot07(marketWatch) {
  if (!marketWatch || !marketWatch.length) {
    return robotResponse('07', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const withRatio = marketWatch
    .filter((s) => s.marketCap > 0)
    .map((s) => ({ symbol: s.symbol, tradeValue: s.value, marketCap: s.marketCap, ratioPct: (s.value / s.marketCap) * 100 }))
    .sort((a, b) => b.ratioPct - a.ratioPct)
    .slice(0, 10)
    .map((r, i) => ({ rank: i + 1, ...r }));

  return robotResponse('07', 'ok', withRatio);
}

// ========================================================================
// ربات ۸ — بیشترین کاهش قیمت
// ========================================================================
const ETF_KEYWORDS = ['صندوق', 'ETF', 'قابل معامله'];

function robot08(marketWatch) {
  if (!marketWatch || !marketWatch.length) {
    return robotResponse('08', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const negative = marketWatch.filter((s) => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
  const etfRows = negative.filter((s) => ETF_KEYWORDS.some((kw) => (s.name || '').includes(kw))).slice(0, 20);
  const generalRows = negative.filter((s) => !ETF_KEYWORDS.some((kw) => (s.name || '').includes(kw))).slice(0, 20);

  return robotResponse('08', 'ok', {
    marketGeneral: generalRows.map((s) => ({ symbol: s.symbol, changePct: s.changePct })),
    etf: etfRows.map((s) => ({ symbol: s.symbol, changePct: s.changePct })),
  });
}

// ========================================================================
// ربات ۹ — برترین عرضه‌ها
// ========================================================================
function robot09(marketWatch) {
  if (!marketWatch || !marketWatch.length) {
    return robotResponse('09', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const sorted = [...marketWatch].sort((a, b) => b.volume - a.volume).slice(0, 10);
  const rows = sorted.map((s, i) => ({ rank: i + 1, symbol: s.symbol, volume: s.volume }));

  return robotResponse('09', 'ok', rows);
}


/**
 * robots-part2.js — ربات‌های ۱۰ تا ۱۳ (نسخه سریع)
 */


// ========================================================================
// ربات ۱۰ — افزایش سرمایه (کدال)
// ========================================================================
async function robot10() {
  const url = 'https://search.codal.ir/api/search/v2/q?PageNumber=1&Category=Group_TarhIssueSharePriceInfoV2&IsNotAudited=false';
  const data = await safeFetchJson(url);

  if (!data) {
    return robotResponse('10', 'error', null, 'دریافت اطلاعیه‌های افزایش سرمایه از کدال ممکن نشد.');
  }

  let rows = [];
  try {
    const letters = data.Letters || [];
    rows = letters.slice(0, 10).map((item) => ({
      symbol: item.Symbol, companyName: item.CompanyName, title: item.Title, publishDate: item.PublishDateTime,
    }));
  } catch (err) {
    return robotResponse('10', 'error', null, 'پاسخ کدال قابل تجزیه نبود.');
  }

  return robotResponse('10', 'ok', rows);
}

// ========================================================================
// ربات ۱۱ — نمادهای پربیننده (بورس و فرابورس)
// ========================================================================
function robot11(marketWatch) {
  if (!marketWatch || !marketWatch.length) {
    return robotResponse('11', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const sorted = [...marketWatch].sort((a, b) => b.volume - a.volume);
  const bourse = sorted.slice(0, 20).map((s, i) => ({ rank: i + 1, symbol: s.symbol, volume: s.volume }));

  return robotResponse('11', 'ok', { bourse, otc: [] });
}

// ========================================================================
// ربات ۱۲ — صندوق‌های کالایی
// ========================================================================
const COMMODITY_KEYWORDS = ['طلا', 'گوهر', 'عیار', 'کهربا', 'کالا'];

function robot12(marketWatch) {
  if (!marketWatch || !marketWatch.length) {
    return robotResponse('12', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const funds = marketWatch.filter((s) => COMMODITY_KEYWORDS.some((kw) => (s.symbol || '').includes(kw) || (s.name || '').includes(kw)));
  const top = funds.sort((a, b) => b.volume - a.volume).slice(0, 10)
    .map((s, i) => ({ rank: i + 1, symbol: s.symbol, volume: s.volume, value: s.value }));

  return robotResponse('12', 'ok', top);
}

// ========================================================================
// ربات ۱۳ — حباب صندوق‌های طلا
// ========================================================================
async function fetchFundNav(fundName) {
  const url = `http://fipiran.com/api/v1/fund/getfundnav?name=${encodeURIComponent(fundName)}`;
  const data = await safeFetchJson(url);
  if (!data) return null;
  return toFloatSafe(data.cancelNav, null);
}

async function robot13(marketWatch) {
  if (!marketWatch || !marketWatch.length) {
    return robotResponse('13', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const goldFunds = marketWatch.filter((s) => COMMODITY_KEYWORDS.some((kw) => (s.symbol || '').includes(kw) || (s.name || '').includes(kw))).slice(0, 8);

  // دریافت موازی NAV همه صندوق‌ها برای سرعت بیشتر (به‌جای پشت‌سرهم)
  const navResults = await Promise.all(goldFunds.map((s) => fetchFundNav(s.name || '')));

  const rows = goldFunds.map((s, idx) => {
    const nav = navResults[idx];
    if (nav === null || nav === 0) {
      return { symbol: s.symbol, tradePrice: s.finalPrice, nav: null, bubblePct: null, bubbleType: 'نامشخص (NAV در دسترس نیست)' };
    }
    const bubblePct = ((s.finalPrice - nav) / nav) * 100;
    return {
      symbol: s.symbol, tradePrice: s.finalPrice, nav,
      bubblePct: Math.round(bubblePct * 100) / 100,
      bubbleType: bubblePct > 0 ? 'مثبت' : 'منفی',
      sentiment: bubblePct > 0 ? 'negative' : 'positive',
    };
  });

  rows.sort((a, b) => Math.abs(b.bubblePct || 0) - Math.abs(a.bubblePct || 0));

  return robotResponse('13', 'ok', rows);
}


/**
 * robots-part3.js — ربات‌های ۱۴ تا ۱۶ (نسخه سریع)
 */


// ========================================================================
// ربات ۱۴ — Fipiran (پول هوشمند)
// ========================================================================
async function robot14() {
  const data = await safeFetchJson('http://fipiran.com/api/v1/fund/fundcompare');

  if (!data) {
    return robotResponse('14', 'error', null, 'دریافت داده از fipiran.com ممکن نشد.');
  }

  const funds = data.items || [];
  if (!funds.length) {
    return robotResponse('14', 'error', null, 'داده‌ای از fipiran دریافت نشد.');
  }

  const topHoldings = [...funds].sort((a, b) => toFloatSafe(b.netAsset) - toFloatSafe(a.netAsset)).slice(0, 5)
    .map((f) => ({ fundName: f.name, netAsset: f.netAsset }));

  const smartMoney = [...funds].sort((a, b) => toFloatSafe(b.dailyReturn) - toFloatSafe(a.dailyReturn)).slice(0, 10)
    .map((f) => ({ fundName: f.name, dailyReturn: f.dailyReturn }));

  const navGrowth = funds.filter((f) => toFloatSafe(f.dailyReturn) > 0).slice(0, 10)
    .map((f) => ({ fundName: f.name, navChange: f.dailyReturn }));

  return robotResponse('14', 'ok', {
    topHoldingsByBigFunds: topHoldings,
    smartMoneyInflow: smartMoney,
    navGrowth,
  });
}

// ========================================================================
// ربات ۱۵ — قیمت سهم نسبت به دلار
// ========================================================================
async function fetchDollarPrice() {
  const data = await safeFetchJson('https://api.navasan.tech/latest/');
  if (!data) return null;
  return toFloatSafe(data.usd?.value, null);
}

async function robot15(marketWatch) {
  if (!marketWatch || !marketWatch.length) {
    return robotResponse('15', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const dollarPrice = await fetchDollarPrice();
  if (dollarPrice === null) {
    return robotResponse('15', 'error', null, 'دریافت نرخ دلار ممکن نشد.');
  }

  const bigCompanies = [...marketWatch].sort((a, b) => b.marketCap - a.marketCap).slice(0, 30);
  const rows = bigCompanies.map((s) => ({
    symbol: s.symbol,
    priceToday: s.finalPrice,
    ratioToday: Math.round((s.finalPrice / dollarPrice) * 100 * 10000) / 10000,
    ratio30DaysAgo: null,
    status: 'نیاز به داده تاریخی ۳۰ روزه',
  }));

  return robotResponse('15', 'ok', rows);
}

// ========================================================================
// ربات ۱۶ — اثر نقدینگی
// ========================================================================
async function robot16(env) {
  let liquidityGrowth = null;
  let liquidityUpdatedDate = null;

  if (env && env.BOURSE_KV) {
    try {
      const stored = await env.BOURSE_KV.get('liquidity_growth_monthly');
      if (stored) {
        const parsed = JSON.parse(stored);
        liquidityGrowth = parsed.valuePct;
        liquidityUpdatedDate = parsed.updatedDate;
      }
    } catch (err) { /* بدون تغییر، liquidityGrowth همچنان null */ }
  }

  const dollarPrice = await fetchDollarPrice();
  const { total } = await getIndices();

  const data = {
    liquidityGrowthMonthly: liquidityGrowth,
    liquidityLastUpdated: liquidityUpdatedDate,
    dollarPriceToday: dollarPrice,
    totalIndexChangePct: total ? total.changePct : null,
  };

  if (liquidityGrowth === null) {
    data.rulesTriggered = ['رشد نقدینگی ماهانه هنوز وارد نشده است.'];
    data.sentiment = 'neutral';
    return robotResponse('16', 'ok', data, 'این ربات نیاز به بروزرسانی دستی ماهانه دارد.');
  }

  const rules = [];
  let sentiment = 'neutral';

  if (dollarPrice !== null && total) {
    if (liquidityGrowth > dollarPrice) {
      rules.push('قانون ۱: رشد نقدینگی بیشتر از دلار — ورود پول به بورس، رشد سهم‌ها');
    } else {
      rules.push('قانون ۲: رشد دلار بیشتر از نقدینگی — پول به سمت ارز، عقب‌افتادگی سهم‌ها');
    }
    if (liquidityGrowth > total.changePct) {
      rules.push('قانون ۳: رشد نقدینگی بیشتر از شاخص کل — رشد سهم‌های کوچک، پول هوشمند فعال');
    }
    if (liquidityGrowth > 0 && Math.abs(total.changePct) < 0.3) {
      rules.push('قانون ۴: نقدینگی بالا، شاخص راکد — بازار آماده جهش');
      sentiment = 'gold';
    } else {
      sentiment = liquidityGrowth > dollarPrice ? 'positive' : 'negative';
    }
  }

  data.rulesTriggered = rules;
  data.sentiment = sentiment;

  return robotResponse('16', 'ok', data);
}


/**
 * robot-gold.js — ربات طلا (نسخه دوم، سریع و مطمئن)
 * منبع دلار: bonbast.amirhn.com — رایگان، بدون نیاز به کلید API، بدون محدودیت درخواست.
 * منبع انس جهانی: metals.live (fallback ساده در صورت شکست)
 */


const DIVISORS = {
  gold24k: 31.1, gold21_6k: 34.56, gold18k: 41.47, mesghal: 9.57,
  coinFull: 4.25, coinHalf: 8.5, coinQuarter: 17, coinGram: 34,
};
const MESGHAL_TO_GRAM18_DIVISOR = 4.33;

const LABELS = {
  gold24k: 'طلای ۲۴ عیار (۱ گرم)', gold21_6k: 'طلای ۲۱.۶ عیار (۱ گرم)', gold18k: 'طلای ۱۸ عیار (۱ گرم)',
  mesghal: 'مظنه (مثقال ۱۷ عیار)', mesghalToGram18: 'تبدیل مظنه به گرم ۱۸',
  coinFull: 'سکه تمام', coinHalf: 'سکه نیم', coinQuarter: 'سکه ربع', coinGram: 'سکه گرمی',
};

async function fetchDollarPriceToman() {
  // Bonbast API (بدون کلید) — قیمت دلار بازار آزاد به تومان
  const data = await safeFetchJson('https://bonbast.amirhn.com/latest');
  if (data) {
    // ساختار محتمل پاسخ: { usd1: {sell, buy}, ... } یا { usd_sell, usd_buy }
    const sell = data.usd1?.sell ?? data.usd_sell ?? data.usd?.sell ?? data.USD?.sell;
    if (sell) return toFloatSafe(sell);
  }
  return null;
}

async function fetchGoldOunceUsd() {
  const data = await safeFetchJson('https://api.metals.live/v1/spot/gold');
  if (data) {
    if (Array.isArray(data) && data.length > 0) return toFloatSafe(data[0].price, null);
    if (data.price) return toFloatSafe(data.price, null);
  }
  return null;
}

async function robotGold() {
  // دو درخواست به‌صورت موازی برای سرعت بیشتر
  const [dollarPrice, ounceUsd] = await Promise.all([fetchDollarPriceToman(), fetchGoldOunceUsd()]);

  if (dollarPrice === null || ounceUsd === null) {
    return robotResponse('gold', 'error', null,
      `دریافت ${dollarPrice === null ? 'نرخ دلار' : 'قیمت جهانی طلا'} در حال حاضر ممکن نیست.`);
  }

  const goldBaseToman = ounceUsd * dollarPrice;
  const products = {};
  for (const [key, divisor] of Object.entries(DIVISORS)) {
    products[key] = Math.round(goldBaseToman / divisor);
  }
  products.mesghalToGram18 = Math.round(products.mesghal / MESGHAL_TO_GRAM18_DIVISOR);

  return robotResponse('gold', 'ok', {
    dollarPrice, goldOunceUsd: ounceUsd, goldBaseToman: Math.round(goldBaseToman), products, labels: LABELS,
  });
}


/**
 * watchlist.js — واچ‌لیست ۵۰ نماد (نسخه سریع، استفاده از دیده‌بان بازار مشترک)
 */


const MAX_SYMBOLS = 50;
const KV_KEY = 'watchlist_symbols';

async function loadWatchlistSymbols(env) {
  if (!env || !env.BOURSE_KV) return [];
  try {
    const stored = await env.BOURSE_KV.get(KV_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (err) {
    return [];
  }
}

async function saveWatchlistSymbols(env, symbols) {
  if (!env || !env.BOURSE_KV) return symbols;
  const unique = [...new Set(symbols)].slice(0, MAX_SYMBOLS);
  await env.BOURSE_KV.put(KV_KEY, JSON.stringify(unique));
  return unique;
}

async function addSymbolToWatchlist(env, symbolName) {
  const current = await loadWatchlistSymbols(env);
  if (current.includes(symbolName)) {
    return { status: 'error', message: 'این نماد از قبل در واچ‌لیست موجود است.', watchlist: current };
  }
  if (current.length >= MAX_SYMBOLS) {
    return { status: 'error', message: 'حداکثر ۵۰ نماد قابل افزودن است.', watchlist: current };
  }
  current.push(symbolName);
  const saved = await saveWatchlistSymbols(env, current);
  return { status: 'ok', watchlist: saved };
}

async function removeSymbolFromWatchlist(env, symbolName) {
  let current = await loadWatchlistSymbols(env);
  current = current.filter((s) => s !== symbolName);
  const saved = await saveWatchlistSymbols(env, current);
  return { status: 'ok', watchlist: saved };
}

function buildRow(symbolRow) {
  return {
    symbol: symbolRow.symbol, finalPrice: symbolRow.finalPrice, changePct: symbolRow.changePct,
    volume: symbolRow.volume, baseVolume: symbolRow.baseVolume, value: symbolRow.value,
    realToLegalCode: null, realMoneyFlow: null, freeFloatPct: null, peRatio: null, queueStatus: null,
  };
}

async function runWatchlist(env, marketWatch) {
  const watchlist = await loadWatchlistSymbols(env);

  if (!watchlist.length) {
    return robotResponse('watchlist', 'ok', [], 'واچ‌لیست خالی است.');
  }

  if (!marketWatch || !marketWatch.length) {
    return robotResponse('watchlist', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const symbolMap = {};
  for (const s of marketWatch) symbolMap[s.symbol] = s;

  const rows = watchlist.map((symName) => {
    if (symbolMap[symName]) return buildRow(symbolMap[symName]);
    return { symbol: symName, finalPrice: null, changePct: null, volume: null, baseVolume: null, value: null,
      realToLegalCode: null, realMoneyFlow: null, freeFloatPct: null, peRatio: null, queueStatus: null,
      note: 'نماد یافت نشد.' };
  });

  return robotResponse('watchlist', 'ok', rows);
}


/**
 * worker.js — نسخه دوم، بهینه‌شده برای سرعت
 *
 * تغییر معماری کلیدی نسبت به نسخه قبل:
 * دیده‌بان بازار (که ۱۲ ربات از ۱۷ ربات بهش نیاز دارند) فقط یک‌بار در ابتدای
 * هر درخواست /api/robots/all گرفته می‌شود و بین همه‌ی ربات‌ها به اشتراک گذاشته می‌شود.
 * این یعنی به‌جای ۱۲ درخواست جداگانه به tsetmc، فقط ۱ درخواست زده می‌شود.
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

/**
 * دسته‌بندی ربات‌ها بر اساس نیازشان به دیده‌بان بازار مشترک.
 * ربات‌هایی که نیاز ندارند (مستقیم API بیرونی دیگری دارند) جدا فراخوانی می‌شوند.
 */
const MARKET_WATCH_DEPENDENT_ROBOTS = {
  '02': robot02, '03': robot03, '04': robot04, '05': robot05, '06': robot06,
  '07': robot07, '08': robot08, '09': robot09, '11': robot11, '12': robot12,
};

const INDEPENDENT_ROBOTS = {
  '01': robot01, '10': robot10, '14': robot14, '16': robot16, 'gold': robotGold,
};

async function runSingleRobot(robotId, env, marketWatch) {
  try {
    if (robotId === '13') return await robot13(marketWatch);
    if (robotId === '15') return await robot15(marketWatch);
    if (robotId === '16') return await robot16(env);

    if (MARKET_WATCH_DEPENDENT_ROBOTS[robotId]) {
      return MARKET_WATCH_DEPENDENT_ROBOTS[robotId](marketWatch);
    }
    if (INDEPENDENT_ROBOTS[robotId]) {
      return await INDEPENDENT_ROBOTS[robotId](env);
    }
    return robotResponse(robotId, 'error', null, `رباتی با شناسه ${robotId} یافت نشد.`);
  } catch (err) {
    return robotResponse(robotId, 'error', null, `خطای غیرمنتظره: ${err.message}`);
  }
}

const workerHandler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // ===== همه‌ی ربات‌ها یکجا (مسیر اصلی داشبورد) =====
      if (path === '/api/robots/all') {
        // دیده‌بان بازار فقط یک‌بار گرفته می‌شود؛ همه‌ی ربات‌های وابسته از همین استفاده می‌کنند
        const marketWatch = await getMarketWatch();

        const allRobotIds = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', 'gold'];
        const results = {};

        // اجرای کاملاً موازی همه‌ی ربات‌ها (چون دیده‌بان بازار از قبل آماده است، سریع اجرا می‌شوند)
        await Promise.all(
          allRobotIds.map(async (id) => {
            results[id] = await runSingleRobot(id, env, marketWatch);
          })
        );

        return jsonResponse(results);
      }

      // ===== ربات منفرد =====
      const robotMatch = path.match(/^\/api\/robot\/([a-zA-Z0-9_]+)$/);
      if (robotMatch) {
        const robotId = robotMatch[1];
        let marketWatch = null;
        if (MARKET_WATCH_DEPENDENT_ROBOTS[robotId] || robotId === '13' || robotId === '15') {
          marketWatch = await getMarketWatch();
        }
        const result = await runSingleRobot(robotId, env, marketWatch);
        return jsonResponse(result);
      }

      // ===== واچ‌لیست =====
      if (path === '/api/watchlist' && request.method === 'GET') {
        const marketWatch = await getMarketWatch();
        const result = await runWatchlist(env, marketWatch);
        return jsonResponse(result);
      }

      if (path === '/api/watchlist/add' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const symbol = (body.symbol || '').trim();
        if (!symbol) return jsonResponse({ status: 'error', message: 'نام نماد ارسال نشده است.' }, 400);
        const result = await addSymbolToWatchlist(env, symbol);
        return jsonResponse(result);
      }

      if (path === '/api/watchlist/remove' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const symbol = (body.symbol || '').trim();
        if (!symbol) return jsonResponse({ status: 'error', message: 'نام نماد ارسال نشده است.' }, 400);
        const result = await removeSymbolFromWatchlist(env, symbol);
        return jsonResponse(result);
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

export default workerHandler;
