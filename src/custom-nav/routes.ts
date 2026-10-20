import { Hono } from "hono";
import type { AppEnv } from "../worker/types";
import { badRequest, ok } from "../worker/core/errors";
import { writeAudit } from "../worker/core/audit";
import { tOf } from "../worker/core/i18n";
import { asRecord } from "../worker/api/validate";
import { getSetting, setSetting } from "../worker/data/settings.repo";
import {
	CUSTOM_NAV_MAX_ITEMS,
	CUSTOM_NAV_SETTING_KEY,
	parseCustomNavItems,
	sanitizeCustomNavItem,
	serializeCustomNavItems,
	type CustomNavItem,
} from "./types";

/**
 * 自定义导航菜单路由（独立功能，挂在 /api/custom-nav）
 *
 * 菜单配置是全局的（所有登录用户共享），存进 settings 表 KV，
 * 无需数据库迁移。GET 供顶栏渲染，PUT 由"管理面板"整表替换。
 */
const customNav = new Hono<AppEnv>();

customNav.get("/", async (c) => {
	const raw = await getSetting(c.env.DB, CUSTOM_NAV_SETTING_KEY);
	return ok(c, { items: parseCustomNavItems(raw) });
});

customNav.put("/", async (c) => {
	const t = tOf(c);
	const payload = asRecord(await c.req.json(), t);
	const incoming = payload.items;
	if (!Array.isArray(incoming)) throw badRequest("items 必须是数组");

	const items: CustomNavItem[] = [];
	for (const entry of incoming) {
		const item = sanitizeCustomNavItem(entry);
		if (!item) throw badRequest("存在无效的菜单项（名称、地址或 id 不符合要求）");
		items.push(item);
	}
	if (items.length > CUSTOM_NAV_MAX_ITEMS) {
		throw badRequest(`最多支持 ${CUSTOM_NAV_MAX_ITEMS} 个自定义菜单`);
	}
	const seen = new Set<string>();
	for (const item of items) {
		if (seen.has(item.id)) throw badRequest("菜单 id 重复");
		seen.add(item.id);
	}

	const next = serializeCustomNavItems(items);
	const before = await getSetting(c.env.DB, CUSTOM_NAV_SETTING_KEY);
	await setSetting(c.env.DB, CUSTOM_NAV_SETTING_KEY, next);

	await writeAudit(c.env.DB, {
		entity: "settings",
		entityId: "custom_nav_items",
		action: "update",
		before: { items: parseCustomNavItems(before).length },
		after: { items: items.length },
	});
	return ok(c, { items });
});

export default customNav;
