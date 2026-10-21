import { useState } from "react";
import { CUSTOM_NAV_HEIGHT_TYPE_MAX } from "../types";
import type { CustomNavItem, CustomNavMode } from "../types";
import { saveNavItems } from "./store";
import { navText } from "./text";
import { useT } from "../../web/lib/i18n";

interface Props {
	items: CustomNavItem[];
	onClose: () => void;
	onSaved: (items: CustomNavItem[]) => void;
}

// 生成短 id（≤32 字符）：完整 UUID 有 36 位，会超服务端 id 长度上限导致保存被拒
const newId = () =>
	crypto?.randomUUID?.()
		? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
		: `nav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type FormState = { name: string; url: string; mode: CustomNavMode; heightType: string };

const EMPTY_FORM: FormState = { name: "", url: "", mode: "embed", heightType: "" };

export function ManagePanel({ items, onClose, onSaved }: Props) {
	const t = navText(useT().lang);
	const [list, setList] = useState<CustomNavItem[]>(items);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<FormState>(EMPTY_FORM);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const beginEdit = (item: CustomNavItem) => {
		setForm({ name: item.name, url: item.url, mode: item.mode, heightType: item.heightMessageType ?? "" });
		setEditingId(item.id);
	};

	const addItem = () => {
		const item: CustomNavItem = { id: newId(), name: "", url: "", mode: "embed" };
		setList((prev) => [item, ...prev]);
		beginEdit(item);
	};

	const saveRow = () => {
		const name = form.name.trim();
		if (!name) {
			setError(t.nameRequired);
			return;
		}
		const url = form.url.trim();
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			setError(t.invalidUrl);
			return;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			setError(t.invalidUrl);
			return;
		}
		// 尺寸不再可配：嵌入页统一「容器最大 1200px 居中 + 高度跟随内容」。
		// 高度上报 type 是可选覆盖项（留空 = 自动识别），切到新标签打开时一并清掉。
		setList((prev) =>
			prev.map((item) => {
				if (item.id !== editingId) return item;
				const next: CustomNavItem = { id: item.id, name, url, mode: form.mode };
				const heightType = form.mode === "embed" ? form.heightType.trim() : "";
				if (heightType) next.heightMessageType = heightType;
				return next;
			}),
		);
		setEditingId(null);
		setForm(EMPTY_FORM);
		setError(null);
	};

	const cancelEdit = () => {
		if (editingId && list.find((item) => item.id === editingId)?.name === "" && !list.find((item) => item.id === editingId)?.url) {
			setList((prev) => prev.filter((item) => item.id !== editingId));
		}
		setEditingId(null);
		setError(null);
	};

	const removeItem = (id: string) => {
		setList((prev) => prev.filter((item) => item.id !== id));
		if (editingId === id) setEditingId(null);
	};

	const move = (id: string, dir: -1 | 1) => {
		setList((prev) => {
			const index = prev.findIndex((item) => item.id === id);
			const target = index + dir;
			if (index < 0 || target < 0 || target >= prev.length) return prev;
			const next = [...prev];
			[next[index], next[target]] = [next[target], next[index]];
			return next;
		});
	};

	const persist = async () => {
		if (!editingId && list.some((item) => !item.name.trim())) {
			setError(t.nameRequired);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const saved = await saveNavItems(list);
			onSaved(saved);
		} catch (err) {
			setError(err instanceof Error ? err.message : t.cancel);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="cnav-overlay" onClick={onClose}>
			<div className="card cnav-panel" onClick={(event) => event.stopPropagation()}>
				<h2>{t.manage}</h2>

				{list.length === 0 && !editingId && <div className="cnav-empty">{t.empty}</div>}

				{list.map((item) =>
					item.id === editingId ? (
						<div key={item.id} className="cnav-form">
							<div className="cnav-form-row">
								<label>{t.name}</label>
								<input
									type="text"
									value={form.name}
									maxLength={40}
									placeholder={t.namePlaceholder}
									onChange={(event) => setForm({ ...form, name: event.target.value })}
								/>
							</div>
							<div className="cnav-form-row">
								<label>{t.url}</label>
								<input
									type="url"
									value={form.url}
									maxLength={1000}
									placeholder={t.urlPlaceholder}
									onChange={(event) => setForm({ ...form, url: event.target.value })}
								/>
							</div>
							<div className="cnav-form-row">
								<label>{t.mode}</label>
								<select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value as CustomNavMode })}>
									<option value="embed">{t.embed}</option>
									<option value="tab">{t.tab}</option>
								</select>
							</div>
							{form.mode === "embed" && (
								<>
									<div className="cnav-form-row">
										<label>{t.heightType}</label>
										<input
											type="text"
											value={form.heightType}
											maxLength={CUSTOM_NAV_HEIGHT_TYPE_MAX}
											placeholder={t.heightTypePlaceholder}
											onChange={(event) => setForm({ ...form, heightType: event.target.value })}
										/>
									</div>
									<p className="cnav-form-hint">{t.heightTypeHint}</p>
								</>
							)}
							<div className="cnav-form-actions">
								<button className="ghost" onClick={cancelEdit}>{t.cancel}</button>
								<button onClick={saveRow}>{t.save}</button>
							</div>
						</div>
					) : (
						<div key={item.id} className="cnav-row">
							<span className="cnav-row-name">{item.name}</span>
							<span className="cnav-row-url">{item.url}</span>
							<span className="cnav-badge">{item.mode === "embed" ? t.embed : t.tab}</span>
							<div className="cnav-row-actions">
								<button className="ghost" title={t.moveUp} onClick={() => move(item.id, -1)}>↑</button>
								<button className="ghost" title={t.moveDown} onClick={() => move(item.id, 1)}>↓</button>
								<button className="ghost" title={t.edit} onClick={() => beginEdit(item)}>{t.edit}</button>
								<button className="ghost danger" title={t.delete} onClick={() => removeItem(item.id)}>{t.delete}</button>
							</div>
						</div>
					),
				)}

				<div className="cnav-panel-footer">
					<span className="cnav-count">{t.itemsCount(list.length)}</span>
					<div className="cnav-form-actions">
						<button className="ghost" onClick={addItem}>{t.add}</button>
						<button className="ghost" onClick={onClose}>{t.close}</button>
						<button disabled={saving} onClick={persist}>{t.save}</button>
					</div>
				</div>
				{error && <p className="form-error">{error}</p>}
			</div>
		</div>
	);
}
