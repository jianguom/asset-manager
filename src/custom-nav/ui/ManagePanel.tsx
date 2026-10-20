import { useState } from "react";
import type { CustomNavItem, CustomNavMode } from "../types";
import { saveNavItems } from "./store";
import { navText } from "./text";
import { useT } from "../../web/lib/i18n";

interface Props {
	items: CustomNavItem[];
	onClose: () => void;
	onSaved: (items: CustomNavItem[]) => void;
}

const newId = () => (crypto?.randomUUID?.() ?? `nav-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

export function ManagePanel({ items, onClose, onSaved }: Props) {
	const t = navText(useT().lang);
	const [list, setList] = useState<CustomNavItem[]>(items);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<{ name: string; url: string; mode: CustomNavMode }>({ name: "", url: "", mode: "embed" });
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const beginEdit = (item: CustomNavItem) => {
		setForm({ name: item.name, url: item.url, mode: item.mode });
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
		setList((prev) => prev.map((item) => (item.id === editingId ? { ...item, name, url, mode: form.mode } : item)));
		setEditingId(null);
		setForm({ name: "", url: "", mode: "embed" });
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
