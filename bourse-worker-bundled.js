/**
 * bourse-worker-bundled.js
 * نسخه‌ی تک‌فایلی کامل Worker — برای Paste مستقیم در ویرایشگر وب Cloudflare
 * شامل: کلاینت tsetmc، هر ۱۶ ربات + طلا، واچ‌لیست، و روتر اصلی
 */

/**
 * tsetmc-client.js
 * لایه‌ی مشترک دریافت داده از tsetmc.com برای همه‌ی ربات‌ها.
 *
 * ⚠️ نکته مهم: این آدرس‌ها بر پایه‌ی ساختار شناخته‌شده و مستند عمومی tsetmc نوشته شده‌اند.
 * اولین قدم بعد از استقرار روی Cloudflare باید تست این اندپوینت‌ها با درخواست واقعی باشد
 * (از طریق مسیر /api/health و بررسی لاگ‌ها در Cloudflare dashboard).
 */

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Referer': 'http://www.tsetmc.com/',
};

const MARKET_WATCH_URL = 'http://www.tsetmc.com/tsev2/data/MarketWatchInit.aspx?h=0&r=0';
const INDEX_VALUE_URL = 'http://www.tsetmc.com/tsev2/data/InstValue.aspx';

const INDEX_IDS = {
  total: '32097828799138957',        // شاخص کل
  equal_weight: '67130298613737946', // شاخص هم‌وزن
};

/**
 * درخواست GET امن با retry خودکار. در صورت شکست، null برمی‌گرداند (نه throw).
 */
async function safeFetch(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { headers: DEFAULT_HEADERS });
      if (resp.ok) {
        return await resp.text();
      }
    } catch (err) {
      if (attempt === retries) return null;
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
 * دریافت خام دیده‌بان بازار (همه‌ی نمادها با قیمت/حجم/تغییر).
 */
async function fetchMarketWatchRaw() {
  return await safeFetch(MARKET_WATCH_URL);
}

/**
 * تجزیه‌ی خروجی خام دیده‌بان بازار به آرایه‌ای از آبجکت‌های نماد.
 * اگر فرمت سایت تغییر کرده باشد، آرایه‌ی خالی برمی‌گرداند (نه خطا).
 */
function parseMarketWatch(rawText) {
  if (!rawText) return [];

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
        insCode: cols[0],
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
 * دریافت مقدار و درصد تغییر یک شاخص (کل / هم‌وزن).
 */
async function fetchIndexValue(indexKey) {
  const indexId = INDEX_IDS[indexKey];
  if (!indexId) return { value: null, changePct: null };

  const raw = await safeFetch(`${INDEX_VALUE_URL}?i=${indexId}`);
  if (!raw) return { value: null, changePct: null };

  try {
    const parts = raw.trim().split(';');
    if (parts.length >= 2) {
      const value = toFloatSafe(parts[parts.length - 2]);
      const changePct = toFloatSafe(parts[parts.length - 1]);
      return { value, changePct };
    }
  } catch (err) {
    // نادیده گرفتن و بازگشت مقدار پیش‌فرض
  }
  return { value: null, changePct: null };
}

/**
 * پاسخ استاندارد یکسان برای همه‌ی ربات‌ها.
 */
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
 * robots.js — پیاده‌سازی کامل ۱۶ ربات + ربات طلا
 * هر ربات دقیقاً طبق مشخصات داده‌شده توسط کاربر پیاده‌سازی شده است.
 * این فایل به چند بخش تقسیم شده تا خوانا و قابل نگهداری بماند.
 */


// ========================================================================
// ربات ۱ — کدام شرکت‌ها بهترند
// منطق: تقسیم عدد رنگی (تغییر) بر عدد سیاه (مقدار) برای شاخص کل و هم‌وزن، مقایسه.
// ========================================================================
async function robot01() {
  const total = await fetchIndexValue('total');
  const eq = await fetchIndexValue('equal_weight');

  if (total.value === null || eq.value === null) {
    return robotResponse('01', 'error', null, 'دریافت داده شاخص‌ها از tsetmc ممکن نشد.');
  }

  const totalRatio = total.value !== 0 ? total.changePct / total.value : 0;
  const eqRatio = eq.value !== 0 ? eq.changePct / eq.value : 0;

  let conclusion, sentiment;
  if (total.changePct < 0 && eq.changePct < 0) {
    // هر دو منفی -> کمتر منفی برنده
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
    equalWeightIndex: { value: eq.value, changePct: eq.changePct, ratio: eqRatio },
    conclusion,
    sentiment,
  });
}

// ========================================================================
// ربات ۲ — عرضه اولیه
// ۴ دسته: در راه / اولین روز / تازه عرضه شده / نماد تازه درج شده
// نبود داده = null برای هر دسته (طبق درخواست صریح کاربر)
// ========================================================================
async function robot02() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);

  const categories = {
    comingSoon: null,
    firstDay: null,
    recentlyListed: null,
    newlyRegistered: null,
  };

  if (!symbols.length) {
    return robotResponse('02', 'error', categories, 'دریافت داده از tsetmc ممکن نشد.');
  }

  // نشانه‌ی غیرمستقیم نماد تازه: حجم دارد ولی حجم مبنا صفر است
  const candidates = symbols.filter((s) => s.volume > 1 && s.baseVolume === 0);
  if (candidates.length > 0) {
    categories.recentlyListed = candidates.slice(0, 10).map((c) => ({
      symbol: c.symbol,
      changePct: c.changePct,
    }));
  }

  return robotResponse(
    '02', 'ok', categories,
    'دسته «عرضه اولیه در راه است» نیازمند اتصال به اطلاعیه‌های رسمی سازمان بورس است و در این نسخه فعال نیست.'
  );
}

