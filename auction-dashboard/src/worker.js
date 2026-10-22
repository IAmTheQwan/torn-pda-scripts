const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

const MAX_TREND_SAMPLE = 5000;
const MAX_SNAPSHOT_ITEMS = 120;
const SNAPSHOT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const ACCESS_JWKS_TTL_MS = 60 * 60 * 1000;
const BACKFILL_STRATEGY_VERSION = "2";
let accessJwksCache = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname === "/api/snapshots/ingest") {
      return snapshotPreflight(request);
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "caf-auction-dashboard", environment: env.ENVIRONMENT || "unknown" });
    }

    if (url.pathname === "/api/snapshots/ingest") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return ingestSnapshot(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      if (!(await isDashboardAuthorized(request, env, ctx))) {
        return json({ error: "Dashboard authorization required." }, 401);
      }
      return routeApi(request, env, ctx, url);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("CAF Auction Dashboard", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledWork(env));
  }
};

async function routeApi(request, env, ctx, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/status") return getStatus(env);
    if (request.method === "GET" && url.pathname === "/api/items") return searchItems(env, url);
    if (request.method === "GET" && url.pathname === "/api/overview") return getOverview(env, url);
    if (request.method === "GET" && url.pathname === "/api/snapshots") return getSnapshots(env);
    if (request.method === "GET" && url.pathname === "/api/admin/device-tokens") return listDeviceTokens(env);
    if (request.method === "POST" && url.pathname === "/api/admin/device-tokens") return createDeviceToken(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/sync") {
      const body = await readJson(request);
      const requested = clampInteger(body?.pages, 1, 20, Number(env.SYNC_PAGES_PER_RUN || 5));
      const result = await runAuctionSync(env, requested, { forceForward: true });
      return json(result);
    }

    const trendMatch = url.pathname.match(/^\/api\/items\/(\d+)\/trends$/);
    if (request.method === "GET" && trendMatch) return getItemTrends(env, url, Number(trendMatch[1]));

    const revokeMatch = url.pathname.match(/^\/api\/admin\/device-tokens\/([a-f0-9-]+)$/i);
    if (request.method === "DELETE" && revokeMatch) return revokeDeviceToken(env, revokeMatch[1]);

    return json({ error: "Not found." }, 404);
  } catch (error) {
    console.error("API error", error);
    return json({ error: error instanceof Error ? error.message : "Unexpected server error." }, 500);
  }
}

async function runScheduledWork(env) {
  try {
    await runAuctionSync(env, clampInteger(env.SYNC_PAGES_PER_RUN, 1, 20, 5));
  } catch (error) {
    console.error("Scheduled auction sync failed", error);
  }

  try {
    const cutoff = Math.floor(Date.now() / 1000) - SNAPSHOT_RETENTION_SECONDS;
    await env.DB.prepare("DELETE FROM snapshot_batches WHERE captured_at < ?1").bind(cutoff).run();
  } catch (error) {
    console.error("Snapshot cleanup failed", error);
  }
}

async function getStatus(env) {
  const [sales, latestBatch, tokens, syncRows] = await env.DB.batch([
    env.DB.prepare(`
      SELECT COUNT(*) AS total_sales,
             MIN(ended_at) AS oldest_sale,
             MAX(ended_at) AS newest_sale,
             COUNT(DISTINCT item_id) AS item_count
      FROM auction_sales
    `),
    env.DB.prepare(`
      SELECT id, captured_at, received_at, source_url, source_page, item_count
      FROM snapshot_batches
      ORDER BY captured_at DESC
      LIMIT 1
    `),
    env.DB.prepare("SELECT COUNT(*) AS active_tokens FROM device_tokens WHERE revoked_at IS NULL"),
    env.DB.prepare(`
      SELECT key, value, updated_at
      FROM sync_state
      WHERE key IN (
        'last_run_at', 'last_ended_at', 'last_inserted', 'last_error',
        'history_caught_up_at', 'last_raw_received', 'last_normalized', 'last_dropped',
        'backfill_to', 'backfill_started_at', 'backfill_budget_day',
        'backfill_inserted_today', 'last_forward_check_at'
      )
    `)
  ]);

  const sync = Object.fromEntries((syncRows.results || []).map(row => [row.key, parseStateValue(row.value)]));
  return json({
    sales: sales.results?.[0] || {},
    latestSnapshot: latestBatch.results?.[0] || null,
    activeDeviceTokens: Number(tokens.results?.[0]?.active_tokens || 0),
    sync
  });
}

async function searchItems(env, url) {
  const query = String(url.searchParams.get("q") || "").trim();
  const limit = clampInteger(url.searchParams.get("limit"), 1, 50, 20);
  if (query.length < 2) return json({ items: [] });

  const result = await env.DB.prepare(`
    SELECT item_id,
           MAX(item_name) AS item_name,
           COUNT(*) AS sale_count,
           MIN(price) AS min_price,
           CAST(AVG(price) AS INTEGER) AS average_price,
           MAX(price) AS max_price,
           MAX(ended_at) AS last_sale
    FROM auction_sales
    WHERE item_name LIKE ?1 ESCAPE '\\'
    GROUP BY item_id
    ORDER BY sale_count DESC, item_name ASC
    LIMIT ?2
  `).bind(`%${escapeLike(query)}%`, limit).all();

  return json({ items: result.results || [] });
}

