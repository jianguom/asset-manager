import type { HoldingRow } from "../worker/types";
import { newId, nowIso } from "../worker/core/utils";
import { computeFifo, checkTradeValid, type TradeLike } from "./calc";

/**
 * 交易流水仓储层 —— 包含 D1 读写、开仓基准、以及"交易 → holdings 同步写回"。
 */

/** holdings.trade_mode 值 */
export const TRADE_MODE_OFF = 0;
export const TRADE_MODE_ON = 1;

export interface TradeRow extends TradeLike {
	id: string;
	holding_id: string;
	created_at: string;
	updated_at: string;
}

/** D1 行 → 计算层形状（附带持有 id 等冗余字段供路由透传） */
export function toTradeLike(row: {
	id: string;
	side: string;
	qty: number;
	price: number;
	fee?: number | null;
	seed?: number | null;
	traded_at: string;
}): TradeLike {
	return {
		id: row.id,
		side: row.side === "sell" ? "sell" : "buy",
		qty: row.qty,
		price: row.price,
		fee: row.fee ?? 0,
		traded_at: row.traded_at,
		seed: (row.seed ?? 0) === 1,
	};
}

export async function listTrades(db: D1Database, holdingId: string): Promise<TradeLike[]> {
	const { results } = await db
		.prepare(
			`SELECT id, side, qty, price, fee, seed, traded_at FROM trades
			 WHERE holding_id = ? ORDER BY traded_at ASC, id ASC`,
		)
		.bind(holdingId)
		.all<{
			id: string;
			side: string;
			qty: number;
			price: number;
			fee: number | null;
			seed: number | null;
			traded_at: string;
		}>();
	return (results ?? []).map(toTradeLike);
}

export async function getTrade(db: D1Database, id: string): Promise<TradeRow | null> {
	return db.prepare(`SELECT * FROM trades WHERE id = ?`).bind(id).first<TradeRow>();
}

export interface TradeInput {
	holding_id: string;
	side: "buy" | "sell";
	qty: number;
	price: number;
	fee?: number;
	traded_at: string;
	note?: string | null;
}