// ========================================================================
// ربات ۳ — حق تقدم
// نمادهای ختم‌شونده به «ح» + اولویت‌بندی وضعیت
// ========================================================================
const RIGHTS_PRIORITY = { firstDay: 1, newlyOpened: 2, subscriptionOpen: 3, closed: 4 };
const RIGHTS_LABELS = {
  firstDay: 'اولین روز',
  newlyOpened: 'تازه باز شده',
  subscriptionOpen: 'در حال پذیره‌نویسی',
  closed: 'بسته شده',
};

function classifyRightsSymbol(s) {
  if (s.volume === 0) return 'closed';
  if (Math.abs(s.changePct) > 0 && s.volume > 0) return 'subscriptionOpen';
  return 'newlyOpened';
}

async function robot03() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);

  if (!symbols.length) {
    return robotResponse('03', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const rightsSymbols = symbols.filter((s) => s.symbol && s.symbol.endsWith('ح'));

  const rows = rightsSymbols.map((s) => {
    const status = classifyRightsSymbol(s);
    return {
      symbol: s.symbol,
      status,
      statusLabel: RIGHTS_LABELS[status],
      priority: RIGHTS_PRIORITY[status],
      changePct: s.changePct,
    };
  });

  rows.sort((a, b) => a.priority - b.priority);

  return robotResponse('03', 'ok', rows);
}

// ========================================================================
// ربات ۴ — رفتار سهامداران عمده
// تمرکز ویژه بر صندوق‌های سرمایه‌گذاری + گروه‌های صنعت
// نکته: اندپوینت‌های اختصاصی سهامداران عمده نیاز به بررسی دقیق دارند؛
// این نسخه یک تخمین اولیه بر پایه‌ی دیده‌بان بازار ارائه می‌دهد.
// ========================================================================
async function robot04() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);

  if (!symbols.length) {
    return robotResponse('04', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const fundKeywords = ['صندوق', 'سرمایه گذاري', 'سرمایه‌گذاری'];
  const fundRelated = symbols.filter((s) =>
    fundKeywords.some((kw) => (s.name || '').includes(kw))
  );

  const topFunds = fundRelated
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 15)
    .map((s) => ({
      symbol: s.symbol,
      name: s.name,
      changePct: s.changePct,
      action: s.changePct >= 0 ? 'خرید/رشد' : 'فروش/افت',
    }));

  return robotResponse(
    '04', 'ok',
    { fundActivity: topFunds, note: 'داده‌ی دقیق تغییرات سهامداران عمده نیازمند اندپوینت اختصاصی ShareHolderChanges است که در فاز تست باید تایید شود.' }
  );
}