async function getOverview(env, url) {
  const days = clampInteger(url.searchParams.get("days"), 7, 90, 30);
  const minSales = clampInteger(url.searchParams.get("minSales"), 1, 100, 5);
  const now = new Date();
  const recentStart = dateOnly(addUtcDays(now, -(days - 1)));
  const priorStart = dateOnly(addUtcDays(now, -(days * 2 - 1)));

  const result = await env.DB.prepare(`
    SELECT item_id,
           MAX(item_name) AS item_name,
           SUM(CASE WHEN day >= ?1 THEN sale_count ELSE 0 END) AS recent_count,
           SUM(CASE WHEN day >= ?1 THEN price_total ELSE 0 END) AS recent_total,
           MIN(CASE WHEN day >= ?1 THEN min_price END) AS recent_min,
           MAX(CASE WHEN day >= ?1 THEN max_price END) AS recent_max,
           SUM(CASE WHEN day >= ?2 AND day < ?1 THEN sale_count ELSE 0 END) AS prior_count,
           SUM(CASE WHEN day >= ?2 AND day < ?1 THEN price_total ELSE 0 END) AS prior_total
    FROM daily_item_rollups
    WHERE day >= ?2
    GROUP BY item_id
    HAVING recent_count >= ?3
    ORDER BY recent_count DESC
    LIMIT 300
  `).bind(recentStart, priorStart, minSales).all();

  const rows = (result.results || []).map(row => {
    const recentAverage = Number(row.recent_count) ? Number(row.recent_total) / Number(row.recent_count) : 0;
    const priorAverage = Number(row.prior_count) ? Number(row.prior_total) / Number(row.prior_count) : 0;
    return {
      itemId: Number(row.item_id),
      itemName: row.item_name,
      recentCount: Number(row.recent_count || 0),
      recentAverage: Math.round(recentAverage),
      recentMin: Number(row.recent_min || 0),
      recentMax: Number(row.recent_max || 0),
      priorCount: Number(row.prior_count || 0),
      priorAverage: Math.round(priorAverage),
      changePercent: priorAverage > 0 ? ((recentAverage - priorAverage) / priorAverage) * 100 : null
    };
  });

  const eligibleMovers = rows.filter(row => row.priorCount >= minSales && row.changePercent !== null);
  return json({
    days,
    minSales,
    rising: eligibleMovers.slice().sort((a, b) => b.changePercent - a.changePercent).slice(0, 12),
    falling: eligibleMovers.slice().sort((a, b) => a.changePercent - b.changePercent).slice(0, 12),
    lowerPriced: rows.slice().sort((a, b) => a.recentAverage - b.recentAverage).slice(0, 12),
    higherPriced: rows.slice().sort((a, b) => b.recentAverage - a.recentAverage).slice(0, 12)
  });
}

