import type { CostMethod, CostState, TradeLike } from "../calc";

/**
 * 交易流水前端 API 客户端 —— 自包含，不依赖 src/web/lib/api.ts，
 * 保证本功能文件夹可以整体独立同步，与主程序升级互不牵连。
 */

interface Envelope<T> {
	ok: boolean;
	data?: T;
	error?: { code: string; message: string };
}

export class TradesApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		credentials: "same-origin",
		headers: init?.body ? { "Content-Type": "application/json" } : undefined,
		...init,
	});
	let payload: Envelope<T> | null = null;
	try {
		payload = (await response.json()) as Envelope<T>;
	} catch {
		payload = null;
	}
	if (!response.ok || !payload?.ok) {
		throw new TradesApiError(
			response.status,
			payload?.error?.code ?? "request_failed",
			payload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
		);
	}
	return payload.data as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** 持仓交易视图：持仓信息 + 流水 + 口径计算结果 */
export interface TradesView {
	holdingId: string;
	tradeMode: boolean;
	/** 所属账户的成本口径：fifo / weighted / diluted */
	costMethod: CostMethod;
	holding: {
		id: string;
		name: string;
		symbol: string | null;
		market: string | null;
		currency: string;
		qty: number;
		avgCost: number | null;
		realizedPnl: number;
		price: number;
	};
	trades: TradeLike[];
	state: CostState;
}

export interface TradeInput {
	side: "buy" | "sell";
	qty: number;
	price: number;
	fee?: number;
	tradedAt: string;
	note?: string | null;
}

export const tradesApi = {
	get: (holdingId: string) => request<TradesView>(`/api/holdings/${holdingId}/trades`),
	create: (holdingId: string, input: TradeInput) =>
		request<TradesView>(`/api/holdings/${holdingId}/trades`, json(input)),
	update: (holdingId: string, tradeId: string, input: Partial<TradeInput>) =>
		request<TradesView>(`/api/holdings/${holdingId}/trades/${tradeId}`, {
			method: "PATCH",
			body: JSON.stringify(input),
		}),
	remove: (holdingId: string, tradeId: string) =>
		request<TradesView>(`/api/holdings/${holdingId}/trades/${tradeId}`, { method: "DELETE" }),
	enable: (holdingId: string) => request<TradesView>(`/api/holdings/${holdingId}/trades/enable`, json({})),
	disable: (holdingId: string) => request<TradesView>(`/api/holdings/${holdingId}/trades/disable`, json({})),
};