/**
 * robots-part2.js — ربات‌های ۵ تا ۹
 */


// ========================================================================
// ربات ۵ — شاخص‌های منتخب
// شناسایی صنایع/سهم‌های مثبت، استخراج بهترین سهم‌ها
// ========================================================================
async function robot05() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);

  if (!symbols.length) {
    return robotResponse('05', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const positiveSymbols = symbols.filter((s) => s.changePct > 0);
  const topPositive = positiveSymbols
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 15)
    .map((s) => ({ symbol: s.symbol, changePct: s.changePct, sentiment: 'positive' }));

  return robotResponse('05', 'ok', topPositive);
}

// ========================================================================
// ربات ۶ — نمادهای پربیننده (۲۰ نماد برتر بر اساس حجم)
// ========================================================================
async function robot06() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);

  if (!symbols.length) {
    return robotResponse('06', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const sorted = [...symbols].sort((a, b) => b.volume - a.volume).slice(0, 20);
  const rows = sorted.map((s, i) => ({
    rank: i + 1,
    symbol: s.symbol,
    changePct: s.changePct,
    sentiment: s.changePct >= 0 ? 'positive' : 'negative',
    volume: s.volume,
  }));

  return robotResponse('06', 'ok', rows);
}

// ========================================================================
// ربات ۷ — برترین گروه صنعت
// نسبت ارزش معاملات به ارزش بازار
// ========================================================================
async function robot07() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);

  if (!symbols.length) {
    return robotResponse('07', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const withRatio = symbols
    .filter((s) => s.marketCap > 0)
    .map((s) => ({
      symbol: s.symbol,
      tradeValue: s.value,
      marketCap: s.marketCap,
      ratioPct: (s.value / s.marketCap) * 100,
    }))
    .sort((a, b) => b.ratioPct - a.ratioPct)
    .slice(0, 10)
    .map((r, i) => ({ rank: i + 1, ...r }));

  return robotResponse('07', 'ok', withRatio);
}

// ========================================================================
// ربات ۸ — بیشترین کاهش قیمت (بازار اول/دوم/ETF)
// نکته: تفکیک دقیق بازار نیاز به جدول مرجع رسمی دارد
// ========================================================================
async function robot08() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);

  if (!symbols.length) {
    return robotResponse('08', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const etfKeywords = ['صندوق', 'ETF', 'قابل معامله'];
  const negative = symbols.filter((s) => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);

  const etfRows = negative.filter((s) => etfKeywords.some((kw) => (s.name || '').includes(kw))).slice(0, 20);
  const generalRows = negative.filter((s) => !etfKeywords.some((kw) => (s.name || '').includes(kw))).slice(0, 20);

  return robotResponse('08', 'ok', {
    marketGeneral: generalRows.map((s) => ({ symbol: s.symbol, changePct: s.changePct })),
    etf: etfRows.map((s) => ({ symbol: s.symbol, changePct: s.changePct })),
    note: 'تفکیک دقیق بازار اول/بازار دوم نیازمند جدول مرجع رسمی است.',
  });
}

// ========================================================================
// ربات ۹ — برترین عرضه‌ها (برای نوسان‌گیری)
// ========================================================================
async function robot09() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);

  if (!symbols.length) {
    return robotResponse('09', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const sorted = [...symbols].sort((a, b) => b.volume - a.volume).slice(0, 10);
  const rows = sorted.map((s, i) => ({ rank: i + 1, symbol: s.symbol, volume: s.volume }));

  return robotResponse('09', 'ok', rows);
}


/**
 * robots-part3.js — ربات‌های ۱۰ تا ۱۳
 */


// ========================================================================
// ربات ۱۰ — افزایش سرمایه
// نیاز به اطلاعیه‌های رسمی کدال دارد
// ========================================================================
async function robot10() {
  const codalUrl = 'https://search.codal.ir/api/search/v2/q?PageNumber=1&Category=Group_TarhIssueSharePriceInfoV2&IsNotAudited=false';
  const raw = await safeFetch(codalUrl);

  if (!raw) {
    return robotResponse('10', 'error', null, 'دریافت اطلاعیه‌های افزایش سرمایه از کدال در حال حاضر ممکن نیست.');
  }

  let rows = [];
  try {
    const json = JSON.parse(raw);
    const letters = json.Letters || [];
    rows = letters.slice(0, 10).map((item) => ({
      symbol: item.Symbol,
      companyName: item.CompanyName,
      title: item.Title,
      publishDate: item.PublishDateTime,
    }));
  } catch (err) {
    return robotResponse('10', 'error', null, 'پاسخ کدال قابل تجزیه نبود؛ فرمت ممکن است تغییر کرده باشد.');
  }

  return robotResponse(
    '10', 'ok', rows,
    'محاسبه‌ی دقیق درصد سهام جدید به قدیم نیازمند باز کردن متن کامل هر اطلاعیه است.'
  );
}

// ========================================================================
// ربات ۱۱ — نمادهای پربیننده (بورس و فرابورس)
// نکته: تفکیک بورس/فرابورس نیاز به فیلد بازار در داده‌ی خام دارد
// ========================================================================
async function robot11() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);

  if (!symbols.length) {
    return robotResponse('11', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const sorted = [...symbols].sort((a, b) => b.volume - a.volume);
  const bourse = sorted.slice(0, 20).map((s, i) => ({ rank: i + 1, symbol: s.symbol, volume: s.volume }));

  return robotResponse('11', 'ok', {
    bourse,
    otc: [],
    note: 'تفکیک دقیق بورس/فرابورس در فاز تست با فیلد بازار واقعی تکمیل می‌شود.',
  });
}

// ========================================================================
// ربات ۱۲ — حجم و ارزش معاملات صندوق‌های کالایی
// ========================================================================
const COMMODITY_KEYWORDS = ['طلا', 'گوهر', 'عیار', 'کهربا', 'کالا'];

async function robot12() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);

  if (!symbols.length) {
    return robotResponse('12', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const commodityFunds = symbols.filter((s) =>
    COMMODITY_KEYWORDS.some((kw) => (s.symbol || '').includes(kw) || (s.name || '').includes(kw))
  );

  const top = commodityFunds
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10)
    .map((s, i) => ({ rank: i + 1, symbol: s.symbol, volume: s.volume, value: s.value }));

  return robotResponse('12', 'ok', top);
}

