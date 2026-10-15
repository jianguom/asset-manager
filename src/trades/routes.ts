import { Hono } from "hono";
import type { AppEnv } from "../worker/types";
import { badRequest, notFound, ok } from "../worker/core/errors";
import { tOf } from "../worker/core/i18n";
import { writeAudit } from "../worker/core/audit";
import {
	asRecord,
	optionalNumber,
	optionalString,
	requireId,
	requireNumber,
	requireOneOf,
	requireString,
} from "../worker/api/validate";
import { getAccount, getHolding } from "../worker/data/accounts.repo";
import {
	createTrade,
	deleteTrade,
	disableTradeMode,
	enableTradeMode,
	listTrades,
	updateTrade,
} from "./repo";
import { computeState, type CostMethod } from "./calc";

/**
 * 持仓交易流水路由（独立功能，挂在 /api/holdings/:id/trades）
 *
 * 所有变更操作都会：校验 FIFO 约束 → 落库 → 重算并写回 holdings.qty/avg_cost/realized_pnl。
 * 只对开启 trade_mode 的持仓生效；未开启时允许读流水、允许写（供先录入后开启）。
 */
const trades = new Hono<AppEnv>();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 解析请求体 → 交易字段（side/qty/price/fee/tradedAt/note） */
function parseTradePayload(
	payload: Record<string, unknown>,
	{t, partial}: { t: Parameters<typeof asRecord>[1]; partial: boolean },
) {
	const out: Record<string, unknown> = {};
	if (payload.side !== undefined) out.side = requireOneOf(payload, "side", ["buy", "sell"] as const, "field.side", t);
	if (payload.qty !== undefined) out.qty = requireNumber(payload, "qty", { labelKey: "field.qty", min: 0, max: 1e15 }, t);
	if (payload.price !== undefined) out.price = requireNumber(payload, "price", { labelKey: "field.price", min: 0, max: 1e15 }, t);
	if (payload.fee !== undefined) out.fee = optionalNumber(payload, "fee", { labelKey: "field.fee", min: 0, max: 1e15 }, t) ?? 0;
	if (payload.tradedAt !== undefined) {
		const value = requireString(payload, "tradedAt", { labelKey: "field.date", max: 10 }, t);
		if (!DATE_RE.test(value)) throw badRequest("交易日期格式应为 YYYY-MM-DD", "invalid_field");
		out.tradedAt = value;
	}
	if (payload.note !== undefined) out.note = optionalString(payload, "note", { labelKey: "field.note", max: 200 }, t);
	if (!partial) {
		// 新增必须给全量字段
		if (out.side === undefined) throw badRequest("缺少 side", "invalid_field");
		if (out.qty === undefined) throw badRequest("缺少 qty", "invalid_field");
		if (out.price === undefined) throw badRequest("缺少 price", "invalid_field");
	}
	return out;
}

/** 统一返回 GET 视图：交易列表 + 口径计算结果 + 持仓 + 口径 */
async function tradesView(db: D1Database, holdingId: string) {
	const holding = await getHolding(db, holdingId);
	if (!holding) throw notFound("持仓不存在");
	const account = await getAccount(db, holding.account_id);
	const method: CostMethod = account?.cost_method ?? "fifo";
	const tradeLikes = await listTrades(db, holdingId);
	return {
		holdingId,
		tradeMode: (holding.trade_mode ?? 0) === 1,
		costMethod: method,
		holding: {
			id: holding.id,
			name: holding.name,
			symbol: holding.symbol,
			market: holding.market,
			currency: holding.currency,
			qty: holding.qty,
			avgCost: holding.avg_cost,
			realizedPnl: holding.realized_pnl ?? 0,
			price: holding.price,
		},
		trades: tradeLikes,
		state: computeState(tradeLikes, method),
	};
}

trades.get("/", async (c) => {
	const t = tOf(c);
	const holdingId = requireId(c.req.param("id"), t);
	return ok(c, await tradesView(c.env.DB, holdingId));
});

trades.post("/", async (c) => {
	const t = tOf(c);
	const holdingId = requireId(c.req.param("id"), t);
	if (!(await getHolding(c.env.DB, holdingId))) throw notFound("持仓不存在");
	const payload = asRecord(await c.req.json(), t);
	const input = parseTradePayload(payload, { t, partial: false });
	const { trade, holding } = await createTrade(c.env.DB, holdingId, {
		side: input.side as "buy" | "sell",
		qty: input.qty as number,
		price: input.price as number,
		fee: input.fee as number | undefined,
		traded_at: input.tradedAt as string,
		note: (input.note as string | null | undefined) ?? null,
	});
	await writeAudit(c.env.DB, { entity: "holding", entityId: holdingId, action: "update", after: { trade: trade.id, holding }, note: "新增交易流水" });
	return ok(c, await tradesView(c.env.DB, holdingId), 201);
});

trades.patch("/:tid", async (c) => {
	const t = tOf(c);
	const holdingId = requireId(c.req.param("id"), t);
	const tradeId = requireId(c.req.param("tid"), t);
	if (!(await getHolding(c.env.DB, holdingId))) throw notFound("持仓不存在");
	const payload = asRecord(await c.req.json(), t);
	const input = parseTradePayload(payload, { t, partial: true });
	await updateTrade(c.env.DB, holdingId, tradeId, {
		side: input.side as "buy" | "sell" | undefined,
		qty: input.qty as number | undefined,
		price: input.price as number | undefined,
		fee: input.fee as number | undefined,
		traded_at: input.tradedAt as string | undefined,
		note: input.note === undefined ? undefined : (input.note as string | null),
	});
	await writeAudit(c.env.DB, { entity: "holding", entityId: holdingId, action: "update", note: `修改交易 ${tradeId}` });
	return ok(c, await tradesView(c.env.DB, holdingId));
});

trades.delete("/:tid", async (c) => {
	const t = tOf(c);
	const holdingId = requireId(c.req.param("id"), t);
	const tradeId = requireId(c.req.param("tid"), t);
	if (!(await getHolding(c.env.DB, holdingId))) throw notFound("持仓不存在");
	await deleteTrade(c.env.DB, holdingId, tradeId);
	await writeAudit(c.env.DB, { entity: "holding", entityId: holdingId, action: "update", note: `删除交易 ${tradeId}` });
	return ok(c, await tradesView(c.env.DB, holdingId));
});

/** 开启交易驱动：若持仓有存量且无流水，自动补一笔开仓基准买入 */
trades.post("/enable", async (c) => {
	const t = tOf(c);
	const holdingId = requireId(c.req.param("id"), t);
	const holding = await enableTradeMode(c.env.DB, holdingId);
	await writeAudit(c.env.DB, { entity: "holding", entityId: holdingId, action: "update", after: { qty: holding.qty, avgCost: holding.avg_cost }, note: "开启交易流水驱动" });
	return ok(c, await tradesView(c.env.DB, holdingId));
});

/** 关闭交易驱动：冻结当前数量/成本为手动，保留全部交易记录 */
trades.post("/disable", async (c) => {
	const t = tOf(c);
	const holdingId = requireId(c.req.param("id"), t);
	await disableTradeMode(c.env.DB, holdingId);
	await writeAudit(c.env.DB, { entity: "holding", entityId: holdingId, action: "update", note: "关闭交易流水驱动" });
	return ok(c, await tradesView(c.env.DB, holdingId));
});

export default trades;
