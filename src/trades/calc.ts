/**
 * FIFO（先进先出）逐笔成本核算 —— 纯函数，无任何 I/O / 框架依赖，可独立单测。
 *
 * 为什么是 FIFO 而不是「移动加权平均」：
 *   移动平均在"高点加仓后减仓"时会把早期低价批也平均进去，剩余持仓成本失真、
 *   且无法核算每笔已实现盈亏。FIFO 把每次买入当作一个独立批次（lot），
 *   卖出时按时间序**先消耗最早买入的批**，逐批结出已实现盈亏 ——
 *   剩余成本、平均成本、已实现盈亏三者都可独立核算，这也是主流券商软件的口径。
 *
 * 与主程序的隔离约定：
 *   - 本模块只读"交易流水"，不直接读写数据库；
 *   - 所有数量 / 单价 / 手续费按**交易币种**计（汇率由主程序统一折算）；
 *   - 同一持仓的流水按 (traded_at, id) 稳定排序后逐笔处理。
 */

/** 计算模块能接受的最小交易形状（repo 层把 D1 行映射成它，测试直接构造它） */
export interface TradeLike {
	id: string;
	/** 买入 / 卖出 */
	side: "buy" | "sell";
	/** 成交数量 */
	qty: number;
	/** 成交单价（不含手续费） */
	price: number;
	/** 手续费：买入加进该批成本，卖出从收入中扣除 */
	fee: number;
	/** 交易日 YYYY-MM-DD */
	traded_at: string;
	/** 备注（不影响计算，仅透传展示） */
	note?: string | null;
	/** 是否为开启 trade_mode 时自动生成的开仓基准买入（不影响计算，只用于展示） */
	seed?: boolean;
}

/** 尚未被卖出的批次（剩余） */
export interface RemainingLot {
	/** 来源买入交易 id（seed 基准批为 "seed:<holdingId>"） */
	tradeId: string;
	/** 剩余数量 */
	qty: number;
	/** 剩余总成本（含该批买入时摊的手续费） */
	cost: number;
	/** 该批买入成交单价（展示用） */
	price: number;
	/** 是否开仓基准批 */
	seed: boolean;
}

/** 逐笔计算的结果：剩余批次 + 汇总 + 已实现盈亏 */
export interface FifoState {
	/** 剩余批次（FIFO 顺序 = 未卖出部分，按买入时间正序） */
	lots: RemainingLot[];
	/** 剩余总数量 */
	qty: number;
	/** 剩余总成本（含剩余批次的手续费） */
	cost: number;
	/** 加权平均成本 = 剩余成本 / 剩余数量（无持仓时为 null） */
	avgCost: number | null;
	/** 累计已实现盈亏（含卖出手续费） */
	realizedPnl: number;
	/** 全部卖出的收入合计（含手续费扣减），对账展示用 */
	soldProceeds: number;
	/** 累计卖出数量 */
	soldQty: number;
	/** 卖出数量超出剩余持仓的部分（正常流程为 0；>0 时路由层应拒绝该变更） */
	oversoldQty: number;
}

const EPS = 1e-9;

function nearZero(value: number): boolean {
	return Math.abs(value) < EPS;
}

/** 稳定排序：先交易日，再交易 id（保证同一日多笔的顺序可复现） */
function sortTrades(trades: TradeLike[]): TradeLike[] {
	return [...trades].sort(
		(a, b) => a.traded_at.localeCompare(b.traded_at) || a.id.localeCompare(b.id),
	);
}

/**
 * 用 FIFO 逐笔法核算一组交易流水。
 *
 * @param trades 同一持仓的全部交易（未排序也可以，内部会稳定排序）
 * @returns 剩余批次、平均成本、已实现盈亏等汇总
 */
export function computeFifo(trades: TradeLike[]): FifoState {
	const lots: RemainingLot[] = [];
	let realizedPnl = 0;
	let soldProceeds = 0;
	let soldQty = 0;
	let oversoldQty = 0;

	for (const trade of sortTrades(trades)) {
		if (trade.side === "buy") {
			// 买入：整笔作为一批（成本 = 数量×单价 + 手续费）
			const cost = trade.qty * trade.price + trade.fee;
			lots.push({
				tradeId: trade.id,
				qty: trade.qty,
				cost,
				price: trade.price,
				seed: Boolean(trade.seed),
			});
			continue;
		}

		// 卖出：从最早的批次开始消耗（FIFO）
		let remaining = trade.qty;
		// 净收入按"卖出的数量占比"分到各被消耗的批次上，手续费已在净收入里
		const netProceeds = trade.qty * trade.price - trade.fee;
		while (remaining > EPS && lots.length > 0) {
			const lot = lots[0];
			const consumed = Math.min(lot.qty, remaining);
			const consumedFullLot = nearZero(lot.qty - consumed);

			// 被消耗批次的成本：整批消耗直接取整批成本；部分消耗按数量比例分摊
			const allocatedCost = consumedFullLot ? lot.cost : lot.cost * (consumed / lot.qty);
			// 这笔卖出里，属于"当前消耗批次"的那部分净收入
			const allocatedProceeds = netProceeds * (consumed / trade.qty);

			realizedPnl += allocatedProceeds - allocatedCost;
			lot.qty -= consumed;
			lot.cost -= allocatedCost;
			if (nearZero(lot.qty)) lots.shift();

			remaining -= consumed;
			soldQty += consumed;
			soldProceeds += allocatedProceeds;
		}

		if (remaining > EPS) {
			// 卖出量超过剩余持仓：记录超额（路由层会拒绝，这里只是不崩溃）
			oversoldQty += remaining;
			soldQty += remaining;
			soldProceeds += netProceeds * (remaining / trade.qty);
		}
	}

	const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
	const cost = lots.reduce((sum, lot) => sum + lot.cost, 0);

	return {
		lots,
		qty,
		cost,
		avgCost: qty > EPS ? cost / qty : null,
		realizedPnl,
		soldProceeds,
		soldQty,
		oversoldQty,
	};
}

/**
 * 校验一条将要写入/删除的交易不会破坏 FIFO 约束。
 *
 * 场景：用户新增/修改/删除一笔交易时，可能造成"卖出量 > 剩余持仓"。
 * 做法：先从当前流水中去掉目标交易 targetId，再加入替换后的 next（若为 null 即删除），
 * 重算一遍 FIFO，一旦出现超额卖出即拒绝；新增交易时 targetId 不在 current 中，等价于直接追加。
 *
 * @param current 当前全部流水（含将被增改删的目标交易）
 * @param targetId 将被替换/删除的交易 id（新增时传入新生成的 id，不在 current 中即可）
 * @param next 替换后的同一条交易；null 表示删除该交易
 * @returns 通过返回 null；不通过返回中文原因
 */
export function checkTradeValid(
	current: TradeLike[],
	targetId: string,
	next: TradeLike | null,
): string | null {
	const rest = current.filter((trade) => trade.id !== targetId);
	const patched = next ? [...rest, next] : rest;
	if (next && next.qty <= EPS) {
		return "交易数量必须大于 0";
	}
	const state = computeFifo(patched);
	if (state.oversoldQty > EPS) {
		return "交易调整后卖出数量将超过剩余持仓，请先核对交易流水";
	}
	return null;
}
