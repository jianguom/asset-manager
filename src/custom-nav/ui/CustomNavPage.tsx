import { useEffect, useState } from "react";
import { useRouter } from "../../web/lib/router";
import { useAsync } from "../../web/lib/useAsync";
import { useT } from "../../web/lib/i18n";
import { getNavItems } from "./store";
import { navText } from "./text";
import "./custom-nav.css";

/**
 * 自定义菜单嵌入页（/custom/:id）
 *
 * 顶栏点击「嵌入」模式的菜单后，在应用壳内用 iframe 无感集成目标页面：
 * 顶部导航栏保持原样，看起来就是当前应用的一部分。
 *
 * - iframe 高度由纯 CSS flex 高度链撑满剩余视口（见 custom-nav.css 的
 *   `.app-shell:has(.cnav-page)`），页面本身不产生滚动条；
 * - iframe 去边框并隐藏自身滚动条（内容仍可滚），呈现"无感"效果；
 * - 加载超过 8 秒未完成时，在 iframe 区域内顶部浮现小气泡提示（不遮挡页面），
 *   load 事件触发后自动消失。
 */
export function CustomNavPage() {
	const { path } = useRouter();
	const t = navText(useT().lang);
	const id = path.split("/")[2] ?? "";
	const { data } = useAsync(() => getNavItems(), []);
	const item = data?.find((entry) => entry.id === id);

	const [slow, setSlow] = useState(false);

	useEffect(() => {
		if (!item || item.mode !== "embed") return;
		setSlow(false);
		const timer = window.setTimeout(() => setSlow(true), 8000);
		return () => window.clearTimeout(timer);
	}, [item?.id, item?.url]);

	if (item && item.mode === "embed") {
		return (
			<div className="cnav-page">
				<div className="cnav-toolbar">
					<span className="cnav-title">{item.name}</span>
					<a className="ghost" href={item.url} target="_blank" rel="noopener noreferrer">
						{t.openTab}
					</a>
				</div>
				<div className="cnav-frame">
					<iframe
						title={item.name}
						src={item.url}
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
						onLoad={() => setSlow(false)}
					/>
					{slow && (
						<div className="cnav-slow">
							<p>{t.embedSlow}</p>
							<a className="ghost" href={item.url} target="_blank" rel="noopener noreferrer">
								{t.openTab}
							</a>
						</div>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="cnav-page">
			<div className="card" style={{ padding: 16 }}>
				<p style={{ margin: 0 }}>
					{t.notFound}
					{item?.mode === "tab" && (
						<a className="ghost" style={{ marginLeft: 8 }} href={item.url} target="_blank" rel="noopener noreferrer">
							{t.openTab}
						</a>
					)}
				</p>
			</div>
		</div>
	);
}