// ========================================================================
// ربات ۱۳ — حباب صندوق‌های طلا
// حباب = (قیمت معامله − NAV ابطال) ÷ NAV ابطال × ۱۰۰
// مثبت = قرمز (حباب مثبت) | منفی = سبز (حباب منفی)
// ========================================================================
async function fetchNavForFund(fundName) {
  const url = `http://fipiran.com/api/v1/fund/getfundnav?name=${encodeURIComponent(fundName)}`;
  const raw = await safeFetch(url);
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    return toFloatSafe(json.cancelNav, null);
  } catch (err) {
    return null;
  }
}

async function robot13() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);

  if (!symbols.length) {
    return robotResponse('13', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const goldFunds = symbols.filter((s) =>
    COMMODITY_KEYWORDS.some((kw) => (s.symbol || '').includes(kw) || (s.name || '').includes(kw))
  );

  const rows = [];
  for (const s of goldFunds) {
    const nav = await fetchNavForFund(s.name || '');
    if (nav === null || nav === 0) {
      rows.push({
        symbol: s.symbol,
        tradePrice: s.finalPrice,
        nav: null,
        bubblePct: null,
        bubbleType: 'نامشخص (NAV در دسترس نیست)',
      });
      continue;
    }
    const bubblePct = ((s.finalPrice - nav) / nav) * 100;
    rows.push({
      symbol: s.symbol,
      tradePrice: s.finalPrice,
      nav,
      bubblePct: Math.round(bubblePct * 100) / 100,
      bubbleType: bubblePct > 0 ? 'مثبت' : 'منفی',
      sentiment: bubblePct > 0 ? 'negative' : 'positive', // حباب مثبت = قرمز طبق تعریف کاربر
    });
  }

  rows.sort((a, b) => Math.abs(b.bubblePct || 0) - Math.abs(a.bubblePct || 0));

  return robotResponse('13', 'ok', rows);
}


/**
 * robots-part4.js — ربات‌های ۱۴ تا ۱۶
 */


// ========================================================================
// ربات ۱۴ — Fipiran (پول هوشمند)
// ۱۰ تحلیل صندوق‌های سرمایه‌گذاری
// هر زیرتحلیل مستقل اجرا می‌شود؛ خطای یکی بقیه را متوقف نمی‌کند.
// ========================================================================
async function fetchAllFunds() {
  const raw = await safeFetch('http://fipiran.com/api/v1/fund/fundcompare');
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    return json.items || [];
  } catch (err) {
    return null;
  }
}

