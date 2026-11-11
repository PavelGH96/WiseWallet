/* WiseWallet — проверки перед выкладкой.
 *
 * Запуск:  npm test
 *
 * Тесты открывают index.html в настоящем браузере, подкладывают данные и
 * проверяют поведение, а не исходный текст файла. Так они переживают
 * перестановку кода и ловят то, что ломается на самом деле.
 *
 * Каждая проверка названа по той ошибке, которую она сторожит: если тест
 * однажды покраснеет, из названия сразу видно, какое поведение вернулось.
 */
"use strict";

const path = require("path");
const fs = require("fs");

const APP = "file://" + path.join(__dirname, "..", "index.html");

/* playwright ставится как devDependency; в песочницах он иногда лежит
   глобально, а браузер задаётся через WW_CHROME. */
function loadPlaywright() {
  for (const id of ["playwright", "/opt/npm-tools/node_modules/playwright"]) {
    try { return require(id); } catch (e) {}
  }
  console.error("Не найден playwright. Установите: npm install");
  process.exit(2);
}
const { chromium } = loadPlaywright();

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log("  ok   " + name); }
  else { failures.push(name + (detail ? " — " + detail : "")); console.log("  ПАДАЕТ " + name + (detail ? " — " + detail : "")); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, actual === expected ? "" : "получили " + JSON.stringify(actual) + ", ждали " + JSON.stringify(expected));
}

/* Состояние для проверок расчётов: платежи стоят на 15-е и 20-е число,
   то есть в первой половине месяца они ещё НЕ наступили — именно на этом
   расходились «Свободные деньги» и «Прогноз остатка» до v4.44. */
function seed() {
  S.accounts.find((a) => a.id === "a_card").balance0 = 400000;
  S.recurring = [
    { id: "r1", name: "Коммуналка", type: "expense", amount: 7000, categoryId: "c_ku", day: 15 },
    { id: "r2", name: "Интернет", type: "expense", amount: 1000, categoryId: "c_net", day: 28 },
    { id: "r3", name: "Зарплата", type: "income", amount: 150000, categoryId: "c_salary", day: 15 },
  ];
  S.credits = [{
    id: "cr1", name: "Авто", lender: "Банк", type: "Автокредит", balance: 600000, balanceFull: 800000,
    rate: 20, start: "2024-01-15", end: "2029-01-15", payment: 27000, payDay: 20, status: "active",
  }];
  S.transactions = [];
  S.posted = {}; S.skipped = {}; S.ww30Cr = {}; S.ww30Tx = {};
  save();
}

