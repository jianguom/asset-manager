import { useEffect, useState } from "react";
import { useRouter } from "../../web/lib/router";
import { useT } from "../../web/lib/i18n";
import { money, number, signedMoney } from "../../web/lib/format";
import { tradesApi, type TradeInput, type TradesView } from "./api";
import type { TradeLike } from "../calc";

/** 交易表单字段 */
interface TradeForm {
	side: "buy" | "sell";
	qty: string;
	price: string;
	fee: string;
	tradedAt: string;
	note: string;
}

const emptyForm = (): TradeForm => ({
	side: "buy",
	qty: "",
	price: "",
	fee: "0",
	tradedAt: new Date().toISOString().slice(0, 10),
	note: "",
});

/**
 * 持仓交易流水页（独立功能，路由 /trades/:holdingId）
 *
 * 功能：
 *   - 开启/关闭「交易驱动」：开启后本持仓的数量与平均成本由流水自动推导（有存量自动补开仓基准）
 *   - 录入/编辑/删除买入卖出交易，FIFO 逐笔法自动核算剩余成本与已实现盈亏
 *   - 切换回手动模式不会删除任何交易记录
 */
export function TradesPage() {
	const t = useT();
	const { path, navigate } = useRouter();
	const holdingId = path.split("/")[2] ?? "";

	const [view, setView] = useState<TradesView | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	/** 正在编辑的交易 id；null 表示新增 */
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<TradeForm>(emptyForm());

	const load = async () => {
		if (!holdingId) return;
		setLoading(true);
		setError(null);
		try {
			setView(await tradesApi.get(holdingId));
		} catch (err) {
			setError(err instanceof Error ? err.message : "加载失败");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [holdingId]);

	const startEdit = (trade: TradeLike) => {
		setEditingId(trade.id);
		setForm({
			side: trade.side,
			qty: String(trade.qty),
			price: String(trade.price),
			fee: String(trade.fee ?? 0),
			tradedAt: trade.traded_at,
			note: trade.note ?? "",
		});
	};

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!view) return;
		const qty = Number(form.qty);
		const price = Number(form.price);
		const fee = Number(form.fee || 0);
		if (!Number.isFinite(qty) || qty <= 0) {
			setError("数量必须大于 0");
			return;
		}
		if (!Number.isFinite(price) || price <= 0) {
			setError("单价必须大于 0");
			return;
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(form.tradedAt)) {
			setError("交易日期格式应为 YYYY-MM-DD");
			return;
		}
		const input: TradeInput = {
			side: form.side,
			qty,
			price,
			fee,
			tradedAt: form.tradedAt,
			note: form.note.trim() || null,
		};
		setSubmitting(true);
		setError(null);
		try {
			if (editingId) await tradesApi.update(holdingId, editingId, input);
			else await tradesApi.create(holdingId, input);
			setForm(emptyForm());
			setEditingId(null);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "保存失败");
		} finally {
			setSubmitting(false);
		}
	};

	const remove = async (trade: TradeLike) => {
		if (!window.confirm("确认删除这笔交易？已实现盈亏将随之重算。")) return;
		setError(null);
		try {
			await tradesApi.remove(holdingId, trade.id);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "删除失败");
		}
	};

	const toggleMode = async () => {
		if (!view) return;
		if (!view.tradeMode && !window.confirm("开启「交易驱动」后，本持仓的数量与平均成本将由交易流水自动计算（不可手改）。已有持仓会自动生成一笔开仓基准，继续吗？")) {
			return;
		}
		setError(null);
		try {
			await tradesApi[view.tradeMode ? "disable" : "enable"](holdingId);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "切换失败");
		}
	};

	if (loading) {
		return (
			<div className="card panel">
				<div className="skeleton" style={{ height: 160 }} />
			</div>
		);
	}
	if (!view) {
		return (
			<div className="card empty">
				{error ?? "未找到该持仓"}
				<div style={{ marginTop: 12 }}>
					<button className="ghost" onClick={() => navigate("/holdings")}>
						返回持仓
					</button>
				</div>
			</div>
		);
	}

	const state = view.state;
	const currency = view.holding.currency;
	const sorted = [...view.trades].sort(
		(a, b) => a.traded_at.localeCompare(b.traded_at) || a.id.localeCompare(b.id),
	);
	// 开仓基准批显示为独立标识
	const isSeed = (trade: TradeLike) => Boolean(trade.seed);
	// 成本口径展示名
	const methodLabel =
		view.costMethod === "weighted"
			? "移动加权平均"
			: view.costMethod === "diluted"
				? "摊薄成本"
				: "先进先出（FIFO）";

	return (
		<>
			<div className="section-head">
				<h2>
					<button className="ghost" onClick={() => navigate("/holdings")} style={{ marginRight: 8 }}>
						←
					</button>
					交易流水
					{view.holding.symbol ? ` · ${view.holding.symbol}` : ""}
					<span className="muted small"> {view.holding.name}</span>
				</h2>
				<div className="spacer" />
				<button className={view.tradeMode ? "ghost" : "primary"} onClick={() => void toggleMode()}>
					{view.tradeMode ? t("交易驱动已开启") : t("开启交易驱动")}
				</button>
			</div>

			{error && <div className="alert error">{error}</div>}

			{/* 汇总卡 */}
			<div className="row" style={{ gap: 12, marginBottom: 16 }}>
				<div className="card panel" style={{ flex: 1 }}>
					<div className="small muted">剩余数量</div>
					<div className="h3">{number(state.qty)}</div>
				</div>
				<div className="card panel" style={{ flex: 1 }}>
					<div className="small muted">平均成本（{methodLabel}）</div>
					<div className="h3">{state.avgCost === null ? "—" : money(state.avgCost, currency, 4)}</div>
				</div>
				<div className="card panel" style={{ flex: 1 }}>
					<div className="small muted">累计已实现盈亏</div>
					{view.costMethod === "diluted" ? (
						<div className="h3 muted" title="摊薄成本法下盈亏已融入剩余成本，不再单独结算">
							不适用
						</div>
					) : (
						<div className={`h3 ${state.realizedPnl > 0 ? "positive" : state.realizedPnl < 0 ? "negative" : "muted"}`}>
							{signedMoney(state.realizedPnl, currency)}
						</div>
					)}
				</div>
			</div>

			{view.tradeMode && (
				<div className="small muted" style={{ marginBottom: 12 }}>
					该持仓已开启交易驱动：数量与平均成本由交易流水按「{methodLabel}」口径自动计算，持仓页不可手改。{" "}
					{view.costMethod === "fifo" && state.lots.length > 0
						? `当前由 ${state.lots.length} 个未卖出批次构成。`
						: state.qty > 0
							? "当前有剩余持仓。"
							: "当前无剩余持仓。"}
				</div>
			)}

			{/* 录入 / 编辑表单 */}
			<form
				className={`card panel${editingId ? " attention" : ""}`}
				onSubmit={(event) => void submit(event)}
				style={{ marginBottom: 16 }}
			>
				<div className="section-head" style={{ marginTop: 0 }}>
					<h3 style={{ margin: 0, fontSize: 14 }}>
						{editingId ? `编辑交易（${editingId.slice(0, 8)}…）` : "录入新交易"}
					</h3>
				</div>
				<div className="row">
					<label className="field">
						<span>方向</span>
						<select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value as "buy" | "sell" })}>
							<option value="buy">买入</option>
							<option value="sell">卖出</option>
						</select>
					</label>
					<label className="field">
						<span>日期</span>
						<input
							type="date"
							value={form.tradedAt}
							onChange={(e) => setForm({ ...form, tradedAt: e.target.value })}
							required
						/>
					</label>
					<label className="field">
						<span>数量</span>
						<input
							type="number"
							step="any"
							min="0"
							value={form.qty}
							onChange={(e) => setForm({ ...form, qty: e.target.value })}
							required
						/>
					</label>
					<label className="field">
						<span>单价（{currency}）</span>
						<input
							type="number"
							step="any"
							min="0"
							value={form.price}
							onChange={(e) => setForm({ ...form, price: e.target.value })}
							required
						/>
					</label>
					<label className="field">
						<span>手续费（{currency}）</span>
						<input
							type="number"
							step="any"
							min="0"
							value={form.fee}
							onChange={(e) => setForm({ ...form, fee: e.target.value })}
						/>
					</label>
					<label className="field">
						<span>备注</span>
						<input
							value={form.note}
							onChange={(e) => setForm({ ...form, note: e.target.value })}
							placeholder="可选"
						/>
					</label>
				</div>
				<div className="row">
					<button className="primary" type="submit" disabled={submitting}>
						{submitting ? "保存中…" : editingId ? "保存修改" : "添加交易"}
					</button>
					{editingId && (
						<button
							type="button"
							onClick={() => {
								setEditingId(null);
								setForm(emptyForm());
							}}
						>
							取消编辑
						</button>
					)}
				</div>
			</form>

			{/* 交易流水表 */}
			<div className="card table-wrap">
				<table>
					<thead>
						<tr>
							<th className="left">日期</th>
							<th className="left">方向</th>
							<th className="left">数量</th>
							<th className="left">单价</th>
							<th className="left">手续费</th>
							<th className="left hide-sm">备注</th>
							<th className="left">操作</th>
						</tr>
					</thead>
					<tbody>
						{sorted.length === 0 ? (
							<tr>
								<td colSpan={7} className="muted">
									还没有交易记录。可先「开启交易驱动」自动生成开仓基准，或直接录入第一笔买入。
								</td>
							</tr>
						) : (
							sorted.map((trade) => (
								<tr key={trade.id} className={editingId === trade.id ? "row-editing" : undefined}>
									<td className="left">{trade.traded_at}</td>
									<td className="left">
										<span className={trade.side === "buy" ? "positive" : "negative"}>
											{trade.side === "buy" ? "买入" : "卖出"}
										</span>
										{isSeed(trade) && <span className="badge"> 开仓基准</span>}
									</td>
									<td className="left">{number(trade.qty)}</td>
									<td className="left">{number(trade.price)}</td>
									<td className="left">{number(trade.fee ?? 0)}</td>
									<td className="left hide-sm muted">{trade.note ?? ""}</td>
									<td className="left">
										{!isSeed(trade) && (
											<>
												<button className="ghost" onClick={() => startEdit(trade)}>
													编辑
												</button>
												<button className="ghost danger" onClick={() => void remove(trade)}>
													删除
												</button>
											</>
										)}
									</td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>

			{/* FIFO 批次透视（只读） */}
			{state.lots.length > 0 && (
				<div className="section">
					<div className="section-head">
						<h2>剩余批次（FIFO）</h2>
					</div>
					<div className="card table-wrap">
						<table>
							<thead>
								<tr>
									<th className="left">来源</th>
									<th className="left">买入日期</th>
									<th className="left">剩余数量</th>
									<th className="left">成本单价</th>
									<th className="left">剩余成本</th>
								</tr>
							</thead>
							<tbody>
								{state.lots.map((lot) => (
									<tr key={lot.tradeId}>
										<td className="left">
											{lot.seed ? "开仓基准" : lot.tradeId.slice(0, 8)}
										</td>
										<td className="left">{view.trades.find((trade) => trade.id === lot.tradeId)?.traded_at ?? "—"}</td>
										<td className="left">{number(lot.qty)}</td>
										<td className="left">{number(lot.price)}</td>
										<td className="left">{money(lot.cost, currency)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			)}
		</>
	);
}
