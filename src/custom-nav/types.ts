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
}

/** settings 表中的 KV key */
export const CUSTOM_NAV_SETTING_KEY = "custom_nav_items";

export const CUSTOM_NAV_MAX_ITEMS = 20;
export const CUSTOM_NAV_NAME_MAX = 40;
export const CUSTOM_NAV_URL_MAX = 1000;

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
	// 尺寸不再由菜单配置：嵌入页固定「容器最大 1200px 居中 + 高度跟随内容」。
	// 历史数据里的 width / height 会被这里丢弃（下次保存即清理干净）。
	return { id, name, url, mode };
}

/** 序列化（存库用） */
export function serializeCustomNavItems(items: CustomNavItem[]): string {
	return JSON.stringify(items.slice(0, CUSTOM_NAV_MAX_ITEMS));
}