async function run() {
  const launch = { args: ["--no-sandbox"] };
  if (process.env.WW_CHROME) launch.executablePath = process.env.WW_CHROME;
  else if (fs.existsSync("/usr/bin/google-chrome")) launch.executablePath = "/usr/bin/google-chrome";
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  /* В тесте наружу не ходим: сеть и так не нужна, а ожидание таймаутов
     к удалённым хостам сделало бы прогон медленным и ненадёжным. */
  await ctx.route("**/*", (r) => (r.request().url().startsWith("file:") ? r.continue() : r.abort()));
  await ctx.addInitScript(() => {
    localStorage.setItem("ww_session_v2", JSON.stringify({
      access_token: "test", refresh_token: "test", expires_at: Date.now() + 9e8, user_id: "11111111-1111-1111-1111-111111111111", email: "test@example.com",
    }));
    /* configurable: отдельные проверки переключают «сеть» на лету */
    Object.defineProperty(navigator, "onLine", { get: () => false, configurable: true });
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/ERR_FAILED|ERR_BLOCKED|Failed to load resource/.test(t)) errors.push("console: " + t.slice(0, 200));
  });

  await page.goto(APP);
  await page.waitForTimeout(1200);

  console.log("\nЗагрузка приложения");
  eq("страница грузится без ошибок в консоли", errors.join(" | "), "");
  eq("версия проставлена", await page.evaluate(() => (typeof WW_VERSION === "string" ? WW_VERSION : null)), "4.46");

  console.log("\nСтартовый набор не содержит чужих данных");
  const fresh = await page.evaluate(() => {
    const st = seedState();
    return { credits: st.credits.length, recurring: st.recurring.length, budgets: st.budgets.length, goals: st.goals.length, cats: st.categories.length };
  });
  eq("у нового пользователя нет чужих кредитов", fresh.credits, 0);
  eq("у нового пользователя нет чужих регулярных платежей", fresh.recurring, 0);
  eq("у нового пользователя нет чужих бюджетов", fresh.budgets, 0);
  eq("у нового пользователя нет чужих целей", fresh.goals, 0);
  check("категории остаются — они нейтральны", fresh.cats > 5, "их " + fresh.cats);

  console.log("\nРасчёты на дашборде сходятся между собой");
  await page.evaluate(seed);
  const calc = await page.evaluate(() => {
    const ym = todayStr().slice(0, 7);
    const d = ww30Data(ym);
    const unpaid = (arr) => arr.reduce((s, x) => s + (x.paid ? 0 : Math.max(0, x.full - x.posted)), 0);
    return {
      day: new Date().getDate(),
      panel: unpaid(d.exp) + unpaid(d.cr),
      remaining: monthRemaining(ym),
      balance: balance(),
      projected: projectedBalanceEnd(ym),
    };
  });
  eq("«Осталось оплатить» и «Нужно на платежи» считают одно и то же", calc.remaining.expense, calc.panel);
  eq("прогноз остатка = баланс + доходы − расходы", calc.projected, calc.balance + calc.remaining.income - calc.remaining.expense);
  check("платежи учитываются до наступления их дня", calc.panel >= 34000,
    "день месяца " + calc.day + ", к оплате " + calc.panel + " (ждали 7000 + 1000 + 27000 = 35000)");

  console.log("\nКопейки");
  const m = await page.evaluate(() => ({ round: money(1500), kop: money(1222.28), calc: money(450 / 3), zero: money(0) }));
  check("круглая сумма без копеек", /^1[\s  ]500[\s ]₽$/.test(m.round), m.round);
  check("дробная сумма с копейками", /1[\s  ]222,28/.test(m.kop), m.kop);
  check("хвосты деления округляются до копеек", /^150[\s ]₽$/.test(m.calc), m.calc);

  console.log("\nПлатёж остаётся привязанным к кредиту после переименования");
  const credit = await page.evaluate(() => {
    const ym = todayStr().slice(0, 7);
    const c = S.credits[0];
    S.transactions.push({ id: uid(), date: todayStr(), type: "expense", amount: 27000, accountId: "a_card", categoryId: "c_credit", creditId: c.id, note: c.name, createdAt: Date.now() });
    const before = wwCreditEffectivePosted(c, ym);
    c.name = "Автокредит ВТБ";                       // переименование без ww314SyncCreditNote
    const after = wwCreditEffectivePosted(c, ym);
    const old = { id: "cr-old", name: "Старый", status: "active", payment: 1000, payDay: 5 };
    S.credits.push(old);
    S.transactions.push({ id: uid(), date: todayStr(), type: "expense", amount: 1000, accountId: "a_card", categoryId: "c_credit", note: "Старый", createdAt: Date.now() });
    const legacy = wwCreditEffectivePosted(old, ym);
    return { before, after, legacy };
  });
  eq("платёж засчитан", credit.before, 27000);
  eq("после переименования платёж не потерялся", credit.after, 27000);
  eq("операции без creditId по-прежнему ищутся по заметке", credit.legacy, 1000);

  console.log("\nОбрыв сети не выглядит как истёкшая сессия");
  const sess = await page.evaluate(async () => {
    const out = {};
    const stored = JSON.parse(localStorage.getItem("ww_session_v2"));
    stored.expires_at = Date.now() - 1000;           // токен просрочен — нужен refresh
    localStorage.setItem("ww_session_v2", JSON.stringify(stored));
    Object.defineProperty(navigator, "onLine", { get: () => true, configurable: true });

    const real = window.fetch;
    window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    out.offline = !!(await ww2Session());
    out.offlineFlag = ww2SessionNetFail();

    window.fetch = () => Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
    out.rejected = !!(await ww2Session());
    out.sessionCleared = !localStorage.getItem("ww_session_v2");

    window.fetch = real;
    return out;
  });
  eq("при обрыве сети сессия сохраняется", sess.offline, true);
  eq("поднят флаг «не смогли обновить токен»", sess.offlineFlag, true);
  eq("при ответе 401 сессия считается истёкшей", sess.rejected, false);
  eq("истёкшая сессия удаляется из хранилища", sess.sessionCleared, true);

  console.log("\nСинхронизация ходит только в личное хранилище");
  const net = await page.evaluate(async () => {
    const urls = [];
    const real = window.fetch;
    window.fetch = (u, o) => { urls.push(String(u)); return Promise.reject(new TypeError("Failed to fetch")); };
    localStorage.setItem("ww_session_v2", JSON.stringify({ access_token: "test", refresh_token: "test", expires_at: Date.now() + 9e8, user_id: "11111111-1111-1111-1111-111111111111", email: "t@e.com" }));
    S.settings.sbUrl = "https://example.supabase.co"; S.settings.sbKey = "anon-key";
    try { await _syncNowInner(false); } catch (e) {}
    window.fetch = real;
    return urls;
  });
  check("обращений к ww_state нет", !net.some((u) => u.includes("ww_state")), net.join(" "));
  check("запрос идёт в ww_user_state", net.some((u) => u.includes("ww_user_state")), net.join(" ") || "(запросов не было)");

  console.log("\nСинхронизация: слияние и защита от гонки");
  /* Поддельный PostgREST в самой странице: хранит одну строку и ведёт себя
     как настоящий — PATCH с фильтром по updated_at меняет строку только если
     фильтр совпал, иначе возвращает пустой список. На этом проверяется, что
     синхронизация действительно сливает, а не затирает. */
  const sync = await page.evaluate(async () => {
    const out = {};
    const T = (n) => ({ id: "s" + n, type: "expense", amount: n, categoryId: "c_byt", accountId: "a_card", date: "2026-11-11", note: "", createdAt: 1700000000000 });

    let row = null;                  /* строка на «сервере» */
    let raceOnce = false;            /* подменить строку между чтением и записью */
    const real = window.fetch;
    window.fetch = async (u, o) => {
      u = String(u); o = o || {};
      const json = (v) => ({ ok: true, status: 200, json: async () => v });
      if (!u.includes("/rest/v1/ww_user_state")) return json([]);
      if (!o.method || o.method === "GET") {
        const res = row ? [{ data: row.data, updated_at: row.updated_at, summary: row.summary }] : [];
        if (raceOnce) {              /* кто-то успел записать сразу после нашего чтения */
          raceOnce = false;
          setTimeout(() => { if (row) row.updated_at = "2026-11-11T10:00:09.000Z"; }, 0);
        }
        return json(res);
      }
      if (o.method === "PATCH") {
        const m = u.match(/updated_at=eq\.([^&]+)/);
        const want = m ? decodeURIComponent(m[1]) : null;
        if (!row || row.updated_at !== want) return json([]);     /* фильтр не совпал — гонка */
        const body = JSON.parse(o.body);
        /* Как настоящий PostgREST: меняются только те колонки, что есть в
           теле. Приложение умеет обновлять одну лишь summary, не трогая
           data и updated_at, — наивная замена строки целиком стирала бы
           при этом все данные. */
        Object.keys(body).forEach((k) => { row[k] = body[k]; });
        return json([{ data: row.data, updated_at: row.updated_at, summary: row.summary }]);
      }
      if (o.method === "POST") {
        const body = JSON.parse(o.body)[0];
        if (row) return json([]);                                  /* ignore-duplicates */
        row = { data: body.data, updated_at: body.updated_at, summary: body.summary };
        return json([{ data: row.data, updated_at: row.updated_at, summary: row.summary }]);
      }
      return json([]);
    };

    try {
      S.settings.sbUrl = "https://example.supabase.co";
      S.settings.sbKey = "anon-key";
      S.transactions = [T(1)];
      S.credits = []; S.recurring = []; S.posted = {}; S.ww30Cr = {};
      save();

      /* 1. Пустой сервер — строка создаётся */
      await syncNow(false);
      out.created = !!row && row.data.transactions.length === 1;

      /* 2. На сервере появилась чужая операция, у нас своя — после
            синхронизации обе должны быть и там, и тут */
      const theirs = JSON.parse(JSON.stringify(row.data));
      theirs.transactions.push(T(2));
      theirs.transactions[1].u = { t: Date.now() - 1000, d: "zzz" };   /* чужая правка минуту назад, а не из будущего */
      theirs.updatedAt = Date.now() - 1000;
      row = { data: theirs, updated_at: "2026-11-11T10:00:05.000Z" };

      S.transactions.push(T(3));
      save();
      await syncNow(false);
      out.localHasAll = S.transactions.map((t) => t.id).sort().join(",");
      out.serverHasAll = row.data.transactions.map((t) => t.id).sort().join(",");

      /* 3. Удаление на нашей стороне доезжает до сервера */
      S.transactions = S.transactions.filter((t) => t.id !== "s2");
      save();
      await syncNow(false);
      out.afterDelete = row.data.transactions.map((t) => t.id).sort().join(",");
      out.graveOnServer = !!(row.data.graves && row.data.graves.transactions && row.data.graves.transactions.s2);

      /* 4. Повторная синхронизация без изменений не трогает строку */
      const stamp = row.updated_at;
      await syncNow(false);
      out.noRewrite = row.updated_at === stamp;

      /* 5. Гонка: строку подменяют между чтением и записью — повтор спасает */
      S.transactions.push(T(4));
      save();
      raceOnce = true;
      await syncNow(false);
      out.afterRace = row.data.transactions.map((t) => t.id).sort().join(",");
      out.summaryOnServer = !!(row.summary && typeof row.summary.free === "number");
      out.summaryHasLastEntry = !!(row.summary && row.summary.lastEntry);
    } finally { window.fetch = real; }
    return out;
  });
  eq("строка создаётся на пустом сервере", sync.created, true);
  eq("после слияния обе операции есть локально", sync.localHasAll, "s1,s2,s3");
  eq("после слияния обе операции есть на сервере", sync.serverHasAll, "s1,s2,s3");
  eq("удаление доезжает до сервера", sync.afterDelete, "s1,s3");
  eq("на сервере появилось надгробие", sync.graveOnServer, true);
  eq("без изменений строка не переписывается", sync.noRewrite, true);
  eq("проигранная гонка не теряет данные", sync.afterRace, "s1,s3,s4");
  eq("сводка для виджета уехала на сервер", sync.summaryOnServer, true);
  eq("в сводке есть дата последней записи", sync.summaryHasLastEntry, true);

  console.log("\nНастройки переносятся между устройствами");
  const settings = await page.evaluate(() => {
    const remote = { theme: "t10", reminderDays: 7, sbUrl: "https://remote", sbKey: "remote-key", lastSync: 111 };
    const local = { theme: "t9", reminderDays: 3, sbUrl: "https://local", sbKey: "local-key", lastSync: 999 };
    return ww44MergeSettings(remote, local);
  });
  eq("тема приходит с сервера", settings.theme, "t10");
  eq("напоминания приходят с сервера", settings.reminderDays, 7);
  eq("адрес проекта остаётся локальным", settings.sbUrl, "https://local");
  eq("отметка синхронизации остаётся локальной", settings.lastSync, 999);

  console.log("\nПароли не заводятся без шифрования");
  const vault = await page.evaluate(async () => {
    S.pwVault = null; S.passwords = [];
    let asked = false;
    const realConfirm = window.wwConfirm;
    window.wwConfirm = async () => { asked = true; return false; };   // человек отказался
    await openPassModal();
    window.wwConfirm = realConfirm;
    const ov = document.getElementById("overlay");
    return { asked, opened: !!(ov && ov.classList.contains("open")) };
  });
  eq("приложение сначала предлагает включить шифрование", vault.asked, true);
  eq("без мастер-пароля форма не открывается", vault.opened, false);

  console.log("\nСерия дней и сводка для виджета");
  const widget = await page.evaluate(() => {
    const out = {};
    const day = (back) => { const d = new Date(); d.setDate(d.getDate() - back); return ymdLocal(d); };
    const mk = (back, amount) => ({ id: uid(), type: "expense", amount, categoryId: "c_byt", accountId: "a_card",
                                    date: day(back), note: "", whose: "family",
                                    createdAt: Date.parse(day(back) + "T12:00:00") });
    S.transactions = [mk(0, 100), mk(1, 200), mk(2, 300), mk(5, 400)];   /* сегодня, вчера, позавчера, потом разрыв */
    out.streakToday = ww46Streak().streak;
    out.lastEntry = ww46Streak().lastEntry === day(0);
    out.loggedToday = ww46Streak().loggedToday;

    S.transactions = [mk(1, 200), mk(2, 300), mk(3, 400)];               /* сегодня ещё не записывали */
    const st2 = ww46Streak();
    out.streakYesterday = st2.streak;                                     /* день не потерян, пока не кончился */
    out.notLoggedToday = st2.loggedToday === false;

    S.transactions = [mk(4, 100)];
    out.streakBroken = ww46Streak().streak;

    S.transactions = [];
    out.streakEmpty = ww46Streak().streak;
    out.emptyLast = ww46Streak().lastEntry;

    S.transactions = [mk(0, 100)];
    const sum = ww46Summary();
    out.summaryKeys = ["v", "lastEntry", "streak", "balance", "free", "due"].every((k) => sum[k] !== undefined);
    out.summarySmall = JSON.stringify(sum).length < 600;                  /* сводка должна быть крошечной */
    return out;
  });
  eq("серия считается по дням подряд", widget.streakToday, 3);
  eq("дата последней записи — сегодня", widget.lastEntry, true);
  eq("отмечено, что сегодня записывали", widget.loggedToday, true);
  eq("без записи сегодня серия не рвётся до конца дня", widget.streakYesterday, 3);
  eq("при этом видно, что сегодня ещё не записывали", widget.notLoggedToday, true);
  eq("после пропущенного дня серия обнуляется", widget.streakBroken, 0);
  eq("пустая история — серия ноль", widget.streakEmpty, 0);
  eq("пустая история — даты последней записи нет", widget.emptyLast, "");
  eq("в сводке есть всё, что нужно виджету", widget.summaryKeys, true);
  eq("сводка остаётся маленькой", widget.summarySmall, true);

  console.log("\nБыстрое добавление по ссылке");
  const quick = await page.evaluate(async () => {
    const out = {};
    const close = () => { try { closeModal(); } catch (e) {} };
    const open = () => { const o = document.getElementById("overlay"); return !!(o && o.classList.contains("open")); };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    S.transactions = [];
    history.replaceState(null, "", location.pathname + "?quick=expense&t=aaa");
    ww46Handle(); await wait(300);
    out.opensForm = open();
    close();

    /* Повторный разбор той же ссылки (возврат в приложение) форму не открывает */
    ww46Handle(); await wait(300);
    out.noRepeat = open() === false;

    /* Новая метка — новое нажатие */
    history.replaceState(null, "", location.pathname + "?quick=expense&t=bbb&cat=Здоровье&amount=450,50");
    ww46Handle(); await wait(300);
    out.secondOpens = open();
    out.prefilledAmount = (document.getElementById("tx-amount") || {}).value || "";
    out.prefilledCat = txCat;
    close();

    /* Молчаливая запись */
    history.replaceState(null, "", location.pathname + "?quick=expense&t=ccc&amount=321&silent=1&note=Такси");
    ww46Handle(); await wait(400);
    const t = S.transactions[S.transactions.length - 1];
    out.silentAdded = !!t && t.amount === 321 && t.note === "Такси";
    out.silentHasWhose = !!(t && t.whose);               /* в форме это обязательное поле */
    out.silentNoForm = open() === false;

    history.replaceState(null, "", location.pathname);
    return out;
  });
  eq("ссылка открывает форму новой операции", quick.opensForm, true);
  eq("возврат в приложение не открывает форму заново", quick.noRepeat, true);
  eq("новая метка запуска открывает форму снова", quick.secondOpens, true);
  eq("сумма из ссылки подставлена", quick.prefilledAmount, "450,50");
  eq("категория найдена по названию", quick.prefilledCat, "c_health");
  eq("silent=1 записывает без формы", quick.silentAdded, true);
  eq("у записанного расхода заполнено «чей»", quick.silentHasWhose, true);
  eq("при silent=1 форма не открывается", quick.silentNoForm, true);

  console.log("\nService worker не кэширует Supabase");
  const sw = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
  check("хосты supabase исключены", /supabase\\\./.test(sw) || /isSupabase/.test(sw), "в sw.js нет исключения для supabase");
  check("при обрыве сети отдаётся ответ, а не undefined", /new Response\(/.test(sw), "нет запасного Response в обработчике fetch");

  console.log("\nДоступность");
  const a11y = await page.evaluate(() => {
    const vp = document.querySelector('meta[name="viewport"]').getAttribute("content");
    return { zoomBlocked: /user-scalable\s*=\s*no|maximum-scale/.test(vp) };
  });
  eq("масштабирование страницы не запрещено", a11y.zoomBlocked, false);

  eq("за весь прогон не появилось ошибок в консоли", errors.join(" | "), "");

  await browser.close();

  console.log("\n" + "=".repeat(60));
  if (failures.length) {
    console.log("ПАДАЮТ ПРОВЕРКИ: " + failures.length + " (прошло " + passed + ")");
    failures.forEach((f) => console.log("  • " + f));
    process.exit(1);
  }
  console.log("Все проверки прошли: " + passed);
}

run().catch((e) => { console.error(e); process.exit(1); });
