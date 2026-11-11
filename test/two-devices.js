/* WiseWallet — два устройства против одного сервера (v4.45).
 *
 * Запуск:  node test/two-devices.js   (входит в npm test)
 *
 * test/merge.js проверяет саму функцию слияния, run-all.js — путь
 * синхронизации с поддельным fetch внутри одной страницы. Здесь третий
 * уровень: два независимых профиля браузера (у каждого свой localStorage,
 * свой идентификатор устройства, свой отпечаток базы) ходят в один и тот
 * же поддельный PostgREST. Именно так вылезли две ошибки, которых не
 * видно на уровне функции:
 *
 *   • порядок записей не сходился — каждое устройство навязывало свой, и
 *     строка переписывалась бесконечно;
 *   • одинаковые по содержимому записи с разными метками (служебные
 *     категории переводов, которые ww2Migrate заводит на каждом
 *     устройстве отдельно) давали тот же бесконечный обмен.
 *
 * Поэтому последняя проверка — «холостая синхронизация не пишет в базу»:
 * она ловит такие расхождения, даже когда данные у всех совпадают.
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

/* ---------- поддельный сервер: одна строка ww_user_state ---------- */
let row = null, writes = 0, races = 0;

function serve(url, method, body) {
  const base = { status: 200, contentType: "application/json" };
  if (!method || method === "GET") {
    return { ...base, body: JSON.stringify(row ? [{ data: row.data, updated_at: row.updated_at, summary: row.summary }] : []) };
  }
  if (method === "PATCH") {
    /* Как настоящий PostgREST: фильтр не совпал — ноль изменённых строк,
       а в теле меняются только перечисленные колонки (приложение умеет
       обновлять одну лишь summary, не трогая data). */
    const want = decodeURIComponent((url.match(/updated_at=eq\.([^&]+)/) || [])[1] || "");
    if (!row || row.updated_at !== want) { races++; return { ...base, body: "[]" }; }
    const b = JSON.parse(body);
    const dataWrite = b.data !== undefined;
    Object.keys(b).forEach((k) => { row[k] = b[k]; });
    if (dataWrite) writes++;                           /* обновление одной сводки записью данных не считаем */
    return { ...base, body: JSON.stringify([{ data: row.data, updated_at: row.updated_at, summary: row.summary }]) };
  }
  if (method === "POST") {
    const b = JSON.parse(body)[0];
    if (row) return { ...base, body: "[]" };          /* resolution=ignore-duplicates */
    row = { data: b.data, updated_at: b.updated_at, summary: b.summary };
    writes++;
    return { ...base, body: JSON.stringify([{ data: row.data, updated_at: row.updated_at, summary: row.summary }]) };
  }
  return { ...base, body: "[]" };
}

let passed = 0;
const failed = [];
function eq(name, actual, expected) {
  if (actual === expected) { passed++; console.log("  ok   " + name); }
  else { failed.push(name); console.log("  ПАДАЕТ " + name + " — получили " + JSON.stringify(actual) + ", ждали " + JSON.stringify(expected)); }
}

async function device(browser, name) {
  const ctx = await browser.newContext();            /* свой localStorage = отдельное устройство */
  await ctx.route("**/*", async (route) => {
    const r = route.request(), u = r.url();
    if (u.startsWith("file:")) return route.continue();
    if (u.includes("/rest/v1/ww_user_state")) return route.fulfill(serve(u, r.method(), r.postData()));
    return route.abort();
  });
  await ctx.addInitScript(() => {
    localStorage.setItem("ww_session_v2", JSON.stringify({
      access_token: "t", refresh_token: "t", expires_at: Date.now() + 9e8,
      user_id: "11111111-1111-1111-1111-111111111111", email: "t@example.com",
    }));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(name + ": " + e.message));
  await page.goto(APP);
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    S.settings.sbUrl = "https://example.supabase.co";
    S.settings.sbKey = "anon-key";
    S.transactions = []; S.credits = []; S.recurring = [];
    save();
  });
  return {
    name, page, errors,
    run: (code) => page.evaluate(code),
    sync: () => page.evaluate(() => syncNow(false)),
    list: () => page.evaluate(() => S.transactions.map((t) => t.id + ":" + t.amount).sort().join(",")),
  };
}

const addTx = (id, amt) =>
  `(() => { S.transactions.push({ id:'${id}', type:'expense', amount:${amt}, categoryId:'c_byt', accountId:'a_card', date: todayStr(), note:'', createdAt: Date.now() }); save(); })()`;

async function run() {
  const launch = { args: ["--no-sandbox"] };
  if (process.env.WW_CHROME) launch.executablePath = process.env.WW_CHROME;
  else if (require("fs").existsSync("/usr/bin/google-chrome")) launch.executablePath = "/usr/bin/google-chrome";
  const browser = await chromium.launch(launch);
  const A = await device(browser, "A");
  const B = await device(browser, "B");

  console.log("\nДва устройства против одного сервера");

  await A.run(addTx("a1", 100));
  await A.sync();
  await B.sync();
  eq("операция с первого устройства доезжает до второго", await B.list(), "a1:100");

  /* встречные добавления */
  await A.run(addTx("a2", 200));
  await B.run(addTx("b1", 300));
  await A.sync(); await B.sync(); await A.sync();
  eq("встречные добавления: всё на первом", await A.list(), "a1:100,a2:200,b1:300");
  eq("встречные добавления: всё на втором", await B.list(), "a1:100,a2:200,b1:300");

  /* правка одной записи на обоих — выигрывает поздняя */
  await A.run("(() => { S.transactions.find(t => t.id === 'a1').amount = 111; save(); })()");
  await new Promise((r) => setTimeout(r, 1100));
  await B.run("(() => { S.transactions.find(t => t.id === 'a1').amount = 222; save(); })()");
  await A.sync(); await B.sync(); await A.sync();
  eq("правка одной записи: поздняя побеждает на первом", await A.list(), "a1:222,a2:200,b1:300");
  eq("правка одной записи: и на втором то же", await B.list(), "a1:222,a2:200,b1:300");

  /* удаление на одном при правке другой записи на другом */
  await A.run("(() => { S.transactions = S.transactions.filter(t => t.id !== 'a2'); save(); })()");
  await B.run("(() => { S.transactions.find(t => t.id === 'b1').amount = 999; save(); })()");
  await A.sync(); await B.sync(); await A.sync(); await B.sync();
  eq("удаление и правка разных записей: первый", await A.list(), "a1:222,b1:999");
  eq("удаление и правка разных записей: второй", await B.list(), "a1:222,b1:999");

  /* главное: когда всё сошлось, синхронизация обязана молчать */
  const before = writes;
  await A.sync(); await B.sync(); await A.sync(); await B.sync();
  eq("холостая синхронизация не пишет в базу", writes - before, 0);

  const errors = [...A.errors, ...B.errors];
  eq("ошибок на страницах нет", errors.join(" | "), "");
  console.log("  (записей на сервер: " + writes + ", проигранных гонок: " + races + ")");

  await browser.close();

  console.log("\n" + "=".repeat(60));
  if (failed.length) {
    console.log("ПАДАЮТ ПРОВЕРКИ: " + failed.length + " (прошло " + passed + ")");
    failed.forEach((f) => console.log("  • " + f));
    process.exit(1);
  }
  console.log("Все проверки прошли: " + passed);
}

run().catch((e) => { console.error(e); process.exit(1); });