async function getItemTrends(env, url, itemId) {
  const days = clampInteger(url.searchParams.get("days"), 7, 3650, 90);
  const bonusId = optionalInteger(url.searchParams.get("bonus"));
  const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const bonusClause = bonusId === null ? "" : "AND (bonus1_id = ?3 OR bonus2_id = ?3)";
  const statement = env.DB.prepare(`
    SELECT listing_id, ended_at, item_id, item_uid, item_name, item_type, item_sub_type,
           rarity, damage, accuracy, armor, quality, price, bids,
           bonus_signature, bonus1_id, bonus1_title, bonus1_value,
           bonus2_id, bonus2_title, bonus2_value
    FROM auction_sales
    WHERE item_id = ?1 AND ended_at >= ?2
    ${bonusClause}
    ORDER BY ended_at DESC
    LIMIT ${MAX_TREND_SAMPLE}
  `);
  const result = bonusId === null
    ? await statement.bind(itemId, since).all()
    : await statement.bind(itemId, since, bonusId).all();
  const sales = result.results || [];
  const prices = sales.map(row => Number(row.price)).filter(Number.isFinite);
  const daily = new Map();

  for (const sale of sales) {
    const day = new Date(Number(sale.ended_at) * 1000).toISOString().slice(0, 10);
    const bucket = daily.get(day) || { day, count: 0, total: 0, min: Infinity, max: 0 };
    const price = Number(sale.price || 0);
    bucket.count += 1;
    bucket.total += price;
    bucket.min = Math.min(bucket.min, price);
    bucket.max = Math.max(bucket.max, price);
    daily.set(day, bucket);
  }

  const dailyRows = [...daily.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map(row => ({ ...row, average: Math.round(row.total / row.count) }));

  return json({
    item: sales.length ? { id: itemId, name: sales[0].item_name } : { id: itemId, name: "Unknown item" },
    days,
    bonusId,
    sampled: sales.length,
    sampleLimit: MAX_TREND_SAMPLE,
    summary: summarizePrices(prices),
    daily: dailyRows,
    recentSales: sales.slice(0, 100).map(formatSale)
  });
}

async function getSnapshots(env) {
  const batches = await env.DB.prepare(`
    SELECT id, captured_at, received_at, source_url, source_page, item_count, device_id
    FROM snapshot_batches
    ORDER BY captured_at DESC
    LIMIT 10
  `).all();
  const latestId = batches.results?.[0]?.id;
  let items = [];

  if (latestId) {
    const result = await env.DB.prepare(`
      SELECT listing_key, captured_at, item_id, item_uid, item_name, rarity,
             damage, accuracy, armor, quality, current_bid, bids,
             bonus_signature, bonuses_json, time_text, ends_at, source_url
      FROM active_snapshots
      WHERE batch_id = ?1
      ORDER BY current_bid ASC, item_name ASC
    `).bind(latestId).all();
    items = (result.results || []).map(row => ({
      ...row,
      bonuses: safeJsonParse(row.bonuses_json, [])
    }));
  }

  return json({ batches: batches.results || [], latestItems: items });
}

async function createDeviceToken(request, env) {
  const body = await readJson(request);
  const label = String(body?.label || "CAF Clean device").trim().slice(0, 80) || "CAF Clean device";
  const rawToken = randomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO device_tokens (id, label, token_hash)
    VALUES (?1, ?2, ?3)
  `).bind(id, label, tokenHash).run();

  return json({
    id,
    label,
    token: rawToken,
    warning: "This token is shown once. Save it in CAF Clean; do not commit it to Git."
  }, 201);
}

async function listDeviceTokens(env) {
  const result = await env.DB.prepare(`
    SELECT id, label, created_at, last_used_at, revoked_at
    FROM device_tokens
    ORDER BY created_at DESC
  `).all();
  return json({ tokens: result.results || [] });
}

async function revokeDeviceToken(env, id) {
  const result = await env.DB.prepare(`
    UPDATE device_tokens SET revoked_at = unixepoch()
    WHERE id = ?1 AND revoked_at IS NULL
  `).bind(id).run();
  return json({ revoked: Number(result.meta?.changes || 0) > 0 });
}

async function ingestSnapshot(request, env) {
  const cors = snapshotCorsHeaders(request);
  try {
    const token = bearerToken(request);
    if (!token) return json({ error: "Device token required." }, 401, cors);
    const tokenHash = await sha256Hex(token);
    const device = await env.DB.prepare(`
      SELECT id FROM device_tokens
      WHERE token_hash = ?1 AND revoked_at IS NULL
      LIMIT 1
    `).bind(tokenHash).first();
    if (!device) return json({ error: "Invalid or revoked device token." }, 401, cors);

    const body = await readJson(request, 512_000);
    const normalized = normalizeSnapshotPayload(body, device.id);
    const existing = await env.DB.prepare("SELECT id FROM snapshot_batches WHERE id = ?1").bind(normalized.batch.id).first();
    if (existing) return json({ ok: true, duplicate: true, batchId: normalized.batch.id }, 200, cors);

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO snapshot_batches (id, captured_at, source_url, source_page, item_count, device_id)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `).bind(
        normalized.batch.id,
        normalized.batch.captured_at,
        normalized.batch.source_url,
        normalized.batch.source_page,
        normalized.items.length,
        device.id
      ),
      env.DB.prepare(`
        INSERT INTO active_snapshots (
          batch_id, listing_key, captured_at, item_id, item_uid, item_name, rarity,
          damage, accuracy, armor, quality, current_bid, bids, bonus_signature,
          bonuses_json, time_text, ends_at, source_url
        )
        SELECT
          ?1,
          json_extract(value, '$.listing_key'),
          ?2,
          json_extract(value, '$.item_id'),
          json_extract(value, '$.item_uid'),
          json_extract(value, '$.item_name'),
          json_extract(value, '$.rarity'),
          json_extract(value, '$.damage'),
          json_extract(value, '$.accuracy'),
          json_extract(value, '$.armor'),
          json_extract(value, '$.quality'),
          json_extract(value, '$.current_bid'),
          json_extract(value, '$.bids'),
          json_extract(value, '$.bonus_signature'),
          json_extract(value, '$.bonuses_json'),
          json_extract(value, '$.time_text'),
          json_extract(value, '$.ends_at'),
          json_extract(value, '$.source_url')
        FROM json_each(?3)
      `).bind(normalized.batch.id, normalized.batch.captured_at, JSON.stringify(normalized.items)),
      env.DB.prepare("UPDATE device_tokens SET last_used_at = unixepoch() WHERE id = ?1").bind(device.id)
    ]);

    return json({ ok: true, batchId: normalized.batch.id, accepted: normalized.items.length }, 201, cors);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Snapshot upload failed." }, 400, cors);
  }
}

