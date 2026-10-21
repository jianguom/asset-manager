import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "../../web/lib/router";
import { useAsync } from "../../web/lib/useAsync";
import { useT } from "../../web/lib/i18n";
import { getNavItems } from "./store";
import { navText } from "./text";
import "./custom-nav.css";

/**
 * 自定义菜单嵌入页（/custom/:id）
 *
 * 尺寸策略（菜单里不再配置宽高）：
 *   - 外层容器 .cnav-frame：PC 端最大 1200px 居中、两侧留空；窄屏自动撑满（见 custom-nav.css）
 *   - iframe 宽度跟随容器 100%
 *   - iframe 高度自动跟随被嵌页面内容高度，全程隐藏滚动条
 *
 * 高度来源（按可行性依次尝试）：
 *   ① 同源页面：直接读 contentDocument 的 scrollHeight，并用 ResizeObserver 跟随内容变化；
 *   ② 跨源页面：读不到文档，改为监听对方 postMessage 上报
 *      `{ type: "cnav:height", height: 1234 }`，并在加载完成 / 窗口尺寸变化时主动发
 *      `{ type: "cnav:request-height" }` 请求对方上报；
 *   ③ 两者都拿不到（跨源且页面未配合）：退化为 CSS 的视口高度兜底，页面自身仍可滚动。
 *
 * 窗口尺寸变化时重新量取（同源）或重新请求上报（跨源），宽度由 CSS 100% 自动适配。
 */
const HEIGHT_MESSAGE = "cnav:height";
const HEIGHT_REQUEST = "cnav:request-height";

export function CustomNavPage() {
	const { path } = useRouter();
	const t = navText(useT().lang);
	const id = path.split("/")[2] ?? "";
	const { data } = useAsync(() => getNavItems(), []);
	const item = data?.find((entry) => entry.id === id);
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	const observerRef = useRef<ResizeObserver | null>(null);
	const [height, setHeight] = useState<number | null>(null);

	const isEmbed = Boolean(item && item.mode === "embed");

	/** 同源量取内容高度；跨源（contentDocument 为 null）返回 false，交由 postMessage 处理 */
	const measure = useCallback(() => {
		const doc = frameRef.current?.contentDocument;
		if (!doc) return false;
		const next = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
		if (next <= 0) return false;
		setHeight(next);
		return true;
	}, []);

	/** 请跨源页面重新上报高度（对方未监听则无副作用） */
	const requestHeight = useCallback(() => {
		frameRef.current?.contentWindow?.postMessage({ type: HEIGHT_REQUEST }, "*");
	}, []);

	// iframe 每次加载完成：复位高度，同源直接量取并监听内容变化，跨源则请求上报
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame || !isEmbed) return;

		const onLoad = () => {
			setHeight(null);
			observerRef.current?.disconnect();
			observerRef.current = null;

			const doc = frame.contentDocument;
			if (doc) {
				measure();
				const observer = new ResizeObserver(() => measure());
				if (doc.documentElement) observer.observe(doc.documentElement);
				if (doc.body) observer.observe(doc.body);
				observerRef.current = observer;
				return;
			}
			requestHeight();
		};

		frame.addEventListener("load", onLoad);
		// 组件挂载时若 iframe 已加载完（浏览器缓存命中，load 不会再触发）
		if (frame.contentDocument?.readyState === "complete") onLoad();

		return () => {
			frame.removeEventListener("load", onLoad);
			observerRef.current?.disconnect();
			observerRef.current = null;
		};
	}, [item?.id, item?.url, isEmbed, measure, requestHeight]);

	// 跨源高度上报：只接受来自本 iframe 的消息
	useEffect(() => {
		if (!isEmbed) return;
		const onMessage = (event: MessageEvent) => {
			const frame = frameRef.current;
			if (!frame || event.source !== frame.contentWindow) return;
			const payload = event.data as unknown;
			const value =
				typeof payload === "number"
					? payload
					: payload && typeof payload === "object" && (payload as { type?: unknown }).type === HEIGHT_MESSAGE
						? (payload as { height?: unknown }).height
						: undefined;
			if (typeof value === "number" && Number.isFinite(value) && value > 0) setHeight(Math.round(value));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [isEmbed]);

	// 屏幕尺寸变化：重新量取（同源），或请对端重新上报（跨源）
	useEffect(() => {
		if (!isEmbed) return;
		const onResize = () => {
			if (!measure()) requestHeight();
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [isEmbed, measure, requestHeight]);

	if (item && item.mode === "embed") {
		return (
			<div className="cnav-page">
				<div className="cnav-toolbar">
					<span className="cnav-title">{item.name}</span>
				</div>
				<div className="cnav-frame">
					<iframe
						ref={frameRef}
						title={item.name}
						src={item.url}
						style={height ? { height: `${height}px` } : undefined}
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
