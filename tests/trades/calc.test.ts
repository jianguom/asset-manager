import { describe, expect, it } from "vitest";
import { computeFifo, checkTradeValid, type TradeLike } from "../../src/trades/calc";

/** 便捷构造交易 */
function trade(partial: Partial<TradeLike>): TradeLike {
	return { id: "t", side: "buy", qty: 0, price: 0, fee: 0, traded_at: "2026-01-01", ...partial };
}

describe("FIFO 逐笔法核心核算", () => {
	it("单笔买入：平均成本 = 含手续费的单价", () => {
		const state = computeFifo([trade({ id: "a", side: "buy", qty: 100, price: 10, fee: 5 })]);
		expect(state.qty).toBe(100);
		expect(state.avgCost).toBeCloseTo(10.05, 6); // (100*10+5)/100
		expect(state.realizedPnl).toBe(0);
		expect(state.lots).toHaveLength(1);
	});

	it("多次加仓：按量加权的平均成本", () => {
		const state = computeFifo([
			trade({ id: "a", side: "buy", qty: 100, price: 10 }),
			trade({ id: "b", side: "buy", qty: 100, price: 20 }),
		]);
		expect(state.qty).toBe(200);
		expect(state.avgCost).toBeCloseTo(15, 6); // (1000+2000)/200
		expect(state.lots).toHaveLength(2);
	});

	it("部分卖出：先消耗最早批，剩余成本由后批构成", () => {
		// 先买 100@10，再买 100@20，再卖 50
		// FIFO 消耗最早 100@10 中的 50 → 剩余 50@10 + 100@20 = 150 股
		const state = computeFifo([
			trade({ id: "a", side: "buy", qty: 100, price: 10 }),
			trade({ id: "b", side: "buy", qty: 100, price: 20 }),
			trade({ id: "s", side: "sell", qty: 50, price: 30 }),
		]);
		expect(state.qty).toBe(150);
		expect(state.avgCost).toBeCloseTo((50 * 10 + 100 * 20) / 150, 6); // 16.666…
		// 已实现盈亏：卖出 50 收入 1500 − 成本 50*10=500 → 1000
		expect(state.realizedPnl).toBeCloseTo(1000, 6);
	});

	it("全卖完：剩余批次清空，已实现盈亏完整结算", () => {
		const state = computeFifo([
			trade({ id: "a", side: "buy", qty: 100, price: 10 }),
			trade({ id: "b", side: "buy", qty: 100, price: 20 }),
			trade({ id: "s", side: "sell", qty: 200, price: 15 }),
		]);
		expect(state.qty).toBe(0);
		expect(state.avgCost).toBeNull();
		expect(state.lots).toHaveLength(0);
		// 收入 200*15=3000 − 成本 1000+2000=3000 → 0
		expect(state.realizedPnl).toBeCloseTo(0, 6);
	});

	it("卖出手续费从收入中扣除（降低已实现盈亏）", () => {
		const state = computeFifo([
			trade({ id: "a", side: "buy", qty: 100, price: 10 }),
			trade({ id: "s", side: "sell", qty: 100, price: 12, fee: 50 }),
		]);
		// 收入 1200−50=1150 − 成本 1000 → 150
		expect(state.realizedPnl).toBeCloseTo(150, 6);
	});

	it("买入手续费摊入批次成本，部分卖出按比例分摊", () => {
		// 买 100@10 手续费 10 → 批成本 1010；卖 50 → 成本被取走 505
		const state = computeFifo([
			trade({ id: "a", side: "buy", qty: 100, price: 10, fee: 10 }),
			trade({ id: "s", side: "sell", qty: 50, price: 12 }),
		]);
		expect(state.realizedPnl).toBeCloseTo(50 * 12 - 505, 6); // 95
		expect(state.qty).toBe(50);
		expect(state.cost).toBeCloseTo(505, 6);
	});

	it("按 traded_at 排序，同一天按 id 二次排序（可复现）", () => {
		// 先卖(a)后买(b)日期相同，但同 id 排序后应为 b 在前？这里验证"b 先买"仍正确：按 traded_at 相同时用 id
		// 构造：卖 50 在买 100 之前出现，但因为日期相同、id 字典序 b < s，交易会被排成 b, s
		const state = computeFifo([
			trade({ id: "s", side: "sell", qty: 50, price: 30, traded_at: "2026-01-01" }),
			trade({ id: "b", side: "buy", qty: 100, price: 10, traded_at: "2026-01-01" }),
		]);
		// 若先按 b,s 处理 → 买100@10 再卖50 → 剩 50
		expect(state.qty).toBe(50);
		expect(state.oversoldQty).toBe(0);
		expect(state.realizedPnl).toBeGreaterThan(0);
	});

	it("卖出超过剩余持仓：记录 oversoldQty 但不崩溃", () => {
		const state = computeFifo([
			trade({ id: "a", side: "buy", qty: 100, price: 10 }),
			trade({ id: "s", side: "sell", qty: 150, price: 12 }),
		]);
		expect(state.qty).toBe(0);
		expect(state.oversoldQty).toBeCloseTo(50, 6);
	});
});

describe("checkTradeValid（写入前校验）", () => {
	const current: TradeLike[] = [
		trade({ id: "a", side: "buy", qty: 100, price: 10 }),
		trade({ id: "b", side: "buy", qty: 100, price: 20 }),
	];

	it("买入追加合法", () => {
		expect(checkTradeValid(current, "c", trade({ id: "c", side: "buy", qty: 50, price: 15 }))).toBeNull();
	});

	it("卖出不超过持仓合法", () => {
		expect(checkTradeValid(current, "c", trade({ id: "c", side: "sell", qty: 150, price: 20 }))).toBeNull();
	});

	it("卖出超过持仓被拒绝", () => {
		expect(checkTradeValid(current, "c", trade({ id: "c", side: "sell", qty: 250, price: 20 }))).not.toBeNull();
	});

	it("修改历史交易导致超额卖出被拒绝", () => {
		// 把 a 改成只买 50，则总持仓 150，卖 150 正好；再改成卖太多会触发
		const changed = trade({ id: "a", side: "buy", qty: 50, price: 10 });
		expect(checkTradeValid(current, "a", changed)).toBeNull();
		const tooBig = trade({ id: "a", side: "sell", qty: 300, price: 20 });
		expect(checkTradeValid(current, "a", tooBig)).not.toBeNull();
	});

	it("删除历史买入导致超额卖出被拒绝", () => {
		// a:100@10 + b:100@20 + 卖出 150：删掉 b 后只剩 100@10，卖出 150 会超额
		const existing = [
			trade({ id: "a", side: "buy", qty: 100, price: 10 }),
			trade({ id: "b", side: "buy", qty: 100, price: 20 }),
			trade({ id: "s", side: "sell", qty: 150, price: 12 }),
		];
		expect(checkTradeValid(existing, "b", null)).not.toBeNull();
	});

	it("删除不会导致超额的交易合法", () => {
		const existing = [
			trade({ id: "a", side: "buy", qty: 100, price: 10 }),
			trade({ id: "s", side: "sell", qty: 50, price: 12 }),
		];
		expect(checkTradeValid(existing, "s", null)).toBeNull();
	});

	it("数量为 0 或负数被拒绝", () => {
		expect(checkTradeValid(current, "c", trade({ id: "c", side: "buy", qty: 0, price: 10 }))).not.toBeNull();
		expect(checkTradeValid(current, "c", trade({ id: "c", side: "buy", qty: -5, price: 10 }))).not.toBeNull();
	});
});