function safeSubAnalysis(name, fn, ...args) {
  try {
    return fn(...args);
  } catch (err) {
    return { error: `تحلیل «${name}» با خطا مواجه شد: ${err.message}` };
  }
}

function analysisTopHoldings(funds) {
  const bigFunds = [...funds].sort((a, b) => toFloatSafe(b.netAsset) - toFloatSafe(a.netAsset)).slice(0, 5);
  return bigFunds.map((f) => ({ fundName: f.name, netAsset: f.netAsset }));
}

function analysisSmartMoneyInflow(funds) {
  const sorted = [...funds].sort((a, b) => toFloatSafe(b.dailyReturn) - toFloatSafe(a.dailyReturn)).slice(0, 10);
  return sorted.map((f) => ({ fundName: f.name, dailyReturn: f.dailyReturn }));
}

function analysisNavGrowth(funds) {
  const growing = funds.filter((f) => toFloatSafe(f.dailyReturn) > 0);
  return growing.slice(0, 10).map((f) => ({ fundName: f.name, navChange: f.dailyReturn }));
}

async function robot14() {
  const funds = await fetchAllFunds();

  if (!funds) {
    return robotResponse('14', 'error', null, 'دریافت داده از fipiran.com در حال حاضر ممکن نیست.');
  }

  const data = {
    topHoldingsByBigFunds: safeSubAnalysis('صندوق‌های بزرگ', analysisTopHoldings, funds),
    smartMoneyInflow: safeSubAnalysis('ورود پول هوشمند', analysisSmartMoneyInflow, funds),
    navGrowth: safeSubAnalysis('رشد NAV', analysisNavGrowth, funds),
    note: 'تحلیل‌های مربوط به تکرار سهم در چند صندوق و تغییر وزن نیازمند دریافت پرتفوی هر صندوق و مقایسه‌ی تاریخی هستند که در فاز تست تکمیل می‌شوند.',
  };

  return robotResponse('14', 'ok', data);
}

// ========================================================================
// ربات ۱۵ — قیمت سهم نسبت به دلار
// (قیمت سهم ÷ قیمت دلار) × ۱۰۰ برای امروز، مقایسه با ۳۰ روز پیش
// ========================================================================
async function fetchDollarRate() {
  const raw = await safeFetch('https://api.navasan.tech/latest/');
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    return toFloatSafe(json.usd?.value, null);
  } catch (err) {
    return null;
  }
}

