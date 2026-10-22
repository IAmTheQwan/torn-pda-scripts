import test from "node:test";
import assert from "node:assert/strict";
import {
  bonusSignature,
  incrementalAuctionUrl,
  normalizeAuction,
  normalizeSnapshotPayload,
  percentile,
  recentAuctionUrl,
  safeTornApiUrl
} from "../src/worker.js";

test("normalizeAuction keeps pricing fields and two normalized bonuses", () => {
  const result = normalizeAuction({
    id: 420000,
    timestamp: 1752799751,
    price: 110000000,
    bids: 6,
    seller: { id: 1, name: "not retained" },
    buyer: { id: 2, name: "not retained" },
    item: {
      id: 668,
      uid: 14289270801,
      name: "Assault Boots",
      type: "Armor",
      sub_type: null,
      rarity: "yellow",
      stats: { damage: null, accuracy: null, armor: 46.26, quality: 5.2 },
      bonuses: [
        { id: 17, title: "Impenetrable", value: 20 },
        { id: 5, title: "Sentinel", value: 12 }
      ]
    }
  });

  assert.equal(result.listing_id, 420000);
  assert.equal(result.item_uid, 14289270801);
  assert.equal(result.armor, 46.26);
  assert.equal(result.price, 110000000);
  assert.equal(result.bonus_signature, "5+17");
  assert.equal(result.bonus1_title, "Impenetrable");
  assert.ok(!("seller" in result));
  assert.ok(!("buyer" in result));
});

test("normalizeAuction skips stackable items that are not equipment", () => {
  assert.equal(normalizeAuction({
    id: 8,
    timestamp: 1_790_000_000,
    price: 50_000,
    bids: 1,
    item: { id: 1, uid: 2, name: "Stackable", type: "Other" }
  }), null);
});

test("percentile interpolates and handles empty input", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
  assert.equal(percentile([40, 10, 30, 20], 0.25), 17.5);
});

test("bonusSignature is stable across bonus order", () => {
  const one = bonusSignature([{ id: 9, title: "B" }, { id: 2, title: "A" }]);
  const two = bonusSignature([{ id: 2, title: "A" }, { id: 9, title: "B" }]);
  assert.equal(one, "2+9");
  assert.equal(one, two);
});

test("safeTornApiUrl accepts only the official auction endpoint", () => {
  assert.match(safeTornApiUrl("https://api.torn.com/v2/market/auctionhouse?limit=100"), /^https:\/\/api\.torn\.com/);
  assert.throws(() => safeTornApiUrl("https://example.com/v2/market/auctionhouse"), /unexpected pagination URL/);
  assert.throws(() => safeTornApiUrl("https://api.torn.com/v2/user/basic"), /unexpected pagination URL/);
  assert.throws(() => safeTornApiUrl("https://api.torn.com/v2/market/auctionhouse/extra"), /unexpected pagination URL/);
});

test("recentAuctionUrl starts at the newest page without an epoch-zero lower bound", () => {
  const url = new URL(recentAuctionUrl());
  assert.equal(url.pathname, "/v2/market/auctionhouse");
  assert.equal(url.searchParams.get("sort"), "DESC");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.has("from"), false);
});

test("incrementalAuctionUrl rewinds one second to retain timestamp-boundary auctions", () => {
  const url = new URL(incrementalAuctionUrl({}, 1_790_000_000));
  assert.equal(url.searchParams.get("sort"), "ASC");
  assert.equal(url.searchParams.get("from"), "1789999999");
});

test("normalizeSnapshotPayload strips non-Torn URLs and deduplicates listing keys", () => {
  const payload = normalizeSnapshotPayload({
    batchId: "f3fba8f5-7151-45c9-8d55-48824f7b46d8",
    capturedAt: 1760000000000,
    sourceUrl: "https://www.torn.com/amarket.php?sid=auctionHouse",
    sourcePage: 3,
    items: [
      {
        listingId: "abc",
        name: "Blunderbuss",
        itemId: 600,
        bid: 80000000,
        bonuses: [{ id: 10, title: "Warlord", value: 17 }],
        sourceUrl: "https://www.torn.com/amarket.php?sid=auctionHouse"
      },
      { listingId: "abc", name: "Duplicate", bid: 1 },
      { listingId: "bad", name: "USP", sourceUrl: "https://example.com/steal" }
    ]
  }, "device-1");

  assert.equal(payload.batch.captured_at, 1760000000);
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[0].bonus_signature, "10");
  assert.equal(payload.items[1].source_url, "");
});