export function normalizeSnapshotPayload(body, deviceId = null) {
  if (!body || !Array.isArray(body.items)) throw new Error("Snapshot items are required.");
  if (!body.items.length) throw new Error("Snapshot contains no listings.");
  if (body.items.length > MAX_SNAPSHOT_ITEMS) throw new Error(`Snapshot exceeds ${MAX_SNAPSHOT_ITEMS} listings.`);
  const capturedAt = normalizeEpoch(body.capturedAt || body.captured_at || Date.now());
  const sourceUrl = safeTornUrl(body.sourceUrl || body.source_url || "");
  const sourcePage = optionalInteger(body.sourcePage ?? body.source_page);
  const id = validUuid(body.batchId || body.batch_id) ? String(body.batchId || body.batch_id) : crypto.randomUUID();
  const seen = new Set();
  const items = [];

  for (let index = 0; index < body.items.length; index += 1) {
    const item = body.items[index] || {};
    const itemName = cleanText(item.name || item.itemName || item.item_name, 100);
    if (!itemName) continue;
    const bonuses = normalizeBonuses(item.bonuses);
    const listingKey = cleanText(
      item.listingId || item.listingID || item.listing_key || item.id || `${itemName}|${item.bid || item.price || 0}|${index}`,
      160
    );
    if (!listingKey || seen.has(listingKey)) continue;
    seen.add(listingKey);
    items.push({
      listing_key: listingKey,
      item_id: optionalInteger(item.itemId ?? item.itemID ?? item.item_id),
      item_uid: optionalInteger(item.uid ?? item.itemUid ?? item.item_uid),
      item_name: itemName,
      rarity: cleanText(item.rarity || item.color, 20),
      damage: optionalNumber(item.damage),
      accuracy: optionalNumber(item.accuracy),
      armor: optionalNumber(item.armor ?? item.armour),
      quality: optionalNumber(item.quality),
      current_bid: optionalInteger(item.bid ?? item.currentBid ?? item.current_bid ?? item.price),
      bids: optionalInteger(item.bids),
      bonus_signature: bonusSignature(bonuses),
      bonuses_json: JSON.stringify(bonuses),
      time_text: cleanText(item.timeText || item.time_text, 40),
      ends_at: normalizeOptionalEpoch(item.endsAt ?? item.endsAtMs ?? item.ends_at),
      source_url: safeTornUrl(item.sourceUrl || item.source_url || sourceUrl)
    });
  }

  if (!items.length) throw new Error("Snapshot contains no valid listings.");
  return {
    batch: {
      id,
      captured_at: capturedAt,
      source_url: sourceUrl,
      source_page: sourcePage,
      device_id: deviceId
    },
    items
  };
}