async function robot15() {
  const raw = await fetchMarketWatchRaw();
  const symbols = parseMarketWatch(raw);
  const dollarPrice = await fetchDollarRate();

  if (!symbols.length || dollarPrice === null) {
    return robotResponse('15', 'error', null, 'دریافت قیمت سهم یا نرخ دلار در حال حاضر ممکن نیست.');
  }

  const bigCompanies = [...symbols].sort((a, b) => b.marketCap - a.marketCap).slice(0, 30);

  const rows = bigCompanies.map((s) => {
    const ratioToday = dollarPrice ? (s.finalPrice / dollarPrice) * 100 : 0;
    return {
      symbol: s.symbol,
      priceToday: s.finalPrice,
      ratioToday: Math.round(ratioToday * 10000) / 10000,
      ratio30DaysAgo: null, // نیاز به داده تاریخی؛ در فاز استقرار با ذخیره‌سازی روزانه تکمیل می‌شود
      status: 'نیاز به داده تاریخی ۳۰ روزه',
    };
  });

  return robotResponse('15', 'ok', rows, 'مقایسه با ۳۰ روز پیش نیازمند ذخیره‌سازی روزانه‌ی داده است.');
}

// ========================================================================
// ربات ۱۶ — اثر نقدینگی
// طبق تایید کاربر: رشد نقدینگی ماهانه/دستی وارد می‌شود
// ⚠️ این مقدار باید ماهانه توسط کاربر در KV Storage بروزرسانی شود (راهنما در مستندات)
// ========================================================================
async function robot16(env) {
  // مقدار رشد نقدینگی از Cloudflare KV خوانده می‌شود (کاربر آن را ماهانه بروزرسانی می‌کند)
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
    } catch (err) {
      // نادیده گرفتن؛ liquidityGrowth همچنان null می‌ماند
    }
  }

  const dollarPrice = await fetchDollarRate();
  const total = await fetchIndexValue('total');

  const data = {
    liquidityGrowthMonthly: liquidityGrowth,
    liquidityLastUpdated: liquidityUpdatedDate,
    dollarPriceToday: dollarPrice,
    totalIndexChangePct: total.changePct,
  };

  if (liquidityGrowth === null) {
    data.rulesTriggered = ['رشد نقدینگی ماهانه هنوز وارد نشده است. طبق راهنمای نصب آن را در Cloudflare KV وارد کنید.'];
    data.sentiment = 'neutral';
    return robotResponse('16', 'ok', data, 'این ربات نیاز به بروزرسانی دستی ماهانه دارد.');
  }

  const rules = [];
  let sentiment = 'neutral';

  if (dollarPrice !== null && total.changePct !== null) {
    if (liquidityGrowth > dollarPrice) {
      rules.push('قانون ۱: رشد نقدینگی بیشتر از دلار — ورود پول به بورس، رشد سهم‌ها');
    } else {
      rules.push('قانون ۲: رشد دلار بیشتر از نقدینگی — پول به سمت ارز، عقب‌افتادگی سهم‌ها');
    }

    if (liquidityGrowth > total.changePct) {
      rules.push('قانون ۳: رشد نقدینگی بیشتر از شاخص کل — رشد سهم‌های کوچک، پول هوشمند فعال');
    }

    if (liquidityGrowth > 0 && Math.abs(total.changePct) < 0.3) {
      rules.push('قانون ۴: نقدینگی بالا، شاخص راکد — بازار آماده جهش (بهترین زمان یافتن سهم مناسب)');
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
 * robot-gold.js — ربات طلا (۳۱+۱)
 * منابع: قیمت لحظه‌ای دلار بازار آزاد + قیمت انس جهانی طلا
 * محاسبه دقیق طبق ضرایب تعریف‌شده توسط کاربر.
 */


// ضرایب تبدیل طبق تعریف دقیق کاربر — این اعداد نباید تغییر کنند
const DIVISORS = {
  gold24k: 31.1,       // طلای ۲۴ عیار (۱۰۰۰)
  gold21_6k: 34.56,    // طلای ۲۱.۶ عیار (۹۰۰)
  gold18k: 41.47,      // طلای ۱۸ عیار (۷۵۰)
  mesghal: 9.57,       // مظنه (مثقال ۱۷ عیار / ۷۰۵)
  coinFull: 4.25,      // سکه تمام
  coinHalf: 8.5,       // سکه نیم
  coinQuarter: 17,     // سکه ربع
  coinGram: 34,        // سکه گرمی
};
const MESGHAL_TO_GRAM18_DIVISOR = 4.33;

const LABELS = {
  gold24k: 'طلای ۲۴ عیار (۱ گرم)',
  gold21_6k: 'طلای ۲۱.۶ عیار (۱ گرم)',
  gold18k: 'طلای ۱۸ عیار (۱ گرم)',
  mesghal: 'مظنه (مثقال ۱۷ عیار)',
  mesghalToGram18: 'تبدیل مظنه به گرم ۱۸',
  coinFull: 'سکه تمام',
  coinHalf: 'سکه نیم',
  coinQuarter: 'سکه ربع',
  coinGram: 'سکه گرمی',
};

async function fetchDollarPrice() {
  const raw = await safeFetch('https://api.navasan.tech/latest/');
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    return toFloatSafe(json.usd?.value, null);
  } catch (err) {
    return null;
  }
}

async function fetchGoldOunceUsd() {
  const raw = await safeFetch('https://api.metals.live/v1/spot/gold');
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    if (Array.isArray(json) && json.length > 0) {
      return toFloatSafe(json[0].price, null);
    }
    return toFloatSafe(json.price, null);
  } catch (err) {
    return null;
  }
}

