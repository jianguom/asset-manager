import { useEffect, useRef, useState } from "react";
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
 * 目标网站若拒绝被嵌入（X-Frame-Options / CSP），iframe 不会触发任何事件，
 * 用超时兜底检测：超过 5 秒仍未加载则提示，并提供新标签打开。
 */
export function CustomNavPage() {
	const { path } = useRouter();
	const t = navText(useT().lang);
	const id = path.split("/")[2] ?? "";
	const { data } = useAsync(() => getNavItems(), []);
	const item = data?.find((entry) => entry.id === id);

	const [stuck, setStuck] = useState(false);
	const loadedRef = useRef(false);

	useEffect(() => {
		if (!item || item.mode !== "embed") return;
		loadedRef.current = false;
		setStuck(false);
		const timer = window.setTimeout(() => {
			// X-Frame-Options 拦截时 iframe 不发 load/error 事件，只能靠超时兜底
			if (!loadedRef.current) setStuck(true);
		}, 5000);
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
						onLoad={() => {
							loadedRef.current = true;
							setStuck(false);
						}}
					/>
					{stuck && (
						<div className="cnav-stuck">
							<p>{t.embedBlocked}</p>
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