async function runAuctionSync(env, pageLimit, options = {}) {
  if (!env.TORN_API_KEY) throw new Error("TORN_API_KEY is not configured.");
  const lock = await acquireSyncLock(env.DB);
  if (!lock) return { ok: false, skipped: true, reason: "Another sync is already running." };

  let processedPages = 0;
  let rawReceived = 0;
  let normalizedReceived = 0;
  let inserted = 0;
  let newestTimestamp = Number(await getSyncState(env.DB, "last_ended_at") || 0);
  let forwardUrl = await getSyncState(env.DB, "forward_cursor_url");
  let backfillTo = Number(await getSyncState(env.DB, "backfill_to") || 0);
  let backfillStarted = Boolean(await getSyncState(env.DB, "backfill_started_at"));
  let historyCaughtUpAt = Number(await getSyncState(env.DB, "history_caught_up_at") || 0);
  const strategyVersion = await getSyncState(env.DB, "backfill_strategy_version");
  const now = Math.floor(Date.now() / 1000);
  const today = new Date(now * 1000).toISOString().slice(0, 10);
  const storedBudgetDay = await getSyncState(env.DB, "backfill_budget_day");
  let insertedToday = storedBudgetDay === today
    ? Number(await getSyncState(env.DB, "backfill_inserted_today") || 0)
    : 0;
  const dailyInsertLimit = clampInteger(env.BACKFILL_DAILY_INSERT_LIMIT, 1_000, 90_000, 40_000);
  const forwardInterval = clampInteger(env.FORWARD_SYNC_INTERVAL_SECONDS, 300, 86_400, 3_600);
  let lastForwardCheckAt = Number(await getSyncState(env.DB, "last_forward_check_at") || 0);

  try {
    if (storedBudgetDay !== today) {
      await setSyncStates(env.DB, {
        backfill_budget_day: today,
        backfill_inserted_today: 0
      });
    }

    // Versions before strategy 2 trusted the newest response's optional next
    // link. Torn can omit that link even though older records are available.
    // Recover automatically from the false "caught up" state by deriving an
    // explicit inclusive `to` boundary from the oldest stored timestamp.
    if (backfillStarted && strategyVersion !== BACKFILL_STRATEGY_VERSION) {
      const oldest = await env.DB.prepare("SELECT MIN(ended_at) AS value FROM auction_sales").first();
      const oldestTimestamp = Number(oldest?.value || 0);
      if (oldestTimestamp > 0) {
        backfillTo = Math.max(0, oldestTimestamp - 1);
        historyCaughtUpAt = 0;
        await setSyncStates(env.DB, {
          backfill_strategy_version: BACKFILL_STRATEGY_VERSION,
          backfill_to: backfillTo,
          backfill_cursor_url: "",
          history_caught_up_at: ""
        });
      } else {
        backfillStarted = false;
      }
    }

    // Seed from Torn's newest page. Starting with `from=0` can yield an empty
    // page, and an empty page must never be mistaken for complete history.
    if (!backfillStarted) {
      const page = await fetchAuctionPage(env, recentAuctionUrl(env));
      if (!page.rawCount) {
        throw new Error("Torn returned an empty initial auction page; history was not marked caught up.");
      }
      const changes = await storeAuctionPage(env.DB, page.normalized);
      processedPages += 1;
      rawReceived += page.rawCount;
      normalizedReceived += page.normalized.length;
      inserted += changes;
      insertedToday += changes;
      newestTimestamp = Math.max(newestTimestamp, page.maxTimestamp);
      backfillTo = nextBackfillTimestamp(0, page.minTimestamp);
      forwardUrl = "";
      backfillStarted = true;
      lastForwardCheckAt = now;
      await setSyncStates(env.DB, {
        backfill_started_at: now,
        backfill_strategy_version: BACKFILL_STRATEGY_VERSION,
        backfill_to: backfillTo,
        backfill_cursor_url: "",
        forward_cursor_url: "",
        history_caught_up_at: "",
        last_forward_check_at: now,
        backfill_budget_day: today,
        backfill_inserted_today: insertedToday
      });
    } else {
      // Check new sales independently from the long historical fill. Rewind
      // one second and rely on the listing-id primary key at the boundary.
      const forwardDue = Boolean(options.forceForward) || Boolean(forwardUrl) || now - lastForwardCheckAt >= forwardInterval;
      if (forwardDue && !forwardUrl) forwardUrl = incrementalAuctionUrl(env, newestTimestamp);
      while (forwardUrl && processedPages < pageLimit) {
        const page = await fetchAuctionPage(env, forwardUrl);
        const changes = await storeAuctionPage(env.DB, page.normalized);
        processedPages += 1;
        rawReceived += page.rawCount;
        normalizedReceived += page.normalized.length;
        inserted += changes;
        insertedToday += changes;
        newestTimestamp = Math.max(newestTimestamp, page.maxTimestamp);
        forwardUrl = page.nextUrl;
        if (!forwardUrl) lastForwardCheckAt = now;
        await setSyncStates(env.DB, {
          forward_cursor_url: forwardUrl,
          last_forward_check_at: lastForwardCheckAt,
          backfill_inserted_today: insertedToday
        });
      }
    }

    // Backfill with an explicit upper timestamp. This does not rely on Torn
    // returning a `next` link for an unbounded newest-page request. An empty
    // bounded page is the only signal that all API history has been reached.
    while (!forwardUrl && backfillTo > 0 && insertedToday < dailyInsertLimit && processedPages < pageLimit) {
      const page = await fetchAuctionPage(env, historicalAuctionUrl(env, backfillTo));
      processedPages += 1;
      rawReceived += page.rawCount;
      normalizedReceived += page.normalized.length;

      if (!page.rawCount) {
        backfillTo = 0;
        historyCaughtUpAt = now;
        await setSyncStates(env.DB, {
          backfill_to: 0,
          backfill_cursor_url: "",
          history_caught_up_at: historyCaughtUpAt
        });
        break;
      }

      const changes = await storeAuctionPage(env.DB, page.normalized);
      inserted += changes;
      insertedToday += changes;
      newestTimestamp = Math.max(newestTimestamp, page.maxTimestamp);
      backfillTo = nextBackfillTimestamp(backfillTo, page.minTimestamp);
      historyCaughtUpAt = 0;
      await setSyncStates(env.DB, {
        backfill_to: backfillTo,
        backfill_cursor_url: "",
        history_caught_up_at: "",
        backfill_budget_day: today,
        backfill_inserted_today: insertedToday
      });
    }

    await setSyncStates(env.DB, {
      cursor_url: "",
      last_ended_at: newestTimestamp,
      last_run_at: now,
      last_raw_received: rawReceived,
      last_normalized: normalizedReceived,
      last_dropped: rawReceived - normalizedReceived,
      last_inserted: inserted,
      last_error: "",
      backfill_to: backfillTo,
      backfill_budget_day: today,
      backfill_inserted_today: insertedToday,
      history_caught_up_at: historyCaughtUpAt || ""
    });

    return {
      ok: true,
      processedPages,
      rawReceived,
      received: normalizedReceived,
      dropped: rawReceived - normalizedReceived,
      inserted,
      newestTimestamp,
      liveHasMore: Boolean(forwardUrl),
      historyHasMore: backfillTo > 0,
      backfillTo,
      dailyInsertLimit,
      insertedToday,
      budgetReached: insertedToday >= dailyInsertLimit
    };
  } catch (error) {
    await setSyncStates(env.DB, {
      last_run_at: Math.floor(Date.now() / 1000),
      last_error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    await releaseSyncLock(env.DB);
  }
}

async function fetchAuctionPage(env, candidate) {
  const safeUrl = safeTornApiUrl(candidate, env);
  const response = await fetch(safeUrl, {
    headers: {
      Authorization: `ApiKey ${env.TORN_API_KEY}`,
      Accept: "application/json",
      "User-Agent": "CAF-Auction-Dashboard/0.2"
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.error || payload?.error?.message || `Torn API returned ${response.status}.`);
  }
  if (payload?.error) throw new Error(payload.error.error || payload.error.message || "Torn API error.");
  if (!Array.isArray(payload?.auctionhouse)) {
    throw new Error("Torn API response did not contain an auctionhouse array.");
  }

  const normalized = payload.auctionhouse.map(normalizeAuction).filter(Boolean);
  const candidateNext = payload?._metadata?.links?.next;
  const timestamps = payload.auctionhouse.map(listing => Number(listing?.timestamp) || 0).filter(Boolean);
  return {
    rawCount: payload.auctionhouse.length,
    maxTimestamp: Math.max(0, ...timestamps),
    minTimestamp: timestamps.length ? Math.min(...timestamps) : 0,
    normalized,
    nextUrl: candidateNext ? safeTornApiUrl(candidateNext, env) : ""
  };
}

async function storeAuctionPage(db, normalized) {
  if (!normalized.length) return 0;
  const result = await insertAuctionBatch(db, normalized);
  return result.results?.length || 0;
}

export function normalizeAuction(listing) {
  if (!listing || !listing.id || !listing.item || !listing.timestamp || !listing.item.stats) return null;
  const item = listing.item;
  const stats = item.stats || {};
  const bonuses = normalizeBonuses(item.bonuses);
  const first = bonuses[0] || {};
  const second = bonuses[1] || {};
  return {
    listing_id: Number(listing.id),
    ended_at: Number(listing.timestamp),
    item_id: Number(item.id),
    item_uid: optionalInteger(item.uid),
    item_name: cleanText(item.name, 100) || `Item ${item.id}`,
    item_type: cleanText(item.type, 40),
    item_sub_type: cleanText(item.sub_type, 40),
    rarity: cleanText(item.rarity, 20),
    damage: optionalNumber(stats.damage),
    accuracy: optionalNumber(stats.accuracy),
    armor: optionalNumber(stats.armor),
    quality: optionalNumber(stats.quality),
    price: Number(listing.price || 0),
    bids: Number(listing.bids || 0),
    bonus_signature: bonusSignature(bonuses),
    bonus1_id: optionalInteger(first.id),
    bonus1_title: cleanText(first.title, 60),
    bonus1_value: optionalNumber(first.value),
    bonus2_id: optionalInteger(second.id),
    bonus2_title: cleanText(second.title, 60),
    bonus2_value: optionalNumber(second.value)
  };
}

async function insertAuctionBatch(db, rows) {
  return db.prepare(`
    INSERT OR IGNORE INTO auction_sales (
      listing_id, ended_at, item_id, item_uid, item_name, item_type, item_sub_type,
      rarity, damage, accuracy, armor, quality, price, bids, bonus_signature,
      bonus1_id, bonus1_title, bonus1_value, bonus2_id, bonus2_title, bonus2_value
    )
    SELECT
      json_extract(value, '$.listing_id'),
      json_extract(value, '$.ended_at'),
      json_extract(value, '$.item_id'),
      json_extract(value, '$.item_uid'),
      json_extract(value, '$.item_name'),
      json_extract(value, '$.item_type'),
      json_extract(value, '$.item_sub_type'),
      json_extract(value, '$.rarity'),
      json_extract(value, '$.damage'),
      json_extract(value, '$.accuracy'),
      json_extract(value, '$.armor'),
      json_extract(value, '$.quality'),
      json_extract(value, '$.price'),
      json_extract(value, '$.bids'),
      json_extract(value, '$.bonus_signature'),
      json_extract(value, '$.bonus1_id'),
      json_extract(value, '$.bonus1_title'),
      json_extract(value, '$.bonus1_value'),
      json_extract(value, '$.bonus2_id'),
      json_extract(value, '$.bonus2_title'),
      json_extract(value, '$.bonus2_value')
    FROM json_each(?1)
    RETURNING listing_id
  `).bind(JSON.stringify(rows)).all();
}

export function recentAuctionUrl(env = {}) {
  const base = String(env.TORN_API_BASE_URL || "https://api.torn.com/v2").replace(/\/$/, "");
  const url = new URL(`${base}/market/auctionhouse`);
  url.searchParams.set("limit", "100");
  url.searchParams.set("sort", "DESC");
  url.searchParams.set("comment", "cafauction");
  return url.toString();
}

export function incrementalAuctionUrl(env = {}, newestTimestamp = 0) {
  const base = String(env.TORN_API_BASE_URL || "https://api.torn.com/v2").replace(/\/$/, "");
  const url = new URL(`${base}/market/auctionhouse`);
  url.searchParams.set("limit", "100");
  url.searchParams.set("sort", "ASC");
  if (Number(newestTimestamp) > 0) {
    url.searchParams.set("from", String(Math.max(0, Math.floor(Number(newestTimestamp)) - 1)));
  }
  url.searchParams.set("comment", "cafauction");
  return url.toString();
}

export function historicalAuctionUrl(env = {}, upperTimestamp) {
  const boundary = Math.max(1, Math.floor(Number(upperTimestamp) || 0));
  const base = String(env.TORN_API_BASE_URL || "https://api.torn.com/v2").replace(/\/$/, "");
  const url = new URL(`${base}/market/auctionhouse`);
  url.searchParams.set("limit", "100");
  url.searchParams.set("sort", "DESC");
  url.searchParams.set("to", String(boundary));
  url.searchParams.set("comment", "cafauction");
  return url.toString();
}

export function nextBackfillTimestamp(currentUpperTimestamp, pageMinimumTimestamp) {
  const current = Math.floor(Number(currentUpperTimestamp) || 0);
  const minimum = Math.floor(Number(pageMinimumTimestamp) || 0);
  if (minimum <= 0) throw new Error("Torn auction page did not provide a usable oldest timestamp.");
  const next = Math.max(0, minimum - 1);
  if (current > 0 && next >= current) {
    throw new Error("Torn auction backfill did not move to an older timestamp.");
  }
  return next;
}

export function safeTornApiUrl(candidate, env = {}) {
  const url = new URL(candidate, String(env.TORN_API_BASE_URL || "https://api.torn.com/v2"));
  if (url.protocol !== "https:" || url.hostname !== "api.torn.com" || !/^\/v2\/market\/auctionhouse\/?$/.test(url.pathname)) {
    throw new Error("Torn API supplied an unexpected pagination URL.");
  }
  url.searchParams.delete("key");
  return url.toString();
}

async function acquireSyncLock(db) {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.prepare(`
    INSERT INTO sync_state (key, value, updated_at)
    VALUES ('sync_lock_until', ?1, ?2)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE CAST(sync_state.value AS INTEGER) < ?2
  `).bind(String(now + 15 * 60), now).run();
  return Number(result.meta?.changes || 0) > 0;
}

async function releaseSyncLock(db) {
  await setSyncStates(db, { sync_lock_until: 0 });
}

async function getSyncState(db, key) {
  const row = await db.prepare("SELECT value FROM sync_state WHERE key = ?1").bind(key).first();
  return row?.value ?? null;
}

async function setSyncStates(db, values) {
  const statements = Object.entries(values).map(([key, value]) => db.prepare(`
    INSERT INTO sync_state (key, value, updated_at)
    VALUES (?1, ?2, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, String(value ?? "")));
  if (statements.length) await db.batch(statements);
}

async function isDashboardAuthorized(request, env, ctx) {
  if (String(env.REQUIRE_ACCESS || "").toLowerCase() !== "true") return true;
  if (await hasValidAccessIdentity(request, env, ctx)) return true;
  const token = bearerToken(request);
  return Boolean(token && env.ADMIN_TOKEN && constantTimeEqual(token, String(env.ADMIN_TOKEN)));
}

export async function hasValidAccessIdentity(request, env, ctx) {
  const expectedEmail = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
  const expectedAudience = String(env.CF_ACCESS_AUD || "").trim();
  if (!expectedEmail) return false;

  // Worker-level Access supplies an unforgeable runtime binding. Prefer it to
  // request headers; a caller cannot manufacture ctx.access from the Internet.
  if (ctx?.access && typeof ctx.access.getIdentity === "function") {
    try {
      if (!expectedAudience || String(ctx.access.aud || "") === expectedAudience) {
        const identity = await ctx.access.getIdentity();
        if (String(identity?.email || "").trim().toLowerCase() === expectedEmail) return true;
      }
    } catch {
      // Some Access paths expose only the signed assertion. Verify that below.
    }
  }

  // Retain signed-JWT verification for hostname-based Access deployments that
  // do not expose the native Worker binding.
  const assertion = String(request.headers.get("Cf-Access-Jwt-Assertion") || "").trim();
  const teamDomain = normalizeAccessTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  if (!assertion || !teamDomain || !expectedAudience) return false;

  try {
    const parts = assertion.split(".");
    if (parts.length !== 3) return false;
    const header = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1])));
    if (header.alg !== "RS256" || !header.kid) return false;

    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= now) return false;
    if (payload.nbf !== undefined && Number(payload.nbf) > now + 30) return false;
    const audiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud || "")];
    if (!audiences.includes(expectedAudience)) return false;
    if (String(payload.iss || "").replace(/\/$/, "") !== teamDomain.replace(/\/$/, "")) return false;
    if (String(payload.email || "").trim().toLowerCase() !== expectedEmail) return false;

    const jwks = await getAccessJwks(teamDomain);
    const jwk = jwks.find(key => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) return false;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64UrlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return false;
  }
}

function normalizeAccessTeamDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(/^https:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") return "";
    return url.origin;
  } catch {
    return "";
  }
}

async function getAccessJwks(teamDomain) {
  const now = Date.now();
  if (accessJwksCache?.teamDomain === teamDomain && accessJwksCache.expiresAt > now) {
    return accessJwksCache.keys;
  }
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error("Unable to load Cloudflare Access signing keys.");
  const payload = await response.json();
  const keys = Array.isArray(payload?.keys) ? payload.keys : [];
  if (!keys.length) throw new Error("Cloudflare Access returned no signing keys.");
  accessJwksCache = { teamDomain, keys, expiresAt: now + ACCESS_JWKS_TTL_MS };
  return keys;
}

function base64UrlBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function snapshotPreflight(request) {
  return new Response(null, { status: 204, headers: snapshotCorsHeaders(request) });
}

function snapshotCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = /^https:\/\/(?:www\.)?torn\.com$/i.test(origin) ? origin : "https://www.torn.com";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function methodNotAllowed(allow) {
  return json({ error: "Method not allowed." }, 405, { allow });
}

async function readJson(request, maxBytes = 64_000) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("Request body is too large.");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("Request body is too large.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function bearerToken(request) {
  const header = String(request.headers.get("Authorization") || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return mismatch === 0;
}

function randomToken(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizeBonuses(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 2).map(bonus => ({
    id: optionalInteger(bonus?.id ?? bonus?.bonus_id),
    title: cleanText(bonus?.title || bonus?.name, 60),
    value: optionalNumber(bonus?.value ?? bonus?.percentage)
  })).filter(bonus => bonus.id !== null || bonus.title);
}

export function bonusSignature(bonuses) {
  return (bonuses || [])
    .map(bonus => ({ id: optionalInteger(bonus?.id), title: cleanText(bonus?.title, 60).toLowerCase() }))
    .filter(bonus => bonus.id !== null || bonus.title)
    .sort((left, right) => (left.id ?? 9999) - (right.id ?? 9999) || left.title.localeCompare(right.title))
    .map(bonus => bonus.id !== null ? String(bonus.id) : bonus.title)
    .join("+");
}

export function percentile(values, fraction) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarizePrices(prices) {
  if (!prices.length) return { count: 0, min: null, p10: null, p25: null, median: null, p75: null, p90: null, max: null, average: null };
  return {
    count: prices.length,
    min: Math.min(...prices),
    p10: Math.round(percentile(prices, 0.10)),
    p25: Math.round(percentile(prices, 0.25)),
    median: Math.round(percentile(prices, 0.50)),
    p75: Math.round(percentile(prices, 0.75)),
    p90: Math.round(percentile(prices, 0.90)),
    max: Math.max(...prices),
    average: Math.round(prices.reduce((sum, value) => sum + value, 0) / prices.length)
  };
}

function formatSale(row) {
  const bonuses = [];
  if (row.bonus1_id || row.bonus1_title) bonuses.push({ id: row.bonus1_id, title: row.bonus1_title, value: row.bonus1_value });
  if (row.bonus2_id || row.bonus2_title) bonuses.push({ id: row.bonus2_id, title: row.bonus2_title, value: row.bonus2_value });
  return {
    listingId: Number(row.listing_id),
    endedAt: Number(row.ended_at),
    itemUid: row.item_uid === null ? null : Number(row.item_uid),
    rarity: row.rarity,
    damage: row.damage,
    accuracy: row.accuracy,
    armor: row.armor,
    quality: row.quality,
    price: Number(row.price),
    bids: Number(row.bids || 0),
    bonuses
  };
}

function cleanText(value, limit = 100) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function optionalInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeEpoch(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.floor(Date.now() / 1000);
  return Math.floor(number > 10_000_000_000 ? number / 1000 : number);
}

function normalizeOptionalEpoch(value) {
  if (value === null || value === undefined || value === "") return null;
  return normalizeEpoch(value);
}

function safeTornUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value), "https://www.torn.com/");
    if (url.protocol !== "https:" || !/(^|\.)torn\.com$/i.test(url.hostname)) return "";
    url.username = "";
    url.password = "";
    return url.toString().slice(0, 1000);
  } catch {
    return "";
  }
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, match => `\\${match}`);
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseStateValue(value) {
  if (/^-?\d+(?:\.\d+)?$/.test(String(value))) return Number(value);
  return value;
}

function addUtcDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}
