/* WiseWallet — проверки слияния при синхронизации (v4.45).
 *
 * Запуск:  node test/merge.js   (или npm test — он гоняет оба файла)
 *
 * ww45Merge — чистая функция, но живёт внутри index.html, поэтому
 * проверки выполняются в настоящей странице: так тестируется ровно тот
 * код, который работает у пользователя, без копии в отдельном модуле,
 * которая неизбежно разойдётся с оригиналом.
 *
 * Два устройства разыгрываются в одной вкладке: ww45Stamp принимает
 * { now, dev, prev }, поэтому можно задать и часы, и идентификатор, и
 * собственный отпечаток предыдущего сохранения для каждого из них.
 */
"use strict";

const path = require("path");
const APP = "file://" + path.join(__dirname, "..", "index.html");

function loadPlaywright() {
  for (const id of ["playwright", "/opt/npm-tools/node_modules/playwright"]) {
    try { return require(id); } catch (e) {}
  }
  console.error("Не найден playwright. Установите: npm install");
  process.exit(2);
}
const { chromium } = loadPlaywright();

/* ---------- то, что выполняется внутри страницы ---------- */
/* Возвращает массив [название, прошло?, подробности]. */
function suite() {
  const out = [];
  const ok = (name, cond, detail) => out.push([name, !!cond, cond ? "" : (detail || "")]);
  const eq = (name, a, b) => ok(name, a === b, "получили " + JSON.stringify(a) + ", ждали " + JSON.stringify(b));

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const T0 = 1700000000000;                     /* фиксированные часы: тесты не должны зависеть от реального времени */

  /* Пустое состояние без стартового набора: проверяем слияние, а не seedState. */
  function blank() {
    return { accounts: [], categories: [], transactions: [], credits: [], recurring: [],
             budgets: [], goals: [], tasks: [], links: [], notes: [], noteFolders: [], passwords: [],
             posted: {}, skipped: {}, ww30Cr: {}, ww30Tx: {}, notifRead: {},
             audit: [], settings: {}, graves: {}, meta: {}, updatedAt: T0 };
  }
  function tx(id, amount, note) {
    return { id, type: "expense", amount, categoryId: "c_byt", accountId: "a_card", date: "2026-11-11", note: note || "", createdAt: T0 };
  }
  /* Устройство: состояние + свой отпечаток предыдущего сохранения. */
  function device(name, st) {
    return {
      name, st: st || blank(), fp: null,
      save(at) { this.st.updatedAt = at; ww45Stamp(this.st, { now: at, dev: name, prev: this.fp }); this.fp = this.st.__fp; return this; },
      copy() { const d = device(this.name, clone(this.st)); d.fp = this.fp ? clone(this.fp) : null; return d; },
    };
  }
  const ids = (st, coll) => (st[coll] || []).map((r) => r.id).sort();
  const ids2 = (st, coll) => (st[coll] || []).map((r) => r.id).join(",");   /* порядок как есть */
  const byId = (st, coll, id) => (st[coll] || []).find((r) => r.id === id);

  /* Общий старт: обе стороны вышли из одного состояния. */
  function paired() {
    const a = device("aaa");
    a.st.transactions = [tx("t1", 100), tx("t2", 200)];
    a.save(T0);
    const base = ww45Fingerprint(a.st);
    const b = device("bbb", clone(a.st));
    b.fp = clone(a.fp);
    return { a, b, base };
  }

  /* 1 — правки разных записей */
  {
    const { a, b, base } = paired();
    byId(a.st, "transactions", "t1").amount = 111; a.save(T0 + 1000);
    byId(b.st, "transactions", "t2").note = "с другого"; b.save(T0 + 2000);
    const m = ww45Merge(a.st, b.st, base);
    eq("1. правки разных записей: обе на месте — сумма", byId(m, "transactions", "t1").amount, 111);
    eq("1. правки разных записей: обе на месте — заметка", byId(m, "transactions", "t2").note, "с другого");
  }

  /* 2 — правки одной записи */
  {
    const { a, b, base } = paired();
    byId(a.st, "transactions", "t1").amount = 111; a.save(T0 + 1000);
    byId(b.st, "transactions", "t1").amount = 222; b.save(T0 + 2000);
    eq("2. одна запись, разное время: выигрывает поздняя", byId(ww45Merge(a.st, b.st, base), "transactions", "t1").amount, 222);

    const p2 = paired();
    byId(p2.a.st, "transactions", "t1").amount = 111; p2.a.save(T0 + 5000);
    byId(p2.b.st, "transactions", "t1").amount = 222; p2.b.save(T0 + 5000);   /* одинаковое время */
    const onA = byId(ww45Merge(p2.a.st, p2.b.st, p2.base), "transactions", "t1").amount;
    const onB = byId(ww45Merge(p2.b.st, p2.a.st, p2.base), "transactions", "t1").amount;
    eq("2. одинаковое время: оба устройства выбирают одно и то же", onA, onB);
  }

  /* 2б — отстающие часы: правку сделало только одно устройство, но его часы
     показывают время РАНЬШЕ, чем метка записи в общей базе. Выбор «кто
     новее» здесь ошибается и выбрасывает единственную настоящую правку;
     спасает сравнение с базой: сторона, у которой запись совпала с базой,
     её не трогала, значит права другая — независимо от часов. */
  {
    const a = device("aaa");
    a.st.transactions = [tx("t1", 100), tx("t2", 200)];
    a.save(T0);
    byId(a.st, "transactions", "t1").amount = 500;
    a.save(T0 + 5000);                          /* метка записи в базе: T0+5000 */
    const base = ww45Fingerprint(a.st);
    const b = device("bbb", clone(a.st)); b.fp = clone(a.fp);

    byId(b.st, "transactions", "t1").amount = 777;
    b.save(T0 + 1000);                          /* часы b отстают на четыре секунды */
    a.save(T0 + 6000);                          /* a сохранялся, но t1 не трогал */

    eq("2б. правку с отстающих часов не выбрасывает (сверка с базой)",
       byId(ww45Merge(a.st, b.st, base), "transactions", "t1").amount, 777);
    eq("2б. то же самое со стороны второго устройства",
       byId(ww45Merge(b.st, a.st, base), "transactions", "t1").amount, 777);
  }

  /* 3 — удаление против более ранней правки */
  {
    const { a, b, base } = paired();
    byId(b.st, "transactions", "t1").note = "правка до удаления"; b.save(T0 + 1000);
    a.st.transactions = a.st.transactions.filter((t) => t.id !== "t1"); a.save(T0 + 2000);
    eq("3. удаление позже правки: запись удалена", JSON.stringify(ids(ww45Merge(a.st, b.st, base), "transactions")), JSON.stringify(["t2"]));
  }

  /* 4 — удаление против более поздней правки */
  {
    const { a, b, base } = paired();
    a.st.transactions = a.st.transactions.filter((t) => t.id !== "t1"); a.save(T0 + 1000);
    byId(b.st, "transactions", "t1").note = "вернул осознанно"; b.save(T0 + 2000);
    const m = ww45Merge(a.st, b.st, base);
    eq("4. правка позже удаления: запись жива", JSON.stringify(ids(m, "transactions")), JSON.stringify(["t1", "t2"]));
  }

  /* 5 — добавление на одном и удаление другой записи на другом */
  {
    const { a, b, base } = paired();
    a.st.transactions.push(tx("t3", 300)); a.save(T0 + 1000);
    b.st.transactions = b.st.transactions.filter((t) => t.id !== "t2"); b.save(T0 + 1500);
    eq("5. добавление и удаление разных записей", JSON.stringify(ids(ww45Merge(a.st, b.st, base), "transactions")), JSON.stringify(["t1", "t3"]));
  }

  /* 6 — частичные оплаты по одному кредиту с двух устройств */
  {
    const a = device("aaa");
    a.st.credits = [{ id: "cr1", name: "Авто", payment: 27000, payDay: 20, status: "active" }];
    a.save(T0);
    const base = ww45Fingerprint(a.st);
    const b = device("bbb", clone(a.st)); b.fp = clone(a.fp);

    a.st.ww30Cr["cr1:2026-11"] = { payments: [{ txId: "x1", amount: 10000, principal: 7000 }], paid: 10000 };
    a.save(T0 + 1000);
    b.st.ww30Cr["cr1:2026-11"] = { payments: [{ txId: "x2", amount: 7000, principal: 5000 }], paid: 7000 };
    b.save(T0 + 2000);
    const m = ww45Merge(a.st, b.st, base);
    const e = m.ww30Cr["cr1:2026-11"];
    eq("6. частичные оплаты: обе в списке", e.payments.length, 2);
    eq("6. частичные оплаты: сумма сходится", e.paid, 17000);
  }

  /* 7 — идемпотентность */
  {
    const { a, b, base } = paired();
    byId(a.st, "transactions", "t1").amount = 111; a.save(T0 + 1000);
    b.st.transactions.push(tx("t9", 900)); b.save(T0 + 2000);
    const once = ww45Merge(a.st, b.st, base);
    const twice = ww45Merge(clone(once), b.st, base);
    eq("7. повторное слияние ничего не меняет", ww45StateHash(twice), ww45StateHash(once));
  }

  /* 8 — симметрия (сравниваем данные; порядок и настройки по смыслу зависят от стороны) */
  {
    const { a, b, base } = paired();
    byId(a.st, "transactions", "t1").amount = 111; a.save(T0 + 1000);
    byId(b.st, "transactions", "t2").amount = 222; b.save(T0 + 2000);
    b.st.transactions.push(tx("t7", 700)); b.save(T0 + 2500);
    a.st.transactions = a.st.transactions.filter((t) => t.id !== "t2" || true);
    const ab = ww45Merge(a.st, b.st, base), ba = ww45Merge(b.st, a.st, base);
    const norm = (st) => JSON.stringify((st.transactions || []).slice().sort((x, y) => x.id < y.id ? -1 : 1));
    eq("8. результат не зависит от того, кто сливает", norm(ab), norm(ba));
  }

  /* 9 — пустое устройство против непустого облака */
  {
    const cloud = device("aaa");
    cloud.st.transactions = [tx("t1", 100), tx("t2", 200)];
    cloud.st.credits = [{ id: "cr1", name: "Авто", payment: 27000, status: "active" }];
    cloud.save(T0);
    const fresh = device("ccc");                 /* свежая установка: базы нет */
    fresh.save(T0 + 999999);                     /* и часы у неё свежее */
    const m = ww45Merge(fresh.st, cloud.st, null);
    eq("9. свежая установка не стирает облако — операции", m.transactions.length, 2);
    eq("9. свежая установка не стирает облако — кредиты", m.credits.length, 1);
  }

  /* 9б — стартовый набор не побеждает переименованную в облаке категорию */
  {
    const cloud = device("aaa", seedState());
    cloud.save(T0);
    cloud.st.categories.find((c) => c.id === "c_byt").name = "Продукты";
    cloud.save(T0 + 1000);
    const fresh = device("ccc", seedState());    /* ставим приложение заново */
    fresh.save(Date.now());
    const m = ww45Merge(fresh.st, cloud.st, null);
    eq("9б. переименование в облаке переживает установку на новом устройстве",
       m.categories.find((c) => c.id === "c_byt").name, "Продукты");
  }

  /* 10 — устройство с устаревшей базой: полный разбор без воскрешения */
  {
    const { a, b } = paired();
    b.st.transactions = b.st.transactions.filter((t) => t.id !== "t1"); b.save(T0 + 1000);   /* b удалил t1, надгробие есть */
    a.st.transactions.push(tx("t5", 500)); a.save(T0 + 1200);                                 /* a добавил своё */
    const m = ww45Merge(a.st, b.st, null);                                                    /* базы нет */
    eq("10. без базы: удалённое не воскресает", !!byId(m, "transactions", "t1"), false);
    eq("10. без базы: своё новое сохраняется", !!byId(m, "transactions", "t5"), true);
    eq("10. без базы: общее остаётся", !!byId(m, "transactions", "t2"), true);
  }

  /* 11 — надгробия вычистились по сроку, но база помнит запись */
  {
    const { a, b, base } = paired();
    b.st.transactions = b.st.transactions.filter((t) => t.id !== "t1"); b.save(T0 + 1000);
    b.st.graves = {};                            /* как будто прошло 90 дней и надгробие убрали */
    eq("11. удаление без надгробия распознаётся по базе",
       !!byId(ww45Merge(a.st, b.st, base), "transactions", "t1"), false);
  }

  /* 12 — настройки: общие с сервера, устройские свои */
  {
    const { a, b, base } = paired();
    a.st.settings = { theme: "t9", sbUrl: "https://local", reminderDays: 3 };
    a.save(T0 + 1000);
    b.st.settings = { theme: "t10", sbUrl: "https://remote", reminderDays: 3 };
    b.save(T0 + 2000);
    const m = ww45Merge(a.st, b.st, base);
    eq("12. тема приходит с другого устройства", m.settings.theme, "t10");
    eq("12. адрес проекта остаётся своим", m.settings.sbUrl, "https://local");
  }

  /* 13 — журнал изменений объединяется, а не затирается */
  {
    const { a, b, base } = paired();
    a.st.audit = [{ id: "e1", ts: T0 + 10, label: "A" }];
    b.st.audit = [{ id: "e2", ts: T0 + 20, label: "B" }, { id: "e1", ts: T0 + 10, label: "A" }];
    const m = ww45Merge(a.st, b.st, base);
    eq("13. записи журнала с обоих устройств", m.audit.length, 2);
    eq("13. журнал отсортирован по времени", m.audit[0].id, "e2");
  }

  /* 14 — словари: разные месяцы не конфликтуют */
  {
    const { a, b, base } = paired();
    a.st.posted["r1:2026-11"] = 7000; a.save(T0 + 1000);
    b.st.posted["r1:2026-12"] = 7100; b.save(T0 + 2000);
    const m = ww45Merge(a.st, b.st, base);
    eq("14. отметки оплат за разные месяцы складываются", Object.keys(m.posted).sort().join(","), "r1:2026-11,r1:2026-12");
  }

  /* 16 — одна и та же запись, заведённая независимо на обоих устройствах.
     Так появляются служебные категории переводов: ww2Migrate добавляет их
     при первом запуске на каждом устройстве, с одинаковым содержимым и
     разными метками. Если слияние оставит каждому свою метку, устройства
     будут бесконечно переписывать строку друг за другом, считая чужую
     метку изменением. */
  {
    const a = device("aaa"); a.st.categories = [{ id: "c_tr_in", name: "Перевод", type: "income", icon: "🔄" }]; a.save(T0 + 1000);
    const b = device("bbb"); b.st.categories = [{ id: "c_tr_in", name: "Перевод", type: "income", icon: "🔄" }]; b.save(T0 + 7000);
    const ab = ww45Merge(a.st, b.st, null), ba = ww45Merge(b.st, a.st, null);
    eq("16. одинаковая запись с разными метками: стороны сходятся", ww45StateHash(ab), ww45StateHash(ba));
    eq("16. берётся более ранняя метка", ab.categories[0].u.t, T0 + 1000);
  }

  /* 17 — порядок записей. Счета и категории переставляются перетаскиванием,
     то есть порядок — тоже данные. Но если каждое устройство при слиянии
     ставит первым свой порядок, второе немедленно вернёт свой: строка
     переписывается вечно, хотя содержимое давно совпало. */
  {
    const a = device("aaa");
    a.st.accounts = [{ id: "a1", name: "Карта" }, { id: "a2", name: "Наличные" }, { id: "a3", name: "Вклад" }];
    a.save(T0);
    const base = ww45Fingerprint(a.st);
    const b = device("bbb", clone(a.st)); b.fp = clone(a.fp);

    const ab0 = ww45Merge(a.st, b.st, base), ba0 = ww45Merge(b.st, a.st, base);
    eq("17. без перестановок порядок одинаков с обеих сторон",
       ids2(ab0, "accounts"), ids2(ba0, "accounts"));

    /* Добавление — не перестановка: каждое устройство завело по счёту,
       порядок никто не трогал. Обе стороны обязаны получить одинаковый
       список, иначе они будут переписывать строку друг за другом. */
    const a2 = device("aaa", clone(a.st)); a2.fp = clone(a.fp);
    const b2 = device("bbb", clone(a.st)); b2.fp = clone(a.fp);
    a2.st.accounts.push({ id: "zz", name: "Новый у A" }); a2.save(T0 + 1000);
    b2.st.accounts.push({ id: "mm", name: "Новый у B" }); b2.save(T0 + 2000);
    eq("17. добавления с двух сторон дают одинаковый порядок",
       ids2(ww45Merge(a2.st, b2.st, base), "accounts"), ids2(ww45Merge(b2.st, a2.st, base), "accounts"));

    b.st.accounts = [b.st.accounts[2], b.st.accounts[0], b.st.accounts[1]];   /* переставил на втором */
    b.save(T0 + 3000);
    const ab = ww45Merge(a.st, b.st, base), ba = ww45Merge(b.st, a.st, base);
    eq("17. перестановка доезжает до второго устройства", ids2(ab, "accounts"), "a3,a1,a2");
    eq("17. и обе стороны видят её одинаково", ids2(ab, "accounts"), ids2(ba, "accounts"));
  }

  /* 15 — случайные последовательности: сходимость, идемпотентность, симметрия */
  {
    let rnd = 12345;
    const rand = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    let bad = 0, badSym = 0, badIdem = 0;

    for (let iter = 0; iter < 200; iter++) {
      const start = device("aaa");
      start.st.transactions = [tx("t1", 100), tx("t2", 200), tx("t3", 300)];
      start.st.posted = { "r1:2026-11": 1000 };
      start.save(T0);
      const base = ww45Fingerprint(start.st);
      const a = device("aaa", clone(start.st)); a.fp = clone(start.fp);
      const b = device("bbb", clone(start.st)); b.fp = clone(start.fp);

      let clock = T0;
      [a, b].forEach((d) => {
        const n = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < n; k++) {
          clock += 1 + Math.floor(rand() * 2000);
          const op = pick(["edit", "delete", "add", "dict"]);
          if (op === "edit" && d.st.transactions.length) pick(d.st.transactions).amount = Math.floor(rand() * 9000);
          else if (op === "delete" && d.st.transactions.length) {
            const victim = pick(d.st.transactions).id;
            d.st.transactions = d.st.transactions.filter((t) => t.id !== victim);
          } else if (op === "add") d.st.transactions.push(tx("n" + d.name + iter + k, Math.floor(rand() * 9000)));
          else d.st.posted["r1:2026-1" + Math.floor(rand() * 2)] = Math.floor(rand() * 9000);
          d.save(clock);
        }
      });

      const norm = (st) => JSON.stringify({
        tx: (st.transactions || []).map((t) => t.id + ":" + t.amount).sort(),
        posted: Object.keys(st.posted || {}).sort().map((k) => k + "=" + st.posted[k]),
      });
      const ab = ww45Merge(clone(a.st), clone(b.st), base);
      const ba = ww45Merge(clone(b.st), clone(a.st), base);
      if (norm(ab) !== norm(ba)) { badSym++; if (badSym === 1) out.push(["15. пример расхождения сторон", false, norm(ab) + " ≠ " + norm(ba)]); }
      const again = ww45Merge(clone(ab), clone(b.st), base);
      if (norm(again) !== norm(ab)) { badIdem++; if (badIdem === 1) out.push(["15. пример неидемпотентности", false, norm(again) + " ≠ " + norm(ab)]); }
      /* Сходимость: оба устройства приняли результат и слились ещё раз —
         состояния обязаны совпасть ЦЕЛИКОМ, вместе с метками и порядком.
         Сравнение по проекции (только id и суммы) эту проверку проходило
         бы и при расходящихся метках — а именно из-за них устройства
         бесконечно переписывали строку друг за другом. */
      const a2 = ww45Merge(clone(ab), clone(ba), base);
      const b2 = ww45Merge(clone(ba), clone(ab), base);
      if (ww45StateHash(a2) !== ww45StateHash(b2)) {
        bad++;
        if (bad === 1) out.push(["15. пример несходимости", false, norm(a2) + " / " + norm(b2)]);
      }
    }
    eq("15. 200 случайных прогонов: стороны согласны", badSym, 0);
    eq("15. 200 случайных прогонов: слияние идемпотентно", badIdem, 0);
    eq("15. 200 случайных прогонов: устройства сходятся", bad, 0);
  }

  return out;
}