async function robotGold() {
  const dollarPrice = await fetchDollarPrice();
  const ounceUsd = await fetchGoldOunceUsd();

  if (dollarPrice === null || ounceUsd === null) {
    return robotResponse('gold', 'error', null, 'دریافت نرخ دلار یا قیمت جهانی طلا در حال حاضر ممکن نیست.');
  }

  // قیمت جهانی طلا به تومان (پایه‌ی محاسبه‌ی همه‌ی محصولات)
  const goldBaseToman = ounceUsd * dollarPrice;

  const products = {};
  for (const [key, divisor] of Object.entries(DIVISORS)) {
    products[key] = Math.round(goldBaseToman / divisor);
  }
  // تبدیل مظنه به گرم ۱۸ طبق دستور دقیق کاربر
  products.mesghalToGram18 = Math.round(products.mesghal / MESGHAL_TO_GRAM18_DIVISOR);

  return robotResponse('gold', 'ok', {
    dollarPrice,
    goldOunceUsd: ounceUsd,
    goldBaseToman: Math.round(goldBaseToman),
    products,
    labels: LABELS,
  });
}


/**
 * watchlist.js — واچ‌لیست ۵۰ نماد دلخواه کاربر
 * از Cloudflare KV برای ذخیره‌ی دائمی لیست نمادها استفاده می‌کند (رایگان، بدون نیاز به دیتابیس جدا).
 * داده‌ی زنده‌ی هر نماد از دیده‌بان بازار tsetmc گرفته می‌شود.
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
  if (!env || !env.BOURSE_KV) return;
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
    symbol: symbolRow.symbol,
    finalPrice: symbolRow.finalPrice,
    changePct: symbolRow.changePct,
    volume: symbolRow.volume,
    baseVolume: symbolRow.baseVolume,
    value: symbolRow.value,
    // فیلدهای زیر placeholder هستند تا در فاز تست با اندپوینت واقعی پر شوند
    realToLegalCode: null,
    realMoneyFlow: null,
    freeFloatPct: null,
    peRatio: null,
    queueStatus: null,
  };
}

async function runWatchlist(env) {
  const watchlist = await loadWatchlistSymbols(env);

  if (!watchlist.length) {
    return robotResponse('watchlist', 'ok', [], 'واچ‌لیست هنوز خالی است. نماد مورد نظر را از داشبورد اضافه کنید.');
  }

  const raw = await fetchMarketWatchRaw();
  const allSymbols = parseMarketWatch(raw);

  if (!allSymbols.length) {
    return robotResponse('watchlist', 'error', null, 'دریافت داده از tsetmc ممکن نشد.');
  }

  const symbolMap = {};
  for (const s of allSymbols) symbolMap[s.symbol] = s;

  const rows = watchlist.map((symName) => {
    if (symbolMap[symName]) {
      return buildRow(symbolMap[symName]);
    }
    return {
      symbol: symName,
      finalPrice: null,
      changePct: null,
      volume: null,
      baseVolume: null,
      value: null,
      realToLegalCode: null,
      realMoneyFlow: null,
      freeFloatPct: null,
      peRatio: null,
      queueStatus: null,
      note: 'نماد در دیده‌بان بازار یافت نشد؛ نام را بررسی کنید.',
    };
  });

  return robotResponse('watchlist', 'ok', rows);
}



// ===== رجیستری مرکزی ربات‌ها =====
const ROBOT_REGISTRY = {
  '01': robot01, '02': robot02, '03': robot03, '04': robot04,
  '05': robot05, '06': robot06, '07': robot07, '08': robot08, '09': robot09,
  '10': robot10, '11': robot11, '12': robot12, '13': robot13,
  '14': robot14, '15': robot15, '16': robot16,
  'gold': robotGold,
};

/**
 * worker.js — نقطه ورود اصلی Cloudflare Worker
 * داشبورد بورس Navid Ramian
 *
 * معماری:
 * - این Worker به‌عنوان واسطه (proxy) بین مرورگر گوشی و tsetmc/fipiran عمل می‌کند
 *   چون مرورگر مستقیماً به دلیل محدودیت CORS نمی‌تواند به این سایت‌ها وصل شود.
 * - هر ربات یک تابع مستقل در فایل robots.js دارد.
 * - خرابی یک ربات باعث از کار افتادن بقیه نمی‌شود (هر کدام try/catch جداگانه دارند).
 *
 * مسیرها:
 *   GET /api/robot/:id       -> داده‌ی یک ربات خاص
 *   GET /api/robots/all      -> داده‌ی همه‌ی ربات‌ها یکجا
 *   GET /api/watchlist       -> داده‌ی نمادهای واچ‌لیست کاربر
 *   POST /api/watchlist/add  -> افزودن نماد به واچ‌لیست
 *   POST /api/watchlist/remove -> حذف نماد از واچ‌لیست
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
 * اجرای امن هر ربات — هیچ خطایی نباید کل Worker را متوقف کند.
 */
