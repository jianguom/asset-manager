import { useLayoutEffect } from "react";
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
 * - iframe 尺寸有两种来源：
 *   ① 菜单里未填宽/高 → 纯 CSS flex 高度链撑满顶栏以下的剩余视口，再叠加
 *      `--cnav-extra` 的余量（见 custom-nav.css 的 `.app-shell.has-cnav`），
 *      比"刚好一屏"略高一点，页面因此多出一小截可滚动空间；
 *   ② 菜单里填了宽/高 → 按配置尺寸锁死 iframe，不再跟随视口推算
 *      （宽、高各自独立生效：只填宽度时高度仍自适应）；
 * - iframe 去边框、背景透明并隐藏自身滚动条（内容仍可滚），呈现"无感"效果。
 */
export function CustomNavPage() {
	const { path } = useRouter();
	const t = navText(useT().lang);
	const id = path.split("/")[2] ?? "";
	const { data } = useAsync(() => getNavItems(), []);
	const item = data?.find((entry) => entry.id === id);

	// 菜单里配置了尺寸时按配置锁死 iframe：填了高度就脱离视口高度链（flex 置为不伸缩，
	// 否则 flex:1 会把 inline 高度再撑开）；只填宽度时高度仍走自适应。
	const locked =
		item && item.mode === "embed" && (item.width || item.height)
			? {
					width: item.width ? `${item.width}px` : undefined,
					height: item.height ? `${item.height}px` : undefined,
					flex: item.height ? "0 0 auto" : undefined,
				}
			: undefined;

	// 未锁定高度时给共享的 .app-shell 加 has-cnav：custom-nav.css 据此把外壳变成纵向 flex，
	// 让 iframe 吃掉顶栏以下的剩余视口，并叠加 --cnav-extra 的余量。
	// 用类选择器而非 :has()，兼容不支持 :has() 的旧浏览器（useLayoutEffect 在首帧绘制前生效）。
	useLayoutEffect(() => {
		if (!item || item.mode !== "embed" || item.height) return;
		const shell = document.querySelector(".app-shell");
		shell?.classList.add("has-cnav");
		return () => {
			shell?.classList.remove("has-cnav");
		};
	}, [item?.id, item?.url, item?.height]);

	if (item && item.mode === "embed") {
		return (
			<div className="cnav-page">
				<div className="cnav-toolbar">
					<span className="cnav-title">{item.name}</span>
				</div>
				<div className="cnav-frame" style={locked}>
					<iframe
						title={item.name}
						src={item.url}
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
					/>
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