async function run() {
  const launch = { args: ["--no-sandbox"] };
  if (process.env.WW_CHROME) launch.executablePath = process.env.WW_CHROME;
  else if (require("fs").existsSync("/usr/bin/google-chrome")) launch.executablePath = "/usr/bin/google-chrome";
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext();
  await ctx.route("**/*", (r) => (r.request().url().startsWith("file:") ? r.continue() : r.abort()));
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", { get: () => false, configurable: true });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(APP);
  await page.waitForTimeout(1200);

  const results = await page.evaluate(suite);
  await browser.close();

  console.log("\nСлияние при синхронизации");
  let passed = 0;
  const failed = [];
  results.forEach(([name, okFlag, detail]) => {
    if (okFlag) { passed++; console.log("  ok   " + name); }
    else { failed.push(name + (detail ? " — " + detail : "")); console.log("  ПАДАЕТ " + name + (detail ? " — " + detail : "")); }
  });
  if (errors.length) failed.push("ошибки страницы: " + errors.join(" | "));

  console.log("\n" + "=".repeat(60));
  if (failed.length) {
    console.log("ПАДАЮТ ПРОВЕРКИ: " + failed.length + " (прошло " + passed + ")");
    failed.forEach((f) => console.log("  • " + f));
    process.exit(1);
  }
  console.log("Все проверки прошли: " + passed);
}

run().catch((e) => { console.error(e); process.exit(1); });
