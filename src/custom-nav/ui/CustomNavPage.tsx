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
 * 目标网站若拒绝被嵌入（X-Frame-Options / CSP），工具栏提供新标签兜底。
 */
export function CustomNavPage() {
	const { path } = useRouter();
	const t = navText(useT().lang);
	const id = path.split("/")[2] ?? "";
	const { data } = useAsync(() => getNavItems(), []);
	const item = data?.find((entry) => entry.id === id);

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
					<iframe title={item.name} src={item.url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals" />
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