/** 校验并写入一笔新交易；成功后同步回写持仓。返回新交易 + 变更后的持仓。 */
export async function createTrade(
	db: D1Database,
	holdingId: string,
	input: Omit<TradeInput, "holding_id">,
): Promise<{ trade: TradeRow; holding: HoldingRow }> {
	const holding = await db
		.prepare(`SELECT * FROM holdings WHERE id = ?`)
		.bind(holdingId)
		.first<HoldingRow>();
	if (!holding) throw new Error("HOLDING_NOT_FOUND");

	const id = newId();
	const candidate: TradeLike = {
		id,
		side: input.side,
		qty: input.qty,
		price: input.price,
		fee: input.fee ?? 0,
		traded_at: input.traded_at,
	};

	const existing = await listTrades(db, holdingId);
	// 新增交易时若卖超即拒绝
	const invalid = checkTradeValid(existing, id, candidate);
	if (invalid) throw new Error(`INVALID_TRADE:${invalid}`);

	const now = nowIso();
	await db
		.prepare(
			`INSERT INTO trades (id, holding_id, side, qty, price, fee, seed, traded_at, note, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
		)
		.bind(id, holdingId, input.side, input.qty, input.price, input.fee ?? 0, input.traded_at, input.note ?? null, now, now)
		.run();

	const trade = (await getTrade(db, id))!;
	const synced = await recomputeHolding(db, holdingId);
	return { trade, holding: synced };
}

/** 校验并更新一笔交易；成功后同步回写持仓。 */
export async function updateTrade(
	db: D1Database,
	holdingId: string,
	tradeId: string,
	patch: Partial<Pick<TradeInput, "side" | "qty" | "price" | "fee" | "traded_at" | "note">>,
): Promise<HoldingRow> {
	const current = await getTrade(db, tradeId);
	if (!current) throw new Error("TRADE_NOT_FOUND");

	const next: TradeLike = {
		id: tradeId,
		side: patch.side ?? current.side,
		qty: patch.qty ?? current.qty,
		price: patch.price ?? current.price,
		fee: patch.fee ?? current.fee ?? 0,
		traded_at: patch.traded_at ?? current.traded_at,
	};

	const existing = await listTrades(db, holdingId);
	const invalid = checkTradeValid(existing, tradeId, next);
	if (invalid) throw new Error(`INVALID_TRADE:${invalid}`);

	const now = nowIso();
	await db
		.prepare(
			`UPDATE trades SET side = ?, qty = ?, price = ?, fee = ?, traded_at = ?, note = ?, updated_at = ?
			 WHERE id = ?`,
		)
		.bind(next.side, next.qty, next.price, next.fee, next.traded_at, patch.note === undefined ? current.note : patch.note, now, tradeId)
		.run();

	return recomputeHolding(db, holdingId);
}

/** 删除一笔交易；成功后同步回写持仓。 */
export async function deleteTrade(db: D1Database, holdingId: string, tradeId: string): Promise<HoldingRow> {
	const current = await getTrade(db, tradeId);
	if (!current) throw new Error("TRADE_NOT_FOUND");

	const existing = await listTrades(db, holdingId);
	const invalid = checkTradeValid(existing, tradeId, null);
	if (invalid) throw new Error(`INVALID_TRADE:${invalid}`);

	await db.prepare(`DELETE FROM trades WHERE id = ?`).bind(tradeId).run();
	return recomputeHolding(db, holdingId);
}

/**
 * 用持仓的全部交易重算 FIFO，并把 qty / avg_cost / realized_pnl 写回 holdings。
 * 无交易时：qty 归 0、avg_cost 置空、realized_pnl 归 0。
 */
export async function recomputeHolding(db: D1Database, holdingId: string): Promise<HoldingRow> {
	const trades = await listTrades(db, holdingId);
	const state = computeFifo(trades);

	const qty = state.qty;
	const avgCost = state.avgCost === null ? null : roundMoney(state.avgCost);
	const realized = roundMoney(state.realizedPnl);
	const now = nowIso();
	await db
		.prepare(
			`UPDATE holdings SET qty = ?, avg_cost = ?, realized_pnl = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(qty, avgCost, realized, now, holdingId)
		.run();

	const row = await db.prepare(`SELECT * FROM holdings WHERE id = ?`).bind(holdingId).first<HoldingRow>();
	if (!row) throw new Error("HOLDING_NOT_FOUND");
	return row;
}

/**
 * 开启某持仓的「交易驱动」模式。
 *   1. 若该持仓已有存量（qty>0）且当前还没有任何交易，自动补一笔「开仓基准」买入，
 *      成本单价取既有 avg_cost（无则用现价），保证切换到流水后成本不跳变、可平滑接续。
 *   2. 置 trade_mode=1 并按现有交易重算一次 holdings。
 * 开启操作幂等：已开启时直接返回。
 */
export async function enableTradeMode(db: D1Database, holdingId: string): Promise<HoldingRow> {
	const holding = await db.prepare(`SELECT * FROM holdings WHERE id = ?`).bind(holdingId).first<HoldingRow>();
	if (!holding) throw new Error("HOLDING_NOT_FOUND");
	if (holding.trade_mode === TRADE_MODE_ON) return recomputeHolding(db, holdingId);

	const existing = await listTrades(db, holdingId);
	if (existing.length === 0 && holding.qty > 0) {
		const price = holding.avg_cost ?? holding.price;
		const seedId = `seed:${holdingId}`;
		const now = nowIso();
		await db
			.prepare(
				`INSERT INTO trades (id, holding_id, side, qty, price, fee, seed, traded_at, note, created_at, updated_at)
				 VALUES (?, ?, 'buy', ?, ?, 0, 1, ?, '开仓基准（切换自原持仓）', ?, ?)`,
			)
			.bind(seedId, holdingId, holding.qty, price, (holding.created_at ?? now).slice(0, 10), now, now)
			.run();
	}

	await db
		.prepare(`UPDATE holdings SET trade_mode = ?, updated_at = ? WHERE id = ?`)
		.bind(TRADE_MODE_ON, nowIso(), holdingId)
		.run();
	await recomputeHolding(db, holdingId);
	const row = await db.prepare(`SELECT * FROM holdings WHERE id = ?`).bind(holdingId).first<HoldingRow>();
	if (!row) throw new Error("HOLDING_NOT_FOUND");
	return row;
}

/** 关闭「交易驱动」：置回手动，保留已算出的 qty/avg_cost（不再随流水变化），不清空交易记录。 */
export async function disableTradeMode(db: D1Database, holdingId: string): Promise<HoldingRow> {
	const holding = await db.prepare(`SELECT * FROM holdings WHERE id = ?`).bind(holdingId).first<HoldingRow>();
	if (!holding) throw new Error("HOLDING_NOT_FOUND");
	// 关闭时以当前已算出的持仓量为基准：先重算一次冻结，再置 AUTO 关闭
	const frozen = await recomputeHolding(db, holdingId);
	await db.prepare(`UPDATE holdings SET trade_mode = ? , updated_at = ? WHERE id = ?`).bind(TRADE_MODE_OFF, nowIso(), holdingId).run();
	return { ...frozen, trade_mode: TRADE_MODE_OFF };
}

export function roundMoney(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}