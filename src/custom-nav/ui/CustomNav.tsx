import { useState } from "react";
import { createPortal } from "react-dom";
import { Link, useRouter } from "../../web/lib/router";
import { useAsync } from "../../web/lib/useAsync";
import { useT } from "../../web/lib/i18n";
import { getNavItems } from "./store";
import { navText } from "./text";
import { ManagePanel } from "./ManagePanel";
import type { CustomNavItem } from "../types";
import "./custom-nav.css";

/**
 * 顶栏自定义导航（渲染进 App.tsx 的 <nav>，纯追加式接线）
 *
 * embed 模式走站内路由 /custom/:id（由 CustomNavPage 用 iframe 嵌入应用壳）；
 * tab 模式直接新标签打开。末尾的齿轮按钮打开全局管理面板。
 */
export function CustomNav() {
	const { path } = useRouter();
	const t = navText(useT().lang);
	const { data, setData } = useAsync(() => getNavItems(), []);
	const [managing, setManaging] = useState(false);
	const items = data ?? [];

	return (
		<>
			{items.map((item) =>
				item.mode === "tab" ? (
					<a
						key={item.id}
						className={path === `/custom/${item.id}` ? "active" : ""}
						href={item.url}
						target="_blank"
						rel="noopener noreferrer"
					>
						{item.name}
					</a>
				) : (
					<Link key={item.id} to={`/custom/${item.id}`} className={path === `/custom/${item.id}` ? "active" : ""}>
						{item.name}
					</Link>
				),
			)}
			<button type="button" className="cnav-gear" title={t.manage} aria-label={t.manage} onClick={() => setManaging(true)}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<circle cx="12" cy="12" r="3" />
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
				</svg>
			</button>
			{managing &&
				// 必须用 Portal 渲染到 document.body：
				// .topbar 有 backdrop-filter，会给 position:fixed 建立包含块，
				// 不逃出去的话弹窗会被锁在顶栏那一小块里（表现为小 iframe + 滚动条）。
				createPortal(
					<ManagePanel
						items={items}
						onClose={() => setManaging(false)}
						onSaved={(next: CustomNavItem[]) => {
							setData(next);
							setManaging(false);
						}}
					/>,
					document.body,
				)}
		</>
	);
}
