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
 * 尺寸策略（菜单里不配置宽高）：
 *   - 外层容器 .cnav-frame：PC 端最大 1200px 居中、两侧留空；窄屏自动撑满（见 custom-nav.css）
 *   - iframe 宽度跟随容器 100%
 *   - iframe 高度自动跟随被嵌页面内容高度，全程隐藏滚动条
 *
 * 高度来源（按可行性依次尝试）：
 *   ① 同源页面：直接读 contentDocument 的 scrollHeight，并用 ResizeObserver 跟随内容变化；
 *   ② 跨源页面：读不到文档，改为监听对端 postMessage 上报（各实现 type 不统一，见下）；
 *   ③ 都没拿到（跨源且页面不上报）：退化为 CSS 的视口高度兜底，页面自身仍可滚动。
 *
 * 跨源上报的通用识别：
 *   - 自动模式（菜单未填 heightMessageType）：type 含 height / resize / size 即认，
 *     也接受纯数字载荷、无 type 的 { height } 载荷；
 *   - 覆盖模式（菜单填了 heightMessageType）：只认这个 type（仍兼容本站的 cnav:height）；
 *   - 载荷归一化：数字、"1234px"、JSON 字符串、{height} / {data:{height}} / {payload:{height}} 等；
 *   - 防误判：来源必须是本 iframe、高度需在 [100, 50000] 内、变化小于 2px 不重排。
 */
const HEIGHT_MESSAGE = "cnav:height";
const HEIGHT_REQUEST = "cnav:request-height";
/** 自动识别时，type 里出现这些词就认为是在上报尺寸 */
const HEIGHT_TYPE_HINT = /height|resize|size/i;
/** 合法内容高度范围（px），超出视为噪声 */
const HEIGHT_MIN = 100;
const HEIGHT_MAX = 50000;
/** 小于该增量的变化忽略，避免与页面自身 resize 来回抖动 */
const HEIGHT_JITTER = 2;

/** 把各家的上报载荷归一化成像素高度：数字 / "1234px" / JSON 字符串 / 多层对象 */
function readHeight(source: unknown, depth = 0): number | undefined {
	if (depth > 3 || source == null) return undefined;
	if (typeof source === "number") return Number.isFinite(source) ? source : undefined;
	if (typeof source === "string") {
		const text = source.trim();
		if (!text) return undefined;
		const numeric = Number(text.replace(/px$/i, ""));
		if (Number.isFinite(numeric)) return numeric;
		try {
			return readHeight(JSON.parse(text), depth + 1);
		} catch {
			return undefined;
		}
	}
	if (typeof source !== "object") return undefined;
	const record = source as Record<string, unknown>;
	for (const key of ["height", "scrollHeight", "contentHeight", "h", "value", "size"]) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			const numeric = Number(value.trim().replace(/px$/i, ""));
			if (Number.isFinite(numeric)) return numeric;
		}
	}
	for (const key of ["data", "payload", "detail", "result"]) {
		const nested = readHeight(record[key], depth + 1);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

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
	const expectedType = item?.heightMessageType;

	/** 统一入口：取整 + 范围校验 + 抖动抑制 */
	const applyHeight = useCallback((raw: number) => {
		const next = Math.round(raw);
		if (!Number.isFinite(next) || next < HEIGHT_MIN || next > HEIGHT_MAX) return;
		setHeight((prev) => (prev === null || Math.abs(prev - next) >= HEIGHT_JITTER ? next : prev));
	}, []);

	/** 同源量取内容高度；跨源（contentDocument 为 null）返回 false，交由 postMessage 处理 */
	const measure = useCallback(() => {
		const doc = frameRef.current?.contentDocument;
		if (!doc) return false;
		const next = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
		if (next <= 0) return false;
		applyHeight(next);
		return true;
	}, [applyHeight]);

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

	// 跨源高度上报：只接受来自本 iframe 的消息，并做 type 归一化识别
	useEffect(() => {
		if (!isEmbed) return;
		const onMessage = (event: MessageEvent) => {
			const frame = frameRef.current;
			if (!frame || event.source !== frame.contentWindow) return;

			const payload = event.data as unknown;
			const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
			const typeText = record && typeof record.type === "string" ? record.type : "";

			let accepted: boolean;
			if (expectedType) {
				// 覆盖模式：只认指定 type（本站协议始终兼容）
				accepted = typeText.toLowerCase() === expectedType.toLowerCase() || typeText === HEIGHT_MESSAGE;
			} else if (typeText) {
				// 自动模式：type 关键字命中即认为在上报尺寸
				accepted = typeText === HEIGHT_MESSAGE || HEIGHT_TYPE_HINT.test(typeText);
			} else {
				// 无 type：只接受纯数字，或形如 { height: n } 的载荷
				accepted = typeof payload === "number" || (record !== null && "height" in record);
			}
			if (!accepted) return;

			const next = readHeight(payload);
			if (next !== undefined) applyHeight(next);
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [isEmbed, expectedType, applyHeight]);

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