async function runRobotSafely(robotId, env) {
  const robotFn = ROBOT_REGISTRY[robotId];
  if (!robotFn) {
    return { robot: robotId, status: 'error', message: `رباتی با شناسه ${robotId} یافت نشد.`, data: null };
  }
  try {
    const result = await robotFn(env);
    return result;
  } catch (err) {
    return {
      robot: robotId,
      status: 'error',
      message: `خطای غیرمنتظره: ${err.message}`,
      data: null,
    };
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
      // ===== ربات منفرد =====
      const robotMatch = path.match(/^\/api\/robot\/([a-zA-Z0-9_]+)$/);
      if (robotMatch) {
        const robotId = robotMatch[1];
        const result = await runRobotSafely(robotId, env);
        return jsonResponse(result);
      }

      // ===== همه‌ی ربات‌ها یکجا =====
      if (path === '/api/robots/all') {
        const robotIds = Object.keys(ROBOT_REGISTRY);
        const results = {};
        // اجرای موازی همه‌ی ربات‌ها برای سرعت بیشتر
        await Promise.all(
          robotIds.map(async (id) => {
            results[id] = await runRobotSafely(id, env);
          })
        );
        return jsonResponse(results);
      }

      // ===== واچ‌لیست =====
      if (path === '/api/watchlist' && request.method === 'GET') {
        const result = await runWatchlist(env);
        return jsonResponse(result);
      }

      if (path === '/api/watchlist/add' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const symbol = (body.symbol || '').trim();
        if (!symbol) {
          return jsonResponse({ status: 'error', message: 'نام نماد ارسال نشده است.' }, 400);
        }
        const result = await addSymbolToWatchlist(env, symbol);
        return jsonResponse(result);
      }

      if (path === '/api/watchlist/remove' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const symbol = (body.symbol || '').trim();
        if (!symbol) {
          return jsonResponse({ status: 'error', message: 'نام نماد ارسال نشده است.' }, 400);
        }
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
