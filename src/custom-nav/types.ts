/**
 * 自定义导航菜单 —— 独立功能（src/custom-nav/）
 *
 * 与上游零迁移、零依赖：配置整体存进 settings 表的 KV key（custom_nav_items），
 * 不需要建表、不需要 bump SCHEMA_VERSION，上游升级不会碰它。
 */

/** 打开方式：embed = iframe 嵌入当前应用壳；tab = 浏览器新标签打开 */
export type CustomNavMode = "embed" | "tab";

export interface CustomNavItem {
	/** 短 id（字母数字与连字符），用于站内路由 /custom/:id */
	id: string;
	/** 菜单显示名 */
	name: string;
	/** 目标页面地址（http/https） */
	url: string;
	mode: CustomNavMode;
	/** 嵌入模式下的 iframe 宽度（px）；留空 = 自适应（占满可用宽度） */
	width?: number;
	/** 嵌入模式下的 iframe 高度（px）；留空 = 撑满顶栏以下剩余视口 + --cnav-extra */
	height?: number;
}

/** settings 表中的 KV key */
export const CUSTOM_NAV_SETTING_KEY = "custom_nav_items";

export const CUSTOM_NAV_MAX_ITEMS = 20;
export const CUSTOM_NAV_NAME_MAX = 40;
export const CUSTOM_NAV_URL_MAX = 1000;
/** 嵌入尺寸（px）的可填范围；超出会被夹到边界，非数字视为「自适应」 */
export const CUSTOM_NAV_SIZE_MIN = 100;
export const CUSTOM_NAV_SIZE_MAX = 4000;

/**
 * 尺寸规整：只接受有限数字（含数字字符串），夹到 [MIN, MAX] 并取整；
 * 其它输入（空串、非数字、非正数）一律视为「自适应」= 不写入该字段。
 * 尺寸是可选项，写坏它不该拖累整个菜单项，因此不做拒绝处理。
 */
function normalizeSize(value: unknown): number | undefined {
	const candidate =
		typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
	if (!Number.isFinite(candidate) || candidate <= 0) return undefined;
	return Math.min(CUSTOM_NAV_SIZE_MAX, Math.max(CUSTOM_NAV_SIZE_MIN, Math.round(candidate)));
}

/** 服务器端统一解析：坏数据整体回退为空列表（不影响主页渲染） */
export function parseCustomNavItems(raw: string | null | undefined): CustomNavItem[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		const items: CustomNavItem[] = [];
		for (const entry of parsed) {
			const item = sanitizeCustomNavItem(entry);
			if (item) items.push(item);
		}
		return items.slice(0, CUSTOM_NAV_MAX_ITEMS);
	} catch {
		return [];
	}
}

/**
 * 单个条目清洗：返回合法条目；不合法返回 null。
 * 服务端 PUT 与前端展示共用，保证写入的必然是能渲染的。
 */
export function sanitizeCustomNavItem(value: unknown): CustomNavItem | null {
	if (!value || typeof value !== "object") return null;
	const entry = value as Record<string, unknown>;
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	const name = typeof entry.name === "string" ? entry.name.trim() : "";
	const url = typeof entry.url === "string" ? entry.url.trim() : "";
	const mode = entry.mode === "tab" ? "tab" : "embed";
	// id 格式校验：字母数字与连字符，最长 40（前端生成 16 位短 id，放宽上限兜底历史数据）
	if (!/^[a-zA-Z0-9-]{1,40}$/.test(id)) return null;
	if (!name || name.length > CUSTOM_NAV_NAME_MAX) return null;
	if (!url || url.length > CUSTOM_NAV_URL_MAX) return null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	} catch {
		return null;
	}
	const item: CustomNavItem = { id, name, url, mode };
	// 尺寸按需写入：不填则完全不落这两个 key（保证存量数据与序列化结果不变）
	const width = normalizeSize(entry.width);
	if (width !== undefined) item.width = width;
	const height = normalizeSize(entry.height);
	if (height !== undefined) item.height = height;
	return item;
}

/** 序列化（存库用） */
export function serializeCustomNavItems(items: CustomNavItem[]): string {
	return JSON.stringify(items.slice(0, CUSTOM_NAV_MAX_ITEMS));
}
